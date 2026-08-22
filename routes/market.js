const router      = require('express').Router();
const pool        = require('../data/mysql');
const usersStore  = require('../data/users-store');
const { photoUrlForUser, hasAnyPhoto } = require('../data/user-serialize');
const { requireAuth }     = require('../middleware/auth');
const { normalizeRole } = require('../data/roles');
const { computeTier }    = require('../data/tiers');
const econConfig         = require('../data/economic-config');

// ── helpers ───────────────────────────────────────────────────────

async function getStock(sym) {
  const [rows] = await pool.query('SELECT * FROM companies WHERE `sym` = ?', [sym.toUpperCase()]);
  return rows[0] || null;
}

async function getStockWithOwners(sym) {
  const s = await getStock(sym);
  if (!s) return null;
  // Parse price_history from JSON string
  s.priceHistory = typeof s.price_history === 'string' ? JSON.parse(s.price_history) : (s.price_history || []);
  // Get owners from company_owners table
  const [ownerRows] = await pool.query(
    'SELECT user_id, pct FROM company_owners WHERE `sym` = ?',
    [sym.toUpperCase()]
  );
  // Attach owner names by querying users
  if (ownerRows.length > 0) {
    const placeholders = ownerRows.map(() => '?').join(',');
    const [userRows] = await pool.query(
      `SELECT id, nick, name FROM users WHERE id IN (${placeholders})`,
      ownerRows.map(o => o.user_id)
    );
    const userMap = {};
    userRows.forEach(u => userMap[u.id] = u);
    s.owners = ownerRows.map(o => ({
      userId: o.user_id,
      name: (userMap[o.user_id] || {}).nick || (userMap[o.user_id] || {}).name || '',
      pct: o.pct
    }));
  } else {
    s.owners = [];
  }
  return s;
}

async function getPortfolio(uid) {
  const [rows] = await pool.query(
    'SELECT sym, qty FROM portfolios WHERE user_id = ? AND qty > 0',
    [uid]
  );
  const pf = {};
  rows.forEach(r => { pf[r.sym] = r.qty; });
  return pf;
}

async function setPortfolioQty(uid, sym, qty) {
  if (qty <= 0) {
    await pool.query(
      'DELETE FROM portfolios WHERE user_id = ? AND sym = ?',
      [uid, sym]
    );
  } else {
    await pool.query(
      `INSERT INTO portfolios (\`user_id\`, \`sym\`, \`qty\`)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE \`qty\` = ?`,
      [uid, sym, qty, qty]
    );
  }
}

