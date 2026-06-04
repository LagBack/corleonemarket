const router = require('express').Router();
const fs     = require('fs');
const path   = require('path');
const multer = require('multer');
const db     = require('../data/db');
const pool   = require('../data/mysql');
const { requireAdmin, requireMod, requireDev } = require('../middleware/auth');
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

// GET /api/admin/log
router.get('/log', requireMod, (req, res) => {
  const log = db.get('adminLog').value();
  res.json(log.slice().reverse().slice(0, 100));
});

// GET /api/admin/users
router.get('/users', requireMod, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, email, name, nick, avatar, photo, country, bio, role, balance, joined FROM users');
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/market/open
router.post('/market/open', requireMod, (req, res) => {
  db.set('market.open', true).write();
  simulator.start();
  db.get('adminLog').push({ t: new Date().toLocaleTimeString('pt-BR'), msg: `Mercado ABERTO por ${req.session.userId}` }).write();
  res.json({ ok: true, open: true });
});

// POST /api/admin/market/close
router.post('/market/close', requireMod, (req, res) => {
  db.set('market.open', false).write();
  db.get('adminLog').push({ t: new Date().toLocaleTimeString('pt-BR'), msg: `Mercado FECHADO por ${req.session.userId}` }).write();
  res.json({ ok: true, open: false });
});

// POST /api/admin/market/crash
router.post('/market/crash', requireMod, (req, res) => {
  const arr = db.get('stocks').value();
  arr.forEach(s => {
    if (s.status !== 'active') return;
    s.price = Math.max(s.open * 0.10, Math.round(s.price * (0.91 + Math.random() * 0.05) * 100) / 100);  // -4% to -9%
    s.supply = Math.min(0.9, s.supply + 0.2);
    s.demand = Math.max(0.1, s.demand - 0.2);
  });
  db.set('stocks', arr).write();
  db.get('adminLog').push({ t: new Date().toLocaleTimeString('pt-BR'), msg: `CRASH simulado por ${req.session.userId}` }).write();
  res.json({ ok: true });
});

// POST /api/admin/market/bull
router.post('/market/bull', requireMod, (req, res) => {
  const arr = db.get('stocks').value();
  arr.forEach(s => {
    if (s.status !== 'active') return;
    s.price = Math.round(s.price * (1.02 + Math.random() * 0.04) * 100) / 100;  // max +6%
    s.demand = Math.min(0.9, s.demand + 0.2);
    s.supply = Math.max(0.1, s.supply - 0.2);
  });
  db.set('stocks', arr).write();
  db.get('adminLog').push({ t: new Date().toLocaleTimeString('pt-BR'), msg: `ALTA geral simulada por ${req.session.userId}` }).write();
  res.json({ ok: true });
});

// POST /api/admin/market/reset  — admin only
router.post('/market/reset', requireAdmin, (req, res) => {
  // reset stock prices to open
  const arr = db.get('stocks').value();
  arr.forEach(s => {
    s.price = s.open;
    s.demand = 0.5;
    s.supply = 0.5;
    s.volume = 0;
    s.buys = 0;
    s.sells = 0;
  });
  db.set('stocks', arr).write();
  db.get('adminLog').push({ t: new Date().toLocaleTimeString('pt-BR'), msg: `Mercado RESETADO por ${req.session.userId}` }).write();
  res.json({ ok: true });
});

// PUT /api/admin/users/:id/role  — admin only
router.put('/users/:id/role', requireAdmin, async (req, res) => {
  const { role } = req.body;
  if (!['user','moderator','admin','dev'].includes(role)) return res.status(400).json({ error: 'Papel inválido.' });
  try {
    const [rows] = await pool.query('SELECT id, nick, name, role FROM users WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Usuário não encontrado.' });
    const target = rows[0];
    if (target.role === 'dev' && role !== 'dev') {
      return res.status(403).json({ error: 'O papel Dev não pode ser removido.' });
    }
    await pool.query('UPDATE users SET role = ? WHERE id = ?', [role, req.params.id]);
    if (req.params.id === req.session.userId) req.session.role = role;
    db.get('adminLog').push({ t: new Date().toLocaleTimeString('pt-BR'), msg: `Papel de ${target.nick || target.name} alterado para ${role} por ${req.session.userId}` }).write();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/admin/users/:id/balance  — admin/mod
router.put('/users/:id/balance', requireMod, async (req, res) => {
  const { balance, mode } = req.body;
  const amt = parseFloat(balance);
  if (isNaN(amt)) return res.status(400).json({ error: 'Valor inválido.' });
  try {
    const [rows] = await pool.query('SELECT id, nick, name, balance FROM users WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Usuário não encontrado.' });
    const target = rows[0];
    let newBalance;
    if (mode === 'add')           newBalance = Math.round((target.balance + amt) * 100) / 100;
    else if (mode === 'subtract') newBalance = Math.max(0, Math.round((target.balance - amt) * 100) / 100);
    else                          newBalance = Math.max(0, Math.round(amt * 100) / 100);
    await pool.query('UPDATE users SET balance = ? WHERE id = ?', [newBalance, req.params.id]);
    db.get('adminLog').push({ t: new Date().toLocaleTimeString('pt-BR'), msg: `Saldo de ${target.nick || target.name} alterado para R$${newBalance.toFixed(2)} por ${req.session.userId}` }).write();
    res.json({ ok: true, balance: newBalance });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/admin/users/:id  — admin only
router.delete('/users/:id', requireAdmin, async (req, res) => {
  if (req.params.id === req.session.userId) return res.status(400).json({ error: 'Não pode deletar a si mesmo.' });
  try {
    const [rows] = await pool.query('SELECT id, email, role FROM users WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Usuário não encontrado.' });
    const target = rows[0];
    if (target.role === 'dev') return res.status(403).json({ error: 'Usuários Dev não podem ser deletados.' });
    await pool.query('DELETE FROM users WHERE id = ?', [req.params.id]);
    db.get('adminLog').push({ t: new Date().toLocaleTimeString('pt-BR'), msg: `Usuário ${target.email} DELETADO por ${req.session.userId}` }).write();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
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

    db.get('adminLog').push({
      t:   new Date().toLocaleTimeString('pt-BR'),
      msg: `db.json restaurado via import por ${req.session.userId}`
    }).write();

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
    const dbData  = db.getState();
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

    res.json({
      generatedAt: new Date().toISOString(),
      totals: {
        users:        userRows[0].cnt,
        stocks:       (dbData.stocks || []).length,
        transactions: (dbData.transactions || []).length,
        adminLog:     (dbData.adminLog || []).length,
      },
      market: dbData.market || { open: false },
      collections,
      files
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/dev/history
router.get('/dev/history', requireDev, (req, res) => {
  res.json({
    adminLog:     (db.get('adminLog').value() || []).slice(-50).reverse(),
    transactions: (db.get('transactions').value() || []).slice(-50).reverse(),
  });
});

module.exports = router;
