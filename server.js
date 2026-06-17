const express = require('express');
const session    = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

app.set('trust proxy', 1);

// ── Ensure data & uploads dirs exist ──
const dataDir = path.join(__dirname, 'data');
const uploadsDir = path.join(__dirname, 'public', 'uploads');
[dataDir, uploadsDir].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// ── Middleware ──
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
const sessionStore = new MySQLStore({
  host:               (process.env.DB_HOST || '').replace(/^https?:\/\//, '').replace(/\/$/, ''),
  user:               process.env.DB_USER,
  password:           process.env.DB_PASSWORD,
  database:           process.env.DB_NAME,
  port:               parseInt(process.env.DB_PORT) || 3306,
  clearExpired:       true,
  checkExpirationInterval: 900000,   // clear expired sessions every 15 min
  expiration:         86400000,      // session expires after 24h
  createDatabaseTable: true,         // auto-creates the sessions table
  schema: {
    tableName:        'sessions',
    columnNames: {
      session_id:     'session_id',
      expires:        'expires',
      data:           'data'
    }
  }
});

app.use(session({
  secret: process.env.SESSION_SECRET || 'corleone-secret-key-2024',
  resave: false,
  saveUninitialized: false,
  proxy: true,
  store: sessionStore,
  cookie: {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'lax' : 'lax',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// Public profile photos (no auth — must be before SPA catch-all)
const { serveUserPhoto, serveUserBanner } = require('./routes/user-photo');
app.get('/api/users/:id/photo', serveUserPhoto);
app.get('/api/users/:id/banner', serveUserBanner);

// ── Routes ──
app.use('/api/auth', require('./routes/auth'));
app.use('/api/market', require('./routes/market'));
app.use('/api/stocks', require('./routes/stocks'));
app.use('/api/users', require('./routes/users'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/economic', require('./routes/economic'));

// ── Serve frontend ──
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ──
app.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║   CORLEONE MARKET — Servidor Ativo   ║`);
  console.log(`║   http://localhost:${PORT}              ║`);
  console.log(`╚══════════════════════════════════════╝\n`);
  // Seed lowdb (stocks/market state), MySQL (users), then start simulator
  require('./data/seed');
  require('./data/mysql-migrate')()
    .then(() => require('./data/mysql-seed')())
    .catch(err => console.error('MySQL init:', err.message));
  require('./data/simulator').start();
});
