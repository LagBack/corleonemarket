const router  = require('express').Router();
const db      = require('../data/db');
const { requireMod, requireAdmin } = require('../middleware/auth');

// GET /api/stocks
router.get('/', (req, res) => {
  res.json(db.get('stocks').value());
});

// POST /api/stocks  — create with optional multi-owner config
// Body: { sym, name, sector, desc, price, shares, vol, status,
//         owners: [{ userId, pct }]  }   ← pct = revenue share %
router.post('/', requireMod, (req, res) => {
  const { sym, name, sector, desc, price, shares, vol, status, owners } = req.body;
  if (!sym || !name || !price || !shares)
    return res.status(400).json({ error: 'Campos obrigatórios: sym, name, price, shares.' });

  const clean = sym.trim().toUpperCase();
  if (!/^[A-Z]{3,5}\d{1,2}$/.test(clean))
    return res.status(400).json({ error: 'Código inválido. Use formato XPTO3.' });
  if (db.get('stocks').find({ sym: clean }).value())
    return res.status(409).json({ error: 'Código já existe.' });

  // Validate & normalise owners
  // owners = [{ userId, pct }]  where pct is revenue-share percentage (e.g. 0.15 = 0.15%)
  // Rules: total pct must be <= 0.5%, each owner must be a real user, no duplicates
  let validatedOwners = [];
  if (Array.isArray(owners) && owners.length > 0) {
    const allUsers = db.get('users').value();
    let totalPct   = 0;
    const seen     = new Set();
    for (const o of owners) {
      if (!o.userId || !o.pct) continue;
      if (seen.has(o.userId)) return res.status(400).json({ error: `Usuário duplicado: ${o.userId}` });
      const u = allUsers.find(x => x.id === o.userId);
      if (!u) return res.status(400).json({ error: `Usuário não encontrado: ${o.userId}` });
      const pct = parseFloat(o.pct);
      if (isNaN(pct) || pct <= 0 || pct > 0.5)
        return res.status(400).json({ error: `Porcentagem inválida para ${u.nick || u.name}. Máx 0.5%.` });
      totalPct += pct;
      seen.add(o.userId);
      validatedOwners.push({ userId: o.userId, name: u.nick || u.name, pct });
    }
    if (totalPct > 0.5)
      return res.status(400).json({ error: `Total de porcentagens (${totalPct.toFixed(3)}%) excede o limite de 0.5%.` });
  }

  const p  = parseFloat(price);
  const ns = {
    sym: clean, name,
    sector:  sector  || 'Outros',
    desc:    desc    || '',
    price: p, open: p,
    shares:  parseInt(shares),
    vol:     parseFloat(vol) || 0.015,
    status:  status  || 'active',
    demand: 0.5, supply: 0.5,
    volume: 0, buys: 0, sells: 0,
    created: Date.now(),
    // Multi-owner revenue share
    owners:       validatedOwners,   // [{ userId, name, pct }]
    totalRevenue: 0,
    // Legacy single-founder fields kept for backwards compat
    founderId:  null,
    founderFee: 0,
  };

  db.get('stocks').push(ns).write();
  db.get('adminLog').push({
    t:   new Date().toLocaleTimeString('pt-BR'),
    msg: `Ativo ${clean} criado por ${req.session.userId}` +
         (validatedOwners.length ? ` | Donos: ${validatedOwners.map(o=>`${o.name}(${o.pct}%)`).join(', ')}` : '')
  }).write();

  res.json({ ok: true, stock: ns });
});

