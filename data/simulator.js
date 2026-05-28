// ── MARKET SIMULATOR ──
const db = require('./db');

const TICK_MS = 2500;
let tickTimer  = null;
let eventTimer = null;

// ── Random market events (fire occasionally, not every tick) ──
const EVENTS = [
  { name: 'Escândalo contábil',      demandDelta: -0.15, supplyDelta: +0.15, priceFactor: 0.92 },
  { name: 'Resultado trimestral ruim', demandDelta: -0.10, supplyDelta: +0.10, priceFactor: 0.95 },
  { name: 'Resultado trimestral bom',  demandDelta: +0.10, supplyDelta: -0.10, priceFactor: 1.04 },
  { name: 'Insider selling',           demandDelta: -0.12, supplyDelta: +0.12, priceFactor: 0.94 },
  { name: 'Contrato bilionário',       demandDelta: +0.12, supplyDelta: -0.12, priceFactor: 1.05 },
  { name: 'Investigação regulatória',  demandDelta: -0.18, supplyDelta: +0.08, priceFactor: 0.90 },
  { name: 'IPO secundário',            demandDelta: -0.08, supplyDelta: +0.18, priceFactor: 0.96 },
  { name: 'Aquisição estratégica',     demandDelta: +0.08, supplyDelta: -0.08, priceFactor: 1.03 },
];

function tick() {
  if (!db.get('market.open').value()) return;

  const arr = db.get('stocks').value();
  if (!arr.length) return;

  arr.forEach(s => {
    if (s.status !== 'active') return;

    const dr = s.demand / (s.demand + s.supply + 0.001);

    // Drift: demand/supply imbalance — capped tightly so it can't runaway
    const drift = (dr - 0.5) * 0.003;

    // Noise: base randomness — always symmetric so losses are as likely as gains
    const noise = (Math.random() - 0.5) * (s.vol || 0.015);

    // Mean-reversion: pulls price back toward open price over time (prevents infinite drift)
    const reversion = (s.open - s.price) / s.open * 0.002;

    // Rare spike event: 1.5% chance per tick per stock (roughly every ~70 ticks = 3 min)
    let spike = 0;
    if (Math.random() < 0.015) {
      // spike can be positive OR negative, weighted slightly bearish to increase risk
      spike = (Math.random() < 0.45 ? 1 : -1) * (0.01 + Math.random() * 0.025);
    }

    const factor = 1 + drift + noise + reversion + spike;

    // Hard floor: price can't go below 10% of open (company still exists)
    const floor  = s.open * 0.10;
    const newPrice = Math.max(floor, Math.round(s.price * factor * 100) / 100);

    const hist = s.priceHistory || [];
    hist.push(newPrice);
    if (hist.length > 80) hist.shift();

    s.price        = newPrice;
    s.priceHistory = hist;
    s.high         = Math.max(s.high || newPrice, newPrice);
    s.low          = Math.min(s.low  || newPrice, newPrice);

    // Demand/supply drift back toward 0.5 gradually (reversion to neutral)
    s.demand = Math.max(0.05, Math.min(0.95,
      s.demand * 0.995 + 0.5 * 0.005 + (Math.random() - 0.51) * 0.016));
    s.supply = Math.max(0.05, Math.min(0.95,
      s.supply * 0.995 + 0.5 * 0.005 + (Math.random() - 0.49) * 0.016));

    s.volume += Math.floor(Math.random() * 200 + 30);
  });

  db.set('stocks', arr).write();
}

// Fire a random news event on one stock every ~90s
function fireRandomEvent() {
  if (!db.get('market.open').value()) return;
  const arr = db.get('stocks').value().filter(s => s.status === 'active');
  if (!arr.length) return;

  const target = arr[Math.floor(Math.random() * arr.length)];
  const event  = EVENTS[Math.floor(Math.random() * EVENTS.length)];

  const idx = db.get('stocks').value().findIndex(s => s.sym === target.sym);
  if (idx < 0) return;

  const stocks = db.get('stocks').value();
  const s      = stocks[idx];

  s.price   = Math.max(s.open * 0.10, Math.round(s.price * event.priceFactor * 100) / 100);
  s.demand  = Math.max(0.05, Math.min(0.95, s.demand + event.demandDelta));
  s.supply  = Math.max(0.05, Math.min(0.95, s.supply + event.supplyDelta));

  const hist = s.priceHistory || [];
  hist.push(s.price);
  if (hist.length > 80) hist.shift();
  s.priceHistory = hist;

  stocks[idx] = s;
  db.set('stocks', stocks).write();

  db.get('adminLog').push({
    t:   new Date().toLocaleTimeString('pt-BR'),
    msg: `📰 EVENTO [${target.sym}]: ${event.name} (${event.priceFactor >= 1 ? '+' : ''}${((event.priceFactor - 1) * 100).toFixed(0)}%)`
  }).write();

  console.log(`📰 Evento: ${target.sym} — ${event.name}`);
}

function start() {
  if (tickTimer) return;

  // Seed priceHistory for any stock that lacks it
  const arr = db.get('stocks').value();
  arr.forEach(s => {
    if (!s.priceHistory || s.priceHistory.length < 2) {
      const hist = [];
      let p = s.price;
      for (let i = 0; i < 60; i++) {
        p = Math.max(s.open * 0.10,
          Math.round(p * (1 + (Math.random() - 0.5) * 0.005) * 100) / 100);
        hist.push(p);
      }
      s.priceHistory = hist;
      s.high = s.high || s.price;
      s.low  = s.low  || s.price;
    }
  });
  db.set('stocks', arr).write();

  tickTimer  = setInterval(tick, TICK_MS);
  // Random event every 80–120s
  eventTimer = setInterval(fireRandomEvent, 80000 + Math.random() * 40000);

  console.log(`📈 Simulador iniciado (tick ${TICK_MS}ms | eventos ~90s)`);
}

function stop() {
  if (tickTimer)  { clearInterval(tickTimer);  tickTimer  = null; }
  if (eventTimer) { clearInterval(eventTimer); eventTimer = null; }
}

module.exports = { start, stop, tick };
