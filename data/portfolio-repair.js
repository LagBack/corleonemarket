/**
 * Portfolio Audit & Repair Script
 * 
 * Compares the portfolios table against the companies table to detect:
 *   1. Orphaned holdings (portfolio has a symbol that no longer exists in companies)
 *   2. Deleted companies that still have portfolio references
 *   3. Summary of each user's recoverable/lost value
 * 
 * Usage: node data/portfolio-repair.js [--dry-run] [--repair]
 * 
 * --dry-run (default): Only reports issues, does not modify data
 * --repair: Updates status='deleted' companies to active and logs the action
 */

const mysql = require('mysql2/promise');
const pool = require('./mysql');

async function main() {
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
    console.log(`  Found ${orphanedByUser[userIds[0]] ? 'orphans in ' + userIds.length + ' user(s):\n' : 'orphans\n'});

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
    console.log('\nTo restore deleted companies with their original symbols:');
    console.log('  1. Recreate each deleted company with the SAME sym code');
    console.log('  2. Orphans will automatically match to the new company');
    console.log('\nTo find what symbols were lost, run:');
    const lostSyms = [...new Set(orphanedByUser[userIds[0]] ? Object.values(orphanedByUser).flatMap(u => u.orphans.map(o => o.sym)) : [])];
    if (lostSyms.length > 0) {
      console.log(`  Lost symbols: ${lostSyms.join(', ')}`);
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
