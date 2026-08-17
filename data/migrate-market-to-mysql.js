require('dotenv').config();

const fs     = require('fs');
const path   = require('path');
const pool   = require('./mysql');

// ── Read db.json directly ────────────────────────────────────────

function readDbJson() {
  const dbPath = path.join(__dirname, 'db.json');
  if (!fs.existsSync(dbPath)) {
    console.log('⚠️  db.json not found. Starting with empty data.');
    return { stocks: [], portfolios: {}, transactions: [], dividends: [], ownershipListings: [], ownershipOffers: [], market: { open: true }, adminLog: [] };
  }
  return JSON.parse(fs.readFileSync(dbPath, 'utf8'));
}

// ── MySQL helper ────────────────────────────────────────────────

function query(sql, params) {
  return pool.query(sql, params).then(([rows]) => rows);
}

// ── Check if companies table exists ─────────────────────────────

async function tablesReady() {
  try {
    const [r] = await pool.query('SELECT COUNT(*) as c FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ("companies","company_owners")');
    return r.c >= 1;
  } catch(_) { return false; }
}

// ── Migration steps ─────────────────────────────────────────────

async function createCompaniesTable(dbData) {
  const stocks = dbData.stocks || [];
  if (!stocks.length && await tablesReady()) return; // nothing to do, table exists

  // Create table with backtick-escaped column names (desc is reserved in MariaDB)
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
      \`price_history\` TEXT         DEFAULT NULL COMMENT 'Rolling array of last 80 price points',
      \`created\`     BIGINT        NOT NULL,
      \`updated\`     BIGINT        NOT NULL,
      PRIMARY KEY (\`sym\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  console.log('📦 companies table ready.');
}

async function migrateCompanies(dbData) {
  const stocks = dbData.stocks || [];
  if (!stocks.length) { console.log('⏭️ No stocks to migrate.'); return; }
  console.log(`\n📦 Stocks to migrate: ${stocks.length}`);

  for (const s of stocks) {
    await pool.query(
      `INSERT INTO companies (\`sym\`,\`name\`,\`sector\`,\`desc\`,\`price\`,\`open\`,\`shares\`,\`vol\`,\`status\`,\`demand\`,\`supply\`,\`volume\`,\`buys\`,\`sells\`,\`day_open\`,\`day_high\`,\`day_low\`,\`day_reset_at\`,\`total_revenue\`,\`price_history\`,\`created\`,\`updated\`)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE \
        \`name\` = VALUES(\`name\`),\
        \`sector\` = VALUES(\`sector\`),\
        \`desc\` = VALUES(\`desc\`),\
        \`price\` = VALUES(\`price\`),\
        \`open\` = VALUES(\`open\`),\
        \`shares\` = VALUES(\`shares\`),\
        \`vol\` = VALUES(\`vol\`),\
        \`status\` = VALUES(\`status\`),\
        \`demand\` = VALUES(\`demand\`),\
        \`supply\` = VALUES(\`supply\`),\
        \`volume\` = VALUES(\`volume\`),\
        \`buys\` = VALUES(\`buys\`),\
        \`sells\` = VALUES(\`sells\`),\
        \`day_open\` = VALUES(\`day_open\`),\
        \`day_high\` = VALUES(\`day_high\`),\
        \`day_low\` = VALUES(\`day_low\`),\
        \`day_reset_at\` = VALUES(\`day_reset_at\`),\
        \`total_revenue\` = VALUES(\`total_revenue\`),\
        \`price_history\` = VALUES(\`price_history\`),\
        \`updated\` = VALUES(\`updated\`)`,
      [
        s.sym,
        s.name || '',
        s.sector || 'Outros',
        s.desc || '',
        s.price || 0,
        s.open || 0,
        s.shares || 0,
        s.vol || 0.015,
        s.status || 'active',
        s.demand ?? 0.5,
        s.supply ?? 0.5,
        s.volume || 0,
        s.buys || 0,
        s.sells || 0,
        s.dayOpen || null,
        s.dayHigh || null,
        s.dayLow || null,
        s.dayResetAt || null,
        s.totalRevenue || 0,
        JSON.stringify(s.priceHistory || []),
        s.created || Date.now(),
        Date.now(),
      ]
    );
  }
  console.log(`✅ ${stocks.length} companies migrated to MySQL.`);
}

