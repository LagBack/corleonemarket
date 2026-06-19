// ── Economic System Admin API ────────────────────────────────────────
// Endpoints for admin/mod to inspect, edit, and manually trigger economic events.

const router       = require('express').Router();
const pool         = require('../data/mysql');
const db           = require('../data/db');
const econConfig   = require('../data/economic-config');
const econEngine   = require('../data/economic-engine');
const usersStore   = require('../data/users-store');
const { requireAuth } = require('../middleware/auth');

// GET /api/economic/config — view current configuration (rates as display-percents)
router.get('/config', requireAuth, (req, res) => {
  const c = econConfig.getConfig();
  // All rates are stored as decimals internally; convert to display-percent for frontend.
  const _toPct = r => Math.round(r * 10000) / 100; // handle floating point imprecision
  res.json({
    buyFeeRate:         _toPct(c.buyFeeRate),
    sellFeeRate:        _toPct(c.sellFeeRate),
    dailyMaintenanceBrackets: c.dailyMaintenanceBrackets.map(b => ({
      min: b.min, max: b.max === Infinity ? null : b.max, rate: _toPct(b.rate)
    })),
    wealthTaxBrackets: c.wealthTaxBrackets.map(b => ({
      min: b.min, max: b.max === Infinity ? null : b.max, rate: _toPct(b.rate)
    })),
    wealthTaxCycleDays: c.wealthTaxCycleDays,
  });
});

// PUT /api/economic/config — update configuration (admin/dev only)
router.put('/config', requireAuth, async (req, res) => {
  try {
    const body = req.body;

    // Validate basic fields
    if (body.buyFeeRate === undefined || body.sellFeeRate === undefined)
      return res.status(400).json({ error: 'buyFeeRate e sellFeeRate obrigatórios.' });
    if (!Array.isArray(body.dailyMaintenanceBrackets) || !Array.isArray(body.wealthTaxBrackets))
      return res.status(400).json({ error: 'Bracket arrays inválidos.' });
    if (body.wealthTaxCycleDays === undefined)
      return res.status(400).json({ error: 'wealthTaxCycleDays é obrigatório.' });

    // Validate bracket structure and ordering
    function validateBrackets(brackets, name) {
      for (let i = 0; i < brackets.length; i++) {
        const b = brackets[i];
        if (typeof b.min !== 'number' || typeof b.rate !== 'number')
          return `${name}[${i}]: min e rate devem ser números`;
        if (b.max !== null && typeof b.max !== 'number')
          return `${name}[${i}]: max deve ser número ou null`;
        if (b.rate < 0 || b.rate > 100)
          return `${name}[${i}]: rate fora do intervalo (0-100)`;
      }
      // With findBracket using >=/<, adjacent boundaries are valid.
      // Reject only inverted order (brackets not sorted ascending by min).
      for (let i = 1; i < brackets.length; i++) {
        if (brackets[i].min <= brackets[i - 1].min)
          return `${name}: ordenação inválida em índice ${i}`;
      }
      return null;
    }

    const dailyErr = validateBrackets(body.dailyMaintenanceBrackets, 'dailyMaintenanceBrackets');
    const wealthErr = validateBrackets(body.wealthTaxBrackets, 'wealthTaxBrackets');
    if (dailyErr) return res.status(400).json({ error: dailyErr });
    if (wealthErr) return res.status(400).json({ error: wealthErr });

    // Convert display-percent to decimal for storage in JSON
    const _toDec = r => Math.round(r / 100 * 10000) / 10000; // safe percent→decimal

    // Sanitize: last bracket must always have max=Infinity (guard against corrupted data like max=0/NaN)
    function sanitizeLastBracket(arr) {
      if (!arr || arr.length === 0) return arr;
      const last = arr[arr.length - 1];
      if (last.min >= Infinity || !isFinite(last.max) || Number(last.max) !== Number(last.max)) {
        // NaN or non-finite → Infinity
        arr[arr.length - 1] = { ...last, max: Infinity };
      } else if (Number(last.max) === 0 && last.min > 0) {
        // Corrupted zero where it should be Infinity
        arr[arr.length - 1] = { ...last, max: Infinity };
      }
      return arr;
    }

    econConfig.saveConfig({
      buyFeeRate:         _toDec(body.buyFeeRate),
      sellFeeRate:        _toDec(body.sellFeeRate),
      dailyMaintenanceBrackets: sanitizeLastBracket(body.dailyMaintenanceBrackets).map(b => ({
        min: Number(b.min), max: b.max === null ? Infinity : Number(b.max), rate: _toDec(Number(b.rate))
      })),
      wealthTaxBrackets:  sanitizeLastBracket(body.wealthTaxBrackets).map(b => ({
        min: Number(b.min), max: b.max === null ? Infinity : Number(b.max), rate: _toDec(Number(b.rate))
      })),
      wealthTaxCycleDays: Number(body.wealthTaxCycleDays),
    });

    // Log to admin log
    try {
      db.get('adminLog').push({
        t: new Date().toLocaleTimeString('pt-BR'),
        msg: `⚙️ Configuração econômica atualizada por ${req.user?.nick || req.user?.name || 'unknown'}`
      }).write();
    } catch (_) { /* non-critical */ }

    res.json({ ok: true, message: 'Configuração econômica salva com sucesso.' });
  } catch (e) {
    console.error('Error saving economic config:', e);
    res.status(500).json({ error: e.message });
  }
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
