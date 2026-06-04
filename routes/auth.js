const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const pool = require('../data/mysql');
const db   = require('../data/db');       // lowdb — still used for portfolios
const { requireAuth } = require('../middleware/auth');

// Helper: row → safe user object
function safe(row) {
  if (!row) return null;
  const { pass, ...rest } = row;
  return rest;
}

// GET /api/auth/me
router.get('/me', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [req.session.userId]);
    if (!rows.length) return res.status(404).json({ error: 'Usuário não encontrado' });
    res.json(safe(rows[0]));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, pass } = req.body;
  if (!email || !pass) return res.status(400).json({ error: 'E-mail e senha são obrigatórios.' });
  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email.toLowerCase().trim()]);
    if (!rows.length) return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
    const user = rows[0];
    if (!bcrypt.compareSync(pass, user.pass)) return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
    req.session.userId = user.id;
    req.session.role   = user.role;
    res.json({ ok: true, user: safe(user) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { name, lname, email, pass, nick, avatar, country } = req.body;
  if (!name || !email || !pass) return res.status(400).json({ error: 'Nome, e-mail e senha são obrigatórios.' });
  if (pass.length < 6) return res.status(400).json({ error: 'Senha mínima: 6 caracteres.' });
  try {
    const [exists] = await pool.query('SELECT id FROM users WHERE email = ?', [email.toLowerCase().trim()]);
    if (exists.length) return res.status(409).json({ error: 'E-mail já cadastrado.' });
    const newUser = {
      id:      uuid(),
      email:   email.toLowerCase().trim(),
      pass:    bcrypt.hashSync(pass, 10),
      name:    `${name} ${lname || ''}`.trim(),
      nick:    nick || name,
      avatar:  avatar || '🦁',
      photo:   null,
      country: country || '🇧🇷 Brasil',
      bio:     '',
      role:    'user',
      balance: 50000,
      joined:  Date.now()
    };
    await pool.query(
      `INSERT INTO users (id, email, pass, name, nick, avatar, photo, country, bio, role, balance, joined)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newUser.id, newUser.email, newUser.pass, newUser.name, newUser.nick,
       newUser.avatar, newUser.photo, newUser.country, newUser.bio,
       newUser.role, newUser.balance, newUser.joined]
    );
    // Create empty portfolio in lowdb
    const pfs = db.get('portfolios').value();
    pfs[newUser.id] = {};
    db.set('portfolios', pfs).write();
    req.session.userId = newUser.id;
    req.session.role   = newUser.role;
    res.json({ ok: true, user: safe(newUser) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

module.exports = router;
