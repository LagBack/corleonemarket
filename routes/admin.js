const router = require('express').Router();
const db = require('../data/db');
const { requireAdmin, requireMod } = require('../middleware/auth');

// GET /api/admin/log
router.get('/log', requireMod, (req, res) => {
  const log = db.get('adminLog').value();
  res.json(log.slice().reverse().slice(0, 100));
});

// GET /api/admin/users
router.get('/users', requireMod, (req, res) => {
  const users = db.get('users').value().map(u => {
    const { pass, ...safe } = u;
    return safe;
  });
  res.json(users);
});

// POST /api/admin/market/open
router.post('/market/open', requireMod, (req, res) => {
  db.set('market.open', true).write();
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
    s.price = Math.max(0.01, Math.round(s.price * (0.88 + Math.random() * 0.07) * 100) / 100);
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
    s.price = Math.round(s.price * (1.05 + Math.random() * 0.06) * 100) / 100;
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
router.put('/users/:id/role', requireAdmin, (req, res) => {
  const { role } = req.body;
  if (!['user','moderator','admin'].includes(role)) return res.status(400).json({ error: 'Papel inválido.' });
  const target = db.get('users').find({ id: req.params.id }).value();
  if (!target) return res.status(404).json({ error: 'Usuário não encontrado.' });
  db.get('users').find({ id: req.params.id }).assign({ role }).write();
  db.get('adminLog').push({ t: new Date().toLocaleTimeString('pt-BR'), msg: `Papel de ${target.nick || target.name} alterado para ${role} por ${req.session.userId}` }).write();
  res.json({ ok: true });
});

// PUT /api/admin/users/:id/balance  — admin/mod
router.put('/users/:id/balance', requireMod, (req, res) => {
  const { balance, mode } = req.body; // mode: 'set' | 'add' | 'subtract'
  const target = db.get('users').find({ id: req.params.id }).value();
  if (!target) return res.status(404).json({ error: 'Usuário não encontrado.' });
  const amt = parseFloat(balance);
  if (isNaN(amt)) return res.status(400).json({ error: 'Valor inválido.' });
  let newBalance;
  if (mode === 'add')      newBalance = Math.round((target.balance + amt) * 100) / 100;
  else if (mode === 'subtract') newBalance = Math.max(0, Math.round((target.balance - amt) * 100) / 100);
  else                     newBalance = Math.max(0, Math.round(amt * 100) / 100);
  db.get('users').find({ id: req.params.id }).assign({ balance: newBalance }).write();
  db.get('adminLog').push({ t: new Date().toLocaleTimeString('pt-BR'), msg: `Saldo de ${target.nick || target.name} alterado para R$${newBalance.toFixed(2)} por ${req.session.userId}` }).write();
  res.json({ ok: true, balance: newBalance });
});

// DELETE /api/admin/users/:id  — admin only
router.delete('/users/:id', requireAdmin, (req, res) => {
  if (req.params.id === req.session.userId) return res.status(400).json({ error: 'Não pode deletar a si mesmo.' });
  const target = db.get('users').find({ id: req.params.id }).value();
  if (!target) return res.status(404).json({ error: 'Usuário não encontrado.' });
  db.get('users').remove({ id: req.params.id }).write();
  db.get('adminLog').push({ t: new Date().toLocaleTimeString('pt-BR'), msg: `Usuário ${target.email} DELETADO por ${req.session.userId}` }).write();
  res.json({ ok: true });
});

module.exports = router;
