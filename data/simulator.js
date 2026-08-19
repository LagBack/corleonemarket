// ── MARKET SIMULATOR (MySQL-backed) ──
const pool = require('./mysql');
const econEngine = require('./economic-engine');
const econConfig = require('./economic-config');

const TICK_MS = 2500;
const DAY_RESET_CHECK_MS = 60000;   // check for new day once a minute
let tickTimer      = null;
let eventTimer     = null;
let dayCheckTimer  = null;
let dailyFeeTimer  = null;
let dailyFeeInterval = null;
let wealthTaxTimer   = null;
let wealthTaxInterval  = null;
let lastDayReset   = null;
let tickCount      = 0;               // counter for periodic priceHistory write-back

// In-memory cache of all companies (source of truth for the simulator)
let stocksCache = [];

// ── Random market events ──
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

async function isAdminEventLogged(msg) {
  // Async — don't await, just fire and forget
  pool.query('INSERT INTO admin_events (`t`, `msg`, `ts`) VALUES (?, ?, ?)',
    [new Date().toLocaleTimeString('pt-BR'), msg, Date.now()]
  ).catch(() => {});
}

function loadCache() {
  return pool.query('SELECT * FROM companies WHERE `status` = "active"').then(([rows]) => {
    stocksCache = rows.map(r => ({
      ...r,
      priceHistory: typeof r.price_history === 'string' ? JSON.parse(r.price_history) : (r.price_history || []),
    }));
  }).catch(() => { stocksCache = []; });
}

function flushPriceHistories() {
  // Write all priceHistory arrays back to MySQL in parallel
  const promises = [];
  for (const s of stocksCache) {
    if (!s.priceHistory || s.priceHistory.length === 0) continue;
    promises.push(
      pool.query('UPDATE companies SET `price_history` = ? WHERE `sym` = ?', [JSON.stringify(s.priceHistory), s.sym])
    );
  }
  return Promise.all(promises).catch(() => {});
}

function tick() {
  // Load market state and stocks each tick (market can be toggled open/closed externally)
  pool.query('SELECT `open` FROM market_state WHERE `id` = 1')
    .then(([rows]) => {
      if (!rows.length || !rows[0].open) return;
      _runTick();
    })
    .catch(() => {});
}

async function _runTick() {
  // Load fresh data from MySQL before each tick to pick up changes from orders/admin actions
  await loadCache();
  if (!stocksCache.length) return;

  for (const s of stocksCache) {
    if (s.status !== 'active') continue;

    // Backfill legacy data
    if (s.dayOpen == null || s.dayHigh == null || s.dayLow == null) {
      s.dayOpen  = s.dayOpen  != null ? s.dayOpen  : s.price;
      s.dayHigh  = s.dayHigh  != null ? s.dayHigh  : s.price;
      s.dayLow   = s.dayLow   != null ? s.dayLow   : s.price;
      s.dayResetAt = s.dayResetAt || Date.now();
    }

    const dr = s.demand / (s.demand + s.supply + 0.001);
    const drift = (dr - 0.5) * 0.003;
    const noise = (Math.random() - 0.5) * (s.vol || 0.015);
    const reversion = (s.open - s.price) / s.open * 0.002;

    let spike = 0;
    if (Math.random() < 0.015) {
      spike = (Math.random() < 0.45 ? 1 : -1) * (0.01 + Math.random() * 0.025);
    }

    const factor = 1 + drift + noise + reversion + spike;
    const floor  = s.open * 0.10;
    const newPrice = Math.max(floor, Math.round(s.price * factor * 100) / 100);

    const hist = s.priceHistory || [];
    hist.push(newPrice);
    if (hist.length > 80) hist.shift();

    s.price        = newPrice;
    s.priceHistory = hist;
    s.high         = Math.max(s.high || newPrice, newPrice);
    s.low          = Math.min(s.low  || newPrice, newPrice);
    s.dayHigh      = Math.max(s.dayHigh != null ? s.dayHigh : newPrice, newPrice);
    s.dayLow       = Math.min(s.dayLow  != null ? s.dayLow  : newPrice, newPrice);

    // Demand/supply drift back toward 0.5 (reversion to neutral)
    s.demand = Math.max(0.05, Math.min(0.95,
      s.demand * 0.995 + 0.5 * 0.005 + (Math.random() - 0.51) * 0.016));
    s.supply = Math.max(0.05, Math.min(0.95,
      s.supply * 0.995 + 0.5 * 0.005 + (Math.random() - 0.49) * 0.016));

    s.volume += Math.floor(Math.random() * 200 + 30);
  }

  // Write back scalar fields every tick (price, demand, supply, volume, day counters)
  const updatePromises = stocksCache.map(s =>
    pool.query(
      'UPDATE companies SET `price`=?, `demand`=?, `supply`=?, `volume`=?, `buys`=?, `sells`=?, `day_open`=?, `day_high`=?, `day_low`=?, `updated`=? WHERE `sym`=?',
      [s.price, s.demand, s.supply, s.volume, s.buys, s.sells, s.dayOpen, s.dayHigh, s.dayLow, Date.now(), s.sym]
    )
  );

  // Write priceHistory back every 10 ticks (40 seconds) to reduce JSON write overhead
  tickCount++;
  if (tickCount % 10 === 0) {
    updatePromises.push(flushPriceHistories());
  }

  await Promise.all(updatePromises).catch(() => {});
}

