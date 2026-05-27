function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Não autenticado' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Não autenticado' });
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'Acesso negado. Requer admin.' });
  next();
}

function requireMod(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Não autenticado' });
  if (!['admin','moderator'].includes(req.session.role)) return res.status(403).json({ error: 'Acesso negado. Requer moderador ou admin.' });
  next();
}

module.exports = { requireAuth, requireAdmin, requireMod };
