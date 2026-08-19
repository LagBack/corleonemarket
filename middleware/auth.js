const pool = require('../data/mysql');
const { normalizeRole } = require('../data/roles');

const ROLE_SYNC_MS = 60 * 1000;

function syncSessionRole(req, force = false) {
  if (!req.session.userId) return Promise.resolve();
  const now = Date.now();
  if (!force && req.session.roleSyncedAt && (now - req.session.roleSyncedAt) < ROLE_SYNC_MS) {
    req.session.role = normalizeRole(req.session.role);
    return Promise.resolve();
  }
  return pool.query('SELECT `role` FROM users WHERE `id` = ?', [req.session.userId])
    .then(([rows]) => {
      if (rows.length) req.session.role = normalizeRole(rows[0].role);
      req.session.roleSyncedAt = now;
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
    const role = normalizeRole(req.session.role);
    if (!['admin', 'dev'].includes(role)) {
      return res.status(403).json({ error: 'Acesso negado. Requer admin.' });
    }
    next();
  });
}

function requireMod(req, res, next) {
  runWithRoleSync(req, res, next, () => {
    const role = normalizeRole(req.session.role);
    if (!['admin', 'moderator', 'dev'].includes(role)) {
      return res.status(403).json({ error: 'Acesso negado. Requer moderador ou admin.' });
    }
    next();
  });
}

function requireDev(req, res, next) {
  runWithRoleSync(req, res, next, () => {
    if (normalizeRole(req.session.role) !== 'dev') {
      return res.status(403).json({ error: 'Acesso negado. Requer dev.' });
    }
    next();
  });
}

module.exports = { requireAuth, requireAdmin, requireMod, requireDev, syncSessionRole };
