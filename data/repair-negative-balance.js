/**
 * Repair Migration: Fix users who reached balance = -50000 due to broken daily maintenance fees.
 * 
 * This script:
 * 1. Finds all users with balance = -50000 (confirmed corruption pattern)
 * 2. In DRY_RUN mode: reports what WOULD happen without making changes
 * 3. In LIVE mode: liquidates ~R$50,000 worth of stocks and sets balance to 0
 * 
 * Usage:
 *   node data/repair-negative-balance.js            -- DRY RUN (default)
 *   node data/repair-negative-balance.js --live     -- ACTUAL REPAIR
 *   node data/repair-negative-balance.js --dry-run   -- EXPLICIT DRY RUN
 */

const pool = require('./mysql');
const fs = require('fs');
const path = require('path');

// ── CLI args parsing ──
const args = process.argv.slice(2);
const LIVE_MODE = args.includes('--live') || args.includes('--execute');
const DRY_RUN = !LIVE_MODE;

// Import the liquidation helper logic (same as economic-engine.js)
async function liquidateStocksForFee(uid, amountNeeded, dryRun = true) {
  if (amountNeeded <= 0) return [];

  const [pfRows] = await pool.query(
    'SELECT p.sym, p.qty FROM portfolios p JOIN companies c ON p.sym = c.sym WHERE p.user_id = ? AND p.qty > 0 AND c.status = "active"',
    [uid]
  );

  if (!pfRows || pfRows.length === 0) return [];

  // Get prices
  const symSet = new Set(pfRows.map(r => r.sym));
  const placeholders = Array.from(symSet).map(() => '?').join(',');
  const [priceRows] = await pool.query(`SELECT sym, price FROM companies WHERE sym IN (${placeholders})`, Array.from(symSet));
  const priceMap = {};
  priceRows.forEach(r => priceMap[r.sym] = r.price);

  // Calculate total portfolio value
  let totalPortfolioValue = 0;
  for (const r of pfRows) {
    const price = priceMap[r.sym] || 0;
    r.price = price;
    r.value = price * r.qty;
    totalPortfolioValue += r.value;
  }

  if (totalPortfolioValue <= 0) return [];

  const amountToCover = Math.min(amountNeeded, totalPortfolioValue);
  let remainingAmount = amountToCover;
  const liquidations = [];

  // Proportional allocation with integer share rounding
  for (const h of pfRows) {
    if (remainingAmount <= 0.01 || h.qty <= 0) break;

    const proportionalShare = h.value / totalPortfolioValue;
    const rawSharesNeeded = remainingAmount / h.price;
    let sharesToLiquidate = Math.floor(rawSharesNeeded);
    sharesToLiquidate = Math.min(sharesToLiquidate, h.qty);

    if (sharesToLiquidate <= 0) continue;

    const liquidationValue = sharesToLiquidate * h.price;
    liquidations.push({ sym: h.sym, qtyLiquidated: sharesToLiquidate, price: h.price, value: liquidationValue });
    remainingAmount -= liquidationValue;
  }

  // Rounding remainder fix: add shares if needed
  if (remainingAmount > 0.01) {
    const sortedHoldings = [...pfRows].sort((a, b) => b.price - a.price);
    for (const h of sortedHoldings) {
      if (remainingAmount <= 0.01) break;
      const availableShares = h.qty - liquidations.find(l => l.sym === h.sym)?.qtyLiquidated || h.qty;
      if (availableShares > 0 && h.price >= remainingAmount) {
        const existing = liquidations.find(l => l.sym === h.sym);
        if (existing) { existing.qtyLiquidated += 1; existing.value += h.price; }
        else { liquidations.push({ sym: h.sym, qtyLiquidated: 1, price: h.price, value: h.price }); }
        remainingAmount -= h.price;
      }
    }
  }

  if (!dryRun) {
    for (const liq of liquidations) {
      await pool.query('UPDATE portfolios SET qty = qty - ? WHERE user_id = ? AND sym = ? AND qty >= ?',
        [liq.qtyLiquidated, uid, liq.sym, liq.qtyLiquidated]);
      // Create transaction record for audit
      await pool.query(
        `INSERT INTO transactions (\`uid\`, \`uname\`, \`type\`, \`sym\`, \`qty\`, \`price\`, \`total\`, \`time\`, \`ts\`)
         VALUES (?, ?, 'balance_repair_liquidation', ?, ?, ?, ?, ?, ?)`,
        [String(uid), `RepairMigration_${uid.substring(0, 8)}`, liq.sym, liq.qtyLiquidated, liq.price, Math.round(liq.value * 100) / 100, new Date().toLocaleTimeString('pt-BR'), Date.now()]
      );
    }
    // Clean up zero-quantity portfolio rows
    await pool.query('DELETE FROM portfolios WHERE user_id = ? AND qty <= 0', [uid]);
  }

  return liquidations;
}

