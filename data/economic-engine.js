// ── Economic Engine (MySQL-backed) ───────────────────────────────────
// Handles daily maintenance fees, wealth taxes, and insufficient-fund stock liquidation.

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

  // Log any orphaned holdings for this user (for audit/debugging)
  const allCompanies = await pool.query('SELECT `sym`, `status` FROM companies');
  const activeSyms = new Set(allCompanies[0].filter(c => c.status === 'active').map(c => c.sym));
  const orphanSyms = pfRows.filter(r => !activeSyms.has(r.sym)).map(r => r.sym);
  if (orphanSyms.length > 0) {
    console.warn(`⚠️ Orphaned portfolio for user ${uid}: holdings in [${orphanSyms.join(', ')}] — no matching active company`);
  }

  const netWorth = user.balance + mv;
  return { netWorth: Math.round(netWorth * 100) / 100, cash: user.balance, marketValue: Math.round(mv * 100) / 100 };
}

/**
 * Liquidate a user's portfolio holdings proportionally to cover the given amount.
 * Shares are rounded down to integers (safe — never over-liquidates without adjustment).
 * If not enough shares exist to cover the fee, liquidates everything and returns what was covered.
 *
 * @param {string} uid - User ID
 * @param {number} amountNeeded - Amount to cover via stock liquidation
 * @returns {Promise<Array<{sym: string, qtyLiquidated: number, price: number, value: number}>>} Liquidation records
 */
async function liquidateStocksForFee(uid, amountNeeded) {
  if (amountNeeded <= 0) return [];

  // Get user's active portfolio holdings with current prices
  const [pfRows] = await pool.query(
    'SELECT p.sym, p.qty FROM portfolios p JOIN companies c ON p.sym = c.sym WHERE p.user_id = ? AND p.qty > 0 AND c.status = "active"',
    [uid]
  );

  if (!pfRows || pfRows.length === 0) return [];

  // Calculate total portfolio value for proportional allocation
  let totalPortfolioValue = 0;
  const holdingsWithPrice = pfRows.map(row => {
    const price = row.price || 0;
    const value = price * row.qty;
    totalPortfolioValue += value;
    return { sym: row.sym, qty: row.qty, price, value };
  });

  if (totalPortfolioValue <= 0) return [];

  // Cap at what's available
  const maxLiquidatable = totalPortfolioValue;
  const amountToCover = Math.min(amountNeeded, maxLiquidatable);

  const liquidations = [];
  let remainingAmount = amountToCover;

  // Calculate shares to liquidate proportionally for each holding
  for (const h of holdingsWithPrice) {
    if (remainingAmount <= 0) break;

    const proportionalShare = h.value / totalPortfolioValue; // e.g., 0.6667 for 66.67%
    const rawSharesNeeded = remainingAmount / h.price;

    // Round DOWN to whole shares (safe — never over-liquidates)
    let sharesToLiquidate = Math.floor(rawSharesNeeded);

    // Ensure we don't liquidate more than held
    sharesToLiquidate = Math.min(sharesToLiquidate, h.qty);

    if (sharesToLiquidate <= 0) continue;

    const liquidationValue = sharesToLiquidate * h.price;
    liquidations.push({
      sym: h.sym,
      qtyLiquidated: sharesToLiquidate,
      price: h.price,
      value: liquidationValue
    });

    remainingAmount -= liquidationValue;
  }

  // Handle rounding remainder: if we still haven't covered the full amount,
  // try adding 1 more share to each holding in order of largest price first
  if (remainingAmount > 0.01) {
    // Sort holdings by price descending to maximize coverage per extra share
    const sortedHoldings = [...holdingsWithPrice].sort((a, b) => b.price - a.price);

    for (const h of sortedHoldings) {
      if (remainingAmount <= 0.01) break;

      const availableShares = h.qty - liquidations.find(l => l.sym === h.sym)?.qtyLiquidated || h.qty;
      if (availableShares <= 0) continue;

      // If adding 1 share covers remaining amount, do it
      if (h.price >= remainingAmount && availableShares > 0) {
        const existing = liquidations.find(l => l.sym === h.sym);
        if (existing) {
          existing.qtyLiquidated += 1;
          existing.value += h.price;
        } else {
          liquidations.push({
            sym: h.sym,
            qtyLiquidated: 1,
            price: h.price,
            value: h.price
          });
        }
        remainingAmount -= h.price;
      }
    }
  }

  // If we STILL haven't covered the full amount due to rounding, try a second pass
  if (remainingAmount > 0.01) {
    const allHoldings = [...holdingsWithPrice].sort((a, b) => b.price - a.price);
    for (const h of allHoldings) {
      if (remainingAmount <= 0.01) break;
      const availableShares = h.qty - liquidations.find(l => l.sym === h.sym)?.qtyLiquidated || h.qty;
      if (availableShares > 0 && h.price >= remainingAmount) {
        const existing = liquidations.find(l => l.sym === h.sym);
        if (existing) {
          existing.qtyLiquidated += 1;
          existing.value += h.price;
        } else {
          liquidations.push({
            sym: h.sym,
            qtyLiquidated: 1,
            price: h.price,
            value: h.price
          });
        }
        remainingAmount -= h.price;
      }
    }
  }

  // Update portfolio quantities in database
  for (const liq of liquidations) {
    await pool.query(
      'UPDATE portfolios SET qty = qty - ? WHERE user_id = ? AND sym = ? AND qty >= ?',
      [liq.qtyLiquidated, uid, liq.sym, liq.qtyLiquidated]
    );
  }

  // Clean up rows where quantity becomes zero or less
  await pool.query(
    'DELETE FROM portfolios WHERE user_id = ? AND qty <= 0',
    [uid]
  );

  return liquidations;
}

