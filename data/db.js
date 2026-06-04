const low      = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path     = require('path');
const fs       = require('fs');

// Ensure the data directory exists (Render ephemeral filesystem)
const dataDir = path.join(__dirname);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const adapter = new FileSync(path.join(dataDir, 'db.json'));
const db = low(adapter);

// Default structure — users removed (now in MySQL)
db.defaults({
  stocks:              [],
  portfolios:          {},
  transactions:        [],
  dividends:           [],
  ownershipListings:   [],
  ownershipOffers:     [],
  market:              { open: true },
  adminLog:            []
}).write();

module.exports = db;
