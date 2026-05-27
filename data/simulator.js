// ── MARKET SIMULATOR — roda no servidor, atualiza o DB a cada 2.5s ──
const db = require('./db');

const TICK_MS = 2500;
let tickTimer = null;

function tick() {
  if (!db.get('market.open').value()) return;

  const arr = db.get('stocks').value();
  if (!arr.length) return;

  arr.forEach(s => {
    if (s.status !== 'active') return;

    const dr    = s.demand / (s.demand + s.supply + 0.001);
    const drift = (dr - 0.5) * 0.004;
    const noise = (Math.random() - 0.5) * (s.vol || 0.015);
    const factor = 1 + drift + noise;

    const newPrice = Math.max(0.01, Math.round(s.price * factor * 100) / 100);

    // price history: store last 80 points
    const hist = s.priceHistory || [];
    hist.push(newPrice);
    if (hist.length > 80) hist.shift();

    s.price        = newPrice;
    s.priceHistory = hist;
    s.high         = Math.max(s.high || newPrice, newPrice);
    s.low          = Math.min(s.low  || newPrice, newPrice);
    s.demand       = Math.max(0.05, Math.min(0.95, s.demand + (Math.random() - 0.51) * 0.018));
    s.supply       = Math.max(0.05, Math.min(0.95, s.supply + (Math.random() - 0.49) * 0.018));
    s.volume      += Math.floor(Math.random() * 250 + 40);
  });

  db.set('stocks', arr).write();
}

function start() {
  if (tickTimer) return;

  // seed priceHistory for stocks that have none
  const arr = db.get('stocks').value();
  arr.forEach(s => {
    if (!s.priceHistory || s.priceHistory.length < 2) {
      const hist = [];
      let p = s.price;
      for (let i = 0; i < 60; i++) {
        p = Math.max(0.01, Math.round(p * (1 + (Math.random() - 0.5) * 0.004) * 100) / 100);
        hist.push(p);
      }
      s.priceHistory = hist;
      s.high = s.high || s.price;
      s.low  = s.low  || s.price;
    }
  });
  db.set('stocks', arr).write();

  tickTimer = setInterval(tick, TICK_MS);
  console.log(`📈 Simulador iniciado (tick a cada ${TICK_MS}ms)`);
}

function stop() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
}

module.exports = { start, stop, tick };
