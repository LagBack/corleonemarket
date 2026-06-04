const router = require('express').Router();
const db = require('../data/db');
const usersStore = require('../data/users-store');
const { requireAuth } = require('../middleware/auth');

function getPortfolio(uid) {
  const pfs = db.get('portfolios').value();
  if (!pfs[uid]) {
    pfs[uid] = {};
    db.set('portfolios', pfs).write();
  }
  return pfs;
}

// GET /api/market/state
router.get('/state', (req, res) => {
  const stocks   = db.get('stocks').value();
  const open     = db.get('market.open').value();
  const ibcx     = stocks.length
    ? stocks.reduce((a, s) => a + (s.price / s.open * 1000), 0) / stocks.length
    : 1000;
  const totalVol = stocks.reduce((a, s) => a + s.volume * s.price, 0);
  const stocksLite = stocks.map(({ priceHistory, ...s }) => s);
  res.json({ stocks: stocksLite, open, ibcx, totalVol });
});

// GET /api/market/history/:sym
router.get('/history/:sym', (req, res) => {
  const sym   = req.params.sym.toUpperCase();
  const stock = db.get('stocks').find({ sym }).value();
  if (!stock) return res.status(404).json({ error: 'Ativo não encontrado' });
  res.json({ sym, history: stock.priceHistory || [] });
});

