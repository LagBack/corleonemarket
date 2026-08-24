const router = require('express').Router();
const fs     = require('fs');
const path   = require('path');
const multer = require('multer');
const db     = require('../data/db');       // kept only for backup/import endpoints
const pool   = require('../data/mysql');
const { requireAdmin, requireMod, requireDev } = require('../middleware/auth');
const { toPublicUser } = require('../data/user-serialize');
const { normalizeRole } = require('../data/roles');
const { computeTier }    = require('../data/tiers');
const simulator = require('../data/simulator');

const uploadMem = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const LOWDB_KEYS = [
  'stocks', 'portfolios', 'transactions', 'dividends',
  'ownershipListings', 'ownershipOffers', 'market', 'adminLog'
];

function validateLowdbBackup(parsed) {
  if (!parsed || typeof parsed !== 'object') return 'JSON inválido.';
  if (!Array.isArray(parsed.stocks)) return 'Backup inválido: falta "stocks".';
  if (!parsed.portfolios || typeof parsed.portfolios !== 'object') return 'Backup inválido: falta "portfolios".';
  return null;
}

function applyLowdbBackup(parsed) {
  const current = db.getState();
  const next = { ...current };
  for (const key of LOWDB_KEYS) {
    if (key in parsed) next[key] = parsed[key];
  }
  if (!next.market || typeof next.market.open !== 'boolean') {
    next.market = { open: true };
  }
  db.setState(next).write();
}

function restoreLowdbFromFile(buffer) {
  const parsed = JSON.parse(buffer.toString('utf8'));
  const err = validateLowdbBackup(parsed);
  if (err) throw new Error(err);
  applyLowdbBackup(parsed);
  return parsed;
}

// ── helpers ───────────────────────────────────────────────────────

async function logAdmin(msg) {
  pool.query('INSERT INTO admin_events (`t`, `msg`, `ts`) VALUES (?, ?, ?)',
    [new Date().toLocaleTimeString('pt-BR'), msg, Date.now()]
  ).catch(() => {});
}

