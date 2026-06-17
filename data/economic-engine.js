// ── Economic Engine ───────────────────────────────────────────────────
// Handles daily maintenance fees, wealth taxes, and insufficient-fund debt tracking.

const db      = require('./db');
const pool    = require('./mysql');
const config  = require('./economic-config');
const usersStore = require('./users-store');

let lastWealthTaxDate = null;   // 'Mon Jun 09 2026' style — toDateString() dedup

// ── Helpers ────────────────────────────────────────────────────────────

function getTodayKey() {
  return new Date().toLocaleDateString('en-CA');  // YYYY-MM-DD format (ISO)
}

function getCycleKey() {
  const now = new Date();
  // Cycle starts from Jan 1 each year, repeating every wealthTaxCycleDays
  const dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);
  const cycleStart = dayOfYear - (dayOfYear % config.wealthTaxCycleDays);
  const cycleDate = new Date(now.getFullYear(), 0, 0);
  cycleDate.setDate(cycleDate.getDate() + cycleStart);
  return cycleDate.toLocaleDateString('en-CA');  // YYYY-MM-DD of cycle start
}

function formatCurrency(value) {
  return value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Compute a user's total net worth = cash balance + portfolio market value
 */
async function computeNetWorth(uid) {
  const user = await usersStore.getUserById(uid);
  if (!user) return { netWorth: 0, cash: 0, marketValue: 0 };

  // Portfolio market value from MySQL portfolios table
  const [pfRows] = await pool.query('SELECT sym, qty FROM portfolios WHERE user_id = ? AND qty > 0', [uid]);
  const stocks = db.get('stocks').value();

  let mv = 0;
  for (const r of pfRows) {
    const s = stocks.find(x => x.sym === r.sym);
    if (s && s.status === 'active') mv += s.price * r.qty;
  }

  const netWorth = user.balance + mv;
  return { netWorth: Math.round(netWorth * 100) / 100, cash: user.balance, marketValue: Math.round(mv * 100) / 100 };
}

/**
 * Apply debt to a user who cannot pay a full fee.
 * Negative balances allowed down to -50000 (debt limit).
 */
async function recordDebt(uid, amountNeeded) {
  const user = await usersStore.getUserById(uid);
  if (!user) return;

  // Debt = the unpayable portion of the fee
  const debt = Math.max(0, amountNeeded - user.balance);
  if (debt <= 0) return;

  // Clamp to max allowed debt (50K)
  const clampedDebt = Math.min(debt, 50000);
  const newBalance = Math.max(-50000, user.balance - amountNeeded);

  await pool.query('UPDATE users SET balance = ? WHERE id = ?', [newBalance, uid]);

  // Log to admin log
  db.get('adminLog').push({
    t: new Date().toLocaleTimeString('pt-BR'),
    msg: `⚠️ ${user.nick || user.name} acumula dívida de R$${formatCurrency(clampedDebt)} por taxa econômica`
  }).write();

  return clampedDebt;
}

/**
 * Record an economic fee/fee tax to the audit table.
 */
async function recordEconomicFee(userId, feeType, amount, netWorth, dayKey, cycleKey) {
  const uid = String(userId);

  // Determine dedup key based on fee type
  let dedupCol, dedupVal;
  if (feeType === 'daily_maintenance') {
    dedupCol = 'day_key';
    dedupVal = dayKey;
  } else {
    dedupCol = 'cycle_key';
    dedupVal = cycleKey;
  }

  // Idempotency check — skip if already charged
  try {
    const [rows] = await pool.query(
      `SELECT id FROM economic_fees WHERE user_id = ? AND fee_type = ? AND ${dedupCol} = ?`,
      [uid, feeType, dedupVal]
    );
    if (rows.length > 0) return null; // already charged this period
  } catch (e) {
    // Table may not exist yet (migration not run) — fall through gracefully
    console.warn('economic_fees table may not exist:', e.message);
    return null;
  }

  const createdAt = Date.now();
  try {
    await pool.query(
      `INSERT INTO economic_fees (user_id, fee_type, amount, net_worth, day_key, cycle_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [uid, feeType, Math.round(amount * 100) / 100, Math.round(netWorth * 100) / 100, dedupCol === 'day_key' ? dedupVal : null, dedupCol === 'cycle_key' ? dedupVal : null, createdAt]
    );
    return { userId: uid, feeType, amount, netWorth, dedupCol, dedupVal };
  } catch (e) {
    // Duplicate key — already charged
    if (/Duplicate.*uk_user_fee/i.test(e.message)) return null;
    console.error('Error recording economic fee:', e.message);
    return null;
  }
}

// ── Main Economic Functions ────────────────────────────────────────────

/**
 * Charge daily maintenance fee to all users.
 * Called once per day by the simulator's scheduled timer.
 */
async function chargeDailyMaintenance() {
  console.log('💰 Starting daily maintenance fee calculation...');

  const dayKey = getTodayKey();
  const [userRows] = await pool.query('SELECT id, nick, name FROM users');
  let processed = 0;
  let skipped = 0;

  for (const user of userRows) {
    try {
      const { netWorth, cash } = await computeNetWorth(user.id);
      if (netWorth <= 1_000_000) {
        // Below threshold — no fee
        skipped++;
        continue;
      }

      const fee = config.calculateDailyMaintenance(netWorth);
      if (fee <= 0) continue;

      if (cash >= fee) {
        // User can pay the full fee
        await pool.query('UPDATE users SET balance = balance - ? WHERE id = ?', [fee, user.id]);
      } else {
        // Insufficient funds — charge what we can and record debt
        const debt = await recordDebt(user.id, fee);
        if (debt !== null) {
          // Partial payment recorded
        }
      }

      await recordEconomicFee(user.id, 'daily_maintenance', fee, netWorth, dayKey, null);

      // Log to admin log for audit trail
      db.get('adminLog').push({
        t: new Date().toLocaleTimeString('pt-BR'),
        msg: `📋 Taxa diária: ${user.nick || user.name} — R$${formatCurrency(fee)} (patrimônio: R$${formatCurrency(netWorth)})`
      }).write();

      processed++;
    } catch (e) {
      console.error(`Error charging daily maintenance for ${user.nick}:`, e.message);
    }
  }

  console.log(`✅ Daily maintenance complete: ${processed} charged, ${skipped} skipped (below threshold)`);
}

/**
 * Charge bi-weekly wealth tax to all users.
 * Called every wealthTaxCycleDays by the simulator's scheduled timer.
 */
async function chargeWealthTax() {
  console.log('🏛️ Starting wealth tax calculation...');

  const cycleKey = getCycleKey();

  // Dedup: skip if already charged this cycle
  try {
    const [rows] = await pool.query(
      `SELECT COUNT(*) as cnt FROM economic_fees WHERE fee_type = 'wealth_tax' AND cycle_key = ?`,
      [cycleKey]
    );
    if (rows[0].cnt > 0) {
      console.log('⏭️ Wealth tax already charged this cycle. Skipping.');
      return;
    }
  } catch (e) {
    // Table may not exist yet
    console.warn('economic_fees table may not exist:', e.message);
    return;
  }

  const [userRows] = await pool.query('SELECT id, nick, name FROM users');
  let processed = 0;

  for (const user of userRows) {
    try {
      const { netWorth, cash } = await computeNetWorth(user.id);
      if (netWorth < 5_000_000) {
        // Below minimum tax threshold
        continue;
      }

      const tax = config.calculateWealthTax(netWorth);
      if (tax <= 0) continue;

      if (cash >= tax) {
        await pool.query('UPDATE users SET balance = balance - ? WHERE id = ?', [tax, user.id]);
      } else {
        const debt = await recordDebt(user.id, tax);
      }

      await recordEconomicFee(user.id, 'wealth_tax', tax, netWorth, null, cycleKey);

      db.get('adminLog').push({
        t: new Date().toLocaleTimeString('pt-BR'),
        msg: `🏛️ Imposto patrimonial: ${user.nick || user.name} — R$${formatCurrency(tax)} (patrimônio: R$${formatCurrency(netWorth)})`
      }).write();

      processed++;
    } catch (e) {
      console.error(`Error charging wealth tax for ${user.nick}:`, e.message);
    }
  }

  // Mark this cycle as taxed so the dedup in recordEconomicFee doesn't double-count
  try {
    await pool.query(
      `INSERT INTO economic_fees (user_id, fee_type, amount, net_worth, cycle_key, created_at)
       VALUES (?, 'wealth_tax_cycle_mark', 0, 0, ?, ?)`,
      ['system', cycleKey, Date.now()]
    );
  } catch (_) { /* ignore mark failures */ }

  console.log(`✅ Wealth tax complete: ${processed} users taxed`);
}

/**
 * Check and fire missed economic events on startup.
 * Ensures fees/taxes aren't skipped during downtime.
 */
async function checkMissedEconomicEvents() {
  try {
    // Check for missed daily maintenance
    const [dailyRows] = await pool.query(
      `SELECT MAX(day_key) as last_day FROM economic_fees WHERE fee_type = 'daily_maintenance'`
    );

    if (dailyRows[0].last_day) {
      const lastDay = new Date(dailyRows[0].last_day);
      const today = new Date();
      const daysSinceLast = Math.floor((today - lastDay) / 86400000);

      if (daysSinceLast > 1) {
        console.log(`⚠️ Detected ${daysSinceLast} missed day(s) of maintenance fees.`);
        // Fire for each missed day
        for (let i = daysSinceLast; i >= 1; i--) {
          const missDate = new Date(today);
          missDate.setDate(missDate.getDate() - i);
          const missDayKey = missDate.toLocaleDateString('en-CA');

          const [userRows] = await pool.query('SELECT id, nick, name FROM users');
          for (const user of userRows) {
            const { netWorth } = await computeNetWorth(user.id);
            if (netWorth > 1_000_000) {
              const fee = config.calculateDailyMaintenance(netWorth);
              await recordEconomicFee(user.id, 'daily_maintenance', fee, netWorth, missDayKey, null);

              // Apply the charge too
              const [userRows2] = await pool.query('SELECT id, balance FROM users WHERE id = ?', [user.id]);
              if (userRows2.length && userRows2[0].balance >= fee) {
                await pool.query('UPDATE users SET balance = balance - ? WHERE id = ?', [fee, user.id]);
              } else if (userRows2.length) {
                const debt = Math.min(userRows2[0].balance < 0 ? Math.abs(userRows2[0].balance) + fee : fee, 50000);
                await pool.query('UPDATE users SET balance = GREATEST(balance - fee, -50000) WHERE id = ?', [fee, user.id]);
              }

              db.get('adminLog').push({
                t: new Date().toLocaleTimeString('pt-BR'),
                msg: `⏰ Recarga de taxa diária (dia perdido ${missDayKey}): ${user.nick || user.name} — R$${formatCurrency(fee)}`
              }).write();
            }
          }
        }
      }
    }

    // Check for missed wealth tax (simpler: just fire if it's been > cycleDays)
    const [taxRows] = await pool.query(
      `SELECT MAX(cycle_key) as last_cycle FROM economic_fees WHERE fee_type LIKE 'wealth_tax%'`
    );

    if (taxRows[0].last_cycle) {
      // Extract year-month-day from the cycle key (YYYY-MM-DD)
      const [cycleYear, cycleMonth, cycleDay] = taxRows[0].last_cycle.split('-').map(Number);
      const lastCycleDate = new Date(cycleYear, cycleMonth - 1, cycleDay);
      const today = new Date();
      const daysSinceLast = Math.floor((today - lastCycleDate) / 86400000);

      if (daysSinceLast > config.wealthTaxCycleDays) {
        console.log(`⚠️ Detected missed wealth tax cycle (${daysSinceLast} days since last). Firing now.`);
        await chargeWealthTax();
      }
    }
  } catch (e) {
    // economic_fees table may not exist yet
    if (/Unknown table/i.test(e.message)) return;
    console.error('Error checking missed economic events:', e.message);
  }
}

module.exports = {
  chargeDailyMaintenance,
  chargeWealthTax,
  checkMissedEconomicEvents,
  computeNetWorth,
  recordDebt,
  formatCurrency,
};
