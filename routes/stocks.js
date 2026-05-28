const router = require('express').Router();
const db = require('../data/db');
const { requireMod, requireAdmin } = require('../middleware/auth');

// GET /api/stocks
router.get('/', (req, res) => {
  res.json(db.get('stocks').value());
});

// POST /api/stocks  — create (admin/mod)
// If creator is a moderator, they get registered as the stock's "founder"
// and will receive a small revenue share on every trade
router.post('/', requireMod, (req, res) => {
  const { sym, name, sector, desc, price, shares, vol, status } = req.body;
  if (!sym || !name || !price || !shares)
    return res.status(400).json({ error: 'Campos obrigatórios: sym, name, price, shares.' });

  const clean = sym.trim().toUpperCase();
  if (!/^[A-Z]{3,5}\d{1,2}$/.test(clean))
    return res.status(400).json({ error: 'Código inválido. Use formato XPTO3.' });
  if (db.get('stocks').find({ sym: clean }).value())
    return res.status(409).json({ error: 'Código já existe.' });

  const p = parseFloat(price);
  const creatorId = req.session.userId;
  const creatorRole = req.session.role;

  const ns = {
    sym: clean, name, sector: sector || 'Outros', desc: desc || '',
    price: p, open: p, shares: parseInt(shares),
    vol: parseFloat(vol) || 0.015,
    status: status || 'active',
    demand: 0.5, supply: 0.5,
    volume: 0, buys: 0, sells: 0,
    created: Date.now(),
    // Founder info — only mods get revenue share (admins don't need it)
    founderId:   creatorRole === 'moderator' ? creatorId : null,
    founderFee:  creatorRole === 'moderator' ? 0.003 : 0,  // 0.3% of every trade volume
    totalRevenue: 0,  // lifetime revenue paid to founder
  };

  db.get('stocks').push(ns).write();
  db.get('adminLog').push({
    t:   new Date().toLocaleTimeString('pt-BR'),
    msg: `Ativo ${clean} criado por ${creatorId}${ns.founderId ? ' (fundador com taxa 0.3%)' : ''}`
  }).write();

  res.json({ ok: true, stock: ns });
});

// PUT /api/stocks/:sym  — edit (admin/mod)
router.put('/:sym', requireMod, (req, res) => {
  const sym = req.params.sym.toUpperCase();
  const s = db.get('stocks').find({ sym }).value();
  if (!s) return res.status(404).json({ error: 'Ativo não encontrado.' });

  const { name, sector, desc, vol, status, pricePct } = req.body;
  const updates = {};
  if (name)             updates.name   = name;
  if (sector)           updates.sector = sector;
  if (desc !== undefined) updates.desc = desc;
  if (vol)              updates.vol    = parseFloat(vol);
  if (status)           updates.status = status;
  if (pricePct && !isNaN(parseFloat(pricePct))) {
    updates.price = Math.max(0.01, Math.round(s.price * (1 + parseFloat(pricePct) / 100) * 100) / 100);
  }

  db.get('stocks').find({ sym }).assign(updates).write();
  db.get('adminLog').push({
    t:   new Date().toLocaleTimeString('pt-BR'),
    msg: `Ativo ${sym} editado por ${req.session.userId}`
  }).write();
  res.json({ ok: true, stock: db.get('stocks').find({ sym }).value() });
});

// DELETE /api/stocks/:sym  — admin only
router.delete('/:sym', requireAdmin, (req, res) => {
  const sym = req.params.sym.toUpperCase();
  db.get('stocks').remove({ sym }).write();
  db.get('adminLog').push({
    t:   new Date().toLocaleTimeString('pt-BR'),
    msg: `Ativo ${sym} DELETADO por ${req.session.userId}`
  }).write();
  res.json({ ok: true });
});

module.exports = router;
