function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Não autenticado' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Não autenticado' });
  if (!['admin','dev'].includes(req.session.role)) return res.status(403).json({ error: 'Acesso negado. Requer admin.' });
  next();
}

function requireMod(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Não autenticado' });
  if (!['admin','moderator','dev'].includes(req.session.role)) return res.status(403).json({ error: 'Acesso negado. Requer moderador ou admin.' });
  next();
}

function requireDev(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'NÃ£o autenticado' });
  if (req.session.role !== 'dev') return res.status(403).json({ error: 'Acesso negado. Requer dev.' });
  next();
}

module.exports = { requireAuth, requireAdmin, requireMod, requireDev };