async function addTransaction(tx) {
  await pool.query(
    `INSERT INTO transactions (\`uid\`, \`uname\`, \`type\`, \`sym\`, \`qty\`, \`price\`, \`total\`, \`time\`, \`ts\`)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [tx.uid, tx.uname, tx.type, tx.sym, tx.qty, tx.price, tx.total, tx.time, tx.ts]
  );
}

async function getUserTransactions(uid) {
  const [rows] = await pool.query(
    'SELECT * FROM transactions WHERE `uid` = ? ORDER BY `ts` DESC',
    [uid]
  );
  return rows;
}

async function logAdmin(msg) {
  await pool.query(
    'INSERT INTO admin_events (`t`, `msg`, `ts`) VALUES (?, ?, ?)',
    [new Date().toLocaleTimeString('pt-BR'), msg, Date.now()]
  );
}

// ── Routes ────────────────────────────────────────────────────────

// GET /api/market/state
router.get('/state', async (req, res) => {
  try {
    const [stocks] = await pool.query('SELECT * FROM companies WHERE `status` != "deleted"');
    const [marketRows] = await pool.query('SELECT * FROM market_state WHERE `id` = 1');
    const market = marketRows[0] || { open: 1 };
    const open = !!market.open;

    const ibcx = stocks.length
      ? stocks.reduce((a, s) => a + (s.price / s.open * 1000), 0) / stocks.length
      : 1000;
    const totalVol = stocks.reduce((a, s) => a + (s.volume || 0) * (s.price || 0), 0);

    // Return stocks without price_history in the response (same as lowdb's destructuring pattern)
    const stocksLite = stocks.map(({ price_history, ...s }) => s);
    res.json({ stocks: stocksLite, open, ibcx, totalVol });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/market/history/:sym
router.get('/history/:sym', async (req, res) => {
  try {
    const sym = req.params.sym.toUpperCase();
    const stock = await getStock(sym);
    if (!stock) return res.status(404).json({ error: 'Ativo não encontrado' });
    const history = typeof stock.price_history === 'string' ? JSON.parse(stock.price_history) : (stock.price_history || []);
    res.json({ sym, history });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/market/portfolio
router.get('/portfolio', requireAuth, async (req, res) => {
  try {
    const uid  = req.session.userId;
    const user = await usersStore.getUserById(uid);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    const pf  = await getPortfolio(uid);
    const txs = await getUserTransactions(uid);

    // Detect orphans for this user's portfolio
    const [activeStockRows] = await pool.query('SELECT `sym` FROM companies WHERE `status` = "active"');
    const activeSyms = new Set(activeStockRows.map(s => s.sym));
    let orphanQty = 0;
    const orphans = [];
    Object.entries(pf).forEach(([sym, qty]) => {
      if (!activeSyms.has(sym)) {
        orphanQty += qty;
        orphans.push({ sym, qty });
      }
    });

    res.json({ user: usersStore.safeUser(user), portfolio: pf, transactions: txs, orphanQty, orphans: orphans.length > 0 ? orphans : undefined });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/market/order
router.post('/order', requireAuth, async (req, res) => {
  let conn;
  try {
    const [marketRows] = await pool.query('SELECT * FROM market_state WHERE `id` = 1');
    const market = marketRows[0] || { open: 1 };
    if (!market.open)
      return res.status(403).json({ error: 'Mercado está fechado.' });

    const { sym, type, qty } = req.body;
    const quantity = parseInt(qty, 10);
    if (!sym || !type || !quantity || quantity < 1)
      return res.status(400).json({ error: 'Parâmetros inválidos.' });

    const uid   = req.session.userId;
    const user  = await usersStore.getUserById(uid);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });

    const stock = await getStock(sym.toUpperCase());
    if (!stock) return res.status(404).json({ error: 'Ativo não encontrado.' });
    if (stock.status !== 'active') return res.status(403).json({ error: 'Ativo suspenso.' });

    const total     = Math.round(stock.price * quantity * 100) / 100;
    const buyFee    = econConfig.calculateTradingFee(total, 'buy');
    const sellFee   = econConfig.calculateTradingFee(total, 'sell');
    const pf        = await getPortfolio(uid);

    // ── ATOMIC TRANSACTION: balance + portfolio + volume all succeed or fail together ──
    conn = await pool.getConnection();
    await conn.beginTransaction();

    if (type === 'buy') {
      const totalCost = total + buyFee;          // trade value + fee
      if (user.balance < totalCost) {
        await conn.rollback();
        return res.status(400).json({ error: 'Saldo insuficiente.' });
      }
      await conn.query('UPDATE users SET `balance` = `balance` - ? WHERE `id` = ?', [totalCost, uid]);
      const newQty = (pf[sym] || 0) + quantity;
      await conn.query(
        'INSERT INTO portfolios (`user_id`, `sym`, `qty`) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE `qty` = ?',
        [uid, sym.toUpperCase(), newQty, newQty]
      );
      const newDemand = Math.min(0.95, stock.demand + 0.03);
      await conn.query(
        'UPDATE companies SET `demand` = ?, `buys` = `buys` + ?, `volume` = `volume` + ? WHERE `sym` = ?',
        [newDemand, quantity, quantity, sym.toUpperCase()]
      );
    } else if (type === 'sell') {
      const owned = pf[sym] || 0;
      if (owned < quantity) {
        await conn.rollback();
        return res.status(400).json({ error: 'Cotas insuficientes.' });
      }
      const netReceived = total - sellFee;         // sale value minus fee
      await conn.query('UPDATE users SET `balance` = `balance` + ? WHERE `id` = ?', [netReceived, uid]);
      const newQty = owned - quantity;
      if (newQty > 0) {
        await conn.query(
          'INSERT INTO portfolios (`user_id`, `sym`, `qty`) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE `qty` = ?',
          [uid, sym.toUpperCase(), newQty, newQty]
        );
      } else {
        await conn.query('DELETE FROM portfolios WHERE `user_id` = ? AND `sym` = ?', [uid, sym.toUpperCase()]);
      }
      const newSupply = Math.min(0.95, stock.supply + 0.03);
      await conn.query(
        'UPDATE companies SET `supply` = ?, `sells` = `sells` + ?, `volume` = `volume` + ? WHERE `sym` = ?',
        [newSupply, quantity, quantity, sym.toUpperCase()]
      );
    } else {
      return res.status(400).json({ error: 'Tipo de ordem inválido.' });
    }

    // Record fee in transaction table (inside same transaction)
    const tx = {
      uid, uname: user.nick || user.name,
      type, sym, qty: quantity,
      price: stock.price, total,
      fee:   type === 'buy' ? buyFee : sellFee,
      fee_type: type === 'buy' ? 'buy_fee' : 'sell_fee',
      time: new Date().toLocaleTimeString('pt-BR'),
      ts:   Date.now()
    };

    await conn.query(
      `INSERT INTO transactions (\`uid\`, \`uname\`, \`type\`, \`sym\`, \`qty\`, \`price\`, \`total\`, \`fee\`, \`fee_type\`, \`time\`, \`ts\`)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [tx.uid, tx.uname, tx.type, tx.sym, tx.qty, tx.price, tx.total, tx.fee, tx.fee_type, tx.time, tx.ts]
    );

    // ── Owner revenue share (separate from trade transaction since it touches different users) ──
    await conn.commit();
    conn.release();
    conn = null;

    const freshStock = await getStockWithOwners(sym.toUpperCase());
    if (freshStock && Array.isArray(freshStock.owners) && freshStock.owners.length > 0) {
      let totalPaid = 0;
      for (const owner of freshStock.owners) {
        const fee = Math.round(total * (owner.pct / 100) * 100) / 100;
        if (fee < 0.01) continue;
        const ownerUser = await usersStore.getUserById(owner.userId);
        if (!ownerUser) continue;
        await usersStore.adjustUserBalance(owner.userId, fee);
        totalPaid += fee;
        await pool.query(
          `INSERT INTO dividends (\`sym\`, \`stock_name\`, \`owner_id\`, \`owner_name\`, \`trader_name\`, \`type\`, \`trade_total\`, \`pct\`, \`fee\`, \`time\`, \`ts\`)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [freshStock.sym, freshStock.name, owner.userId, owner.name || '', user.nick || user.name, type, total, owner.pct, fee, tx.time, tx.ts]
        );
      }
      if (totalPaid > 0) {
        await pool.query(
          'UPDATE companies SET `total_revenue` = `total_revenue` + ? WHERE `sym` = ?',
          [totalPaid, freshStock.sym]
        );
      }
    }

    await logAdmin(`${user.nick || user.name} ${type === 'buy' ? 'COMPROU' : 'VENDEU'} ${quantity}× ${sym.toUpperCase()} @ R$${stock.price.toFixed(2)} | Taxa: R$${(type === 'buy' ? buyFee : sellFee).toFixed(2)}`);

    const updatedUser = await usersStore.getUserById(uid);
    res.json({
      ok: true,
      tx,
      fee:   type === 'buy' ? buyFee : sellFee,
      feeType: type === 'buy' ? 'buy_fee' : 'sell_fee',
      user:  usersStore.safeUser(updatedUser),
      portfolio: await getPortfolio(uid)
    });
  } catch(e) {
    if (conn) { try { await conn.rollback(); } catch(_) {} }
    res.status(500).json({ error: e.message });
  } finally {
    if (conn) conn.release();
  }
});

// GET /api/market/ranking
router.get('/ranking', async (req, res) => {
  try {
    const [stocks] = await pool.query('SELECT * FROM companies');
    const users  = await usersStore.getAllUsers();

    // Load all portfolios from MySQL in one query
    const [pfRows] = await pool.query('SELECT user_id, sym, qty FROM portfolios WHERE qty > 0');
    const pfMap = {};
    pfRows.forEach(r => {
      if (!pfMap[r.user_id]) pfMap[r.user_id] = {};
      pfMap[r.user_id][r.sym] = r.qty;
    });

    // Build stock lookup by sym for MV computation
    const stockMap = {};
    stocks.forEach(s => { stockMap[s.sym] = s; });

    const investors = users
      .map(u => {
        const pf = pfMap[u.id] || {};
        let mv = 0;
        let orphanMv = 0;
        const orphans = [];
        Object.entries(pf).forEach(([sym, qty]) => {
          const s = stockMap[sym];
          if (s) {
            mv += s.price * qty;
          } else {
            // ORPHAN: portfolio holds a stock that no longer exists in companies
            orphanMv += qty;
            orphans.push({ sym, qty });
          }
        });
        const total = Math.round((u.balance + mv) * 100) / 100;
        return {
          id: u.id, name: u.nick || u.name,
          avatar: u.avatar, photo: hasAnyPhoto(u) ? photoUrlForUser(u) : null,
          role: normalizeRole(u.role), country: u.country,
          total, cash: u.balance, stocks: mv,
          orphanMv, orphans: orphans.length > 0 ? orphans : undefined,
          wealthTier: computeTier(total),
          hasDonated: !!u.has_donated,
        };
      }).sort((a, b) => b.total - a.total);

    const supplyDemand = [...stocks].sort((a, b) =>
      (b.demand / (b.demand + b.supply)) - (a.demand / (a.demand + a.supply)));
    const topTraded = [...stocks].sort((a, b) => b.volume - a.volume);

    // Intraday movers — use day_open (current-day opening) as the reference.
    const dayPct = (s) => {
      const ref = s.day_open != null ? s.day_open : s.open;
      return ref > 0 ? (s.price - ref) / ref * 100 : 0;
    };
    const enrichedDay = stocks
      .filter(s => s.status === 'active')
      .map(s => ({ ...s, dayPct: dayPct(s) }));
    const topGainersDay = [...enrichedDay].sort((a, b) => b.dayPct - a.dayPct).slice(0, 5);
    const topLosersDay  = [...enrichedDay].sort((a, b) => a.dayPct - b.dayPct).slice(0, 5);

    res.json({
      investors,
      supplyDemand: supplyDemand.slice(0, 8),
      topTraded:    topTraded.slice(0, 8),
      topGainersDay,
      topLosersDay
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── P2P OWNERSHIP MARKETPLACE (MySQL-backed) ─────────────────────

// GET /api/market/ownership-offers
router.get('/ownership-offers', async (req, res) => {
  try {
    const [offers] = await pool.query(
      'SELECT * FROM ownership_offers WHERE `status` = "open"'
    );
    if (!offers.length) return res.json([]);

    const sellerIds = [...new Set(offers.map(o => o.seller_id).filter(Boolean))];
    const sellers = new Map();
    if (sellerIds.length) {
      const placeholders = sellerIds.map(() => '?').join(',');
      const [rows] = await pool.query(
        `SELECT id, nick, name FROM users WHERE id IN (${placeholders})`,
        sellerIds
      );
      rows.forEach(u => sellers.set(u.id, u));
    }

    // Also load company names from MySQL
    const symList = [...new Set(offers.map(o => o.sym).filter(Boolean))];
    const stockMap = {};
    if (symList.length) {
      const placeholders = symList.map(() => '?').join(',');
      const [rows] = await pool.query(
        `SELECT sym, name FROM companies WHERE sym IN (${placeholders})`,
        symList
      );
      rows.forEach(s => stockMap[s.sym] = s.name);
    }

    const enriched = offers.map(o => ({
      ...o,
      stockName:  o.stock_name || stockMap[o.sym] || o.sym,
      sellerName: (sellers.get(o.seller_id) || {}).nick || (sellers.get(o.seller_id) || {}).name || '?',
    }));
    res.json(enriched);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/market/ownership-offers
router.post('/ownership-offers', requireAuth, async (req, res) => {
  try {
    const { sym, pctToSell, askPrice } = req.body;
    if (!sym || !pctToSell || !askPrice)
      return res.status(400).json({ error: 'sym, pctToSell e askPrice são obrigatórios.' });
    const uid   = req.session.userId;
    const stock = await getStock(sym.toUpperCase());
    if (!stock) return res.status(404).json({ error: 'Ativo não encontrado.' });

    // Check ownership from company_owners table
    const [ownerRows] = await pool.query('SELECT * FROM company_owners WHERE `sym` = ? AND `user_id` = ?', [sym.toUpperCase(), uid]);
    let ownedPct = 0;
    ownerRows.forEach(o => { ownedPct += o.pct; });
    if (ownedPct <= 0) return res.status(403).json({ error: 'Você não tem participação nessa empresa.' });

    const pct = parseFloat(pctToSell);
    if (pct > ownedPct) return res.status(400).json({ error: `Você só pode vender até ${ownedPct.toFixed(3)}%.` });
    if (pct <= 0) return res.status(400).json({ error: 'Porcentagem inválida.' });

    const id = 'offer_' + Date.now();
    const now = Date.now();
    await pool.query(
      'INSERT INTO ownership_offers (`id`, `sym`, `stock_name`, `seller_id`, `pct`, `ask_price`, `status`, `created_at`, `time`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, sym.toUpperCase(), stock.name, uid, pct, parseFloat(askPrice), 'open', now, new Date().toLocaleTimeString('pt-BR')]
    );

    const user = await usersStore.getUserById(uid);
    await logAdmin(`${user.nick||user.name} listou ${pct.toFixed(3)}% de ${sym.toUpperCase()} por R$${parseFloat(askPrice).toFixed(2)}`);
    res.json({ ok: true, offer: { id, sym: sym.toUpperCase(), pct, askPrice: parseFloat(askPrice) } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/market/ownership-offers/:id/buy
router.post('/ownership-offers/:id/buy', requireAuth, async (req, res) => {
  try {
    const uid      = req.session.userId;
    const [offerRows] = await pool.query(
      'SELECT * FROM ownership_offers WHERE `id` = ? AND `status` = "open"',
      [req.params.id]
    );
    if (offerRows.length === 0) return res.status(404).json({ error: 'Oferta não encontrada ou já encerrada.' });
    const offer = offerRows[0];

    if (offer.seller_id === uid) return res.status(400).json({ error: 'Você não pode comprar sua própria oferta.' });

    const buyer  = await usersStore.getUserById(uid);
    const seller = await usersStore.getUserById(offer.seller_id);
    const stock  = await getStock(offer.sym);
    if (!buyer || !seller || !stock) return res.status(404).json({ error: 'Usuário ou ativo não encontrado.' });
    if (buyer.balance < offer.ask_price) return res.status(400).json({ error: 'Saldo insuficiente.' });

    // Process payment
    await pool.query('UPDATE users SET `balance` = `balance` - ? WHERE `id` = ?', [offer.ask_price, uid]);
    await pool.query('UPDATE users SET `balance` = `balance` + ? WHERE `id` = ?', [offer.ask_price, offer.seller_id]);

    // Transfer ownership
    const sym = offer.sym.toUpperCase();
    let owners = await getStockWithOwners(sym).then(s => s.owners);

    // Decrease seller's pct
    const si = owners.findIndex(o => o.userId === offer.seller_id);
    if (si >= 0) {
      owners[si].pct -= offer.pct;
      if (owners[si].pct <= 0) owners.splice(si, 1);
    }

    // Increase buyer's pct
    const bi = owners.findIndex(o => o.userId === uid);
    if (bi >= 0) {
      owners[bi].pct += offer.pct;
    } else {
      owners.push({ userId: uid, name: buyer.nick || buyer.name, pct: offer.pct });
    }

    // Replace company_owners rows
    await pool.query('DELETE FROM company_owners WHERE `sym` = ?', [sym]);
    const now = Date.now();
    for (const o of owners) {
      await pool.query('INSERT INTO company_owners (`sym`, `user_id`, `pct`, `created_at`) VALUES (?, ?, ?, ?)', [sym, o.userId, o.pct, now]);
    }

    // Close offer
    await pool.query(
      'UPDATE ownership_offers SET `status` = "sold", `buyer_id` = ?, `buyer_name` = ?, `sold_at` = ? WHERE `id` = ?',
      [uid, buyer.nick || buyer.name, Date.now(), req.params.id]
    );

    await logAdmin(`${buyer.nick||buyer.name} comprou ${offer.pct.toFixed(3)}% de ${offer.sym} de ${seller.nick||seller.name} por R$${offer.ask_price.toFixed(2)}`);
    res.json({ ok: true, user: usersStore.safeUser(buyer) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/market/ownership-offers/:id
router.delete('/ownership-offers/:id', requireAuth, async (req, res) => {
  const uid    = req.session.userId;
  const [result] = await pool.query(
    'UPDATE ownership_offers SET `status` = "cancelled" WHERE `id` = ? AND `seller_id` = ? AND `status` = "open"',
    [req.params.id, uid]
  );
  if (result.affectedRows === 0) return res.status(404).json({ error: 'Oferta não encontrada.' });
  res.json({ ok: true });
});

module.exports = router;
