const router = require('express').Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../data/db');
const { requireAuth } = require('../middleware/auth');

// Photo upload config
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '../public/uploads')),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${req.session.userId}_${Date.now()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/image\/(jpeg|png|gif|webp)/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Apenas imagens são permitidas.'));
  }
});

// GET /api/users/me
router.get('/me', requireAuth, (req, res) => {
  const user = db.get('users').find({ id: req.session.userId }).value();
  if (!user) return res.status(404).json({ error: 'Não encontrado' });
  const { pass, ...safe } = user;
  res.json(safe);
});

// PUT /api/users/me  — update profile
router.put('/me', requireAuth, (req, res) => {
  const { nick, bio, country, avatar } = req.body;
  const updates = {};
  if (nick !== undefined)    updates.nick    = nick;
  if (bio !== undefined)     updates.bio     = bio;
  if (country !== undefined) updates.country = country;
  if (avatar !== undefined)  updates.avatar  = avatar;
  db.get('users').find({ id: req.session.userId }).assign(updates).write();
  const updated = db.get('users').find({ id: req.session.userId }).value();
  const { pass, ...safe } = updated;
  res.json({ ok: true, user: safe });
});

// POST /api/users/me/photo  — upload profile photo
router.post('/me/photo', requireAuth, upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  const photoUrl = `/uploads/${req.file.filename}`;
  // Delete old photo if exists
  const user = db.get('users').find({ id: req.session.userId }).value();
  if (user.photo) {
    const oldPath = path.join(__dirname, '../public', user.photo);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }
  db.get('users').find({ id: req.session.userId }).assign({ photo: photoUrl }).write();
  res.json({ ok: true, photo: photoUrl });
});

// DELETE /api/users/me/photo
router.delete('/me/photo', requireAuth, (req, res) => {
  const user = db.get('users').find({ id: req.session.userId }).value();
  if (user.photo) {
    const oldPath = path.join(__dirname, '../public', user.photo);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }
  db.get('users').find({ id: req.session.userId }).assign({ photo: null }).write();
  res.json({ ok: true });
});

module.exports = router;
