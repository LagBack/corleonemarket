const router     = require('express').Router();
const pool       = require('../data/mysql');
const usersStore = require('../data/users-store');
const { requireMod, requireAdmin } = require('../middleware/auth');

// ── helpers ───────────────────────────────────────────────────────

/**
 * Calculate cost basis for a user's holdings in a symbol using FIFO purchase history.
 */
async function calcCostBasis(userId, sym) {
  const [buys] = await pool.query(
    'SELECT qty, total FROM transactions WHERE uid = ? AND type = "buy" AND sym = ? ORDER BY ts ASC',
    [userId, sym.toUpperCase()]
  );
  if (buys.length === 0) return 0;

  const [portfolio] = await pool.query(
    'SELECT qty FROM portfolios WHERE user_id = ? AND sym = ? AND qty > 0 LIMIT 1',
    [userId, sym.toUpperCase()]
  );
  const remainingQty = portfolio.length > 0 ? portfolio[0].qty : 0;
  if (remainingQty <= 0) return 0;

  // FIFO: account for any sells against earliest buys
  const [sells] = await pool.query(
    'SELECT qty FROM transactions WHERE uid = ? AND type = "sell" AND sym = ? ORDER BY ts ASC',
    [userId, sym.toUpperCase()]
  );
  let sellAccum = sells.reduce((s, x) => s + x.qty, 0);

  // Simple proportional refund: totalPaid/totalBought * remainingQty
  const totalBought = buys.reduce((s, b) => s + b.qty, 0);
  const totalPaid = buys.reduce((s, b) => s + b.total, 0);
  if (totalBought === 0) return 0;

  const pricePerShare = totalPaid / totalBought;
  return Math.round(pricePerShare * remainingQty * 100) / 100;
}

/**
 * Process refund for all users holding a company about to be deleted.
 * Returns array of {userId, amount, sym, qty, userName} records.
 */
async function processCompanyDeletionRefund(sym) {
  const upperSym = sym.toUpperCase();
  
  // Find all users holding this symbol
  const [holders] = await pool.query(
    'SELECT p.user_id, p.qty, u.nick, u.name FROM portfolios p JOIN users u ON u.id = p.user_id WHERE p.sym = ? AND p.qty > 0',
    [upperSym]
  );

  if (holders.length === 0) return [];

  const refunds = [];
  for (const h of holders) {
    const refundAmount = await calcCostBasis(h.user_id, upperSym);
    if (refundAmount > 0.01) {
      // Refund to user balance
      await pool.query(
        'UPDATE users SET `balance` = `balance` + ? WHERE `id` = ?',
        [refundAmount, h.user_id]
      );
      refunds.push({ userId: h.user_id, amount: refundAmount, sym: upperSym, qty: h.qty, userName: h.nick || h.name });

      // Remove orphaned portfolio entry
      await pool.query(
        'DELETE FROM portfolios WHERE `user_id` = ? AND `sym` = ?',
        [h.user_id, upperSym]
      );

      // Log the action
      await logAdmin(`ORPHAN CLEANUP: Refunded R$${refundAmount.toFixed(2)} to ${h.nick || h.name} for ${upperSym} (${h.qty} shares) — auto-refund on company deletion`);
    }
  }

  return refunds;
}

async function getStock(sym) {
  const [rows] = await pool.query('SELECT * FROM companies WHERE `sym` = ?', [sym.toUpperCase()]);
  return rows[0] || null;
}

async function getOwners(sym) {
  const [rows] = await pool.query(
    'SELECT co.user_id, c.nick, c.name, co.pct FROM company_owners co JOIN users c ON c.id = co.user_id WHERE co.sym = ?',
    [sym.toUpperCase()]
  );
  return rows.map(r => ({ userId: r.user_id, name: r.nick || r.name, pct: r.pct }));
}

async function validateOwners(owners) {
  if (!Array.isArray(owners) || owners.length === 0) return [];
  const allUsers = await usersStore.getAllUsers();
  let totalPct = 0;
  const seen = new Set();
  const validatedOwners = [];
  for (const o of owners) {
    if (!o.userId || !o.pct) continue;
    if (seen.has(o.userId)) throw new Error(`Usuário duplicado: ${o.userId}`);
    const u = allUsers.find(x => x.id === o.userId);
    if (!u) throw new Error(`Usuário não encontrado: ${o.userId}`);
    const pct = parseFloat(o.pct);
    if (isNaN(pct) || pct <= 0 || pct > 10)
      throw new Error(`Porcentagem inválida para ${u.nick || u.name}. Máx 10%.`);
    totalPct += pct;
    seen.add(o.userId);
    validatedOwners.push({ userId: o.userId, name: u.nick || u.name, pct });
  }
  if (totalPct > 10)
    throw new Error(`Total de porcentagens (${totalPct.toFixed(3)}%) excede o limite de 10%.`);
  return validatedOwners;
}