// GET /api/admin/log
router.get('/log', requireMod, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM admin_events ORDER BY id DESC LIMIT 100');
    res.json(rows.reverse());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/users
router.get('/users', requireMod, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM users');
    const [stockRows] = await pool.query('SELECT `sym`, `price` FROM companies WHERE `status` = "active"');
    const stockMap = {};
    stockRows.forEach(s => stockMap[s.sym] = s.price);

    const [pfRows] = await pool.query('SELECT user_id, sym, qty FROM portfolios WHERE qty > 0');
    const pfMap = {};
    pfRows.forEach(r => {
      if (!pfMap[r.user_id]) pfMap[r.user_id] = {};
      pfMap[r.user_id][r.sym] = r.qty;
    });

    res.json(rows.map(u => {
      let mv = 0;
      let orphanMv = 0;
      const orphans = [];
      Object.entries(pfMap[u.id] || {}).forEach(([sym, qty]) => {
        if (stockMap[sym]) {
          mv += stockMap[sym] * qty;
        } else {
          orphanMv += qty;
          orphans.push({ sym, qty });
        }
      });
      return { ...toPublicUser(u), wealthTier: computeTier(u.balance + mv), orphanMv, orphans: orphans.length > 0 ? orphans : undefined };
    }));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/market/open
router.post('/market/open', requireMod, async (req, res) => {
  try {
    const reset = simulator.resetDayCounters();
    await pool.query('UPDATE market_state SET `open`=1, `updated`=? WHERE `id`=1', [Date.now()]);
    simulator.start();
    if (reset) {
      await logAdmin('🔄 Máx/Mín/Abertura do dia resetados ao abrir o pregão');
    }
    await logAdmin(`Mercado ABERTO por ${req.session.userId}`);
    res.json({ ok: true, open: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/market/close
router.post('/market/close', requireMod, async (req, res) => {
  try {
    await pool.query('UPDATE market_state SET `open`=0, `updated`=? WHERE `id`=1', [Date.now()]);
    await logAdmin(`Mercado FECHADO por ${req.session.userId}`);
    res.json({ ok: true, open: false });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/market/crash
router.post('/market/crash', requireMod, async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT `sym`, `price`, `open`, `supply`, `demand` FROM companies WHERE `status` = 'active'");
    for (const s of rows) {
      const newPrice = Math.max(s.open * 0.10, Math.round(s.price * (0.91 + Math.random() * 0.05) * 100) / 100);
      await pool.query(
        "UPDATE companies SET `price`=?, `supply`=LEAST(0.9, `supply`+0.2), `demand`=GREATEST(0.1, `demand`-0.2) WHERE `sym`=?",
        [newPrice, s.sym]
      );
    }
    await logAdmin(`CRASH simulado por ${req.session.userId}`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/market/bull
router.post('/market/bull', requireMod, async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT `sym`, `price`, `demand`, `supply` FROM companies WHERE `status` = 'active'");
    for (const s of rows) {
      const newPrice = Math.round(s.price * (1.02 + Math.random() * 0.04) * 100) / 100;
      await pool.query(
        "UPDATE companies SET `price`=?, `demand`=LEAST(0.9, `demand`+0.2), `supply`=GREATEST(0.1, `supply`-0.2) WHERE `sym`=?",
        [newPrice, s.sym]
      );
    }
    await logAdmin(`ALTA geral simulada por ${req.session.userId}`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/market/reset — admin only
router.post('/market/reset', requireAdmin, async (req, res) => {
  try {
    // FIX: preserve original open price as reset price instead of Date.now()
    const [rows] = await pool.query("SELECT `sym`, `open` FROM companies WHERE `status`='active'");
    for (const s of rows) {
      await pool.query(
        "UPDATE companies SET `price`=?, `demand`=0.5, `supply`=0.5, `volume`=0, `buys`=0, `sells`=0, `updated`=? WHERE `sym`=?",
        [s.open, Date.now(), s.sym]
      );
    }
    await logAdmin(`Mercado RESETADO por ${req.session.userId}`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/admin/users/:id/role — admin only
router.put('/users/:id/role', requireAdmin, async (req, res) => {
  const role = normalizeRole(req.body.role);
  if (!['user', 'moderator', 'admin', 'dev'].includes(role)) {
    return res.status(400).json({ error: 'Papel inválido.' });
  }
  try {
    const [rows] = await pool.query('SELECT id, nick, name, role FROM users WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Usuário não encontrado.' });
    const target = rows[0];
    const currentRole = normalizeRole(target.role);
    if (currentRole === 'dev' && role !== 'dev') {
      return res.status(403).json({ error: 'O papel Dev não pode ser removido.' });
    }
    await pool.query('UPDATE users SET `role` = ? WHERE `id` = ?', [role, req.params.id]);
    if (String(req.params.id) === String(req.session.userId)) {
      req.session.role = role;
      req.session.roleSyncedAt = Date.now();
    }
    await logAdmin(`Papel de ${target.nick || target.name} alterado para ${role} por ${req.session.userId}`);
    res.json({ ok: true, role });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/admin/users/:id/balance — admin/mod
router.put('/users/:id/balance', requireMod, async (req, res) => {
  const { balance, mode } = req.body;
  const amt = parseFloat(balance);
  if (isNaN(amt)) return res.status(400).json({ error: 'Valor inválido.' });
  try {
    const [rows] = await pool.query('SELECT id, nick, name, balance FROM users WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Usuário não encontrado.' });
    const target = rows[0];
    const currentBal = parseFloat(target.balance) || 0;
    let newBalance;
    if (mode === 'add')           newBalance = Math.round((currentBal + amt) * 100) / 100;
    else if (mode === 'subtract') newBalance = Math.max(0, Math.round((currentBal - amt) * 100) / 100);
    else                          newBalance = Math.max(0, Math.round(amt * 100) / 100);
    await pool.query('UPDATE users SET `balance` = ? WHERE `id` = ?', [newBalance, req.params.id]);

    // Recompute wealth_tier from balance + portfolio market value
    const [stockRows] = await pool.query('SELECT `sym`, `price` FROM companies WHERE `status` = "active"');
    const stockMap = {};
    stockRows.forEach(s => stockMap[s.sym] = s.price);

    const [pfRows] = await pool.query('SELECT sym, qty FROM portfolios WHERE user_id = ? AND qty > 0', [req.params.id]);
    let mv = 0;
    let orphanMv = 0;
    const orphans = [];
    for (const r of pfRows) {
      if (stockMap[r.sym]) {
        mv += stockMap[r.sym] * r.qty;
      } else {
        orphanMv += r.qty;
        orphans.push({ sym: r.sym, qty: r.qty });
      }
    }
    const totalWealth = newBalance + mv;
    const newTier = computeTier(totalWealth);
    await pool.query('UPDATE users SET `wealth_tier` = ? WHERE `id` = ?', [newTier, req.params.id]);

    await logAdmin(`Saldo de ${target.nick || target.name} alterado para R$${newBalance.toFixed(2)} por ${req.session.userId}`);
    res.json({ ok: true, balance: newBalance, wealthTier: newTier, orphanMv, orphans: orphans.length > 0 ? orphans : undefined });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/admin/users/:id — admin only
router.delete('/users/:id', requireAdmin, async (req, res) => {
  if (req.params.id === req.session.userId) return res.status(400).json({ error: 'Não pode deletar a si mesmo.' });
  try {
    const [rows] = await pool.query('SELECT id, email, role FROM users WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Usuário não encontrado.' });
    const target = rows[0];
    if (target.role === 'dev') return res.status(403).json({ error: 'Usuários Dev não podem ser deletados.' });
    await pool.query('DELETE FROM users WHERE `id` = ?', [req.params.id]);
    await logAdmin(`Usuário ${target.email} DELETADO por ${req.session.userId}`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Orphaned Company Cleanup (admin) ─────────────────────────────

/** Calculate cost basis using FIFO purchase history */
async function calcOrphanRefund(userId, sym) {
  const [buys] = await pool.query(
    'SELECT qty, total FROM transactions WHERE uid = ? AND type = "buy" AND sym = ? ORDER BY ts ASC',
    [userId, sym.toUpperCase()]
  );
  if (buys.length === 0) return 0;

  const [pf] = await pool.query(
    'SELECT qty FROM portfolios WHERE user_id = ? AND sym = ? AND qty > 0 LIMIT 1',
    [userId, sym.toUpperCase()]
  );
  const remainingQty = pf.length > 0 ? pf[0].qty : 0;
  if (remainingQty <= 0) return 0;

  // Proportional refund based on total paid / total bought
  const totalBought = buys.reduce((s, b) => s + b.qty, 0);
  const totalPaid = buys.reduce((s, b) => s + b.total, 0);
  if (totalBought === 0) return 0;

  const pricePerShare = totalPaid / totalBought;
  return Math.round(pricePerShare * remainingQty * 100) / 100;
}

/** GET /api/admin/orphans — audit orphaned holdings */
router.get('/orphans', requireAdmin, async (req, res) => {
  try {
    const [orphanRows] = await pool.query(
      'SELECT p.user_id, p.sym, p.qty, u.nick, u.name, u.balance, c.name as company_name, c.status as company_status ' +
      'FROM portfolios p ' +
      'JOIN users u ON u.id = p.user_id ' +
      'LEFT JOIN companies c ON c.sym = p.sym ' +
      'WHERE p.qty > 0 AND (c.sym IS NULL OR c.status != "active") ' +
      'ORDER BY p.user_id, p.sym'
    );

    const orphansByUser = {};
    for (const r of orphanRows) {
      if (!orphansByUser[r.user_id]) {
        orphansByUser[r.user_id] = { nick: r.nick, name: r.name, balance: r.balance, holdings: [] };
      }
      orphansByUser[r.user_id].holdings.push({ sym: r.sym, qty: r.qty, companyName: r.company_name || '(deleted record)', status: r.company_status });
    }

    // Calculate estimated refunds
    const estimates = {};
    let totalRefund = 0;
    for (const [uid, info] of Object.entries(orphansByUser)) {
      estimates[uid] = [];
      for (const h of info.holdings) {
        const refund = await calcOrphanRefund(uid, h.sym);
        if (refund > 0.01) totalRefund += refund;
        estimates[uid].push({ sym: h.sym, qty: h.qty, estimatedRefund: Math.round(refund * 100) / 100 });
      }
    }

    res.json({
      orphanCount: orphanRows.length,
      usersAffected: Object.keys(orphansByUser).length,
      estimates,
      totalEstimatedRefund: totalRefund,
      orphansByUser
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** POST /api/admin/orphans/cleanup — refund users and remove orphaned holdings */
router.post('/orphans/cleanup', requireAdmin, async (req, res) => {
  try {
    const [orphanRows] = await pool.query(
      'SELECT p.user_id, p.sym, p.qty FROM portfolios p WHERE p.qty > 0 AND p.sym NOT IN (SELECT sym FROM companies WHERE status = "active") ORDER BY p.user_id, p.sym'
    );

    if (orphanRows.length === 0) {
      return res.json({ ok: true, refunded: 0, cleaned: 0, message: 'No orphans found.' });
    }

    let totalRefunded = 0;
    let refundCount = 0;
    let cleanCount = 0;
    const results = [];

    for (const h of orphanRows) {
      // Calculate and process refund
      const refund = await calcOrphanRefund(h.user_id, h.sym);
      if (refund > 0.01) {
        await pool.query('UPDATE users SET `balance` = `balance` + ? WHERE `id` = ?', [refund, h.user_id]);
        totalRefunded += refund;
        refundCount++;
      }

      // Remove orphaned portfolio entry
      await pool.query('DELETE FROM portfolios WHERE `user_id` = ? AND `sym` = ?', [h.user_id, h.sym]);
      cleanCount++;

      results.push({ userId: h.user_id, sym: h.sym, qty: h.qty, refund });
    }

    // Log admin event
    await logAdmin(`ORPHAN CLEANUP: Refunded R$${totalRefunded.toFixed(2)} (${refundCount} refunds), removed ${cleanCount} orphaned holdings`);

    res.json({ ok: true, refunded: totalRefunded, refundCount, cleaned: cleanCount, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/dev/download-db
router.get('/dev/download-db', requireDev, (req, res) => {
  const dbPath = path.join(__dirname, '../data/db.json');
  if (!fs.existsSync(dbPath)) return res.status(404).json({ error: 'db.json não encontrado.' });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  res.setHeader('Content-Disposition', `attachment; filename="corleone-db-${ts}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.sendFile(dbPath);
});

function handleImportDb(req, res) {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  try {
    const parsed = restoreLowdbFromFile(req.file.buffer);
    const wasOpen = db.get('market.open').value();
    if (parsed.market && parsed.market.open && !wasOpen) simulator.start();
    else if (parsed.market && !parsed.market.open && wasOpen) simulator.stop();

    pool.query('INSERT INTO admin_events (`t`, `msg`, `ts`) VALUES (?, ?, ?)',
      [new Date().toLocaleTimeString('pt-BR'), `db.json restaurado via import por ${req.session.userId}`, Date.now()]
    ).catch(() => {});

    res.json({
      ok: true,
      totals: {
        stocks: (parsed.stocks || []).length,
        transactions: (parsed.transactions || []).length,
        portfolios: Object.keys(parsed.portfolios || {}).length
      },
      marketOpen: db.get('market.open').value()
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}

router.post('/dev/import-db', requireDev, uploadMem.single('dbfile'), handleImportDb);
router.post('/dev/upload-db', requireDev, uploadMem.single('db'), handleImportDb);

// GET /api/admin/dev/database-report
router.get('/dev/database-report', requireDev, async (req, res) => {
  try {
    const dataDir = path.join(__dirname, '../data');
    const dbData = db.getState();
    const [userRows] = await pool.query('SELECT COUNT(*) as cnt FROM users');

    const collections = Object.entries(dbData).map(([name, val]) => {
      const isArray = Array.isArray(val);
      const isObj   = val && typeof val === 'object' && !isArray;
      const count   = isArray ? val.length : isObj ? Object.keys(val).length : 1;
      const sample  = isArray && val.length > 0 ? Object.keys(val[0]).slice(0, 5) : isObj ? Object.keys(val).slice(0, 5) : [];
      const sizeBytes = Buffer.byteLength(JSON.stringify(val), 'utf8');
      return { name, type: isArray ? 'array' : isObj ? 'object' : 'value', count, sizeBytes, sampleKeys: sample };
    });

    const files = fs.readdirSync(dataDir).map(f => {
      const fp = path.join(dataDir, f);
      const st = fs.statSync(fp);
      return { name: f, sizeBytes: st.size, modifiedAt: st.mtime };
    });

    // Get MySQL table stats for comparison
    let mysqlStats = {};
    try {
      const [tables] = await pool.query('SELECT TABLE_NAME, TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()');
      mysqlStats = {};
      tables.forEach(t => { mysqlStats[t.table_name] = t.table_rows; });
    } catch(_) {}

    res.json({
      generatedAt: new Date().toISOString(),
      totals: {
        users: userRows[0].cnt,
        stocks: (dbData.stocks || []).length,
        transactions: (dbData.transactions || []).length,
        adminLog: (dbData.adminLog || []).length,
      },
      market: dbData.market || { open: false },
      collections,
      files,
      mysqlTables: mysqlStats
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/dev/history
router.get('/dev/history', requireDev, async (req, res) => {
  try {
    const [adminRows] = await pool.query('SELECT * FROM admin_events ORDER BY id DESC LIMIT 50');
    let txRows = [];
    try {
      const [tRows] = await pool.query('SELECT * FROM transactions ORDER BY ts DESC LIMIT 50');
      txRows = tRows;
    } catch(_) {} // table may not exist
    res.json({
      adminLog:     adminRows.reverse(),
      transactions: txRows,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
