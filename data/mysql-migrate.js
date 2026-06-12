const pool = require('./mysql');

async function columnExists(table, column) {
  const [rows] = await pool.query(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  return rows.length > 0;
}

async function migrateUsersTable() {
  await pool.query(`UPDATE users SET role = LOWER(TRIM(role)) WHERE role IS NOT NULL`).catch(() => {});
  if (!(await columnExists('users', 'photo'))) {
    await pool.query(`ALTER TABLE users ADD COLUMN photo VARCHAR(500) DEFAULT NULL`);
    console.log('📦 MySQL: coluna photo adicionada.');
  }
  if (!(await columnExists('users', 'photo_data'))) {
    await pool.query(`ALTER TABLE users ADD COLUMN photo_data MEDIUMBLOB DEFAULT NULL`);
    console.log('📦 MySQL: coluna photo_data adicionada.');
  }
  if (!(await columnExists('users', 'photo_mime'))) {
    await pool.query(`ALTER TABLE users ADD COLUMN photo_mime VARCHAR(64) DEFAULT NULL`);
    console.log('📦 MySQL: coluna photo_mime adicionada.');
  }
  if (!(await columnExists('users', 'wealth_tier'))) {
    await pool.query(`ALTER TABLE users ADD COLUMN wealth_tier VARCHAR(20) DEFAULT 'investidor'`);
    console.log('📦 MySQL: coluna wealth_tier adicionada.');
  }
  if (!(await columnExists('users', 'has_donated'))) {
    await pool.query(`ALTER TABLE users ADD COLUMN has_donated BOOLEAN DEFAULT FALSE`);
    console.log('🌟 MySQL: coluna has_donated adicionada.');
  }
}

module.exports = migrateUsersTable;