async function createOwnersTable(dbData) {
  const stocks = dbData.stocks || [];
  if (!stocks.length && await tablesReady()) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS company_owners (
      \`id\`        BIGINT       NOT NULL AUTO_INCREMENT,
      \`sym\`       VARCHAR(10)  NOT NULL,
      \`user_id\`   VARCHAR(36)  NOT NULL,
      \`pct\`       DOUBLE       NOT NULL COMMENT 'Revenue share %',
      \`created_at\` BIGINT       NOT NULL,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY uk_sym_user (\`sym\`, \`user_id\`),
      KEY idx_sym (\`sym\`),
      KEY idx_user_id (\`user_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  console.log('📦 company_owners table ready.');
}

async function migrateOwners(dbData) {
  const stocks = dbData.stocks || [];
  let count = 0;

  for (const s of stocks) {
    const owners = s.owners || [];
    for (const o of owners) {
      if (!o.userId) continue;
      await pool.query(
        `INSERT INTO company_owners (\`sym\`,\`user_id\`,\`pct\`,\`created_at\`) VALUES (?,?,?,?)
         ON DUPLICATE KEY UPDATE \`pct\` = VALUES(\`pct\`)`,
        [s.sym, o.userId, o.pct || 0, o.createdAt || Date.now()]
      );
      count++;
    }

    const shares = s.ownershipShares || {};
    for (const [userId, pct] of Object.entries(shares)) {
      if (!userId || !pct) continue;
      await pool.query(
        `INSERT INTO company_owners (\`sym\`,\`user_id\`,\`pct\`,\`created_at\`) VALUES (?,?,?,?)
         ON DUPLICATE KEY UPDATE \`pct\` = VALUES(\`pct\`)`,
        [s.sym, userId, pct, Date.now()]
      );
      count++;
    }
  }

  console.log(`✅ ${count} company_ownership records migrated.`);
}

async function createListingsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ownership_listings (
      \`id\`        VARCHAR(30)  NOT NULL,
      \`sym\`       VARCHAR(10)  NOT NULL,
      \`stock_name\` VARCHAR(255) NOT NULL,
      \`seller_id\` VARCHAR(36)  NOT NULL,
      \`seller_name\` VARCHAR(255) NOT NULL,
      \`pct_to_sell\` DOUBLE      NOT NULL COMMENT 'Revenue share % being sold',
      \`ask_price\`  DOUBLE       NOT NULL,
      \`status\`    VARCHAR(10)  NOT NULL DEFAULT 'open' COMMENT 'open|sold|cancelled',
      \`buyer_id\`   VARCHAR(36)  DEFAULT NULL,
      \`buyer_name\` VARCHAR(255) DEFAULT NULL,
      \`sold_at\`   BIGINT       DEFAULT NULL,
      \`created_at\` BIGINT       NOT NULL,
      PRIMARY KEY (\`id\`),
      KEY idx_sym_status (\`sym\`, \`status\`),
      KEY idx_seller (\`seller_id\`),
      KEY idx_status (\`status\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  console.log('📦 ownership_listings table ready.');
}

async function migrateListings(dbData) {
  const listings = dbData.ownershipListings || [];
  if (!listings.length) { console.log('⏭️ No ownership_listings to migrate.'); return; }

  for (const l of listings) {
    await pool.query(
      `INSERT INTO ownership_listings (\`id\`,\`sym\`,\`stock_name\`,\`seller_id\`,\`seller_name\`,\`pct_to_sell\`,\`ask_price\`,\`status\`,\`buyer_id\`,\`buyer_name\`,\`sold_at\`,\`created_at\`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE \`status\` = VALUES(\`status\`)`,
      [l.id, l.sym, l.stockName || '', l.sellerId || '', l.sellerName || '', l.pctToSell || 0, l.askPrice || 0, l.status || 'open', l.buyerId || null, l.buyerName || null, l.soldAt || null, l.createdAt || Date.now()]
    );
  }
  console.log(`✅ ${listings.length} ownership_listings migrated.`);
}