// PUT /api/stocks/:sym  — edit
router.put('/:sym', requireMod, (req, res) => {
  const sym = req.params.sym.toUpperCase();
  const s   = db.get('stocks').find({ sym }).value();
  if (!s) return res.status(404).json({ error: 'Ativo não encontrado.' });

  const { name, sector, desc, vol, status, pricePct } = req.body;
  const updates = {};
  if (name)             updates.name   = name;
  if (sector)           updates.sector = sector;
  if (desc !== undefined) updates.desc = desc;
  if (vol)              updates.vol    = parseFloat(vol);
  if (status)           updates.status = status;
  if (pricePct && !isNaN(parseFloat(pricePct)))
    updates.price = Math.max(0.01, Math.round(s.price * (1 + parseFloat(pricePct) / 100) * 100) / 100);

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

// ── Ownership marketplace ──────────────────────────────────────
// A stock owner can LIST their revenue-share stake for sale to real players.
// The "market maker" (simulator) NEVER buys these listings.

// GET /api/stocks/:sym/ownership-listings
router.get('/:sym/ownership-listings', (req, res) => {
  const sym      = req.params.sym.toUpperCase();
  const listings = (db.get('ownershipListings').value() || [])
    .filter(l => l.sym === sym && l.status === 'open');
  res.json(listings);
});

// GET /api/stocks/ownership-listings/my  — my open listings
router.get('/ownership-listings/my', requireMod, (req, res) => {
  const uid      = req.session.userId;
  const listings = (db.get('ownershipListings').value() || [])
    .filter(l => l.sellerId === uid);
  res.json(listings);
});

// POST /api/stocks/:sym/ownership-listings — list a revenue-share stake for sale
// Body: { pctToSell, askPrice }
// pctToSell: how much of the owner's revenue-share % they want to sell
// askPrice:  how much R$ they want for it (negotiated between players)
router.post('/:sym/ownership-listings', requireMod, (req, res) => {
  const sym      = req.params.sym.toUpperCase();
  const uid      = req.session.userId;
  const stock    = db.get('stocks').find({ sym }).value();
  if (!stock) return res.status(404).json({ error: 'Ativo não encontrado.' });

  const owner = (stock.owners || []).find(o => o.userId === uid);
  if (!owner) return res.status(403).json({ error: 'Você não é dono desta empresa.' });

  const pctToSell = parseFloat(req.body.pctToSell);
  const askPrice  = parseFloat(req.body.askPrice);

  if (isNaN(pctToSell) || pctToSell <= 0 || pctToSell > owner.pct)
    return res.status(400).json({ error: `Você só possui ${owner.pct}% desta empresa.` });
  if (isNaN(askPrice) || askPrice <= 0)
    return res.status(400).json({ error: 'Preço de venda inválido.' });

  // Check not already listing more than they own
  const alreadyListed = (db.get('ownershipListings').value() || [])
    .filter(l => l.sym === sym && l.sellerId === uid && l.status === 'open')
    .reduce((a, l) => a + l.pctToSell, 0);
  if (alreadyListed + pctToSell > owner.pct)
    return res.status(400).json({ error: `Você já tem ${alreadyListed}% listado. Não pode listar mais que ${owner.pct}%.` });

  const listing = {
    id:         `ol_${Date.now()}`,
    sym,
    stockName:  stock.name,
    sellerId:   uid,
    sellerName: owner.name,
    pctToSell,
    askPrice,
    status:     'open',   // open | sold | cancelled
    createdAt:  Date.now()
  };
  const all = db.get('ownershipListings').value() || [];
  all.push(listing);
  db.set('ownershipListings', all).write();

  db.get('adminLog').push({
    t:   new Date().toLocaleTimeString('pt-BR'),
    msg: `${owner.name} listou ${pctToSell}% de ${sym} por R$${askPrice}`
  }).write();

  res.json({ ok: true, listing });
});

// POST /api/stocks/:sym/ownership-listings/:listingId/buy — buy a listed stake (any player)
router.post('/:sym/ownership-listings/:listingId/buy', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Não autenticado.' });

  const buyerId  = req.session.userId;
  const buyer    = db.get('users').find({ id: buyerId }).value();
  const listingId = req.params.listingId;

  const all      = db.get('ownershipListings').value() || [];
  const lIdx     = all.findIndex(l => l.id === listingId && l.status === 'open');
  if (lIdx < 0) return res.status(404).json({ error: 'Listagem não encontrada ou já fechada.' });

  const listing  = all[lIdx];
  if (listing.sellerId === buyerId) return res.status(400).json({ error: 'Você não pode comprar sua própria listagem.' });
  if (buyer.balance < listing.askPrice)
    return res.status(400).json({ error: 'Saldo insuficiente.' });

  // Transfer money buyer → seller
  const seller = db.get('users').find({ id: listing.sellerId }).value();
  db.get('users').find({ id: buyerId   }).assign({ balance: Math.round((buyer.balance  - listing.askPrice) * 100) / 100 }).write();
  db.get('users').find({ id: listing.sellerId }).assign({ balance: Math.round((seller.balance + listing.askPrice) * 100) / 100 }).write();

  // Transfer ownership in the stock
  const sym   = listing.sym.toUpperCase();
  const sAll  = db.get('stocks').value();
  const sIdx  = sAll.findIndex(s => s.sym === sym);
  const stock = sAll[sIdx];
  const owners = stock.owners || [];

  // Remove pctToSell from seller
  const sellerOwnerIdx = owners.findIndex(o => o.userId === listing.sellerId);
  if (sellerOwnerIdx >= 0) {
    owners[sellerOwnerIdx].pct = Math.round((owners[sellerOwnerIdx].pct - listing.pctToSell) * 10000) / 10000;
    if (owners[sellerOwnerIdx].pct <= 0) owners.splice(sellerOwnerIdx, 1);
  }

  // Add pct to buyer
  const buyerOwnerIdx = owners.findIndex(o => o.userId === buyerId);
  if (buyerOwnerIdx >= 0) {
    owners[buyerOwnerIdx].pct = Math.round((owners[buyerOwnerIdx].pct + listing.pctToSell) * 10000) / 10000;
  } else {
    owners.push({ userId: buyerId, name: buyer.nick || buyer.name, pct: listing.pctToSell });
  }

  sAll[sIdx].owners = owners;
  db.set('stocks', sAll).write();

  // Close listing
  all[lIdx].status   = 'sold';
  all[lIdx].buyerId  = buyerId;
  all[lIdx].buyerName = buyer.nick || buyer.name;
  all[lIdx].soldAt   = Date.now();
  db.set('ownershipListings', all).write();

  db.get('adminLog').push({
    t:   new Date().toLocaleTimeString('pt-BR'),
    msg: `${buyer.nick||buyer.name} comprou ${listing.pctToSell}% de ${sym} de ${listing.sellerName} por R$${listing.askPrice}`
  }).write();

  const { pass, ...safeB } = db.get('users').find({ id: buyerId }).value();
  res.json({ ok: true, user: safeB });
});

// DELETE /api/stocks/:sym/ownership-listings/:listingId — cancel a listing
router.delete('/:sym/ownership-listings/:listingId', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Não autenticado.' });
  const uid  = req.session.userId;
  const all  = db.get('ownershipListings').value() || [];
  const lIdx = all.findIndex(l => l.id === req.params.listingId && l.sellerId === uid && l.status === 'open');
  if (lIdx < 0) return res.status(404).json({ error: 'Listagem não encontrada.' });
  all[lIdx].status = 'cancelled';
  db.set('ownershipListings', all).write();
  res.json({ ok: true });
});

module.exports = router;
