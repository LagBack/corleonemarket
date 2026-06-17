// ── Economic System Admin API ────────────────────────────────────────
// Endpoints for admin/mod to inspect and manually trigger economic events.

const router       = require('express').Router();
const pool         = require('../data/mysql');
const db           = require('../data/db');
const econConfig   = require('../data/economic-config');
const econEngine   = require('../data/economic-engine');
const usersStore   = require('../data/users-store');
const { requireAuth } = require('../middleware/auth');

// GET /api/economic/config — view current configuration
router.get('/config', requireAuth, (req, res) => {
  res.json({
    buyFeeRate: econConfig.buyFeeRate * 100,        // display as percent
    sellFeeRate: econConfig.sellFeeRate * 100,
    dailyMaintenanceBrackets: econConfig.dailyMaintenanceBrackets.map(b => ({
      min: b.min, max: b.max === Infinity ? null : b.max, rate: b.rate * 100
    })),
    wealthTaxBrackets: econConfig.wealthTaxBrackets.map(b => ({
      min: b.min, max: b.max === Infinity ? null : b.max, rate: b.rate * 100
    })),
    wealthTaxCycleDays: econConfig.wealthTaxCycleDays,
  });
});

// GET /api/economic/reports/daily — recent daily maintenance fees
router.get('/reports/daily', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT ef.*, u.nick, u.name FROM economic_fees ef
       LEFT JOIN users u ON ef.user_id = u.id
       WHERE ef.fee_type = 'daily_maintenance'
       ORDER BY ef.created_at DESC LIMIT 200`
    );
    res.json(rows);
  } catch (e) {
    res.json([]); // table may not exist
  }
});

// GET /api/economic/reports/wealth — recent wealth tax records
router.get('/reports/wealth', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT ef.*, u.nick, u.name FROM economic_fees ef
       LEFT JOIN users u ON ef.user_id = u.id
       WHERE ef.fee_type LIKE 'wealth_tax%' AND ef.amount > 0
       ORDER BY ef.created_at DESC LIMIT 200`
    );
    res.json(rows);
  } catch (e) {
    res.json([]); // table may not exist
  }
});

// GET /api/economic/reports/summary — summary of economic activity
router.get('/reports/summary', requireAuth, async (req, res) => {
  try {
    const [dailyRows] = await pool.query(
      `SELECT COUNT(*) as totalCharges, SUM(amount) as totalCollected
       FROM economic_fees WHERE fee_type = 'daily_maintenance'`
    );
    const [taxRows] = await pool.query(
      `SELECT COUNT(*) as totalCharges, SUM(amount) as totalCollected
       FROM economic_fees WHERE fee_type LIKE 'wealth_tax%' AND amount > 0`
    );
    const [feeColCheck] = await pool.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_NAME = 'transactions' AND COLUMN_NAME = 'fee'`
    );

    res.json({
      dailyMaintenance: { totalCharges: Number(dailyRows[0].totalCharges) || 0, totalCollected: Number(dailyRows[0].totalCollected) || 0 },
      wealthTax:        { totalCharges: Number(taxRows[0].totalCharges) || 0, totalCollected: Number(taxRows[0].totalCollected) || 0 },
      tradingFeesActive: feeColCheck.length > 0,
    });
  } catch (e) {
    res.json({ dailyMaintenance: { totalCharges: 0, totalCollected: 0 }, wealthTax: { totalCharges: 0, totalCollected: 0 }, tradingFeesActive: false });
  }
});

// POST /api/economic/manual/maintenance — manually trigger daily maintenance
router.post('/manual/maintenance', requireAuth, async (req, res) => {
  try {
    await econEngine.chargeDailyMaintenance();
    res.json({ ok: true, message: 'Taxa diária aplicada manualmente.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/economic/manual/wealth-tax — manually trigger wealth tax
router.post('/manual/wealth-tax', requireAuth, async (req, res) => {
  try {
    await econEngine.chargeWealthTax();
    res.json({ ok: true, message: 'Imposto patrimonial aplicado manualmente.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/economic/user/:id/net-worth — compute net worth for a user
router.get('/user/:id/net-worth', requireAuth, async (req, res) => {
  try {
    const result = await econEngine.computeNetWorth(req.params.id);
    const feeLabel = econConfig.calculateDailyMaintenance(result.netWorth) > 0
      ? econConfig.getMaintenanceBracketLabel(result.netWorth)
      : 'Isento (abaixo de R$1.000.000)';
    const taxLabel = econConfig.calculateWealthTax(result.netWorth) > 0
      ? econConfig.getWealthTaxBracketLabel(result.netWorth)
      : 'Isento (abaixo de R$5.000.000)';

    res.json({ ...result, maintenanceRate: feeLabel, taxRate: taxLabel });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