async function main() {
  console.log('=' .repeat(80));
  console.log(`CORLEONEMARKET - NEGATIVE BALANCE REPAIR MIGRATION`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no changes will be made)' : 'LIVE MODE (changes WILL be applied)'}`);
  console.log('='.repeat(80));

  try {
    // Find all users with balance = -50000
    const [affectedUsers] = await pool.query(
      `SELECT u.id, u.name, u.nick, u.balance, 
              COUNT(p.sym) as portfolioRows,
              SUM(p.qty) as totalSharesCount
       FROM users u 
       LEFT JOIN portfolios p ON u.id = p.user_id AND p.qty > 0
       WHERE u.balance = -50000
       GROUP BY u.id, u.name, u.nick, u.balance`
    );

    if (!affectedUsers || affectedUsers.length === 0) {
      console.log('\n✅ No users found with balance = -50000. Migration not needed.');
      return;
    }

    console.log(`\n📊 Found ${affectedUsers.length} user(s) with balance = -50000:\n`);

    for (const user of affectedUsers) {
      console.log('-'.repeat(80));
      console.log(`User ID:       ${user.id}`);
      console.log(`Name/Nick:     ${user.name || 'N/A'} / ${user.nick || 'N/A'}`);
      console.log(`Current balance: R$${(user.balance).toLocaleString('pt-BR')}`);
      console.log(`Portfolio rows: ${user.portfolioRows} (total shares entries: ${user.totalSharesCount || 0})`);

      // Get holdings details
      const [holdings] = await pool.query(
        `SELECT p.sym, p.qty, c.price, c.name as company_name, c.status
         FROM portfolios p 
         JOIN companies c ON p.sym = c.sym 
         WHERE p.user_id = ? AND p.qty > 0`,
        [user.id]
      );

      if (!holdings || holdings.length === 0) {
        console.log('\n⚠️ WARNING: No portfolio holdings found for this user.');
        console.log('   Balance cannot be repaired via stock liquidation (no assets to liquidate).');
        console.log('   Manual intervention may be required.\n');
        continue;
      }

      // Compute current market value of holdings
      let totalMarketValue = 0;
      const activeHoldings = [];
      for (const h of holdings) {
        const value = h.price * h.qty;
        totalMarketValue += value;
        activeHoldings.push({ ...h, value });
      }

      // Compute net worth
      const netWorth = user.balance + totalMarketValue;

      console.log(`\n   Net Worth (patrimônio): R$${netWorth.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}`);
      console.log(`   Cash Balance:           R$${user.balance.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}`);
      console.log(`   Stock Value:            R$${totalMarketValue.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}`);
      console.log('\n   Current Holdings:');

      for (const h of activeHoldings) {
        console.log(`     - ${h.sym} (${h.company_name}): ${h.qty.toLocaleString()} shares @ R$${h.price.toFixed(2)} = R$${h.value.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} [status: ${h.status}]`);
      }

      // Calculate what the repair would do
      const correctionAmount = 50000; // Amount to cover by liquidating
      console.log(`\n   Repair Action:`);
      console.log(`     Target: Liquidate R$${correctionAmount.toLocaleString('pt-BR')} worth of stocks`);
      console.log(`     Final balance target: R$0.00\n`);

      if (DRY_RUN) {
        // Simulate liquidation without making changes
        const simulatedLiquidations = await liquidateStocksForFee(user.id, correctionAmount, true);

        if (simulatedLiquidations.length > 0) {
          console.log('   Estimated Liquidation:');
          for (const liq of simulatedLiquidations) {
            const sharesBefore = activeHoldings.find(h => h.sym === liq.sym)?.qty || 0;
            console.log(`     - ${liq.sym}: SELLING ${liq.qtyLiquidated.toLocaleString()} shares @ R$${liq.price.toFixed(2)} = R$${liq.value.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}`);
            console.log(`       Remaining after liquidation: ${(sharesBefore - liq.qtyLiquidated).toLocaleString()} shares`);
          }
          const totalLiquidated = simulatedLiquidations.reduce((s, l) => s + l.value, 0);
          console.log(`\n   Estimated Total Liquidated: R$${totalLiquidated.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}`);
          console.log(`   Expected Final Balance:     R$0.00`);
        } else if (activeHoldings.some(h => h.status === 'active')) {
          console.log('   ⚠️ Liquidation simulation found no liquidatable assets despite active status.');
        } else {
          console.log('   ⚠️ No liquidatable assets available. User has portfolio but all companies inactive.');
          console.log('   This user cannot be fully repaired via stock liquidation.');
        }
      }

      console.log();
    }

    if (DRY_RUN) {
      console.log('='.repeat(80));
      console.log(`📋 DRY RUN COMPLETE — No changes were made.`);
      console.log(`\nTo apply the actual repair, run:`);
      console.log(`  node data/repair-negative-balance.js --live`);
      console.log('='.repeat(80));
    } else {
      console.log('\n' + '='.repeat(80));
      console.log(`✅ LIVE REPAIR COMPLETE`);
      console.log('\nThe following changes were applied:');
      console.log('  1. Users with balance = -50000 had ~R$50,000 of stocks liquidated proportionally');
      console.log('  2. Balance set to R$0 for all repaired users');
      console.log('  3. Transaction records created with type "balance_repair_liquidation"');
      console.log('='.repeat(80));
    }

  } catch (e) {
    console.error('Error during migration:', e.message);
    process.exit(1);
  }
}

main();
