/**
 * Portfolio Audit & Repair Script
 * 
 * Compares the portfolios table against the companies table to detect:
 *   1. Orphaned holdings (portfolio has a symbol that no longer exists in companies)
 *   2. Deleted companies that still have portfolio references
 *   3. Summary of each user's recoverable/lost value
 * 
 * Usage: node data/portfolio-repair.js [--dry-run] [--refund-and-cleanup]
 * 
 * --dry-run (default):       Only reports issues, does not modify data
 * --refund-and-cleanup:      Refund users their cost basis and remove orphaned holdings
 */

const mysql = require('mysql2/promise');
const pool = require('./mysql');

async function logAdmin(msg) {
  pool.query('INSERT INTO admin_events (`t`, `msg`, `ts`) VALUES (?, ?, ?)',
    [new Date().toLocaleTimeString('pt-BR'), msg, Date.now()]
  ).catch(() => {});
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args.includes('--refund-and-cleanup') ? 'refund' : 'dry-run';
  
  console.log('═══════════════════════════════════════════');
  console.log('  CORLEONE MARKET — Portfolio Audit Report');
  console.log('═══════════════════════════════════════════\n');

  // ── Load active companies ──
  const [companies] = await pool.query('SELECT `sym`, `name`, `price`, `status` FROM companies');
  const activeCompanies = {};
  const deletedCompanies = {};
  companies.forEach(c => {
    if (c.status === 'active') {
      activeCompanies[c.sym] = c;
    } else {
      deletedCompanies[c.sym] = c;
    }
  });

  console.log(`\n📊 Companies: ${companies.length} total | ${Object.keys(activeCompanies).length} active | ${Object.keys(deletedCompanies).length} non-active\n`);

  // ── Load all orphaned portfolio entries ──
  const [portfolioRows] = await pool.query(
    'SELECT p.user_id, p.sym, p.qty, u.nick, u.name, u.balance ' +
    'FROM portfolios p JOIN users u ON u.id = p.user_id ' +
    'WHERE p.qty > 0 AND p.sym NOT IN (SELECT `sym` FROM companies WHERE `status` = "active")'
  );

  // Group orphans by user
  const orphanedByUser = {};
  portfolioRows.forEach(r => {
    if (!orphanedByUser[r.user_id]) {
      orphanedByUser[r.user_id] = { nick: r.nick, name: r.name, balance: r.balance, orphans: [] };
    }
    orphanedByUser[r.user_id].orphans.push({ sym: r.sym, qty: r.qty });
  });

  // ── Load deleted companies with portfolio references ──
  const [deletedCompanyRows] = await pool.query(
    'SELECT `sym`, `name`, `status` FROM companies WHERE `status` != "active"'
  );

  console.log('── DELETED/INACTIVE COMPANIES ─────────────');
  if (deletedCompanyRows.length === 0) {
    console.log('  (none found)\n');
  } else {
    for (const c of deletedCompanyRows) {
      console.log(`  ${c.sym}: ${c.name} (status: ${c.status})`);
      
      // Check if any portfolios reference this deleted company
      const [refRows] = await pool.query(
        'SELECT p.user_id, p.qty, u.nick, u.name FROM portfolios p JOIN users u ON u.id = p.user_id WHERE p.sym = ? AND p.qty > 0',
        [c.sym]
      );
      if (refRows.length > 0) {
        console.log(`    ⚠️  ${refRows.length} portfolio(s) reference this deleted company:`);
        refRows.forEach(r => {
          console.log(`       - ${r.nick || r.name} (user ${r.user_id}): ${r.qty} shares`);
        });
      } else {
        console.log('    ✓ No active portfolio references');
      }
    }
    console.log();
  }

  // ── Report orphaned holdings per user ──
  console.log('── ORPHANED PORTFOLIO HOLDINGS ────────────');
  if (portfolioRows.length === 0) {
    console.log('  ✓ No orphaned holdings found.\n');
  } else {
    const userIds = Object.keys(orphanedByUser);
    const countStr = orphanedByUser[userIds[0]]
      ? `orphans in ${userIds.length} user(s):`
      : 'orphans:';
    console.log(`  Found ${countStr}\n`);

    for (const uid of userIds) {
      const info = orphanedByUser[uid];
      console.log(`\n  User: ${info.nick || info.name} (ID: ${uid})`);
      console.log(`    Cash balance: R$${(info.balance || 0).toFixed(2)}`);
      console.log(`    Orphaned holdings:`);
      
      let totalOrphanQty = 0;
      for (const o of info.orphans) {
        const deleted = deletedCompanies[o.sym];
        if (deleted) {
          console.log(`      - ${o.sym}: ${o.qty} shares [company status: "${deleted.status}", name: "${deleted.name}"]`);
        } else {
          console.log(`      - ${o.sym}: ${o.qty} shares [company record completely missing]`);
        }
        totalOrphanQty += o.qty;
      }
      console.log(`    Total orphaned shares: ${totalOrphanQty}`);
    }
    console.log();
  }

  // ── Verify all users' net worth accuracy ──
  console.log('── USER WEALTH VERIFICATION ───────────────');
  const [allUsers] = await pool.query('SELECT id, nick, name, balance FROM users');
  
  const [allPfRows] = await pool.query('SELECT user_id, sym, qty FROM portfolios WHERE qty > 0');
  const pfMap = {};
  allPfRows.forEach(r => {
    if (!pfMap[r.user_id]) pfMap[r.user_id] = {};
    pfMap[r.user_id][r.sym] = r.qty;
  });

  let corruptedUsers = [];
  
  for (const u of allUsers) {
    const pf = pfMap[u.id] || {};
    let mv = 0;
    let orphanQty = 0;
    
    Object.entries(pf).forEach(([sym, qty]) => {
      if (activeCompanies[sym]) {
        mv += activeCompanies[sym].price * qty;
      } else {
        orphanQty += qty;
      }
    });
    
    const netWorth = (u.balance || 0) + mv;
    
    if (orphanQty > 0) {
      corruptedUsers.push({
        id: u.id,
        nick: u.nick || u.name,
        balance: u.balance,
        portfolioValue: Math.round(mv * 100) / 100,
        netWorth: Math.round(netWorth * 100) / 100,
        orphanQty,
        missingSymbols: Object.keys(pf).filter(s => !activeCompanies[s])
      });
    }
  }

  if (corruptedUsers.length === 0) {
    console.log('  ✓ All user portfolios reference valid active companies.\n');
  } else {
    console.log(`  ⚠️  ${corruptedUsers.length} user(s) have orphaned holdings:\n`);
    for (const u of corruptedUsers) {
      console.log(`  ${u.nick || u.name} (ID: ${u.id})`);
      console.log(`    Cash: R$${u.balance.toFixed(2)}`);
      console.log(`    Portfolio value (valid stocks): R$${u.portfolioValue.toFixed(2)}`);
      console.log(`    Net worth: R$${u.netWorth.toFixed(2)}`);
      console.log(`    Missing symbols: ${u.missingSymbols.join(', ')}`);
      console.log(`    Total orphaned shares: ${u.orphanQty}\n`);
    }
  }

  // ── Suggestions for repair ──
  if (corruptedUsers.length > 0 || deletedCompanyRows.filter(c => {
    return portfolioRows.some(pr => pr.sym === c.sym);
  }).length > 0) {
    console.log('── REPAIR SUGGESTIONS ─────────────────────');
    
    if (mode !== 'refund') {
      console.log('\nTo refund users and remove orphaned holdings:');
      console.log('  node data/portfolio-repair.js --refund-and-cleanup');
      console.log('  node data/orphan-cleanup.js --refund-and-cleanup');
      console.log('\nTo restore deleted companies with their original symbols:');
      console.log('  1. Recreate each deleted company with the SAME sym code');
      console.log('  2. Orphans will automatically match to the new company');
    } else {
      console.log();
    }

    // ── Execute refund-and-cleanup mode ──
    if (mode === 'refund') {
      const readline = require('readline').createInterface({ input: process.stdin, output: process.stdout });
      console.log('\n⚠️  This will PERMANENTLY delete orphaned holdings and refund users.');

      // Calculate per-user refunds using cost basis from purchase transactions
      for (const ue of corruptedUsers) {
        ue.refunds = {};
        let userTotalRefund = 0;
        for (const sym of ue.missingSymbols) {
          const [symBuys] = await pool.query(
            'SELECT qty, total FROM transactions WHERE uid = ? AND type = "buy" AND sym = ? ORDER BY ts ASC',
            [ue.id, sym]
          );
          if (symBuys.length === 0) { ue.refunds[sym] = { qty: 0, refund: 0 }; continue; }
          const totalBought = symBuys.reduce((s, b) => s + b.qty, 0);
          const totalPaid   = symBuys.reduce((s, b) => s + b.total, 0);
          const pricePerShare = totalBought > 0 ? totalPaid / totalBought : 0;
          const heldQty     = pfMap[ue.id]?.[sym] || 0;
          const refund      = Math.round(pricePerShare * heldQty * 100) / 100;
          ue.refunds[sym] = { qty: heldQty, refund };
          userTotalRefund += refund;
        }
      }

      let totalRefund = corruptedUsers.reduce((s, ue) => s + Object.values(ue.refunds).reduce((rs, r) => rs + r.refund, 0), 0);
      console.log(`\n── REFUND SUMMARY ──────────────────────`);
      for (const ue of corruptedUsers) {
        let userTotalRefund = 0;
        let symDetails = '';
        for (const [sym, data] of Object.entries(ue.refunds)) {
          if (data.refund > 0.01) {
            userTotalRefund += data.refund;
            symDetails += `${sym}: ${data.qty} shares → R$${data.refund.toFixed(2)} `;
          }
        }
        totalRefund += userTotalRefund;
        console.log(`  ${ue.nick}: R$${userTotalRefund.toFixed(2)} (${symDetails})`);
      }
      console.log(`\n  TOTAL: R$${totalRefund.toFixed(2)}`);
      
      const confirm = await new Promise(resolve => {
        readline.question('\nProceed? (yes/no): ', (answer) => resolve(answer.toLowerCase().trim()));
      });

      if (confirm === 'yes') {
        let cleanCount = 0;
        for (const ue of corruptedUsers) {
          const userTotalRefund = Object.values(ue.refunds).reduce((s, r) => s + r.refund, 0);
          if (userTotalRefund > 0.01) {
            await pool.query('UPDATE users SET `balance` = `balance` + ? WHERE `id` = ?', [userTotalRefund, ue.id]);
            console.log(`  ✓ Refunded R$${userTotalRefund.toFixed(2)} to ${ue.nick}`);
          }
          for (const sym of ue.missingSymbols) {
            await pool.query('DELETE FROM portfolios WHERE `user_id` = ? AND `sym` = ?', [ue.id, sym]);
            cleanCount++;
          }
          await logAdmin(`ORPHAN CLEANUP: Refunded R$${userTotalRefund.toFixed(2)} to ${ue.nick} (${Object.keys(ue.refunds).length} orphaned holding(s) removed)`);
        }
        console.log(`\n═══════════════════════════════════════════`);
        console.log(`  ORPHAN CLEANUP COMPLETE`);
        console.log(`  Users refunded: ${corruptedUsers.filter(u => Object.values(u.refunds).some(r => r.refund > 0)).length}`);
        console.log(`  Orphaned holdings removed: ${cleanCount}`);
        console.log(`  Total refunded: R$${totalRefund.toFixed(2)}`);
        console.log(`═══════════════════════════════════════════\n`);
      } else {
        console.log('Aborted. No changes were made.');
      }
      readline.close();
    }

    console.log('\n═══════════════════════════════════════════');
    console.log('  Audit complete.');
    console.log('═══════════════════════════════════════════\n');
  } else {
    console.log('\n═══════════════════════════════════════════');
    console.log('  All portfolios are valid. No issues found.');
    console.log('═══════════════════════════════════════════\n');
  }
}

main().catch(err => {
  console.error('Audit error:', err.message);
  process.exit(1);
});
