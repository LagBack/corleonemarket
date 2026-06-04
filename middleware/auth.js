const db = require('../data/db');

function syncSessionRole(req) {
  if (!req.session.userId) return;
  const user = db.get('users').find({ id: req.session.userId }).value();
  if (user) req.session.role = user.role;
}

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Não autenticado' });
  syncSessionRole(req);
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Não autenticado' });
  syncSessionRole(req);
  if (!['admin', 'dev'].includes(req.session.role)) {
    return res.status(403).json({ error: 'Acesso negado. Requer admin.' });
  }
  next();
}

function requireMod(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Não autenticado' });
  syncSessionRole(req);
  if (!['admin', 'moderator', 'dev'].includes(req.session.role)) {
    return res.status(403).json({ error: 'Acesso negado. Requer moderador ou admin.' });
  }
  next();
}

function requireDev(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Não autenticado' });
  syncSessionRole(req);
  if (req.session.role !== 'dev') {
    return res.status(403).json({ error: 'Acesso negado. Requer dev.' });
  }
  next();
}

module.exports = { requireAuth, requireAdmin, requireMod, requireDev };
