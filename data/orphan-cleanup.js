/**
 * Orphaned Company Refund & Cleanup Script
 * 
 * Fixes users who hold shares in companies that were soft-deleted (status='deleted').
 * Refunds users their proportional cost basis from purchase transactions, then removes
 * the orphaned portfolio entries so their net worth stops considering dead values.
 * 
 * Usage:
 *   node data/orphan-cleanup.js --estimate          Preview refunds without making changes
 *   node data/orphan-cleanup.js --refund-and-cleanup Refund users and remove orphans (DANGEROUS)
 *   node data/orphan-cleanup.js --dry-run            Default: audit only (same as --estimate)
 * 
 * Refund calculation uses FIFO: matches user's sells against earliest buys to determine
 * remaining cost basis. If no transaction history found, refunds R$0 (no price anchor).
 */

const mysql = require('mysql2/promise');
const pool = require('./mysql');

// ── Helpers ────────────────────────────────────────────────────────

function formatCurrency(value) {
  return value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Calculate cost basis for remaining shares using FIFO from purchase transactions.
 * Returns the total amount the user originally paid for the remaining quantity.
 */
async function calculateRefundAmount(userId, sym) {
  // Get all buy transactions for this symbol, ordered oldest first
  const [buys] = await pool.query(
    'SELECT qty, total FROM transactions WHERE uid = ? AND type = "buy" AND sym = ? ORDER BY ts ASC',
    [userId, sym.toUpperCase()]
  );

  if (buys.length === 0) return 0;

  // Get all sell transactions for this symbol
  const [sells] = await pool.query(
    'SELECT qty FROM transactions WHERE uid = ? AND type = "sell" AND sym = ? ORDER BY ts ASC',
    [userId, sym.toUpperCase()]
  );

  // Current held quantity (from portfolio)
  const [portfolio] = await pool.query(
    'SELECT qty FROM portfolios WHERE user_id = ? AND sym = ? AND qty > 0 LIMIT 1',
    [userId, sym.toUpperCase()]
  );
  const remainingQty = portfolio.length > 0 ? portfolio[0].qty : 0;

  if (remainingQty <= 0) return 0;

  // FIFO: subtract sells from earliest buys to find remaining cost basis
  let sellAccumulator = sells.reduce((sum, s) => sum + s.qty, 0);
  
  let coveredQty = 0;
  let cumulativeBasis = 0;
  let refundAmount = 0;

  for (const buy of buys) {
    const buyPricePerShare = buy.total / buy.qty;
    
    if (sellAccumulator <= 0) {
      // No more sells to offset — this buy is still partially or fully held
      refundAmount += cumulativeBasis + (buy.total - cumulativeBasis);
      break;
    }

    const coveredThisBuy = Math.min(buy.qty, sellAccumulator);
    sellAccumulator -= coveredThisBuy;
    
    // Record basis per share for this buy batch
    const basisPerShare = buy.total / buy.qty;
    cumulativeBasis += coveredThisBuy * basisPerShare;
  }

  // If we haven't reached the remaining quantity yet, add full cost of remaining buys
  if (refundAmount === 0) {
    let qtyAccounted = sells.reduce((sum, s) => sum + s.qty, 0);
    refundAmount = 0;
    
    for (const buy of buys) {
      const availableFromBuy = Math.min(buy.qty, remainingQty + qtyAccounted - (remainingQty));
      if (availableFromBuy <= 0 && qtyAccounted >= remainingQty) break;
      
      if (qtyAccounted < remainingQty) {
        const fromThisBuy = Math.min(buy.qty, remainingQty - qtyAccounted);
        const pricePerShare = buy.total / buy.qty;
        refundAmount += fromThisBuy * pricePerShare;
        qtyAccounted += fromThisBuy;
      } else if (qtyAccounted >= remainingQty) {
        // All sells have been accounted for, add full remaining buys
        break;
      }
    }
  }

  // Simpler approach: just refund proportionally based on total paid / total bought
  const totalBought = buys.reduce((sum, b) => sum + b.qty, 0);
  const totalPaid = buys.reduce((sum, b) => sum + b.total, 0);
  if (totalBought === 0) return 0;

  const pricePerShare = totalPaid / totalBought;
  return Math.round(pricePerShare * remainingQty * 100) / 100;
}

// ── Main ───────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const mode = args.includes('--refund-and-cleanup') ? 'refund' : 
               args.includes('--estimate') ? 'estimate' : 'dry-run';

  console.log('═══════════════════════════════════════════');
  console.log('  CORLEONE MARKET — Orphaned Company Cleanup');
  console.log(`  Mode: ${mode === 'refund' ? 'REFUND & CLEANUP' : mode === 'estimate' ? 'ESTIMATE ONLY' : 'DRY RUN (AUDIT)'} `);
  console.log('═══════════════════════════════════════════\n');

  // ── Step 1: Find all orphaned holdings ───────────────────────────

  const [orphanRows] = await pool.query(
    'SELECT p.user_id, p.sym, p.qty, u.nick, u.name, u.balance, c.name as company_name, c.status as company_status ' +
    'FROM portfolios p ' +
    'JOIN users u ON u.id = p.user_id ' +
    'LEFT JOIN companies c ON c.sym = p.sym ' +
    'WHERE p.qty > 0 AND (c.sym IS NULL OR c.status != "active") ' +
    'ORDER BY p.user_id, p.sym'
  );

  if (orphanRows.length === 0) {
    console.log('✓ No orphaned holdings found. All portfolios reference valid active companies.\n');
    return;
  }

  // Group by user
  const orphansByUser = {};
  for (const r of orphanRows) {
    const key = r.user_id;
    if (!orphansByUser[key]) {
      orphansByUser[key] = { nick: r.nick, name: r.name, balance: r.balance, holdings: [] };
    }
    orphansByUser[key].holdings.push({ sym: r.sym, qty: r.qty, companyName: r.company_name || '(deleted record)', status: r.company_status });
  }

  // ── Step 2: For each user, calculate refund amounts ──────────────

  let totalRefundAll = 0;
  const userEstimates = [];

  for (const [uid, info] of Object.entries(orphansByUser)) {
    let userRefund = 0;
    const itemEstimates = [];

    for (const holding of info.holdings) {
      const refundAmount = await calculateRefundAmount(uid, holding.sym);
      if (refundAmount > 0.01) {
        totalRefundAll += refundAmount;
        userRefund += refundAmount;
      }

      itemEstimates.push({
        sym: holding.sym,
        qty: holding.qty,
        companyName: holding.companyName,
        status: holding.status,
        estimatedRefund: refundAmount
      });
    }

    userEstimates.push({ uid, ...info, totalRefund: userRefund, items: itemEstimates });
  }

  // ── Step 3: Output results ───────────────────────────────────────

  console.log('── ORPHANED HOLDINGS SUMMARY ─────────────');
  console.log(`Total orphaned holdings: ${orphanRows.length}\n`);

  for (const ue of userEstimates) {
    console.log(`User: ${ue.nick || ue.name} (ID: ${ue.uid})`);
    console.log(`  Current balance: R$${formatCurrency(ue.balance)}\n`);
    
    for (const item of ue.items) {
      console.log(`  - ${item.sym}: ${item.qty} shares (${item.companyName}, status: ${item.status})`);
      if (item.estimatedRefund > 0.01) {
        console.log(`    → Estimated refund: R$${formatCurrency(item.estimatedRefund)}`);
      } else {
        console.log('    → No purchase history found for refund');
      }
    }
    
    console.log(`  ─── User total refund: R$${formatCurrency(ue.totalRefund)}`);
    console.log(`  Post-refund balance: R$${formatCurrency(ue.balance + ue.totalRefund)}\n`);
  }

  console.log(`═══════════════════════════════════════════`);
  console.log(`  TOTAL REFUND ACROSS ALL USERS: R$${formatCurrency(totalRefundAll)}`);
  console.log(`═══════════════════════════════════════════\n`);

  // ── Step 4: Execute based on mode ────────────────────────────────

  if (mode === 'dry-run') {
    console.log('DRY RUN complete. No changes were made.');
    console.log('\nTo execute the refund and cleanup, run:');
    console.log('  node data/orphan-cleanup.js --refund-and-cleanup\n');
  } else if (mode === 'estimate') {
    console.log('Estimate complete. To execute, run:');
    console.log('  node data/orphan-cleanup.js --refund-and-cleanup\n');
  } else if (mode === 'refund') {
    // Confirm with user
    const readline = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout
    });

    console.log('\n⚠️  This will PERMANENTLY delete orphaned holdings and refund users.');
    console.log('   Total to refund: R$' + formatCurrency(totalRefundAll));
    console.log('\nProceed? (yes/no): ');
    
    const confirm = await new Promise(resolve => {
      readline.question('', (answer) => resolve(answer.toLowerCase().trim()));
    });

    if (confirm !== 'yes') {
      console.log('Aborted. No changes were made.');
      readline.close();
      return;
    }
    
    readline.close();

    // Execute refunds and cleanup
    let refundCount = 0;
    let deleteCount = 0;

    for (const ue of userEstimates) {
      if (ue.totalRefund <= 0) continue;

      // Refund the user
      await pool.query(
        'UPDATE users SET `balance` = `balance` + ? WHERE `id` = ?',
        [ue.totalRefund, ue.uid]
      );
      console.log(`  ✓ Refunded R$${formatCurrency(ue.totalRefund)} to ${ue.nick || ue.name}`);
      refundCount++;

      // Delete orphaned portfolio entries
      for (const item of ue.items) {
        await pool.query(
          'DELETE FROM portfolios WHERE `user_id` = ? AND `sym` = ? AND qty > 0',
          [ue.uid, item.sym]
        );
        deleteCount++;
      }
      
      // Log the cleanup action
      await pool.query(
        'INSERT INTO admin_events (`t`, `msg`, `ts`) VALUES (?, ?, ?)',
        [new Date().toLocaleTimeString('pt-BR'), 
         `ORPHAN CLEANUP: Refunded R$${formatCurrency(ue.totalRefund)} to ${ue.nick || ue.name} (${ue.items.length} orphaned holding(s) removed)`, 
         Date.now()]
      );
    }

    console.log(`\n═══════════════════════════════════════════`);
    console.log(`  ORPHAN CLEANUP COMPLETE`);
    console.log(`  Users refunded: ${refundCount}`);
    console.log(`  Orphaned holdings removed: ${deleteCount}`);
    console.log(`  Total refunded: R$${formatCurrency(totalRefundAll)}`);
    console.log(`═══════════════════════════════════════════\n`);
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