async function createDividendsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dividends (
      \`id\`            BIGINT       NOT NULL AUTO_INCREMENT,
      \`sym\`           VARCHAR(10)  NOT NULL,
      \`stock_name\`    VARCHAR(255) NOT NULL,
      \`owner_id\`      VARCHAR(36)  NOT NULL,
      \`owner_name\`    VARCHAR(255) NOT NULL,
      \`trader_name\`   VARCHAR(255) DEFAULT '',
      \`type\`          VARCHAR(10)  NOT NULL COMMENT 'buy OR sell',
      \`trade_total\`   DOUBLE       NOT NULL COMMENT 'Total value of the triggering trade',
      \`pct\`           DOUBLE       NOT NULL COMMENT 'Owner revenue share %',
      \`fee\`           DOUBLE       NOT NULL COMMENT 'Dividend amount paid',
      \`time\`          VARCHAR(20)  DEFAULT '',
      \`ts\`            BIGINT       DEFAULT 0,
      PRIMARY KEY (\`id\`),
      KEY idx_sym (\`sym\`),
      KEY idx_owner_id (\`owner_id\`),
      KEY idx_ts (\`ts\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  console.log('📦 dividends table ready.');
}

async function migrateDividends(dbData) {
  const divs = dbData.dividends || [];
  if (!divs.length) { console.log('⏭️ No dividends to migrate.'); return; }

  for (const d of divs) {
    await pool.query(
      `INSERT INTO dividends (\`sym\`,\`stock_name\`,\`owner_id\`,\`owner_name\`,\`trader_name\`,\`type\`,\`trade_total\`,\`pct\`,\`fee\`,\`time\`,\`ts\`) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [d.sym || '', d.stockName || '', d.founderId || d.ownerId || '', d.ownerName || (d.founderId ? 'Unknown' : ''), d.traderName || '', d.type || 'dividend', d.tradeTotal || 0, d.pct || 0, d.fee || 0, d.time || '', d.ts || Date.now()]
    );
  }
  console.log(`✅ ${divs.length} dividends migrated.`);
}

async function createOffersTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ownership_offers (
      \`id\`          VARCHAR(40)  NOT NULL,
      \`sym\`         VARCHAR(10)  NOT NULL,
      \`stock_name\`  VARCHAR(255) DEFAULT '',
      \`seller_id\`   VARCHAR(36)  NOT NULL,
      \`pct\`         DOUBLE       NOT NULL,
      \`ask_price\`   DOUBLE       NOT NULL,
      \`status\`      VARCHAR(10)  NOT NULL DEFAULT 'open' COMMENT 'open|sold|cancelled',
      \`buyer_id\`    VARCHAR(36)  DEFAULT NULL,
      \`buyer_name\`  VARCHAR(255) DEFAULT NULL,
      \`sold_at\`     BIGINT       DEFAULT NULL,
      \`created_at\`  BIGINT       NOT NULL,
      \`time\`        VARCHAR(20)  DEFAULT '',
      PRIMARY KEY (\`id\`),
      KEY idx_sym_status (\`sym\`, \`status\`),
      KEY idx_seller (\`seller_id\`),
      KEY idx_status (\`status\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  console.log('📦 ownership_offers table ready.');
}

async function migrateOffers(dbData) {
  const offers = dbData.ownershipOffers || [];
  if (!offers.length) { console.log('⏭️ No ownership_offers to migrate.'); return; }

  for (const o of offers) {
    await pool.query(
      `INSERT INTO ownership_offers (\`id\`,\`sym\`,\`stock_name\`,\`seller_id\`,\`pct\`,\`ask_price\`,\`status\`,\`buyer_id\`,\`buyer_name\`,\`sold_at\`,\`created_at\`,\`time\`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE \`status\` = VALUES(\`status\`)`,
      [o.id, o.sym || '', o.stockName || '', o.sellerId || '', o.pct || 0, o.askPrice || 0, o.status || 'open', o.buyerId || null, o.buyerName || null, o.soldAt || null, o.createdAt || Date.now(), o.time || '']
    );
  }
  console.log(`✅ ${offers.length} ownership_offers migrated.`);
}

