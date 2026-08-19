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
  await pool.query(`UPDATE users SET \`role\` = LOWER(TRIM(\`role\`)) WHERE \`role\` IS NOT NULL`).catch(() => {});
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
    console.log('🌟 MySQL: coluna has_donada adicionada.');
  }
  if (!(await columnExists('users', 'banner'))) {
    await pool.query(`ALTER TABLE users ADD COLUMN banner VARCHAR(500) DEFAULT NULL`);
    console.log('📦 MySQL: coluna banner adicionada.');
  }
  if (!(await columnExists('users', 'banner_data'))) {
    await pool.query(`ALTER TABLE users ADD COLUMN banner_data MEDIUMBLOB DEFAULT NULL`);
    console.log('📦 MySQL: coluna banner_data adicionada.');
  }
  if (!(await columnExists('users', 'banner_mime'))) {
    await pool.query(`ALTER TABLE users ADD COLUMN banner_mime VARCHAR(64) DEFAULT NULL`);
    console.log('📦 MySQL: coluna banner_mime adicionada.');
  }

  // ── Economic system tables (new in v5.7) ────────────────────

  if (!(await columnExists('transactions', 'fee'))) {
    await pool.query(`ALTER TABLE transactions ADD COLUMN fee DOUBLE DEFAULT NULL AFTER total`);
    console.log('📦 MySQL: coluna fee adicionada em transactions.');
  }
  if (!(await columnExists('transactions', 'fee_type'))) {
    await pool.query(`ALTER TABLE transactions ADD COLUMN fee_type VARCHAR(20) DEFAULT NULL AFTER fee`);
    console.log('📦 MySQL: coluna fee_type adicionada em transactions.');
  }

  if (!(await columnExists('economic_fees', 'id'))) {
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
    console.log('📦 MySQL: tabela economic_fees criada.');
  }

  // ── Social system tables (new in v6.0) ────────────────────
  if (!(await columnExists('social_posts', 'id'))) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS social_posts (
        id          BIGINT       NOT NULL AUTO_INCREMENT,
        author_id   VARCHAR(36)  NOT NULL,
        title       VARCHAR(500) NOT NULL,
        content     TEXT         NOT NULL,
        type        VARCHAR(20)  NOT NULL DEFAULT 'forum' COMMENT 'forum OR update',
        is_pinned   TINYINT(1)   NOT NULL DEFAULT 0,
        is_locked   TINYINT(1)   NOT NULL DEFAULT 0,
        like_count  INT          NOT NULL DEFAULT 0,
        comment_count INT        NOT NULL DEFAULT 0,
        created_at  BIGINT       NOT NULL,
        updated_at  BIGINT       NOT NULL,
        PRIMARY KEY (id),
        KEY idx_type (type),
        KEY idx_is_pinned (is_pinned),
        KEY idx_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('📦 MySQL: tabela social_posts criada.');
  }

  if (!(await columnExists('social_comments', 'id'))) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS social_comments (
        id              BIGINT       NOT NULL AUTO_INCREMENT,
        post_id         BIGINT       NOT NULL,
        author_id       VARCHAR(36)  NOT NULL,
        parent_comment_id BIGINT     DEFAULT NULL,
        content         TEXT         NOT NULL,
        created_at      BIGINT       NOT NULL,
        updated_at      BIGINT       NOT NULL,
        PRIMARY KEY (id),
        KEY idx_post_id (post_id),
        KEY idx_author_id (author_id),
        KEY idx_parent_comment_id (parent_comment_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('📦 MySQL: tabela social_comments criada.');
  }

  if (!(await columnExists('social_post_likes', 'id'))) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS social_post_likes (
        id          BIGINT       NOT NULL AUTO_INCREMENT,
        user_id     VARCHAR(36)  NOT NULL,
        post_id     BIGINT       NOT NULL,
        created_at  BIGINT       NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uk_user_post (user_id, post_id),
        KEY idx_post_id (post_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('📦 MySQL: tabela social_post_likes criada.');
  }

  if (!(await columnExists('social_comment_likes', 'id'))) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS social_comment_likes (
        id           BIGINT       NOT NULL AUTO_INCREMENT,
        user_id      VARCHAR(36)  NOT NULL,
        comment_id   BIGINT       NOT NULL,
        created_at   BIGINT       NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uk_user_comment (user_id, comment_id),
        KEY idx_comment_id (comment_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('📦 MySQL: tabela social_comment_likes criada.');
  }

  if (!(await columnExists('notifications', 'id'))) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id              BIGINT       NOT NULL AUTO_INCREMENT,
        recipient_user_id VARCHAR(36)  NOT NULL,
        actor_user_id   VARCHAR(36)  NOT NULL,
        type            VARCHAR(30)  NOT NULL COMMENT 'POST_LIKE|COMMENT_LIKE|POST_COMMENT|COMMENT_REPLY|NEW_UPDATE|TOPIC_LOCKED|TOPIC_PINNED',
        reference_type  VARCHAR(20)  DEFAULT NULL COMMENT 'forum OR update',
        reference_id    BIGINT       DEFAULT NULL,
        message         VARCHAR(500) NOT NULL,
        is_read         TINYINT(1)   NOT NULL DEFAULT 0,
        created_at      BIGINT       NOT NULL,
        PRIMARY KEY (id),
        KEY idx_recipient (recipient_user_id, is_read),
        KEY idx_actor_id (actor_user_id),
        KEY idx_reference (reference_type, reference_id),
        KEY idx_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('📦 MySQL: tabela notifications criada.');
  }

  // ── Market companies table (new in v7.62) ──────────────────────
  if (!(await columnExists('companies', 'id'))) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS companies (
        \`sym\`         VARCHAR(10)   NOT NULL,
        \`name\`        VARCHAR(255)  NOT NULL,
        \`sector\`      VARCHAR(50)   NOT NULL DEFAULT 'Outros',
        \`desc\`        TEXT          DEFAULT '',
        \`price\`       DOUBLE        NOT NULL DEFAULT 0,
        \`open\`        DOUBLE        NOT NULL DEFAULT 0 COMMENT 'IPO/opening price — anchor for mean reversion',
        \`shares\`      INT           NOT NULL DEFAULT 0 COMMENT 'Total shares outstanding',
        \`vol\`         DOUBLE        NOT NULL DEFAULT 0.015 COMMENT 'Volatility factor',
        \`status\`      VARCHAR(10)   NOT NULL DEFAULT 'active' COMMENT 'active OR suspended',
        \`demand\`      DOUBLE        NOT NULL DEFAULT 0.5,
        \`supply\`      DOUBLE        NOT NULL DEFAULT 0.5,
        \`volume\`      INT           NOT NULL DEFAULT 0 COMMENT 'Cumulative trade volume',
        \`buys\`        INT           NOT NULL DEFAULT 0 COMMENT 'Intraday buy volume',
        \`sells\`       INT           NOT NULL DEFAULT 0 COMMENT 'Intraday sell volume',
        \`day_open\`    DOUBLE        DEFAULT NULL COMMENT 'Current day opening price',
        \`day_high\`    DOUBLE        DEFAULT NULL COMMENT 'Intraday high',
        \`day_low\`     DOUBLE        DEFAULT NULL COMMENT 'Intraday low',
        \`day_reset_at\` BIGINT       DEFAULT NULL,
        \`total_revenue\` DOUBLE      NOT NULL DEFAULT 0 COMMENT 'Total dividend revenue paid to owners',
        \`price_history\` JSON        DEFAULT NULL COMMENT 'Rolling array of last 80 price points',
        \`created\`     BIGINT        NOT NULL,
        \`updated\`     BIGINT        NOT NULL,
        PRIMARY KEY (\`sym\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('📦 MySQL: tabela companies criada.');
  }

  // ── Owners table (revenue share — many-to-many) ────────────────
  if (!(await columnExists('company_owners', 'id'))) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS company_owners (
        id          BIGINT       NOT NULL AUTO_INCREMENT,
        sym         VARCHAR(10)  NOT NULL,
        user_id     VARCHAR(36)  NOT NULL,
        pct         DOUBLE       NOT NULL COMMENT 'Revenue share %',
        created_at  BIGINT       NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uk_sym_user (sym, user_id),
        KEY idx_sym (sym),
        KEY idx_user_id (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('📦 MySQL: tabela company_owners criada.');
  }

  // ── Ownership listings (P2P revenue-share marketplace) ─────────
  if (!(await columnExists('ownership_listings', 'id'))) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ownership_listings (
        id          VARCHAR(30)  NOT NULL,
        sym         VARCHAR(10)  NOT NULL,
        stock_name  VARCHAR(255) NOT NULL,
        seller_id   VARCHAR(36)  NOT NULL,
        seller_name VARCHAR(255) NOT NULL,
        pct_to_sell DOUBLE       NOT NULL COMMENT 'Revenue share % being sold',
        ask_price   DOUBLE       NOT NULL,
        status      VARCHAR(10)  NOT NULL DEFAULT 'open' COMMENT 'open|sold|cancelled',
        buyer_id    VARCHAR(36)  DEFAULT NULL,
        buyer_name  VARCHAR(255) DEFAULT NULL,
        sold_at     BIGINT       DEFAULT NULL,
        created_at  BIGINT       NOT NULL,
        PRIMARY KEY (id),
        KEY idx_sym_status (sym, status),
        KEY idx_seller (seller_id),
        KEY idx_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('📦 MySQL: tabela ownership_listings criada.');
  }

  // ── Dividends (revenue share payments to owners) ───────────────
  if (!(await columnExists('dividends', 'id'))) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dividends (
        id            BIGINT       NOT NULL AUTO_INCREMENT,
        sym           VARCHAR(10)  NOT NULL,
        stock_name    VARCHAR(255) NOT NULL,
        owner_id      VARCHAR(36)  NOT NULL,
        owner_name    VARCHAR(255) NOT NULL,
        trader_name   VARCHAR(255) DEFAULT '',
        type          VARCHAR(10)  NOT NULL COMMENT 'buy OR sell',
        trade_total   DOUBLE       NOT NULL COMMENT 'Total value of the triggering trade',
        pct           DOUBLE       NOT NULL COMMENT 'Owner revenue share %',
        fee           DOUBLE       NOT NULL COMMENT 'Dividend amount paid',
        time          VARCHAR(20)  DEFAULT '',
        ts            BIGINT       DEFAULT 0,
        PRIMARY KEY (id),
        KEY idx_sym (sym),
        KEY idx_owner_id (owner_id),
        KEY idx_ts (ts)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('📦 MySQL: tabela dividends criada.');
  }

  // ── Ownership offers (P2P — separate from revenue-share listings) ─
  if (!(await columnExists('ownership_offers', 'id'))) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ownership_offers (
        id          VARCHAR(40)  NOT NULL,
        sym         VARCHAR(10)  NOT NULL,
        stock_name  VARCHAR(255) DEFAULT '',
        seller_id   VARCHAR(36)  NOT NULL,
        pct         DOUBLE       NOT NULL,
        ask_price   DOUBLE       NOT NULL,
        status      VARCHAR(10)  NOT NULL DEFAULT 'open' COMMENT 'open|sold|cancelled',
        buyer_id    VARCHAR(36)  DEFAULT NULL,
        buyer_name  VARCHAR(255) DEFAULT NULL,
        sold_at     BIGINT       DEFAULT NULL,
        created_at  BIGINT       NOT NULL,
        time        VARCHAR(20)  DEFAULT '',
        PRIMARY KEY (id),
        KEY idx_sym_status (sym, status),
        KEY idx_seller (seller_id),
        KEY idx_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('📦 MySQL: tabela ownership_offers criada.');
  }

  // ── Market state (singleton row) ────────────────────────────────
  if (!(await columnExists('market_state', 'id'))) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS market_state (
        id        INT          NOT NULL DEFAULT 1,
        open      TINYINT(1)   NOT NULL DEFAULT 1 COMMENT '1 = market open',
        ibcx      DOUBLE       NOT NULL DEFAULT 1000 COMMENT 'IBOVESPA-like index',
        total_vol BIGINT       NOT NULL DEFAULT 0 COMMENT 'Market-wide trade volume',
        updated   BIGINT       NOT NULL,
        PRIMARY KEY (id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('📦 MySQL: tabela market_state criada.');
  }

  // ── Admin event log ────────────────────────────────────────────
  if (!(await columnExists('admin_events', 'id'))) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS admin_events (
        id      BIGINT       NOT NULL AUTO_INCREMENT,
        t       VARCHAR(20)  DEFAULT '',
        msg     VARCHAR(500) NOT NULL,
        ts      BIGINT       DEFAULT 0,
        PRIMARY KEY (id),
        KEY idx_ts (ts)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('📦 MySQL: tabela admin_events criada.');
  }
}

module.exports = migrateUsersTable;
