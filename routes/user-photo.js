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

/** Public — no session required */
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

module.exports = { serveUserPhoto, legacyDiskPath, hasBuffer };
