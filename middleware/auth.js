const pool = require('../data/mysql');

function syncSessionRole(req) {
  if (!req.session.userId) return Promise.resolve();
  return pool.query('SELECT role FROM users WHERE id = ?', [req.session.userId])
    .then(([rows]) => {
      if (rows.length) req.session.role = rows[0].role;
    });
}

function runWithRoleSync(req, res, next, check) {
  if (!req.session.userId) return res.status(401).json({ error: 'Não autenticado' });
  syncSessionRole(req)
    .then(() => check(req, res, next))
    .catch(err => res.status(500).json({ error: err.message }));
}

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Não autenticado' });
  syncSessionRole(req).then(() => next()).catch(err => res.status(500).json({ error: err.message }));
}

function requireAdmin(req, res, next) {
  runWithRoleSync(req, res, next, () => {
    if (!['admin', 'dev'].includes(req.session.role)) {
      return res.status(403).json({ error: 'Acesso negado. Requer admin.' });
    }
    next();
  });
}

function requireMod(req, res, next) {
  runWithRoleSync(req, res, next, () => {
    if (!['admin', 'moderator', 'dev'].includes(req.session.role)) {
      return res.status(403).json({ error: 'Acesso negado. Requer moderador ou admin.' });
    }
    next();
  });
}

function requireDev(req, res, next) {
  runWithRoleSync(req, res, next, () => {
    if (req.session.role !== 'dev') {
      return res.status(403).json({ error: 'Acesso negado. Requer dev.' });
    }
    next();
  });
}

module.exports = { requireAuth, requireAdmin, requireMod, requireDev };
