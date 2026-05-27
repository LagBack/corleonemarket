const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const db = require('../data/db');
const { requireAuth } = require('../middleware/auth');

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  const user = db.get('users').find({ id: req.session.userId }).value();
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  const { pass, ...safe } = user;
  res.json(safe);
});

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { email, pass } = req.body;
  if (!email || !pass) return res.status(400).json({ error: 'E-mail e senha são obrigatórios.' });
  const user = db.get('users').find({ email: email.toLowerCase().trim() }).value();
  if (!user) return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
  const valid = bcrypt.compareSync(pass, user.pass);
  if (!valid) return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
  req.session.userId = user.id;
  req.session.role = user.role;
  const { pass: _, ...safe } = user;
  res.json({ ok: true, user: safe });
});

// POST /api/auth/register
router.post('/register', (req, res) => {
  const { name, lname, email, pass, nick, avatar, country } = req.body;
  if (!name || !email || !pass) return res.status(400).json({ error: 'Nome, e-mail e senha são obrigatórios.' });
  if (pass.length < 6) return res.status(400).json({ error: 'Senha mínima: 6 caracteres.' });
  const exists = db.get('users').find({ email: email.toLowerCase().trim() }).value();
  if (exists) return res.status(409).json({ error: 'E-mail já cadastrado.' });
  const hashed = bcrypt.hashSync(pass, 10);
  const newUser = {
    id: uuid(),
    email: email.toLowerCase().trim(),
    pass: hashed,
    name: `${name} ${lname || ''}`.trim(),
    nick: nick || name,
    avatar: avatar || '🦁',
    photo: null,
    country: country || '🇧🇷 Brasil',
    bio: '',
    role: 'user',
    balance: 50000,
    joined: Date.now()
  };
  db.get('users').push(newUser).write();
  db.get('portfolios').set(newUser.id, {}).write();
  req.session.userId = newUser.id;
  req.session.role = newUser.role;
  const { pass: _, ...safe } = newUser;
  res.json({ ok: true, user: safe });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

module.exports = router;