/**
 * Deduct fees from a user's assets atomically: cash first, then proportional stock liquidation.
 * Returns { cashDeducted, stockLiquidated: [...], totalCovered, shortfall }.
 *
 * This is the NEW safe fee-deduction mechanism that replaces recordDebt().
 */
async function deductFeeFromAssets(uid, feeAmount) {
  // Get fresh user data inside transaction context
  const [userRows] = await pool.query('SELECT id, balance FROM users WHERE id = ?', [uid]);
  if (!userRows.length) return { cashDeducted: 0, stockLiquidated: [], totalCovered: 0, shortfall: feeAmount };

  let cashBalance = userRows[0].balance;
  const cashDeducted = Math.min(feeAmount, Math.max(0, cashBalance));
  cashBalance -= cashDeducted;

  // Ensure cash never goes negative (clamp to 0 minimum)
  if (cashBalance < 0) cashBalance = 0;

  let remainingFee = feeAmount - cashDeducted;
  const stockLiquidated = [];

  if (remainingFee > 0.01) {
    const liquidations = await liquidateStocksForFee(uid, remainingFee);

    // The actual value collected from liquidation may slightly differ from requested
    let liquidatedValue = liquidations.reduce((sum, l) => sum + l.value, 0);
    stockLiquidated.push(...liquidations.map(l => ({ ...l })));
    remainingFee -= liquidatedValue;

    // Cash balance is now exactly 0 after deducting what we had + whatever came from stocks
    cashBalance = Math.max(0, cashBalance);
  }

  return {
    cashDeducted,
    stockLiquidated,
    totalCovered: feeAmount - remainingFee,
    shortfall: remainingFee > 0.01 ? remainingFee : 0
  };
}

/**
 * Apply the complete fee deduction atomically within a single transaction.
 * @returns {Promise<{ success: boolean, cashDeducted: number, stockLiquidated: Array, shortfall: number }>}
 */