// ── Intraday counters reset ─────────────────────────────────────
async function resetDayCounters() {
  const now = Date.now();
  try {
    await pool.query('UPDATE companies SET `day_open`=?, `day_high`=?, `day_low`=?, `day_reset_at`=?, `updated`=?', [now, now, now, now, now]);
    return true;
  } catch(e) { return false; }
}

async function maybeResetDay() {
  const today = new Date().toDateString();
  if (lastDayReset === today) return false;
  const ok = await resetDayCounters();
  lastDayReset = today;
  if (ok) {
    pool.query('INSERT INTO admin_events (`t`, `msg`, `ts`) VALUES (?, ?, ?)',
      [new Date().toLocaleTimeString('pt-BR'), '🌅 Novo dia — contadores intraday (máx/mín/abertura do dia) resetados', Date.now()]
    ).catch(() => {});
    console.log('🌅 Day counters reset (new local day: ' + today + ')');
  }
  return ok;
}

// Fire a random news event on one stock every ~90s
async function fireRandomEvent() {
  try {
    const [marketRows] = await pool.query('SELECT open FROM market_state WHERE id = 1');
    if (!marketRows.length || !marketRows[0].open) return;

    const [rows] = await pool.query("SELECT * FROM companies WHERE `status` = 'active'");
    if (!rows.length) return;

    const target = rows[Math.floor(Math.random() * rows.length)];
    const event  = EVENTS[Math.floor(Math.random() * EVENTS.length)];

    // Update this stock's price/demand/supply via SQL
    const newPrice = Math.max(target.open * 0.10, Math.round(target.price * event.priceFactor * 100) / 100);
    await pool.query(
      "UPDATE companies SET `price`=?, `demand`=LEAST(GREATEST(`demand` + ?, 0.05), 0.95), `supply`=LEAST(GREATEST(`supply` + ?, 0.05), 0.95), `updated`=? WHERE `sym`=?",
      [newPrice, event.demandDelta, event.supplyDelta, Date.now(), target.sym]
    );

    // Update priceHistory (read-modify-write for this single stock)
    const [phRows] = await pool.query('SELECT `price_history` FROM companies WHERE `sym` = ?', [target.sym]);
    if (phRows.length) {
      let hist = typeof phRows[0].price_history === 'string' ? JSON.parse(phRows[0].price_history) : (phRows[0].price_history || []);
      hist.push(newPrice);
      if (hist.length > 80) hist.shift();
      await pool.query('UPDATE companies SET `price_history`=?, `updated`=? WHERE `sym`=?', [JSON.stringify(hist), Date.now(), target.sym]);
    }

    // Update day high/low
    const currentDay = new Date();
    const todayStr = currentDay.toDateString();
    const [dayRows] = await pool.query("SELECT `day_open`, `day_high`, `day_low` FROM companies WHERE `sym` = ? AND `status`='active'", [target.sym]);
    if (dayRows.length) {
      const d = dayRows[0];
      await pool.query(
        "UPDATE companies SET `day_high`=GREATEAST(`day_high`, ?), `day_low`=LEAST(`day_low`, ?), `updated`=? WHERE `sym`=?",
        [newPrice, newPrice, Date.now(), target.sym]
      );
    }

    pool.query('INSERT INTO admin_events (`t`, `msg`, `ts`) VALUES (?, ?, ?)',
      [new Date().toLocaleTimeString('pt-BR'),
       `📰 EVENTO [${target.sym}]: ${event.name} (${event.priceFactor >= 1 ? '+' : ''}${((event.priceFactor - 1) * 100).toFixed(0)}%)`,
       Date.now()]
    ).catch(() => {});

    console.log(`📰 Evento: ${target.sym} — ${event.name}`);
  } catch(e) {
    console.error('Error firing random event:', e.message);
  }
}

