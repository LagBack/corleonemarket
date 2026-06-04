const router = require('express').Router();
const db   = require('../data/db');
const pool = require('../data/mysql');
const { requireAdmin, requireMod } = require('../middleware/auth');
const simulator = require('../data/simulator');

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
    const [rows] = await pool.query('SELECT id, nick, name FROM users WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Usuário não encontrado.' });
    const target = rows[0];
    await pool.query('UPDATE users SET role = ? WHERE id = ?', [role, req.params.id]);
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
    const [rows] = await pool.query('SELECT id, email FROM users WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Usuário não encontrado.' });
    const target = rows[0];
    await pool.query('DELETE FROM users WHERE id = ?', [req.params.id]);
    db.get('adminLog').push({ t: new Date().toLocaleTimeString('pt-BR'), msg: `Usuário ${target.email} DELETADO por ${req.session.userId}` }).write();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

// ── DEV TOOLS ──
const multer = require('multer');
const uploadMem = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// GET /api/admin/dev/download-db
router.get('/dev/download-db', requireAdmin, (req, res) => {
  const dbPath = require('path').join(__dirname, '../data/db.json');
  if (!require('fs').existsSync(dbPath))
    return res.status(404).json({ error: 'db.json não encontrado.' });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  res.setHeader('Content-Disposition', `attachment; filename="corleone-db-${ts}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.sendFile(dbPath);
});

// POST /api/admin/dev/upload-db  — restore a backup
router.post('/dev/upload-db', requireAdmin, uploadMem.single('db'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  try {
    const text = req.file.buffer.toString('utf8');
    const parsed = JSON.parse(text);
    // Basic validation — must have users and stocks arrays
    if (!parsed.users || !parsed.stocks)
      return res.status(400).json({ error: 'JSON inválido: precisa ter campos "users" e "stocks".' });
    const dbPath = require('path').join(__dirname, '../data/db.json');
    require('fs').writeFileSync(dbPath, text, 'utf8');
    // Reload lowdb from disk
    const db   = require('../data/db');
const pool = require('../data/mysql');
    db.read();
    db.get('adminLog').push({
      t:   new Date().toLocaleTimeString('pt-BR'),
      msg: `Database restaurada via upload por ${req.session.userId}`
    }).write();
    res.json({ ok: true, users: parsed.users.length, stocks: parsed.stocks.length });
  } catch(e) {
    res.status(400).json({ error: 'JSON inválido: ' + e.message });
  }
});

// GET /api/admin/dev/database-report
router.get('/dev/database-report', requireAdmin, (req, res) => {
  const fs   = require('fs');
  const path = require('path');
  const db   = require('../data/db');
  const dataDir = path.join(__dirname, '../data');

  const dbData = db.value();
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
    generatedAt: Date.now(),
    totals: {
      users:        (dbData.users || []).length,
      stocks:       (dbData.stocks || []).length,
      transactions: (dbData.transactions || []).length,
      adminLog:     (dbData.adminLog || []).length,
    },
    market: dbData.market || { open: false },
    collections,
    files
  });
});

// GET /api/admin/dev/history
router.get('/dev/history', requireAdmin, (req, res) => {
  const db   = require('../data/db');
const pool = require('../data/mysql');
  res.json({
    adminLog:     (db.get('adminLog').value() || []).slice(-50).reverse(),
    transactions: (db.get('transactions').value() || []).slice(-50).reverse(),
  });
});
