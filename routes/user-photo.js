const path = require('path');
const fs   = require('fs');
const pool = require('../data/mysql');

function legacyDiskPath(photo) {
  if (!photo || !String(photo).startsWith('/uploads/')) return null;
  return path.join(__dirname, '..', 'public', photo.replace(/^\//, ''));
}

function hasBuffer(data) {
  if (!data) return false;
  return (Buffer.isBuffer(data) ? data.length : data.length) > 0;
}

/** Public — no session required. Serve a user's profile photo. */
async function serveUserPhoto(req, res) {
  const id = req.params.id;
  if (!id || id === 'me') return res.status(404).end();

  try {
    const [rows] = await pool.query(
      'SELECT photo_data, photo_mime, photo FROM users WHERE id = ?',
      [id]
    );
    if (!rows.length) return res.status(404).end();

    const row = rows[0];
    if (hasBuffer(row.photo_data)) {
      res.set('Content-Type', row.photo_mime || 'image/jpeg');
      res.set('Cache-Control', 'public, max-age=86400');
      return res.send(row.photo_data);
    }

    const diskPath = legacyDiskPath(row.photo);
    if (diskPath && fs.existsSync(diskPath)) {
      return res.sendFile(diskPath);
    }
    res.status(404).end();
  } catch (e) {
    console.error('serveUserPhoto:', e.message);
    res.status(500).end();
  }
}

/** Public — no session required. Serve a user's profile banner. */
async function serveUserBanner(req, res) {
  const id = req.params.id;
  if (!id || id === 'me') return res.status(404).end();

  try {
    const [rows] = await pool.query(
      'SELECT banner_data, banner_mime, banner FROM users WHERE id = ?',
      [id]
    );
    if (!rows.length) return res.status(404).end();

    const row = rows[0];
    if (hasBuffer(row.banner_data)) {
      res.set('Content-Type', row.banner_mime || 'image/jpeg');
      res.set('Cache-Control', 'public, max-age=86400');
      return res.send(row.banner_data);
    }

    const diskPath = legacyDiskPath(row.banner);
    if (diskPath && fs.existsSync(diskPath)) {
      return res.sendFile(diskPath);
    }
    res.status(404).end();
  } catch (e) {
    console.error('serveUserBanner:', e.message);
    res.status(500).end();
  }
}

module.exports = { serveUserPhoto, serveUserBanner, legacyDiskPath, hasBuffer };
