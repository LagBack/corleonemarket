const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path = require('path');

const adapter = new FileSync(path.join(__dirname, 'db.json'));
const db = low(adapter);

// Default structure
db.defaults({
  users: [],
  stocks: [],
  portfolios: {},
  transactions: [],
  dividends: [],
  ownershipListings: [],
  market: { open: true },
  adminLog: []
}).write();

module.exports = db;
