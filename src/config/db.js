const { Pool } = require('pg');
require('dotenv').config();

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('❌ DATABASE_URL is not set!');
}

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
});

pool.on('connect', () => {
  console.log('📡 Database connected');
});

pool.on('error', (err) => {
  console.error('❌ Database pool error:', err.message);
});

module.exports = pool;
