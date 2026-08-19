// ── Economic Engine (MySQL-backed) ───────────────────────────────────
// Handles daily maintenance fees, wealth taxes, and insufficient-fund debt tracking.

const pool = require('./mysql');
const config = require('./economic-config');
const usersStore = require('./users-store');

let lastWealthTaxDate = null;   // 'Mon Jun 09 2026' style — toDateString() dedup

// ── Helpers ────────────────────────────────────────────────────────────

function getTodayKey() {
  return new Date().toLocaleDateString('en-CA');
}

function getCycleKey() {
  const now = new Date();
  const dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);
  const cycleStart = dayOfYear - (dayOfYear % config.wealthTaxCycleDays);
  const cycleDate = new Date(now.getFullYear(), 0, 0);
  cycleDate.setDate(cycleDate.getDate() + cycleStart);
  return cycleDate.toLocaleDateString('en-CA');
}

function formatCurrency(value) {
  return value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function logAdmin(msg) {
  pool.query('INSERT INTO admin_events (`t`, `msg`, `ts`) VALUES (?, ?, ?)',
    [new Date().toLocaleTimeString('pt-BR'), msg, Date.now()]
  ).catch(() => {});
}

/**
 * Compute a user's total net worth = cash balance + portfolio market value
 */
async function computeNetWorth(uid) {
  const user = await usersStore.getUserById(uid);
  if (!user) return { netWorth: 0, cash: 0, marketValue: 0 };

  // Portfolio market value from MySQL portfolios table
  const [pfRows] = await pool.query('SELECT sym, qty FROM portfolios WHERE user_id = ? AND qty > 0', [uid]);

  let mv = 0;
  for (const r of pfRows) {
    try {
      const [stockRows] = await pool.query('SELECT `price`, `status` FROM companies WHERE `sym` = ?', [r.sym]);
      if (stockRows.length && stockRows[0].status === 'active') mv += stockRows[0].price * r.qty;
    } catch(_) {} // company table may not exist yet during migration
  }

  const netWorth = user.balance + mv;
  return { netWorth: Math.round(netWorth * 100) / 100, cash: user.balance, marketValue: Math.round(mv * 100) / 100 };
}

/**
 * Apply debt to a user who cannot pay a full fee.
 */
async function recordDebt(uid, amountNeeded) {
  const user = await usersStore.getUserById(uid);
  if (!user) return;

  const debt = Math.max(0, amountNeeded - user.balance);
  if (debt <= 0) return;

  const clampedDebt = Math.min(debt, 50000);
  const newBalance = Math.max(-50000, user.balance - amountNeeded);

  await pool.query('UPDATE users SET `balance` = ? WHERE `id` = ?', [newBalance, uid]);

  await logAdmin(`⚠️ ${user.nick || user.name} acumula dívida de R$${formatCurrency(clampedDebt)} por taxa econômica`);
  return clampedDebt;
}

/**
 * Record an economic fee/fee tax to the audit table.
 */
async function recordEconomicFee(userId, feeType, amount, netWorth, dayKey, cycleKey) {
  const uid = String(userId);

  let dedupCol, dedupVal;
  if (feeType === 'daily_maintenance') {
    dedupCol = 'day_key';
    dedupVal = dayKey;
  } else {
    dedupCol = 'cycle_key';
    dedupVal = cycleKey;
  }

  try {
    const [rows] = await pool.query(
      `SELECT id FROM economic_fees WHERE user_id = ? AND fee_type = ? AND ${dedupCol} = ?`,
      [uid, feeType, dedupVal]
    );
    if (rows.length > 0) return null;
  } catch (e) {
    console.warn('economic_fees table may not exist:', e.message);
    return null;
  }

  const createdAt = Date.now();
  try {
    await pool.query(
      `INSERT INTO economic_fees (\`user_id\`, \`fee_type\`, \`amount\`, \`net_worth\`, \`day_key\`, \`cycle_key\`, \`created_at\`)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [uid, feeType, Math.round(amount * 100) / 100, Math.round(netWorth * 100) / 100, dedupCol === 'day_key' ? dedupVal : null, dedupCol === 'cycle_key' ? dedupVal : null, createdAt]
    );
    return { userId: uid, feeType, amount, netWorth, dedupCol, dedupVal };
  } catch (e) {
    if (/Duplicate.*uk_user_fee/i.test(e.message)) return null;
    console.error('Error recording economic fee:', e.message);
    return null;
  }
}

// ── Main Economic Functions ────────────────────────────────────────────

async function chargeDailyMaintenance() {
  console.log('💰 Starting daily maintenance fee calculation...');

  const dayKey = getTodayKey();
  const [userRows] = await pool.query('SELECT id, nick, name FROM users');
  let processed = 0;
  let skipped = 0;

  for (const user of userRows) {
    try {
      const { netWorth, cash } = await computeNetWorth(user.id);
      if (netWorth <= 1_000_000) { skipped++; continue; }

      const fee = config.calculateDailyMaintenance(netWorth);
      if (fee <= 0) continue;

      if (cash >= fee) {
        await pool.query('UPDATE users SET `balance` = `balance` - ? WHERE `id` = ?', [fee, user.id]);
      } else {
        const debt = await recordDebt(user.id, fee);
        // Partial payment recorded above
      }

      await recordEconomicFee(user.id, 'daily_maintenance', fee, netWorth, dayKey, null);
      await logAdmin(`📋 Taxa diária: ${user.nick || user.name} — R$${formatCurrency(fee)} (patrimônio: R$${formatCurrency(netWorth)})`);
      processed++;
    } catch (e) {
      console.error(`Error charging daily maintenance for ${user.nick}:`, e.message);
    }
  }

  console.log(`✅ Daily maintenance complete: ${processed} charged, ${skipped} skipped (below threshold)`);
}

async function chargeWealthTax() {
  console.log('🏛️ Starting wealth tax calculation...');

  const cycleKey = getCycleKey();

  try {
    const [rows] = await pool.query(
      `SELECT COUNT(*) as cnt FROM economic_fees WHERE fee_type = 'wealth_tax' AND cycle_key = ?`,
      [cycleKey]
    );
    if (rows[0].cnt > 0) { console.log('⏭️ Wealth tax already charged this cycle. Skipping.'); return; }
  } catch (e) {
    console.warn('economic_fees table may not exist:', e.message);
    return;
  }

  const [userRows] = await pool.query('SELECT id, nick, name FROM users');
  let processed = 0;

  for (const user of userRows) {
    try {
      const { netWorth, cash } = await computeNetWorth(user.id);
      if (netWorth < 5_000_000) continue;

      const tax = config.calculateWealthTax(netWorth);
      if (tax <= 0) continue;

      if (cash >= tax) {
        await pool.query('UPDATE users SET `balance` = `balance` - ? WHERE `id` = ?', [tax, user.id]);
      } else {
        await recordDebt(user.id, tax);
      }

      await recordEconomicFee(user.id, 'wealth_tax', tax, netWorth, null, cycleKey);
      await logAdmin(`🏛️ Imposto patrimonial: ${user.nick || user.name} — R$${formatCurrency(tax)} (patrimônio: R$${formatCurrency(netWorth)})`);
      processed++;
    } catch (e) {
      console.error(`Error charging wealth tax for ${user.nick}:`, e.message);
    }
  }

  try {
    await pool.query(
      `INSERT INTO economic_fees (\`user_id\`, \`fee_type\`, \`amount\`, \`net_worth\`, \`cycle_key\`, \`created_at\`)
       VALUES (?, 'wealth_tax_cycle_mark', 0, 0, ?, ?)`,
      ['system', cycleKey, Date.now()]
    );
  } catch (_) {}

  console.log(`✅ Wealth tax complete: ${processed} users taxed`);
}

async function checkMissedEconomicEvents() {
  try {
    const [dailyRows] = await pool.query(
      `SELECT MAX(day_key) as last_day FROM economic_fees WHERE fee_type = 'daily_maintenance'`
    );

    if (dailyRows[0].last_day) {
      const lastDay = new Date(dailyRows[0].last_day);
      const today = new Date();
      const daysSinceLast = Math.floor((today - lastDay) / 86400000);

      if (daysSinceLast > 1) {
        console.log(`⚠️ Detected ${daysSinceLast} missed day(s) of maintenance fees.`);
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

              const [userRows2] = await pool.query('SELECT id, balance FROM users WHERE id = ?', [user.id]);
              if (userRows2.length && userRows2[0].balance >= fee) {
                await pool.query('UPDATE users SET `balance` = `balance` - ? WHERE `id` = ?', [fee, user.id]);
              } else if (userRows2.length) {
                await pool.query('UPDATE users SET `balance` = GREATEST(`balance` - fee, -50000) WHERE `id` = ?', [fee, user.id]);
              }

              await logAdmin(`⏰ Recarga de taxa diária (dia perdido ${missDayKey}): ${user.nick || user.name} — R$${formatCurrency(fee)}`);
            }
          }
        }
      }
    }

    const [taxRows] = await pool.query(
      `SELECT MAX(cycle_key) as last_cycle FROM economic_fees WHERE fee_type LIKE 'wealth_tax%'`
    );

    if (taxRows[0].last_cycle) {
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