async function createMarketStateTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS market_state (
      \`id\`        INT          NOT NULL DEFAULT 1,
      \`open\`      TINYINT(1)   NOT NULL DEFAULT 1 COMMENT '1 = market open',
      \`ibcx\`      DOUBLE       NOT NULL DEFAULT 1000 COMMENT 'IBOVESPA-like index',
      \`total_vol\` BIGINT       NOT NULL DEFAULT 0 COMMENT 'Market-wide trade volume',
      \`updated\`   BIGINT       NOT NULL,
      PRIMARY KEY (\`id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  console.log('📦 market_state table ready.');
}

async function migrateMarketState(dbData) {
  const market = dbData.market || {};
  const stocks = dbData.stocks || [];

  const ibcx = stocks.length ? stocks.reduce((a, s) => a + (s.price / s.open * 1000), 0) / stocks.length : 1000;
  const totalVol = stocks.length ? stocks.reduce((a, s) => a + (s.volume || 0) * (s.price || 0), 0) : 0;

  await pool.query(
    'INSERT INTO market_state (\`id\`,\`open\`,\`ibcx\`,\`total_vol\`,\`updated\`) VALUES (1,?,?,?,?) ON DUPLICATE KEY UPDATE \`open\`=VALUES(\`open\`),\`ibcx\`=VALUES(\`ibcx\`),\`total_vol\`=VALUES(\`total_vol\`),\`updated\`=VALUES(\`updated\`)',
    [market.open ? 1 : 0, ibcx, totalVol, Date.now()]
  );
  console.log('✅ Market state migrated.');
}

async function createAdminEventsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_events (
      \`id\`   BIGINT       NOT NULL AUTO_INCREMENT,
      \`t\`    VARCHAR(20)  DEFAULT '',
      \`msg\`  VARCHAR(500) NOT NULL,
      \`ts\`   BIGINT       DEFAULT 0,
      PRIMARY KEY (\`id\`),
      KEY idx_ts (\`ts\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  console.log('📦 admin_events table ready.');
}

async function migrateAdminLog(dbData) {
  const log = dbData.adminLog || [];
  if (!log.length) { console.log('⏭️ No admin_log entries to migrate.'); return; }

  const batchSize = 100;
  for (let i = 0; i < log.length; i += batchSize) {
    const batch = log.slice(i, i + batchSize);
    for (const e of batch) {
      await pool.query('INSERT INTO admin_events (\`t\`,\`msg\`,\`ts\`) VALUES (?,?,?)', [e.t || '', e.msg || '', Date.now()]);
    }
  }
  console.log(`✅ ${log.length} admin events migrated.`);
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(60));
  console.log('MIGRATING MARKET DATA FROM db.json -> MYSQL');
  console.log('='.repeat(60));

  const dbData = readDbJson();

  // Create all tables first
  await createCompaniesTable(dbData);
  await createOwnersTable(dbData);
  await createListingsTable();
  await createDividendsTable();
  await createOffersTable();
  await createMarketStateTable();
  await createAdminEventsTable();

  // Now migrate data
  await migrateCompanies(dbData);
  await migrateOwners(dbData);
  await migrateListings(dbData);
  await migrateDividends(dbData);
  await migrateOffers(dbData);
  await migrateMarketState(dbData);
  await migrateAdminLog(dbData);

  // Verify
  const [companiesCount] = await pool.query('SELECT COUNT(*) as c FROM companies');
  console.log(`\n✅ MySQL now has ${companiesCount[0].c} company(ies).`);

  console.log('\n' + '='.repeat(60));
  console.log('MIGRATION COMPLETE!');
  console.log('='.repeat(60));
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
