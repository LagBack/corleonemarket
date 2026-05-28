const router = require('express').Router();
const db = require('../data/db');
const { requireAuth } = require('../middleware/auth');

// GET /api/market/state
router.get('/state', (req, res) => {
  const stocks   = db.get('stocks').value();
  const open     = db.get('market.open').value();
  const ibcx     = stocks.length
    ? stocks.reduce((a, s) => a + (s.price / s.open * 1000), 0) / stocks.length
    : 1000;
  const totalVol = stocks.reduce((a, s) => a + s.volume * s.price, 0);
  // strip heavy priceHistory from table list, keep it per-stock only when requested
  const stocksLite = stocks.map(({ priceHistory, ...s }) => s);
  res.json({ stocks: stocksLite, open, ibcx, totalVol });
});

// GET /api/market/history/:sym  — price history for chart
router.get('/history/:sym', (req, res) => {
  const sym   = req.params.sym.toUpperCase();
  const stock = db.get('stocks').find({ sym }).value();
  if (!stock) return res.status(404).json({ error: 'Ativo não encontrado' });
  res.json({ sym, history: stock.priceHistory || [] });
});

// GET /api/market/portfolio
router.get('/portfolio', requireAuth, (req, res) => {
  const uid  = req.session.userId;
  const user = db.get('users').find({ id: uid }).value();
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  const pf  = db.get('portfolios').get(uid).value() || {};
  const txs = db.get('transactions').filter({ uid }).value();
  const { pass, ...safe } = user;
  res.json({ user: safe, portfolio: pf, transactions: txs });
});

// POST /api/market/order
router.post('/order', requireAuth, (req, res) => {
  if (!db.get('market.open').value())
    return res.status(403).json({ error: 'Mercado está fechado.' });

  const { sym, type, qty } = req.body;
  const quantity = parseInt(qty);
  if (!sym || !type || !quantity || quantity < 1)
    return res.status(400).json({ error: 'Parâmetros inválidos.' });

  const uid   = req.session.userId;
  const user  = db.get('users').find({ id: uid }).value();
  const stock = db.get('stocks').find({ sym }).value();
  if (!stock) return res.status(404).json({ error: 'Ativo não encontrado.' });
  if (stock.status !== 'active') return res.status(403).json({ error: 'Ativo suspenso.' });

  const total = Math.round(stock.price * quantity * 100) / 100;
  const pfs   = db.get('portfolios').value();
  if (!pfs[uid]) pfs[uid] = {};

  if (type === 'buy') {
    if (user.balance < total) return res.status(400).json({ error: 'Saldo insuficiente.' });
    db.get('users').find({ id: uid }).assign({ balance: Math.round((user.balance - total) * 100) / 100 }).write();
    pfs[uid][sym] = (pfs[uid][sym] || 0) + quantity;
    db.get('stocks').find({ sym }).assign({
      demand: Math.min(0.95, stock.demand + 0.03),
      buys:   stock.buys + quantity,
      volume: stock.volume + quantity
    }).write();
  } else {
    const owned = pfs[uid][sym] || 0;
    if (owned < quantity) return res.status(400).json({ error: 'Cotas insuficientes.' });
    db.get('users').find({ id: uid }).assign({ balance: Math.round((user.balance + total) * 100) / 100 }).write();
    pfs[uid][sym] -= quantity;
    if (pfs[uid][sym] === 0) delete pfs[uid][sym];
    db.get('stocks').find({ sym }).assign({
      supply: Math.min(0.95, stock.supply + 0.03),
      sells:  stock.sells + quantity,
      volume: stock.volume + quantity
    }).write();
  }

  db.set('portfolios', pfs).write();

  const tx = {
    id:    Date.now(),
    uid,
    uname: user.nick || user.name,
    type,  sym,
    qty:   quantity,
    price: stock.price,
    total,
    time:  new Date().toLocaleTimeString('pt-BR'),
    ts:    Date.now()
  };
  db.get('transactions').push(tx).write();

  // ── Founder fee: pay 0.3% of trade volume to the stock's founder (if mod-created) ──
  const freshStock = db.get('stocks').find({ sym }).value();
  if (freshStock && freshStock.founderId && freshStock.founderFee > 0) {
    const fee = Math.round(total * freshStock.founderFee * 100) / 100;
    if (fee > 0.01) {
      const founder = db.get('users').find({ id: freshStock.founderId }).value();
      if (founder) {
        db.get('users').find({ id: freshStock.founderId })
          .assign({ balance: Math.round((founder.balance + fee) * 100) / 100 }).write();
        db.get('stocks').find({ sym })
          .assign({ totalRevenue: (freshStock.totalRevenue || 0) + fee }).write();
        // Store dividend record so founder can see it in their profile
        const divs = db.get('dividends').value() || [];
        divs.push({
          id: Date.now() + Math.random(),
          founderId: freshStock.founderId,
          sym,
          traderName: user.nick || user.name,
          type,
          tradeTotal: total,
          fee,
          time: new Date().toLocaleTimeString('pt-BR'),
          ts: Date.now()
        });
        db.set('dividends', divs).write();
      }
    }
  }

  db.get('adminLog').push({
    t:   new Date().toLocaleTimeString('pt-BR'),
    msg: `${user.nick || user.name} ${type === 'buy' ? 'COMPROU' : 'VENDEU'} ${quantity}× ${sym} @ R$${stock.price.toFixed(2)}`
  }).write();

  const updatedUser = db.get('users').find({ id: uid }).value();
  const { pass, ...safeUser } = updatedUser;
  res.json({ ok: true, tx, user: safeUser, portfolio: pfs[uid] });
});

// GET /api/market/ranking
router.get('/ranking', (req, res) => {
  const stocks = db.get('stocks').value();
  const users  = db.get('users').filter(u => u.role !== 'admin').value();
  const pfs    = db.get('portfolios').value();

  const investors = users.map(u => {
    const pf = pfs[u.id] || {};
    let mv = 0;
    Object.entries(pf).forEach(([sym, qty]) => {
      const s = stocks.find(x => x.sym === sym);
      if (s) mv += s.price * qty;
    });
    return {
      id: u.id, name: u.nick || u.name,
      avatar: u.avatar, photo: u.photo,
      country: u.country,
      total: Math.round((u.balance + mv) * 100) / 100,
      cash:  u.balance, stocks: mv
    };
  }).sort((a, b) => b.total - a.total);

  const supplyDemand = [...stocks].sort((a, b) =>
    (b.demand / (b.demand + b.supply)) - (a.demand / (a.demand + a.supply)));
  const topTraded = [...stocks].sort((a, b) => b.volume - a.volume);

  res.json({ investors, supplyDemand: supplyDemand.slice(0, 8), topTraded: topTraded.slice(0, 8) });
});

module.exports = router;
