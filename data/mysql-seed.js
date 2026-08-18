const bcrypt = require('bcryptjs');
const pool   = require('./mysql');

async function seedMySQL() {
  try {
    // MySQL 5.6 compatible — use VARCHAR instead of ENUM/JSON
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        \`id\`       VARCHAR(36)   NOT NULL,
        \`email\`    VARCHAR(255)  NOT NULL,
        \`pass\`     VARCHAR(255)  NOT NULL,
        \`name\`     VARCHAR(255)  DEFAULT '',
        \`nick\`     VARCHAR(255)  DEFAULT '',
        \`avatar\`   VARCHAR(20)   DEFAULT '',
        \`photo\`    VARCHAR(500)  DEFAULT NULL,
        \`banner\`   VARCHAR(500)  DEFAULT NULL,
        \`banner_data\` MEDIUMBLOB   DEFAULT NULL,
        \`banner_mime\` VARCHAR(64)  DEFAULT NULL,
        \`country\`    VARCHAR(100)  DEFAULT '',
        \`bio\`      TEXT,
        \`role\`     VARCHAR(20)   DEFAULT 'user',
        \`balance\`  DOUBLE        DEFAULT 50000,
        \`joined\`   BIGINT        DEFAULT 0,
        PRIMARY KEY (\`id\`),
        UNIQUE KEY unique_email (\`email\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS portfolios (
        user_id  VARCHAR(36)  NOT NULL,
        sym      VARCHAR(10)  NOT NULL,
        qty      INT          NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, sym)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        \`id\`     BIGINT        NOT NULL AUTO_INCREMENT,
        \`uid\`    VARCHAR(36)   NOT NULL,
        \`uname\`  VARCHAR(255)  DEFAULT '',
        \`type\`   VARCHAR(10)   NOT NULL,
        \`sym\`    VARCHAR(10)   NOT NULL,
        \`qty\`    INT           NOT NULL,
        \`price\`  DOUBLE        NOT NULL,
        \`total\`  DOUBLE        NOT NULL,
        \`fee\`    DOUBLE        DEFAULT NULL,
        \`fee_type\`  VARCHAR(20)  DEFAULT NULL,
        \`time\`   VARCHAR(20)   DEFAULT '',
        \`ts\`     BIGINT        DEFAULT 0,
        PRIMARY KEY (\`id\`),
        KEY idx_uid (\`uid\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS economic_fees (
        id          BIGINT       NOT NULL AUTO_INCREMENT,
        user_id     VARCHAR(36)  NOT NULL,
        fee_type    VARCHAR(20)  NOT NULL COMMENT 'daily_maintenance OR wealth_tax',
        amount      DOUBLE       NOT NULL,
        net_worth   DOUBLE       NOT NULL,
        tx_id       BIGINT       DEFAULT NULL,
        day_key     VARCHAR(10)  DEFAULT NULL,
        cycle_key   VARCHAR(10)  DEFAULT NULL,
        created_at  BIGINT       NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uk_user_fee_day (user_id, fee_type, day_key),
        UNIQUE KEY uk_user_fee_cycle (user_id, fee_type, cycle_key),
        KEY idx_fee_type (fee_type)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    console.log('✅ MySQL tables ready (users, portfolios, transactions, economic_fees, companies, company_owners, ownership_listings, dividends, ownership_offers, market_state, admin_events)');

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
        country: 'Brasil',
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
        country: 'Brasil',
        bio:     '',
        role:    'user',
        balance: 50000,
        joined:  Date.now()
      }
    ];

    for (const u of users) {
      await pool.query(
        `INSERT INTO users
           (\`id\`, \`email\`, \`pass\`, \`name\`, \`nick\`, \`avatar\`, \`photo\`, \`banner\`, \`banner_data\`, \`banner_mime\`, \`country\`, \`bio\`, \`role\`, \`balance\`, \`joined\`, \`wealth_tier\`)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [u.id, u.email, u.pass, u.name, u.nick, u.avatar,
         u.photo, null, null, null, u.country, u.bio, u.role, u.balance, u.joined, 'investidor']
      );
    }

    
  // --- Initial social content (seedSocial) ---
  try {
    const [existingPosts] = await pool.query(`SELECT COUNT(*) AS cnt FROM social_posts`);
    if (existingPosts[0].cnt === 0) {
      const now = Date.now();
      await pool.query(
        `INSERT INTO social_posts (author_id, title, content, type, is_pinned, like_count, comment_count, created_at, updated_at)
         VALUES ('adm1', 'Bem-vindo ao forum do Corleone Market!', 'Bem-vindo ao novo sistema de discusses no jogo.

Aqui você pode:
- Discutir estrategias de mercado
- Compartilhar experiencias
- Interagir com outros jogadores
- Receber atualizacoes oficiais da equipe
---
Boas negociacoes! 📈', 'forum', 1, 0, 0, now, now)
      );
    }
  } catch (e) { console.warn('Could not seed social content:', e.message); }console.log('✅ MySQL users seeded!');
    console.log('  👑 Admin:   corleoneadmin@email.com   / admin123');
    console.log('  🦁 Usuário: usuarioteste@corleone.com / 123456');
  } catch (err) {
    console.error('❌ MySQL seed error:', err.message);
  }
}

module.exports = seedMySQL;
