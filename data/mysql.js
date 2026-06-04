// ── MySQL connection pool (users only) ──
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host:               process.env.DB_HOST,
  user:               process.env.DB_USER,
  password:           process.env.DB_PASSWORD,
  database:           process.env.DB_NAME,
  port:               parseInt(process.env.DB_PORT) || 3306,
  waitForConnections: true,
  connectionLimit:    5,
  timezone:           '+00:00',
});

// Test connection on startup
pool.getConnection()
  .then(conn => { console.log('✅ MySQL conectado!'); conn.release(); })
  .catch(err => console.error('❌ MySQL erro:', err.message));

module.exports = pool;
