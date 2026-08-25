const router = require('express').Router();
const multer = require('multer');
const pool   = require('../data/mysql');
const { normalizeCountry } = require('../data/countries');
const { toPublicUser, photoUrlForUser, hasAnyPhoto, hasAnyBanner, bannerDataUrl } = require('../data/user-serialize');
const { legacyDiskPath } = require('./user-photo');
const fs     = require('fs');
const { requireAuth } = require('../middleware/auth');
const { computeTier }  = require('../data/tiers');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/image\/(jpeg|png|gif|webp|jpg)/i.test(file.mimetype)) cb(null, true);
    else cb(new Error('Apenas imagens são permitidas (JPEG, PNG, GIF, WebP).'));
  }
});

function unlinkLegacyPhoto(photo) {
  const diskPath = legacyDiskPath(photo);
  if (diskPath && fs.existsSync(diskPath)) {
    try { fs.unlinkSync(diskPath); } catch (_) {}
  }
}

// GET /api/users/me
router.get('/me', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [req.session.userId]);
    if (!rows.length) return res.status(404).json({ error: 'Não encontrado' });

    // Compute wealth tier (balance + portfolio market value)
    let mv = 0;
    let orphanQty = 0;
    const orphans = [];
    const pfRows = await pool.query('SELECT sym, qty FROM portfolios WHERE user_id = ? AND qty > 0', [req.session.userId]);
    const [stockRows] = await pool.query('SELECT `sym`, `price` FROM companies');
    const stockMap = {};
    // MUST uppercase keys — portfolios table always stores UPPERCASE symbols (e.g. 'CRLNE4')
    // If companies.sym is stored as lowercase/mixed-case, case-sensitive JS lookup would fail
    stockRows.forEach(s => { stockMap[s.sym.toUpperCase()] = s.price; });

    for (const r of pfRows) {
      if (!r?.sym) continue;  // skip rows with null/empty symbol
      const symUpper = r.sym.toUpperCase();
      if (stockMap[symUpper]) {
        mv += stockMap[symUpper] * r.qty;
      } else {
        orphanQty += r.qty;
        orphans.push({ sym: r.sym, qty: r.qty });
      }
    }
    const totalWealth = rows[0].balance + mv;

    res.json({ ...toPublicUser(rows[0], { includePhotoData: true }), wealthTier: computeTier(totalWealth), assetsCount: pfRows.length, orphanQty, orphans: orphans.length > 0 ? orphans : undefined });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/users/me/dividends — before /:id/* routes
router.get('/me/dividends', requireAuth, async (req, res) => {
  const uid = req.session.userId;
  try {
    // Dividends from MySQL table
    const [divRows] = await pool.query(
      'SELECT * FROM dividends WHERE owner_id = ? ORDER BY ts DESC LIMIT 100',
      [uid]
    );
    const divs = divRows.map(d => ({ ...d, founderId: d.owner_id })); // keep shape for frontend compat
    const total = divs.reduce((a, d) => a + (d.fee || d.fee || 0), 0);

    // Owned stocks from MySQL
    const [stockRows] = await pool.query('SELECT `sym`, `price`, `name`, `total_revenue` FROM companies WHERE `status` = "active"');
    const stockMap = {};
    // MUST uppercase keys — company_owners table stores UPPERCASE symbols
    stockRows.forEach(s => { stockMap[s.sym.toUpperCase()] = s; });

    const [ownerRows] = await pool.query(
      'SELECT sym, pct FROM company_owners WHERE user_id = ?',
      [uid]
    );
    const ownedStocks = ownerRows.map(o => ({
      sym: o.sym,
      name: stockMap[o.sym]?.name || o.sym,
      pct: o.pct,
      totalRevenue: stockMap[o.sym]?.total_revenue || 0,
      price: stockMap[o.sym]?.price || 0
    }));

    // myListings - ownership listings are handled via /api/stocks/:sym/ownership-listings
    res.json({
      dividends: divs,
      total: Math.round(total * 100) / 100,
      ownedStocks,
      founded: ownedStocks,
      myListings: []
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/users/me
router.put('/me', requireAuth, async (req, res) => {
  const body = req.body; // may include name, nick, bio, country, avatar
  const sets = [];
  const vals = [];
  if (body.name !== undefined)       { sets.push('`name`=?');   vals.push(body.name); }
  if (body.nick !== undefined)       { sets.push('`nick`=?');   vals.push(body.nick); }
  if (body.bio !== undefined)        { sets.push('`bio`=?');    vals.push(body.bio); }
  if (body.country !== undefined)    { sets.push('`country`=?'); vals.push(normalizeCountry(body.country)); }
  if (body.avatar !== undefined)     { sets.push('`avatar`=?');  vals.push(body.avatar); }
  try {
    if (!sets.length) return res.status(400).json({ error: 'Nada para atualizar.' });
    const query = 'UPDATE users SET ' + sets.join(', ') + ' WHERE id=?';
    await pool.query(query, [...vals, req.session.userId]);
    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [req.session.userId]);
    res.json({ ok: true, user: toPublicUser(rows[0], { includePhotoData: true }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/users/me/photo
router.post('/me/photo', requireAuth, (req, res, next) => {
  upload.single('photo')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload inválido.' });
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  const uid = req.session.userId;
  const photoUrl = `/api/users/${uid}/photo`;
  try {
    const [rows] = await pool.query('SELECT photo FROM users WHERE id = ?', [uid]);
    if (rows.length && rows[0].photo) unlinkLegacyPhoto(rows[0].photo);

    await pool.query(
      `UPDATE users SET \`photo\`=?, \`photo_data\`=?, \`photo_mime\`=? WHERE \`id\`=?`,
      [photoUrl, req.file.buffer, req.file.mimetype, uid]
    );

    const display = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    res.json({ ok: true, photo: photoUrl, photoDisplay: display });
  } catch (e) {
    console.error('Photo upload error:', e.message);
    if (/Unknown column/i.test(e.message)) {
      return res.status(500).json({
        error: 'Banco desatualizado. Reinicie o servidor para aplicar migrações ou rode mysql-migrate.'
      });
    }
    res.status(500).json({ error: e.message || 'Não foi possível salvar a foto.' });
  }
});

// DELETE /api/users/me/photo
router.delete('/me/photo', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT photo FROM users WHERE id = ?', [req.session.userId]);
    if (!rows.length) return res.status(404).json({ error: 'Não encontrado' });
    const user = rows[0];

    const diskPath = legacyDiskPath(user.photo);
    if (diskPath && fs.existsSync(diskPath)) {
      try { fs.unlinkSync(diskPath); } catch (_) {}
    }

    await pool.query(
      'UPDATE users SET `photo`=NULL, `photo_data`=NULL, `photo_mime`=NULL WHERE `id`=?',
      [req.session.userId]
    );
    res.json({ ok: true });
  } catch (e) {
    if (/Unknown column/i.test(e.message)) {
      return res.status(500).json({
        error: 'Colunas de foto não existem. Execute: node data/mysql-migrate.js'
      });
    }
    res.status(500).json({ error: e.message });
  }
});

// ── Banner upload helpers ──

function unlinkLegacyBanner(bannerPath) {
  const diskPath = legacyDiskPath(bannerPath);
  if (diskPath && fs.existsSync(diskPath)) {
    try { fs.unlinkSync(diskPath); } catch (_) {}
  }
}

// POST /api/users/me/banner
router.post('/me/banner', requireAuth, (req, res, next) => {
  upload.single('banner')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload inválido.' });
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  const uid = req.session.userId;
  const bannerUrl = `/api/users/${uid}/banner`;
  try {
    const [rows] = await pool.query('SELECT banner FROM users WHERE id = ?', [uid]);
    if (rows.length && rows[0].banner) unlinkLegacyBanner(rows[0].banner);

    await pool.query(
      `UPDATE users SET \`banner\`=?, \`banner_data\`=?, \`banner_mime\`=? WHERE \`id\`=?`,
      [bannerUrl, req.file.buffer, req.file.mimetype, uid]
    );

    const display = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    res.json({ ok: true, banner: bannerUrl, bannerDisplay: display });
  } catch (e) {
    console.error('Banner upload error:', e.message);
    if (/Unknown column/i.test(e.message)) {
      return res.status(500).json({
        error: 'Banco desatualizado. Reinicie o servidor para aplicar migrações ou rode mysql-migrate.'
      });
    }
    res.status(500).json({ error: e.message || 'Não foi possível salvar o banner.' });
  }
});

// DELETE /api/users/me/banner
router.delete('/me/banner', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT banner FROM users WHERE id = ?', [req.session.userId]);
    if (!rows.length) return res.status(404).json({ error: 'Não encontrado' });
    const user = rows[0];

    const diskPath = legacyDiskPath(user.banner);
    if (diskPath && fs.existsSync(diskPath)) {
      try { fs.unlinkSync(diskPath); } catch (_) {}
    }

    await pool.query(
      'UPDATE users SET `banner`=NULL, `banner_data`=NULL, `banner_mime`=NULL WHERE `id`=?',
      [req.session.userId]
    );
    res.json({ ok: true });
  } catch (e) {
    if (/Unknown column/i.test(e.message)) {
      return res.status(500).json({
        error: 'Colunas de banner não existem. Execute: node data/mysql-migrate.js'
      });
    }
    res.status(500).json({ error: e.message });
  }
});


// GET /api/users/:id/public
router.get('/:id/public', async (req, res) => {
  if (req.params.id === 'me') {
    return res.status(400).json({ error: 'Use GET /api/users/me' });
  }
  try {
    const uid = req.params.id;
    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [uid]);
    if (!rows.length) return res.status(404).json({ error: 'Usuario nao encontrado.' });
    const user = rows[0];
    // Load ALL companies (including deleted) so ticker matching works for re-created companies
    const stocks = await pool.query('SELECT `sym`, `price`, `name`, `sector`, `shares`, `status`, `day_open`, `open` FROM companies');
    const stockMap = {};
    // MUST uppercase keys — portfolios table always stores UPPERCASE symbols (e.g. 'CRLNE4')
    if (stocks && stocks.length) {
      for (const s of stocks) {
        if (!s || !s.sym) continue;  // skip rows with missing data
        const key = s.sym.toUpperCase();
        const existing = stockMap[key];
        if (!existing) {
          stockMap[key] = s;
        } else if (s.status === 'active' && existing.status !== 'active') {
          // Prefer active over non-active when duplicate ticker exists
          stockMap[key] = s;
        }
      }
    };
    const hideFinance = ['admin', 'dev'].includes(user.role);

    const [pfRows] = await pool.query(
      'SELECT sym, qty FROM portfolios WHERE user_id = ? AND qty > 0',
      [uid]
    );
    const [txRows] = await pool.query(
      'SELECT `type`, `sym`, `qty`, `price`, `total`, `time`, `ts` FROM transactions WHERE `uid` = ? ORDER BY `ts` DESC LIMIT 100',
      [uid]
    );
    const [txCountRows] = await pool.query(
      `SELECT
         COUNT(*) AS totalTx,
         SUM(type = 'buy') AS buys,
         SUM(type = 'sell') AS sells,
         COALESCE(SUM(CASE WHEN type = 'buy'  THEN total ELSE 0 END), 0) AS buyVolume,
         COALESCE(SUM(CASE WHEN type = 'sell' THEN total ELSE 0 END), 0) AS sellVolume
       FROM transactions WHERE uid = ?`,
      [uid]
    );
    const txStats = txCountRows[0] || {};

    let mv = 0;
    let delistedQty = 0;
    const delisteds = [];
    const trueOrphans = [];
    const holdings = pfRows.filter(r => r?.sym).map(({ sym, qty }) => {
      const s = stockMap[sym.toUpperCase()];
      if (!s) {
        // True orphan: ticker doesn't exist at all in companies table
        delistedQty += qty;
        trueOrphans.push({ sym, qty });
        return {
          sym,
          name: `🗑️ ${sym} (not found)`,
          sector: 'unknown',
          qty,
          price: 0,
          value: 0,
          pctOfCompany: 0,
          dayPct: 0,
          status: 'deleted',
        };
      }
      const isDelisted = s.status !== 'active';
      if (isDelisted) {
        // Company exists but not active (may have been deleted and re-created with same ticker)
        delistedQty += qty;
        delisteds.push({ sym, qty });
        const value = qty > 0 ? 0 : 0; // don't count delisted value in wealth
        return {
          sym: s.sym,
          name: `🗑️ ${s.name} (${sym})`,
          sector: s.sector || 'unknown',
          qty,
          price: s.price || 0,
          value: 0,
          pctOfCompany: qty / (s.shares || 1) * 100,
          dayPct: 0,
          status: s.status,
        };
      }
      const value = s.price * qty;
      mv += value;
      const ref = s.day_open != null ? s.day_open : s.open;
      const dayPct = ref > 0 ? (s.price - ref) / ref * 100 : 0;
      return {
        sym,
        name: s.name,
        sector: s.sector,
        qty,
        price: s.price,
        value,
        pctOfCompany: qty / (s.shares || 1) * 100,
        dayPct: Math.round(dayPct * 100) / 100,
        status: s.status,
      };
    }).sort((a, b) => (b.value || 0) - (a.value || 0));

    const totalWealth = hideFinance ? null : user.balance + mv;
    holdings.forEach(h => {
      h.pctOfPortfolio = totalWealth > 0 ? Math.round(h.value / totalWealth * 10000) / 100 : 0;
    });

    const transactions = txRows.map(t => ({
      type: t.type,
      sym: t.sym,
      qty: t.qty,
      price: t.price,
      total: t.total,
      time: t.time,
      ts: t.ts,
    }));

    res.json({
      id: user.id,
      nick: user.nick || user.name,
      name: user.name,
      avatar: user.avatar,
      photo: hasAnyPhoto(user) ? photoUrlForUser(user) : null,
      banner: hasAnyBanner(user) ? `/api/users/${user.id}/banner` : null,
      bannerDisplay: bannerDataUrl(user),
      country: user.country,
      bio: user.bio,
      role: user.role,
      joined: user.joined,
      balance: hideFinance ? null : user.balance,
      cash: hideFinance ? null : user.balance,
      marketValue: hideFinance ? null : Math.round(mv * 100) / 100,
      totalWealth: hideFinance ? null : Math.round(totalWealth * 100) / 100,
      wealthTier: hideFinance ? 'investidor' : computeTier(totalWealth),
      hasDonated: !!user.has_donated,
      totalTx: Number(txStats.totalTx) || 0,
      buys: Number(txStats.buys) || 0,
      sells: Number(txStats.sells) || 0,
      buyVolume: hideFinance ? null : Math.round(Number(txStats.buyVolume) * 100) / 100,
      sellVolume: hideFinance ? null : Math.round(Number(txStats.sellVolume) * 100) / 100,
      holdings,
      transactions,
      assetsCount: holdings.length,
      delistedQty, delisteds: delisteds.length > 0 ? delisteds : undefined, orphanQty: trueOrphans.reduce((a,o) => a + o.qty, 0), orphans: trueOrphans.length > 0 ? trueOrphans : undefined,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
