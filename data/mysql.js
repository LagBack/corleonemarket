const mysql = require('mysql2/promise');

// Strip any protocol prefix the user might have copy-pasted
function cleanHost(h) {
  return (h || '').replace(/^https?:\/\//, '').replace(/\/$/, '').trim();
}

const pool = mysql.createPool({
  host:               cleanHost(process.env.DB_HOST),
  user:               process.env.DB_USER,
  password:           process.env.DB_PASSWORD,
  database:           process.env.DB_NAME,
  port:               parseInt(process.env.DB_PORT) || 3306,
  waitForConnections: true,
  connectionLimit:    5,
  // MySQL 5.6 compatibility
  ssl:                false,
  charset:            'utf8mb4',
});

// Test connection on startup
pool.getConnection()
  .then(conn => {
    console.log('✅ MySQL conectado!');
    conn.release();
  })
  .catch(err => {
    console.error('❌ MySQL erro de conexão:', err.message);
    console.error('   Host:', cleanHost(process.env.DB_HOST));
    console.error('   User:', process.env.DB_USER);
    console.error('   DB:  ', process.env.DB_NAME);
  });

module.exports = pool;
