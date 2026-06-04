const router = require('express').Router();
const multer = require('multer');
const path   = require('path');
const fs     = require('fs');
const pool   = require('../data/mysql');
const { normalizeCountry } = require('../data/countries');
const db     = require('../data/db');     // lowdb for stocks/portfolios/transactions
const { requireAuth } = require('../middleware/auth');

// Photo upload config
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '../public/uploads')),
  filename:    (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${req.session.userId}_${Date.now()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/image\/(jpeg|png|gif|webp)/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Apenas imagens são permitidas.'));
  }
});

function safe(row) { if (!row) return null; const { pass, ...r } = row; return r; }

// GET /api/users/me
router.get('/me', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [req.session.userId]);
    if (!rows.length) return res.status(404).json({ error: 'Não encontrado' });
    res.json(safe(rows[0]));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/users/me
router.put('/me', requireAuth, async (req, res) => {
  const { nick, bio, country, avatar } = req.body;
  try {
    await pool.query(
      'UPDATE users SET nick=?, bio=?, country=?, avatar=? WHERE id=?',
      [nick, bio, normalizeCountry(country), avatar, req.session.userId]
    );
    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [req.session.userId]);
    res.json({ ok: true, user: safe(rows[0]) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/users/me/photo
router.post('/me/photo', requireAuth, upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  const photoUrl = `/uploads/${req.file.filename}`;
  try {
    const [rows] = await pool.query('SELECT photo FROM users WHERE id = ?', [req.session.userId]);
    if (rows.length && rows[0].photo) {
      const oldPath = path.join(__dirname, '../public', rows[0].photo);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
    await pool.query('UPDATE users SET photo=? WHERE id=?', [photoUrl, req.session.userId]);
    res.json({ ok: true, photo: photoUrl });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/users/me/photo
router.delete('/me/photo', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT photo FROM users WHERE id = ?', [req.session.userId]);
    if (rows.length && rows[0].photo) {
      const oldPath = path.join(__dirname, '../public', rows[0].photo);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
    await pool.query('UPDATE users SET photo=NULL WHERE id=?', [req.session.userId]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/users/:id/public
router.get('/:id/public', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Usuário não encontrado.' });
    const user   = rows[0];
    const stocks = db.get('stocks').value();
    const pf     = db.get('portfolios').get(req.params.id).value() || {};
    const txs    = db.get('transactions').filter({ uid: req.params.id }).value();
    let mv = 0;
    const holdings = Object.entries(pf).map(([sym, qty]) => {
      const s = stocks.find(x => x.sym === sym);
      if (!s) return null;
      const val = s.price * qty;
      mv += val;
      return { sym, name: s.name, qty, price: s.price, value: val, pctOfCompany: qty / s.shares * 100 };
    }).filter(Boolean);
    res.json({
      id: user.id, nick: user.nick || user.name, name: user.name,
      avatar: user.avatar, photo: user.photo, country: user.country,
      bio: user.bio, role: user.role, joined: user.joined,
      balance:     ['admin', 'dev'].includes(user.role) ? null : user.balance,
      totalTx:     txs.length,
      buys:        txs.filter(t => t.type === 'buy').length,
      sells:       txs.filter(t => t.type === 'sell').length,
      holdings,
      marketValue: mv,
      totalWealth: ['admin', 'dev'].includes(user.role) ? null : user.balance + mv,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/users/me/dividends
router.get('/me/dividends', requireAuth, async (req, res) => {
  const uid  = req.session.userId;
  const divs = (db.get('dividends').value() || [])
    .filter(d => d.founderId === uid).sort((a,b) => b.ts - a.ts).slice(0, 100);
  const total = divs.reduce((a, d) => a + d.fee, 0);
  const allStocks = db.get('stocks').value();
  const ownedStocks = allStocks
    .filter(s => Array.isArray(s.owners) && s.owners.some(o => o.userId === uid))
    .map(s => {
      const o = s.owners.find(o => o.userId === uid);
      return { sym: s.sym, name: s.name, pct: o.pct, totalRevenue: s.totalRevenue || 0, price: s.price };
    });
  const myListings = (db.get('ownershipListings').value() || [])
    .filter(l => l.sellerId === uid && l.status === 'open');
  res.json({ dividends: divs, total: Math.round(total * 100) / 100, ownedStocks, myListings });
});

module.exports = router;
