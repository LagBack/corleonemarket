const pool = require('./mysql');
const { toPublicUser } = require('./user-serialize');

function safeUser(row) {
  return toPublicUser(row);
}

async function getUserById(id) {
  const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [id]);
  return rows[0] || null;
}

async function getAllUsers() {
  const [rows] = await pool.query('SELECT * FROM users');
  return rows;
}

async function setUserBalance(id, balance) {
  const rounded = Math.max(0, Math.round(balance * 100) / 100);
  await pool.query('UPDATE users SET balance = ? WHERE id = ?', [rounded, id]);
  return rounded;
}

async function adjustUserBalance(id, delta) {
  const user = await getUserById(id);
  if (!user) return null;
  return setUserBalance(id, user.balance + delta);
}

module.exports = { safeUser, getUserById, getAllUsers, setUserBalance, adjustUserBalance };
