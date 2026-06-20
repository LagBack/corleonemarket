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
}

module.exports = migrateUsersTable;
