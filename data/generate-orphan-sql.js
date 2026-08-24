/**
 * Generates SQL to fix orphaned companies based on local db.json data.
 * Run: node data/generate-orphan-sql.js
 * Output: Prints SQL to stdout — copy/paste into your remote MySQL (phpMyAdmin).
 */

const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, 'db.json');
if (!fs.existsSync(dbPath)) {
  console.log('⚠️  db.json not found. No local data to analyze.');
  console.log('   Your production data is on the remote MySQL server.');
  console.log('   Use the orphan-cleanup.sql file instead (copy/paste into phpMyAdmin).');
  process.exit(0);
}

const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
const companies = db.companies || [];
const deletedSyms = new Set((companies.filter(c => c.status === 'deleted') || []).map(c => c.sym.toUpperCase()));

if (deletedSyms.size === 0) {
  console.log('✓ No deleted companies found in local data.');
  process.exit(0);
}

console.log(`\n═══ Generated SQL for orphan cleanup — ${deletedSyms.size} deleted company(s) ═══\n`);
console.log('-- ============================================================');
console.log('-- CORLEONE MARKET — Orphaned Company Cleanup (Auto-Generated)');
console.log('-- Run this in your remote MySQL database via phpMyAdmin or similar.');
console.log('-- ============================================================\n');

// Show affected portfolios
let orphanHoldings = [];
const portfolios = db.portfolios || {};
Object.entries(portfolios).forEach(([uid, stk]) => {
  if (stk) Object.keys(stk).forEach(sym => {
    const qty = stk[sym] || 0;
    if (qty > 0 && deletedSyms.has(sym.toUpperCase())) {
      orphanHoldings.push({ user_id: uid, sym: sym.toUpperCase(), qty });
    }
  });
});

if (orphanHoldings.length === 0) {
  console.log('-- No orphan holdings found in local db.json.');
  console.log('-- (Production data may differ — use the manual SQL script.)');
} else {
  console.log(`-- Step 1: Affected portfolios (${orphanHoldings.length} row(s))\n`);
  orphanHoldings.forEach(h => {
    console.log(`--   User ${h.user_id} holds ${h.qty} × ${h.sym}`);
  });

  console.log(`\n-- Step 2: Refund SQL (update user balances)\n`);
  
  // For each user, sum the total to refund
  const byUser = {};
  orphanHoldings.forEach(h => {
    if (!byUser[h.user_id]) byUser[h.user_id] = [];
    byUser[h.user_id].push(h);
  });

  Object.entries(byUser).forEach(([uid, holdings]) => {
    // For each holding, refund at a flat rate (since we can't access purchase history from db.json)
    // The avg_price is estimated from deleted companies' open price as fallback
    let totalRefund = 0;
    holdings.forEach(h => {
      const comp = companies.find(c => c.sym.toUpperCase() === h.sym);
      const pricePerShare = comp ? comp.price : comp?.open || 1.0;
      totalRefund += Math.round(pricePerShare * h.qty * 100) / 100;
    });
    console.log(`-- User ${uid}: refund R$${totalRefund.toFixed(2)}`);
    console.log(`UPDATE users SET \`balance\` = \`balance\` + ${totalRefund.toFixed(2)} WHERE \`id\` = '${uid}';`);
  });

  console.log(`\n-- Step 3: Delete orphaned portfolio entries\n`);
  orphanHoldings.forEach(h => {
    console.log(`DELETE FROM portfolios WHERE \`user_id\` = '${h.user_id}' AND \`sym\` = '${h.sym}';`);
  });

  console.log(`\n-- Step 4: Delete orphaned company_owners entries\n`);
  deletedSyms.forEach(sym => {
    console.log(`DELETE FROM company_owners WHERE \`sym\` = '${sym}';`);
  });

  console.log(`\n-- Step 5: Mark companies as deleted (if not already)\n`);
  deletedSyms.forEach(sym => {
    const comp = companies.find(c => c.sym.toUpperCase() === sym);
    if (comp && comp.status !== 'deleted') {
      console.log(`UPDATE companies SET \`status\`='deleted', \`demand\`=0, \`supply\`=0 WHERE \`sym\`='${sym}';`);
    }
  });

  console.log('\n-- ============================================================');
  console.log('-- Done. Review and execute in your remote MySQL.');
  console.log('-- ============================================================\n');
}
