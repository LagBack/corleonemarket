// ── Seeds MySQL users table if empty ──
const bcrypt = require('bcryptjs');
const pool   = require('./mysql');

async function seedMySQL() {
  try {
    // Create table if it doesn't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id       VARCHAR(36)  PRIMARY KEY,
        email    VARCHAR(255) UNIQUE NOT NULL,
        pass     VARCHAR(255) NOT NULL,
        name     VARCHAR(255),
        nick     VARCHAR(255),
        avatar   VARCHAR(20),
        photo    VARCHAR(500),
        country  VARCHAR(100),
        bio      TEXT,
        role     ENUM('user','moderator','admin','dev') DEFAULT 'user',
        balance  DOUBLE DEFAULT 50000,
        joined   BIGINT
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);

    const [rows] = await pool.query('SELECT COUNT(*) as cnt FROM users');
    if (rows[0].cnt > 0) {
      console.log(`👤 MySQL: ${rows[0].cnt} usuário(s) já existem.`);
      return;
    }

    console.log('🌱 Seeding MySQL users...');

    const users = [
      {
        id:      'adm1',
        email:   'corleoneadmin@email.com',
        pass:    bcrypt.hashSync('admin123', 10),
        name:    'Corleone',
        nick:    'Corleone',
        avatar:  '👑',
        photo:   null,
        country: '🇧🇷 Brasil',
        bio:     '',
        role:    'admin',
        balance: 999999,
        joined:  Date.now()
      },
      {
        id:      'u1',
        email:   'usuarioteste@corleone.com',
        pass:    bcrypt.hashSync('123456', 10),
        name:    'Usuario',
        nick:    'Usuario',
        avatar:  '🦁',
        photo:   null,
        country: '🇧🇷 Brasil',
        bio:     '',
        role:    'user',
        balance: 50000,
        joined:  Date.now()
      }
    ];

    for (const u of users) {
      await pool.query(
        `INSERT INTO users (id, email, pass, name, nick, avatar, photo, country, bio, role, balance, joined)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [u.id, u.email, u.pass, u.name, u.nick, u.avatar, u.photo, u.country, u.bio, u.role, u.balance, u.joined]
      );
    }

    console.log('✅ MySQL users seeded!');
    console.log('  👑 Admin:   corleoneadmin@email.com  / admin123');
    console.log('  🦁 Usuário: usuarioteste@corleone.com / 123456');
  } catch (err) {
    console.error('❌ MySQL seed error:', err.message);
  }
}

module.exports = seedMySQL;
