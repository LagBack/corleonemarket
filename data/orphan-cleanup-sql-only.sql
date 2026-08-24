-- ============================================================
-- CORLEONE MARKET — Orphaned Company Cleanup (Direct SQL)
-- ============================================================
-- Copy and paste each section into your remote MySQL database
-- via phpMyAdmin, HeidiSQL, or your hosting's database panel.
-- ============================================================

-- STEP 1: AUDIT — See all orphaned holdings
SELECT 
    p.user_id,
    u.nick,
    u.name,
    u.balance AS current_balance,
    p.sym AS company_symbol,
    c.name AS company_name,
    c.status AS company_status,
    p.qty AS shares_held
FROM portfolios p
JOIN users u ON u.id = p.user_id
LEFT JOIN companies c ON c.sym = p.sym
WHERE p.qty > 0 
  AND (c.sym IS NULL OR c.status != 'active')
ORDER BY p.user_id, p.sym;

-- STEP 2: AUDIT — Estimated refund per user per symbol
-- Uses purchase transaction cost basis: totalPaid / totalBought * remainingQty
SELECT 
    t.uid AS user_id,
    u.nick,
    t.sym,
    SUM(t.qty) AS total_bought_shares,
    SUM(t.total) AS total_paid_amount,
    ROUND(SUM(t.total)/SUM(t.qty), 2) AS avg_price_per_share,
    COALESCE(p.qty,0) AS shares_still_held_in_portfolio,
    ROUND((SUM(t.total)/SUM(t.qty)) * COALESCE(p.qty,0), 2) AS estimated_refund_amount
FROM transactions t
JOIN users u ON u.id = t.uid
LEFT JOIN portfolios p ON p.user_id = t.uid AND p.sym = t.sym AND p.qty > 0
WHERE t.type = 'buy'
GROUP BY t.uid, t.sym, COALESCE(p.qty,0)
HAVING t.sym NOT IN (SELECT sym FROM companies WHERE status = 'active')
ORDER BY estimated_refund_amount DESC;

-- STEP 3: EXECUTE — Refund users (UNCOMMENT the block below to execute)
/*
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

-- STEP 4: EXECUTE — Remove orphaned portfolio entries (UNCOMMENT to execute)
DELETE p FROM portfolios p
WHERE p.sym NOT IN (SELECT sym FROM companies WHERE status = 'active');

-- STEP 5: EXECUTE — Remove orphaned company_owners entries
DELETE FROM company_owners 
WHERE `sym` NOT IN (SELECT sym FROM companies WHERE status = 'active');

-- STEP 6: VERIFY — Check remaining orphans (should show 0)
SELECT COUNT(*) AS remaining_orphans 
FROM portfolios p 
LEFT JOIN companies c ON c.sym = p.sym
WHERE p.qty > 0 AND (c.sym IS NULL OR c.status != 'active');
*/
