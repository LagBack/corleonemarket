const VALID_ROLES = ['user', 'moderator', 'admin', 'dev'];

function normalizeRole(role) {
  const r = String(role || 'user').trim().toLowerCase();
  return VALID_ROLES.includes(r) ? r : 'user';
}

module.exports = { VALID_ROLES, normalizeRole };
