const fs   = require('fs');
const path = require('path');
const db   = require('./db');

// If RESET_DB=true, wipe db.json (stocks/market data only — users are in MySQL)
if (process.env.RESET_DB === 'true') {
  console.log('🔄 RESET_DB detected — wiping db.json...');
  const dbPath = path.join(__dirname, 'db.json');
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  delete require.cache[require.resolve('./db')];
  Object.assign(db, require('./db'));
  console.log('🗑️  db.json wiped.\n');
}

// Seed stocks if empty (users are seeded separately via mysql-seed.js)
if (db.get('stocks').size().value() === 0) {
  console.log('🌱 Seeding stocks & market state...');

  const stocks = [
    { sym:'CRLNE4', name:'Corleone Holdings',  sector:'Financeiro',  desc:'Holding de investimentos da família Corleone.',  price:85.40,  open:85.40,  shares:5000000,  vol:0.012, status:'active', demand:0.6,  supply:0.4,  volume:0, buys:0, sells:0, owners:[], ownershipShares:{}, totalRevenue:0, dayOpen:85.40,  dayHigh:85.40,  dayLow:85.40,  dayResetAt:Date.now(), created:Date.now() },
    { sym:'SICIL3', name:'Sicilian Export SA', sector:'Alimentação', desc:'Exportação de azeites e vinhos premium.',        price:32.70,  open:32.70,  shares:8000000,  vol:0.015, status:'active', demand:0.5,  supply:0.5,  volume:0, buys:0, sells:0, owners:[], ownershipShares:{}, totalRevenue:0, dayOpen:32.70,  dayHigh:32.70,  dayLow:32.70,  dayResetAt:Date.now(), created:Date.now() },
    { sym:'GODFT4', name:'Godfather Tech',      sector:'Tecnologia',  desc:'Soluções de segurança e criptografia.',         price:124.50, open:124.50, shares:3000000,  vol:0.022, status:'active', demand:0.7,  supply:0.3,  volume:0, buys:0, sells:0, owners:[], ownershipShares:{}, totalRevenue:0, dayOpen:124.50, dayHigh:124.50, dayLow:124.50, dayResetAt:Date.now(), created:Date.now() },
    { sym:'OLIVE3', name:'OliveOil Corp',       sector:'Alimentação', desc:'Maior produtor de azeite da América Latina.',   price:18.90,  open:18.90,  shares:12000000, vol:0.010, status:'active', demand:0.45, supply:0.55, volume:0, buys:0, sells:0, owners:[], ownershipShares:{}, totalRevenue:0, dayOpen:18.90,  dayHigh:18.90,  dayLow:18.90,  dayResetAt:Date.now(), created:Date.now() },
    { sym:'CAPO5',  name:'Capo Industries',     sector:'Indústria',   desc:'Manufatura de bens de capital.',                price:47.20,  open:47.20,  shares:4000000,  vol:0.018, status:'active', demand:0.52, supply:0.48, volume:0, buys:0, sells:0, owners:[], ownershipShares:{}, totalRevenue:0, dayOpen:47.20,  dayHigh:47.20,  dayLow:47.20,  dayResetAt:Date.now(), created:Date.now() },
    { sym:'CONSG3', name:'Consigliere Bank',    sector:'Financeiro',  desc:'Banco de investimentos e assessoria.',          price:63.80,  open:63.80,  shares:2500000,  vol:0.009, status:'active', demand:0.58, supply:0.42, volume:0, buys:0, sells:0, owners:[], ownershipShares:{}, totalRevenue:0, dayOpen:63.80,  dayHigh:63.80,  dayLow:63.80,  dayResetAt:Date.now(), created:Date.now() },
    { sym:'OMERT3', name:'Omerta Security',     sector:'Tecnologia',  desc:'Empresa de cibersegurança e compliance.',      price:55.10,  open:55.10,  shares:3500000,  vol:0.020, status:'active', demand:0.55, supply:0.45, volume:0, buys:0, sells:0, owners:[], ownershipShares:{}, totalRevenue:0, dayOpen:55.10,  dayHigh:55.10,  dayLow:55.10,  dayResetAt:Date.now(), created:Date.now() },
    { sym:'FAMLG4', name:'Famiglia Logistics', sector:'Transporte',  desc:'Logística e distribuição premium.',             price:29.30,  open:29.30,  shares:6000000,  vol:0.014, status:'active', demand:0.48, supply:0.52, volume:0, buys:0, sells:0, owners:[], ownershipShares:{}, totalRevenue:0, dayOpen:29.30,  dayHigh:29.30,  dayLow:29.30,  dayResetAt:Date.now(), created:Date.now() },
  ];

  db.set('stocks',     stocks).write();
  db.set('portfolios', {}).write();
  db.set('market',     { open: true }).write();

  console.log('✅ Stocks seeded!\n');
}
