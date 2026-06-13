const router = require('express').Router();
const multer = require('multer');
const pool   = require('../data/mysql');
const { normalizeCountry } = require('../data/countries');
const { toPublicUser, photoUrlForUser, hasAnyPhoto, hasAnyBanner, bannerDataUrl } = require('../data/user-serialize');
const { legacyDiskPath } = require('./user-photo');
const fs     = require('fs');
const db     = require('../data/db');
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
    const pfRows = await pool.query('SELECT sym, qty FROM portfolios WHERE user_id = ? AND qty > 0', [req.session.userId]);
    const stocks = db.get('stocks').value();
    for (const r of pfRows[0]) {
      const s = stocks.find(x => x.sym === r.sym);
      if (s) mv += s.price * r.qty;
    }
    const totalWealth = rows[0].balance + mv;

    res.json({ ...toPublicUser(rows[0], { includePhotoData: true }), wealthTier: computeTier(totalWealth) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/users/me/dividends — before /:id/* routes
router.get('/me/dividends', requireAuth, async (req, res) => {
  const uid  = req.session.userId;
  const divs = (db.get('dividends').value() || [])
    .filter(d => d.founderId === uid).sort((a, b) => b.ts - a.ts).slice(0, 100);
  const total = divs.reduce((a, d) => a + d.fee, 0);
  const allStocks = db.get('stocks').value();
  const ownedStocks = allStocks
    .filter(s => Array.isArray(s.owners) && s.owners.some(o => o.userId === uid))
    .map(s => {
      const o = s.owners.find(o => o.userId === uid);
      return { sym: s.sym, name: s.name, pct: o.pct, totalRevenue: s.totalRevenue || 0, price: s.price };
    });
  const myListings = (db.get('ownershipListings').value() || [])
    .filter(l => l.sellerId === uid && l.status === 'open');
  res.json({
    dividends: divs,
    total: Math.round(total * 100) / 100,
    ownedStocks,
    founded: ownedStocks,
    myListings
  });
});

// PUT /api/users/me
router.put('/me', requireAuth, async (req, res) => {
  const body = req.body; // may include name, nick, bio, country, avatar
  const sets = [];
  const vals = [];
  if (body.name !== undefined)       { sets.push('name=?');   vals.push(body.name); }
  if (body.nick !== undefined)       { sets.push('nick=?');   vals.push(body.nick); }
  if (body.bio !== undefined)        { sets.push('bio=?');    vals.push(body.bio); }
  if (body.country !== undefined)    { sets.push('country=?'); vals.push(normalizeCountry(body.country)); }
  if (body.avatar !== undefined)     { sets.push('avatar=?');  vals.push(body.avatar); }
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
      `UPDATE users SET photo=?, photo_data=?, photo_mime=? WHERE id=?`,
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
    if (!rows.length) return res.status(404).json({ error: 'N達o encontrado' });
    const user = rows[0];

    // Clean up old disk-based photo (legacy) if it still exists on disk
    const diskPath = legacyDiskPath(user.photo);
    if (diskPath && fs.existsSync(diskPath)) {
      try { fs.unlinkSync(diskPath); } catch (_) {}
    }

    await pool.query(
      'UPDATE users SET photo=NULL, photo_data=NULL, photo_mime=NULL WHERE id=?',
      [req.session.userId]
    );
    res.json({ ok: true });
  } catch (e) {
    if (/Unknown column/i.test(e.message)) {
      return res.status(500).json({
        error: 'Colunas de foto n達o existem. Execute: node data/mysql-migrate.js'
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
      `UPDATE users SET banner=?, banner_data=?, banner_mime=? WHERE id=?`,
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
      'UPDATE users SET banner=NULL, banner_data=NULL, banner_mime=NULL WHERE id=?',
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
    const stocks = db.get('stocks').value();
    const hideFinance = ['admin', 'dev'].includes(user.role);

    const [pfRows] = await pool.query(
      'SELECT sym, qty FROM portfolios WHERE user_id = ? AND qty > 0',
      [uid]
    );
    const [txRows] = await pool.query(
      'SELECT type, sym, qty, price, total, time, ts FROM transactions WHERE uid = ? ORDER BY ts DESC LIMIT 100',
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
    const holdings = pfRows.map(({ sym, qty }) => {
      const s = stocks.find(x => x.sym === sym);
      if (!s) return null;
      const value = s.price * qty;
      mv += value;
      const ref = s.dayOpen != null ? s.dayOpen : s.open;
      const dayPct = ref > 0 ? (s.price - ref) / ref * 100 : 0;
      return {
        sym,
        name: s.name,
        sector: s.sector,
        qty,
        price: s.price,
        value,
        pctOfCompany: qty / s.shares * 100,
        dayPct: Math.round(dayPct * 100) / 100,
        status: s.status,
      };
    }).filter(Boolean).sort((a, b) => b.value - a.value);

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
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