async function logAdmin(msg) {
  await pool.query(
    'INSERT INTO admin_events (`t`, `msg`, `ts`) VALUES (?, ?, ?)',
    [new Date().toLocaleTimeString('pt-BR'), msg, Date.now()]
  );
}

// ── Routes ───────────────────────────────────────────────────────

// GET /api/stocks
router.get('/', async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM companies');
    // Attach owners to each stock (same shape as lowdb used to return)
    const stocksWithOwners = [];
    for (const s of rows) {
      const owners = await getOwners(s.sym);
      stocksWithOwners.push({ ...s, priceHistory: typeof s.price_history === 'string' ? JSON.parse(s.price_history) : (s.price_history || []), owners });
    }
    res.json(stocksWithOwners);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/stocks — create with optional multi-owner config
router.post('/', requireMod, async (req, res) => {
  const { sym, name, sector, desc, price, shares, vol, status, owners } = req.body;
  if (!sym || !name || !price || !shares)
    return res.status(400).json({ error: 'Campos obrigatórios: sym, name, price, shares.' });

  const clean = sym.trim().toUpperCase();
  if (!/^[A-Z]{3,5}\d{1,2}$/.test(clean))
    return res.status(400).json({ error: 'Código inválido. Use formato XPTO3.' });

  try {
    const existing = await getStock(clean);
    if (existing) return res.status(409).json({ error: 'Código já existe.' });

    const validatedOwners = owners ? await validateOwners(owners) : [];

    const p  = parseFloat(price);
    const now = Date.now();

    // Single-line INSERT with all values as parameters (no inline defaults mixed with ? placeholders)
    await pool.query(
      'INSERT INTO companies (`sym`,`name`,`sector`,`desc`,`price`,`open`,`shares`,`vol`,`status`,`demand`,`supply`,`volume`,`buys`,`sells`,`day_open`,`day_high`,`day_low`,`day_reset_at`,`total_revenue`,`price_history`,`created`,`updated`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [clean, name, sector || 'Outros', desc || '', p, p, parseInt(shares), parseFloat(vol) || 0.015, status || 'active', 0.5, 0.5, 0, 0, 0, p, p, p, now, 0, null, now, now]
    );

    // Save owners
    if (validatedOwners.length > 0) {
      for (const o of validatedOwners) {
        await pool.query('INSERT INTO company_owners (`sym`,`user_id`,`pct`,`created_at`) VALUES (?,?,?,?)', [clean, o.userId, o.pct, now]);
      }
    }

    // Log admin event
    await logAdmin(`Ativo ${clean} criado por ${req.session.userId}`);
    res.json({ ok: true, stock: { sym: clean } });
  } catch(e) {
    if (e.message.includes('Duplicate entry')) return res.status(409).json({ error: 'Código já existe.' });
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/stocks/:sym — edit
router.put('/:sym', requireMod, async (req, res) => {
  const sym = req.params.sym.toUpperCase();
  const s = await getStock(sym);
  if (!s) return res.status(404).json({ error: 'Ativo não encontrado.' });

  const { name, sector, desc, vol, status, pricePct, owners } = req.body;
  const updates = {};
  if (name)          updates.name   = name;
  if (sector !== undefined) updates.sector = sector;
  if (desc !== undefined)      updates.desc     = desc;
  if (vol !== undefined)       updates.vol        = parseFloat(vol);
  if (status)         updates.status = status;
  if (pricePct && !isNaN(parseFloat(pricePct)))
    updates.price = Math.max(0.01, Math.round(s.price * (1 + parseFloat(pricePct) / 100) * 100) / 100);

  try {
    const setClauses = [];
    const values = [];
    for (const [k, v] of Object.entries(updates)) {
      setClauses.push("\`" + k.replace(/`/g, '') + "\` = ?");
      values.push(v);
    }
    values.push(Date.now()); // updated
    values.push(sym);
    await pool.query(`UPDATE companies SET ${setClauses.join(', ')} WHERE \`sym\` = ?`, values);

    if (owners !== undefined) {
      const validated = await validateOwners(owners);
      // Replace all owners
      await pool.query('DELETE FROM company_owners WHERE `sym` = ?', [sym]);
      const now = Date.now();
      for (const o of validated) {
        await pool.query('INSERT INTO company_owners (`sym`, `user_id`, `pct`, `created_at`) VALUES (?, ?, ?, ?)', [sym, o.userId, o.pct, now]);
      }
    }

    const ownerNote = owners !== undefined
      ? ` | Donos: ${(await getOwners(sym)).map(o => `${o.name}(${o.pct}%)`).join(', ')}`
      : '';
    await logAdmin(`Ativo ${sym} editado por ${req.session.userId}${ownerNote}`);

    const updated = await getStock(sym);
    res.json({ ok: true, stock: updated });
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});

// DELETE /api/stocks/:sym — admin only (soft delete: marks as 'deleted', refunds holders, cleans up)
router.delete('/:sym', requireAdmin, async (req, res) => {
  const sym = req.params.sym.toUpperCase();
  
  // Check if anyone holds this stock
  const [holders] = await pool.query(
    'SELECT COUNT(*) as cnt FROM portfolios WHERE sym = ? AND qty > 0',
    [sym]
  );

  let refundInfo = null;
  if (holders[0].cnt > 0) {
    // Process auto-refunds before deleting
    refundInfo = await processCompanyDeletionRefund(sym);
    
    // Log admin event with refund details
    const totalRefunded = refundInfo.reduce((s, r) => s + r.amount, 0);
    await logAdmin(
      `Ativo ${sym} DESATIVADO com auto-refundo — R$${totalRefunded.toFixed(2)} refunded to ${refundInfo.length} user(s)`
    );
  }

  // Soft-delete: set status to 'deleted' so portfolio holdings remain valid
  // Also clean up company_owners but keep the row in companies table
  await pool.query("UPDATE companies SET `status`='deleted', `demand`=0, `supply`=0 WHERE `sym` = ?", [sym]);
  await pool.query('DELETE FROM company_owners WHERE `sym` = ?', [sym]);

  res.json({ ok: true, refundInfo });
});

// ── Ownership marketplace (P2P revenue-share stake listings) ──────

// GET /api/stocks/:sym/ownership-listings
router.get('/:sym/ownership-listings', async (req, res) => {
  try {
    const sym = req.params.sym.toUpperCase();
    const [rows] = await pool.query(
      'SELECT * FROM ownership_listings WHERE `sym` = ? AND `status` = "open"',
      [sym]
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/stocks/ownership-listings/my — my open listings
router.get('/ownership-listings/my', requireMod, (req, res) => {
  const uid = req.session.userId;
  // Ownership listings are per-seller; ownership_offers also uses seller_id
  res.json([]); // delegated to ownership-offers route for sellers
});

// POST /api/stocks/:sym/ownership-listings — list a revenue-share stake for sale
router.post('/:sym/ownership-listings', requireMod, async (req, res) => {
  const sym = req.params.sym.toUpperCase();
  const uid = req.session.userId;
  const stock = await getStock(sym);
  if (!stock) return res.status(404).json({ error: 'Ativo não encontrado.' });

  // Get owners from MySQL
  const [rows] = await pool.query('SELECT * FROM company_owners WHERE `sym` = ?', [sym]);
  const owner = rows.find(o => o.user_id === uid);
  if (!owner) return res.status(403).json({ error: 'Você não é dono desta empresa.' });

  const pctToSell = parseFloat(req.body.pctToSell);
  const askPrice  = parseFloat(req.body.askPrice);

  if (isNaN(pctToSell) || pctToSell <= 0 || pctToSell > owner.pct)
    return res.status(400).json({ error: `Você só possui ${owner.pct}% desta empresa.` });
  if (isNaN(askPrice) || askPrice <= 0)
    return res.status(400).json({ error: 'Preço de venda inválido.' });

  // Check not already listing more than they own
  const [alreadyRows] = await pool.query(
    'SELECT COALESCE(SUM(`pct_to_sell`), 0) as total FROM ownership_listings WHERE `sym` = ? AND `seller_id` = ? AND `status` = "open"',
    [sym, uid]
  );
  if (alreadyRows.total + pctToSell > owner.pct)
    return res.status(400).json({ error: `Você já tem ${alreadyRows.total.toFixed(3)}% listado. Não pode listar mais que ${owner.pct}%.` });

  const id = `ol_${Date.now()}`;
  const now = Date.now();
  await pool.query(
    'INSERT INTO ownership_listings (`id`, `sym`, `stock_name`, `seller_id`, `seller_name`, `pct_to_sell`, `ask_price`, `status`, `created_at`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, sym, stock.name, uid, owner.name || '', pctToSell, askPrice, 'open', now]
  );

  await logAdmin(`${owner.name || ''} listou ${pctToSell}% de ${sym} por R$${askPrice}`);
  res.json({ ok: true, listing: { id, sym, pctToSell, askPrice } });
});

// POST /api/stocks/:sym/ownership-listings/:listingId/buy — buy a listed stake (any player)
router.post('/:sym/ownership-listings/:listingId/buy', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Não autenticado.' });

  try {
    const buyerId = req.session.userId;
    const buyer   = await usersStore.getUserById(buyerId);
    if (!buyer) return res.status(404).json({ error: 'Usuário não encontrado.' });

    const listingId = req.params.listingId;
    const [listingRows] = await pool.query(
      'SELECT * FROM ownership_listings WHERE `id` = ? AND `status` = "open"',
      [listingId]
    );
    if (listingRows.length === 0) return res.status(404).json({ error: 'Listagem não encontrada ou já fechada.' });
    const listing = listingRows[0];

    if (listing.seller_id === buyerId) return res.status(400).json({ error: 'Você não pode comprar sua própria listagem.' });
    if (buyer.balance < listing.ask_price) return res.status(400).json({ error: 'Saldo insuficiente.' });

    const [sellerRows] = await pool.query('SELECT id, nick, name, balance FROM users WHERE id = ?', [listing.seller_id]);
    const seller = sellerRows[0];
    if (!seller) return res.status(404).json({ error: 'Vendedor não encontrado.' });

    // Process payment
    await pool.query('UPDATE users SET `balance` = `balance` - ? WHERE `id` = ?', [listing.ask_price, buyerId]);
    await pool.query('UPDATE users SET `balance` = `balance` + ? WHERE `id` = ?', [listing.ask_price, listing.seller_id]);

    // Transfer ownership in the stock
    const sym = listing.sym.toUpperCase();
    let owners = await getOwners(sym);

    // Remove pctToSell from seller
    const sellerOwnerIdx = owners.findIndex(o => o.userId === listing.seller_id);
    if (sellerOwnerIdx >= 0) {
      owners[sellerOwnerIdx].pct = Math.round((owners[sellerOwnerIdx].pct - listing.pct_to_sell) * 10000) / 10000;
      if (owners[sellerOwnerIdx].pct <= 0) owners.splice(sellerOwnerIdx, 1);
    }

    // Add pct to buyer
    const buyerOwnerIdx = owners.findIndex(o => o.userId === buyerId);
    if (buyerOwnerIdx >= 0) {
      owners[buyerOwnerIdx].pct = Math.round((owners[buyerOwnerIdx].pct + listing.pct_to_sell) * 10000) / 10000;
    } else {
      owners.push({ userId: buyerId, name: buyer.nick || buyer.name, pct: listing.pct_to_sell });
    }

    // Replace all company_owners rows
    await pool.query('DELETE FROM company_owners WHERE `sym` = ?', [sym]);
    const now = Date.now();
    for (const o of owners) {
      await pool.query('INSERT INTO company_owners (`sym`, `user_id`, `pct`, `created_at`) VALUES (?, ?, ?, ?)', [sym, o.userId, o.pct, now]);
    }

    // Close listing
    await pool.query(
      'UPDATE ownership_listings SET `status` = "sold", `buyer_id` = ?, `buyer_name` = ?, `sold_at` = ? WHERE `id` = ?',
      [buyerId, buyer.nick || buyer.name, Date.now(), listingId]
    );

    await logAdmin(`${buyer.nick||buyer.name} comprou ${listing.pct_to_sell}% de ${sym} de ${listing.seller_name} por R$${listing.ask_price}`);
    res.json({ ok: true, user: usersStore.safeUser(buyer) });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/stocks/:sym/ownership-listings/:listingId — cancel a listing
router.delete('/:sym/ownership-listings/:listingId', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Não autenticado.' });
  const uid = req.session.userId;
  pool.query(
    'UPDATE ownership_listings SET `status` = "cancelled" WHERE `id` = ? AND `seller_id` = ? AND `status` = "open"',
    [req.params.listingId, uid]
  ).then(() => res.json({ ok: true }))
   .catch(e => res.status(404).json({ error: 'Listagem não encontrada.' }));
});

module.exports = router;
