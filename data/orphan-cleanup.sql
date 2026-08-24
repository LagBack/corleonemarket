-- ============================================================
-- CORLEONE MARKET — Orphaned Company Cleanup (Manual SQL)
-- ============================================================
-- Run this in your remote MySQL database (phpMyAdmin / HeidiSQL / etc.)
-- This refunds users and removes orphaned portfolio holdings.
-- ============================================================

-- Step 1: See what orphans exist before cleaning up
SELECT 
    p.user_id,
    u.nick,
    p.sym AS company_symbol,
    c.name AS company_name,
    p.qty AS shares_held,
    u.balance AS current_balance
FROM portfolios p
JOIN users u ON u.id = p.user_id
LEFT JOIN companies c ON c.sym = p.sym
WHERE p.qty > 0 
  AND (c.sym IS NULL OR c.status != 'active')
ORDER BY p.user_id, p.sym;

-- Step 2: See the refund amounts per user (cost basis from buy transactions)
-- This shows how much each user should be refunded
SELECT 
    t.uid AS user_id,
    u.nick,
    t.sym,
    SUM(t.qty) AS total_bought,
    SUM(t.total) AS total_paid,
    ROUND(SUM(t.total)/SUM(t.qty), 2) AS avg_price_per_share,
    p.qty AS shares_still_held,
    ROUND((SUM(t.total)/SUM(t.qty)) * p.qty, 2) AS estimated_refund
FROM transactions t
JOIN users u ON u.id = t.uid
LEFT JOIN portfolios p ON p.user_id = t.uid AND p.sym = t.sym AND p.qty > 0
WHERE t.type = 'buy'
GROUP BY t.uid, t.sym, p.qty
HAVING t.sym NOT IN (SELECT sym FROM companies WHERE status = 'active');

-- Step 3: Refund users and clean up orphans (UNCOMMENT to execute)
-- Uncomment the following block ONLY after reviewing Steps 1 & 2 above

/*
-- Part A: Calculate refunds and update user balances
UPDATE users u
INNER JOIN (
    SELECT 
        t.uid AS user_id,
        ROUND((SUM(t.total)/SUM(t.qty)) * COALESCE(p.qty,0), 2) AS refund_amount
    FROM transactions t
    LEFT JOIN portfolios p ON p.user_id = t.uid AND p.sym = t.sym AND p.qty > 0
    WHERE t.type = 'buy'
      AND t.sym NOT IN (SELECT sym FROM companies WHERE status = 'active')
    GROUP BY t.uid, COALESCE(p.qty,0)
    HAVING refund_amount > 0.01
) refund ON refund.user_id = u.id
SET u.balance = u.balance + refund.refund_amount;

-- Part B: Delete orphaned portfolio entries
DELETE p FROM portfolios p
WHERE p.sym NOT IN (SELECT sym FROM companies WHERE status = 'active');

-- Step 4: Verify cleanup
SELECT 
    u.nick,
    u.balance AS new_balance,
    COUNT(DISTINCT p.sym) AS orphan_count
FROM users u
LEFT JOIN portfolios p ON p.user_id = u.id AND p.sym NOT IN (SELECT sym FROM companies WHERE status = 'active')
GROUP BY u.id
HAVING orphan_count > 0;
*/

-- ============================================================
-- End of cleanup script
-- ============================================================