// GET /api/market/portfolio
router.get('/portfolio', requireAuth, async (req, res) => {
  try {
    const uid  = req.session.userId;
    const user = await usersStore.getUserById(uid);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    const pfs  = db.get('portfolios').value();
    const pf   = pfs[uid] || {};
    const txs  = db.get('transactions').filter({ uid }).value();
    res.json({ user: usersStore.safeUser(user), portfolio: pf, transactions: txs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/market/order
router.post('/order', requireAuth, async (req, res) => {
  try {
    if (!db.get('market.open').value()) {
      return res.status(403).json({ error: 'Mercado está fechado.' });
    }

    const { sym, type, qty } = req.body;
    const quantity = parseInt(qty, 10);
    if (!sym || !type || !quantity || quantity < 1) {
      return res.status(400).json({ error: 'Parâmetros inválidos.' });
    }

    const uid   = req.session.userId;
    const user  = await usersStore.getUserById(uid);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });

    const stock = db.get('stocks').find({ sym }).value();
    if (!stock) return res.status(404).json({ error: 'Ativo não encontrado.' });
    if (stock.status !== 'active') return res.status(403).json({ error: 'Ativo suspenso.' });

    const total = Math.round(stock.price * quantity * 100) / 100;
    const pfs   = getPortfolio(uid);

    if (type === 'buy') {
      if (user.balance < total) return res.status(400).json({ error: 'Saldo insuficiente.' });
      await usersStore.setUserBalance(uid, user.balance - total);
      pfs[uid][sym] = (pfs[uid][sym] || 0) + quantity;
      db.get('stocks').find({ sym }).assign({
        demand: Math.min(0.95, stock.demand + 0.03),
        buys:   stock.buys + quantity,
        volume: stock.volume + quantity
      }).write();
    } else if (type === 'sell') {
      const owned = pfs[uid][sym] || 0;
      if (owned < quantity) return res.status(400).json({ error: 'Cotas insuficientes.' });
      await usersStore.setUserBalance(uid, user.balance + total);
      pfs[uid][sym] -= quantity;
      if (pfs[uid][sym] === 0) delete pfs[uid][sym];
      db.get('stocks').find({ sym }).assign({
        supply: Math.min(0.95, stock.supply + 0.03),
        sells:  stock.sells + quantity,
        volume: stock.volume + quantity
      }).write();
    } else {
      return res.status(400).json({ error: 'Tipo de ordem inválido.' });
    }

    db.set('portfolios', pfs).write();

    const tx = {
      id:    Date.now(),
      uid,
      uname: user.nick || user.name,
      type, sym,
      qty:   quantity,
      price: stock.price,
      total,
      time:  new Date().toLocaleTimeString('pt-BR'),
      ts:    Date.now()
    };
    db.get('transactions').push(tx).write();

    const freshStock = db.get('stocks').find({ sym }).value();
    if (freshStock && Array.isArray(freshStock.owners) && freshStock.owners.length > 0) {
      let totalPaid = 0;
      const divs = db.get('dividends').value() || [];

      for (const owner of freshStock.owners) {
        const fee = Math.round(total * (owner.pct / 100) * 100) / 100;
        if (fee < 0.01) continue;
        const ownerUser = await usersStore.getUserById(owner.userId);
        if (!ownerUser) continue;
        await usersStore.adjustUserBalance(owner.userId, fee);
        totalPaid += fee;
        divs.push({
          id:         Date.now() + Math.random(),
          founderId:  owner.userId,
          sym,
          stockName:  freshStock.name,
          ownerName:  owner.name,
          traderName: user.nick || user.name,
          type,
          tradeTotal: total,
          pct:        owner.pct,
          fee,
          time: new Date().toLocaleTimeString('pt-BR'),
          ts:   Date.now()
        });
      }

      if (totalPaid > 0) {
        db.set('dividends', divs).write();
        db.get('stocks').find({ sym })
          .assign({ totalRevenue: (freshStock.totalRevenue || 0) + totalPaid }).write();
      }
    }

    db.get('adminLog').push({
      t:   new Date().toLocaleTimeString('pt-BR'),
      msg: `${user.nick || user.name} ${type === 'buy' ? 'COMPROU' : 'VENDEU'} ${quantity}× ${sym} @ R$${stock.price.toFixed(2)}`
    }).write();

    const updatedUser = await usersStore.getUserById(uid);
    res.json({
      ok: true,
      tx,
      user: usersStore.safeUser(updatedUser),
      portfolio: pfs[uid]
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/market/ranking
router.get('/ranking', async (req, res) => {
  try {
    const stocks = db.get('stocks').value();
    const users  = await usersStore.getAllUsers();
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
        role: u.role,
        country: u.country,
        total: Math.round((u.balance + mv) * 100) / 100,
        cash:  u.balance, stocks: mv
      };
    }).sort((a, b) => b.total - a.total);

    const supplyDemand = [...stocks].sort((a, b) =>
      (b.demand / (b.demand + b.supply)) - (a.demand / (a.demand + a.supply)));
    const topTraded = [...stocks].sort((a, b) => b.volume - a.volume);

    res.json({ investors, supplyDemand: supplyDemand.slice(0, 8), topTraded: topTraded.slice(0, 8) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/market/ownership-offers
router.get('/ownership-offers', async (req, res) => {
  try {
    const offers = db.get('ownershipOffers').value() || [];
    const enriched = [];
    for (const o of offers.filter(x => x.status === 'open')) {
      const s = db.get('stocks').find({ sym: o.sym }).value();
      const seller = await usersStore.getUserById(o.sellerId);
      enriched.push({
        ...o,
        stockName: s ? s.name : o.sym,
        sellerName: seller ? (seller.nick || seller.name) : '?',
      });
    }
    res.json(enriched);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/market/ownership-offers
router.post('/ownership-offers', requireAuth, async (req, res) => {
  try {
    const { sym, pctToSell, askPrice } = req.body;
    if (!sym || !pctToSell || !askPrice) {
      return res.status(400).json({ error: 'sym, pctToSell e askPrice são obrigatórios.' });
    }

    const uid   = req.session.userId;
    const stock = db.get('stocks').find({ sym }).value();
    if (!stock) return res.status(404).json({ error: 'Ativo não encontrado.' });

    const ownedPct = (stock.ownershipShares || {})[uid] || 0;
    const pct = parseFloat(pctToSell);
    if (ownedPct <= 0) return res.status(403).json({ error: 'Você não tem participação nessa empresa.' });
    if (pct > ownedPct) return res.status(400).json({ error: `Você só pode vender até ${ownedPct.toFixed(3)}% da sua participação.` });
    if (pct <= 0) return res.status(400).json({ error: 'Porcentagem inválida.' });

    const offer = {
      id:        'offer_' + Date.now(),
      sym,
      sellerId:  uid,
      pct,
      askPrice:  parseFloat(askPrice),
      status:    'open',
      createdAt: Date.now(),
      time:      new Date().toLocaleTimeString('pt-BR'),
    };

    const offers = db.get('ownershipOffers').value() || [];
    offers.push(offer);
    db.set('ownershipOffers', offers).write();

    const user = await usersStore.getUserById(uid);
    db.get('adminLog').push({
      t:   new Date().toLocaleTimeString('pt-BR'),
      msg: `${user.nick || user.name} listou ${pct.toFixed(3)}% de ${sym} para venda por R$${parseFloat(askPrice).toFixed(2)}`
    }).write();

    res.json({ ok: true, offer });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/market/ownership-offers/:id/buy
router.post('/ownership-offers/:id/buy', requireAuth, async (req, res) => {
  try {
    const uid    = req.session.userId;
    const offers = db.get('ownershipOffers').value() || [];
    const offerIdx = offers.findIndex(o => o.id === req.params.id && o.status === 'open');
    if (offerIdx < 0) return res.status(404).json({ error: 'Oferta não encontrada ou já encerrada.' });

    const offer = offers[offerIdx];
    if (offer.sellerId === uid) return res.status(400).json({ error: 'Você não pode comprar sua própria oferta.' });

    const buyer  = await usersStore.getUserById(uid);
    const seller = await usersStore.getUserById(offer.sellerId);
    const stock  = db.get('stocks').find({ sym: offer.sym }).value();
    if (!buyer || !seller || !stock) {
      return res.status(404).json({ error: 'Usuário ou ativo não encontrado.' });
    }

    if (buyer.balance < offer.askPrice) {
      return res.status(400).json({ error: 'Saldo insuficiente para comprar esta participação.' });
    }

    await usersStore.setUserBalance(uid, buyer.balance - offer.askPrice);
    await usersStore.setUserBalance(offer.sellerId, seller.balance + offer.askPrice);

    const os = stock.ownershipShares || {};
    os[offer.sellerId] = Math.round(((os[offer.sellerId] || 0) - offer.pct) * 10000) / 10000;
    if (os[offer.sellerId] <= 0) delete os[offer.sellerId];
    os[uid] = Math.round(((os[uid] || 0) + offer.pct) * 10000) / 10000;

    const owners = stock.owners || [];
    const sellerOwnerIdx = owners.findIndex(o => o.userId === offer.sellerId);
    if (sellerOwnerIdx >= 0) {
      owners[sellerOwnerIdx].pct -= offer.pct;
      if (owners[sellerOwnerIdx].pct <= 0) owners.splice(sellerOwnerIdx, 1);
    }
    const buyerOwnerIdx = owners.findIndex(o => o.userId === uid);
    if (buyerOwnerIdx >= 0) {
      owners[buyerOwnerIdx].pct += offer.pct;
    } else {
      owners.push({ userId: uid, name: buyer.nick || buyer.name, pct: offer.pct });
    }

    db.get('stocks').find({ sym: offer.sym }).assign({ ownershipShares: os, owners }).write();

    offers[offerIdx].status = 'sold';
    offers[offerIdx].buyerId = uid;
    offers[offerIdx].soldAt = Date.now();
    db.set('ownershipOffers', offers).write();

    db.get('adminLog').push({
      t:   new Date().toLocaleTimeString('pt-BR'),
      msg: `${buyer.nick || buyer.name} comprou ${offer.pct.toFixed(3)}% de ${offer.sym} de ${seller.nick || seller.name} por R$${offer.askPrice.toFixed(2)}`
    }).write();

    const updatedBuyer = await usersStore.getUserById(uid);
    res.json({ ok: true, user: usersStore.safeUser(updatedBuyer) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/market/ownership-offers/:id
router.delete('/ownership-offers/:id', requireAuth, (req, res) => {
  const uid    = req.session.userId;
  const offers = db.get('ownershipOffers').value() || [];
  const idx    = offers.findIndex(o => o.id === req.params.id && o.sellerId === uid && o.status === 'open');
  if (idx < 0) return res.status(404).json({ error: 'Oferta não encontrada.' });
  offers[idx].status = 'cancelled';
  db.set('ownershipOffers', offers).write();
  res.json({ ok: true });
});

module.exports = router;