async function start() {
  if (tickTimer) return;

  // Load initial data into cache
  await loadCache();

  // Seed priceHistory for any stock that lacks it
  if (stocksCache.length > 0) {
    const needsHistory = stocksCache.filter(s => !s.priceHistory || s.priceHistory.length < 2);
    if (needsHistory.length > 0) {
      for (const s of needsHistory) {
        const hist = [];
        let p = s.price;
        for (let i = 0; i < 60; i++) {
          p = Math.max(s.open * 0.10,
            Math.round(p * (1 + (Math.random() - 0.5) * 0.005) * 100) / 100);
          hist.push(p);
        }
        s.priceHistory = hist;
        await pool.query(
          'UPDATE companies SET `price_history`=?, `high`=COALESCE(`high`,?), `low`=COALESCE(`low`,?) WHERE `sym`=?',
          [JSON.stringify(hist), s.high || s.price, s.low || s.price, s.sym]
        );
      }
    }

    // Ensure day counters exist
    for (const s of stocksCache) {
      if (s.dayOpen == null)  await pool.query("UPDATE companies SET `day_open`=?, `day_high`=?, `day_low`=?, `day_reset_at`=?, `updated`=? WHERE `sym`=?", [s.price, s.price, s.price, Date.now(), Date.now(), s.sym]);
    }
  }

  lastDayReset = new Date().toDateString();

  tickTimer     = setInterval(tick, TICK_MS);
  eventTimer    = setInterval(fireRandomEvent, 80000 + Math.random() * 40000);
  dayCheckTimer = setInterval(maybeResetDay, DAY_RESET_CHECK_MS);

  // ── Economic scheduled jobs ────────────────────────────────
  econEngine.checkMissedEconomicEvents().catch(e => console.error('Economic check:', e.message));

  const now = new Date();
  let msUntilThreeAM = (3 * 3600000) - now.getHours() * 3600000 - now.getMinutes() * 60000;
  if (msUntilThreeAM <= 0) msUntilThreeAM += 86400000;

  dailyFeeTimer = setTimeout(async () => {
    econEngine.chargeDailyMaintenance().catch(e => console.error('Daily maintenance error:', e.message));
    dailyFeeInterval = setInterval(async () => {
      await econEngine.chargeDailyMaintenance().catch(e => console.error('Daily maintenance error:', e.message));
    }, 86400000);
  }, msUntilThreeAM);

  const cycleMs = econConfig.wealthTaxCycleDays * 86400000;
  const daysSinceJan1 = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);
  const dayInCycle = daysSinceJan1 % econConfig.wealthTaxCycleDays;
  let msUntilNextCycle = (cycleMs - dayInCycle * 86400000) + (3 * 3600000) - now.getHours() * 3600000 - now.getMinutes() * 60000;
  if (msUntilNextCycle <= 0) msUntilNextCycle += cycleMs;

  wealthTaxTimer = setTimeout(() => {
    econEngine.chargeWealthTax().catch(e => console.error('Wealth tax error:', e.message));
    wealthTaxInterval = setInterval(async () => {
      await econEngine.chargeWealthTax().catch(e => console.error('Wealth tax error:', e.message));
    }, cycleMs);
  }, msUntilNextCycle);

  console.log(`📈 Simulador iniciado (tick ${TICK_MS}ms | eventos ~90s | reset diário ${DAY_RESET_CHECK_MS}ms)`);
}

function stop() {
  if (tickTimer)          { clearInterval(tickTimer);     tickTimer      = null; }
  if (eventTimer)         { clearInterval(eventTimer);    eventTimer     = null; }
  if (dayCheckTimer)      { clearInterval(dayCheckTimer); dayCheckTimer  = null; }
  if (dailyFeeTimer)      { clearTimeout(dailyFeeTimer);  dailyFeeTimer  = null; }
  if (dailyFeeInterval)   { clearInterval(dailyFeeInterval); dailyFeeInterval = null; }
  if (wealthTaxTimer)     { clearTimeout(wealthTaxTimer); wealthTaxTimer = null; }
  if (wealthTaxInterval)  { clearInterval(wealthTaxInterval); wealthTaxInterval = null; }
}

module.exports = { start, stop, tick, resetDayCounters, maybeResetDay };