async function applyDailyFeeWithLiquidation(uid, feeAmount) {
  // Use a transaction for atomicity
  await pool.query('START TRANSACTION');
  try {
    // Step 1: Get current user balance
    const [userRows] = await pool.query('SELECT id, balance FROM users WHERE id = ?', [uid]);
    if (!userRows.length) {
      await pool.query('ROLLBACK');
      return { success: false, cashDeducted: 0, stockLiquidated: [], shortfall: feeAmount };
    }

    let cashBalance = userRows[0].balance;
    const cashAvailable = Math.max(0, cashBalance);
    const cashDeducted = Math.min(feeAmount, cashAvailable);

    // Step 2: Deduct from cash (never below 0)
    if (cashAvailable > 0) {
      await pool.query('UPDATE users SET balance = balance - ? WHERE id = ?', [cashDeducted, uid]);
    }
    // Cash is now at 0 or positive — never negative

    let remainingFee = feeAmount - cashDeducted;
    const stockLiquidated = [];

    // Step 3: If cash insufficient, liquidate stocks proportionally
    if (remainingFee > 0.01) {
      const liquidations = await liquidateStocksForFee(uid, remainingFee);
      stockLiquidated.push(...liquidations.map(l => ({ ...l })));

      let liquidatedValue = liquidations.reduce((sum, l) => sum + l.value, 0);
      remainingFee -= liquidatedValue;
    }

    // Step 4: Ensure balance never negative (final safety clamp)
    const [checkBalance] = await pool.query('SELECT balance FROM users WHERE id = ?', [uid]);
    if (checkBalance.length && checkBalance[0].balance < 0) {
      await pool.query('UPDATE users SET balance = 0 WHERE id = ? AND balance < 0', [uid]);
    }

    await pool.query('COMMIT');

    return {
      success: true,
      cashDeducted,
      stockLiquidated,
      shortfall: remainingFee > 0.01 ? remainingFee : 0
    };
  } catch (e) {
    await pool.query('ROLLBACK').catch(() => {});
    console.error(`Error applying daily fee for user ${uid}:`, e.message);
    return { success: false, cashDeducted: 0, stockLiquidated: [], shortfall: feeAmount };
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

      // Use the NEW safe deduction mechanism: cash first, then proportional stock liquidation
      const result = await applyDailyFeeWithLiquidation(user.id, fee);

      if (result.success && result.stockLiquidated.length > 0) {
        // Record automatic liquidation transactions for audit trail
        for (const liq of result.stockLiquidated) {
          const timeStr = new Date().toLocaleTimeString('pt-BR');
          await pool.query(
            `INSERT INTO transactions (\`uid\`, \`uname\`, \`type\`, \`sym\`, \`qty\`, \`price\`, \`total\`, \`time\`, \`ts\`)
             VALUES (?, ?, 'maintenance_fee_liquidation', ?, ?, ?, ?, ?, ?)`,
            [String(user.id), user.nick || user.name, liq.sym, liq.qtyLiquidated, liq.price, Math.round(liq.value * 100) / 100, timeStr, Date.now()]
          );
        }

        // Log admin message with liquidation details
        const totalLiquidated = result.stockLiquidated.reduce((sum, l) => sum + l.value, 0);
        await logAdmin(`📋 Taxa diária: ${user.nick || user.name} — R$${formatCurrency(fee)} (patrimônio: R$${formatCurrency(netWorth)}) | Liquidado: R$${formatCurrency(totalLiquidated)}`);
      } else {
        await logAdmin(`📋 Taxa diária: ${user.nick || user.name} — R$${formatCurrency(fee)} (patrimônio: R$${formatCurrency(netWorth)})`);
      }

      // Record the fee in economic_fees table
      await recordEconomicFee(user.id, 'daily_maintenance', fee, netWorth, dayKey, null);
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

      // Use the NEW safe deduction mechanism
      const result = await applyDailyFeeWithLiquidation(user.id, tax);

      if (result.success && result.stockLiquidated.length > 0) {
        for (const liq of result.stockLiquidated) {
          const timeStr = new Date().toLocaleTimeString('pt-BR');
          await pool.query(
            `INSERT INTO transactions (\`uid\`, \`uname\`, \`type\`, \`sym\`, \`qty\`, \`price\`, \`total\`, \`time\`, \`ts\`)
             VALUES (?, ?, 'wealth_tax_liquidation', ?, ?, ?, ?, ?, ?)`,
            [String(user.id), user.nick || user.name, liq.sym, liq.qtyLiquidated, liq.price, Math.round(liq.value * 100) / 100, timeStr, Date.now()]
          );
        }
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

          const [missUserRows] = await pool.query('SELECT id, nick, name FROM users');
          for (const user of missUserRows) {
            try {
              const { netWorth } = await computeNetWorth(user.id);
              if (netWorth > 1_000_000) {
                const fee = config.calculateDailyMaintenance(netWorth);
                await recordEconomicFee(user.id, 'daily_maintenance', fee, netWorth, missDayKey, null);

                // Use the NEW safe deduction — cash first, then proportional stock liquidation
                const result = await applyDailyFeeWithLiquidation(user.id, fee);

                if (result.success && result.stockLiquidated.length > 0) {
                  for (const liq of result.stockLiquidated) {
                    const timeStr = new Date().toLocaleTimeString('pt-BR');
                    await pool.query(
                      `INSERT INTO transactions (\`uid\`, \`uname\`, \`type\`, \`sym\`, \`qty\`, \`price\`, \`total\`, \`time\`, \`ts\`)
                       VALUES (?, ?, 'maintenance_fee_liquidation', ?, ?, ?, ?, ?, ?)`,
                      [String(user.id), user.nick || user.name, liq.sym, liq.qtyLiquidated, liq.price, Math.round(liq.value * 100) / 100, timeStr, Date.now()]
                    );
                  }
                }

                // Final safety: ensure balance is never negative
                const [finalBalance] = await pool.query('SELECT balance FROM users WHERE id = ?', [user.id]);
                if (finalBalance.length && finalBalance[0].balance < 0) {
                  await pool.query('UPDATE users SET balance = 0 WHERE id = ? AND balance < 0', [user.id]);
                }

                await logAdmin(`⏰ Recarga de taxa diária (dia perdido ${missDayKey}): ${user.nick || user.name} — R$${formatCurrency(fee)}`);
              }
            } catch (e) {
              console.error(`Error processing missed fee for ${user.nick}:`, e.message);
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
  formatCurrency,
};
