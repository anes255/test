const express = require('express');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const path = require('path');
require('dotenv').config();

const app = express();

// ============================================================
// CORS — RAW HEADERS, FIRST THING, NO PACKAGES
// ============================================================
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-store-slug, X-Requested-With, Accept, Origin');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.use(compression());
app.use(cookieParser());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// ============ ROOT & HEALTH ============
app.get('/', (req, res) => {
  res.json({ name: 'KyoMarket API', status: 'running', version: '1.0.0' });
});
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============ PLATFORM INFO (safe) ============
const pool = require('./config/db');
app.get('/api/platform-info', async (req, res) => {
  try {
    const result = await pool.query('SELECT site_name, logo_url, primary_color, secondary_color, accent_color, meta_description, favicon_url, maintenance_mode, currency FROM platform_settings LIMIT 1');
    const s = result.rows[0] || {};
    res.json({ ...s, site_logo: s.logo_url, favicon: s.favicon_url, default_language: 'en' });
  } catch (error) {
    res.json({ site_name: 'KyoMarket', primary_color: '#7C3AED', secondary_color: '#06B6D4', accent_color: '#F59E0B' });
  }
});

// ============ FULL DATABASE SCHEMA DUMP (directly in server.js — guaranteed to work) ============
app.get('/api/dump-schema', async (req, res) => {
  try {
    const tables = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`);
    const schema = {};
    for (const row of tables.rows) {
      const cols = await pool.query(`SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`, [row.table_name]);
      schema[row.table_name] = cols.rows.map(c => c.column_name + ' (' + c.data_type + (c.is_nullable === 'NO' ? ', NOT NULL' : '') + ')');
    }
    res.json(schema);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ LOAD ROUTES — each in try/catch so one bad file doesn't kill everything ============
const routeFiles = [
  { path: '/api/platform', file: './routes/platformAdmin' },
  { path: '/api/owner', file: './routes/storeOwner' },
  { path: '/api/manage', file: './routes/products' },
  { path: '/api/manage', file: './routes/orders' },
  { path: '/api/store', file: './routes/storefront' },
  { path: '/api/ai', file: './routes/ai' },
];

const loadedRoutes = [];
const failedRoutes = [];

for (const route of routeFiles) {
  try {
    const router = require(route.file);
    app.use(route.path, router);
    loadedRoutes.push(route.file);
    console.log(`✅ Route loaded: ${route.path} → ${route.file}`);
  } catch (error) {
    failedRoutes.push({ file: route.file, error: error.message });
    console.error(`❌ Failed to load route ${route.file}:`, error.message);
    console.error(error.stack);
  }
}

// Debug endpoint to see what loaded
app.get('/api/debug/routes', (req, res) => {
  res.json({ loaded: loadedRoutes, failed: failedRoutes, nodeVersion: process.version });
});

// ============ ERROR HANDLING ============
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message, err.stack);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found', path: req.path, loadedRoutes, failedRoutes });
});

// ============ START + AUTO-INIT DB ============
const { initDb } = require('./config/initDb');

const PORT = process.env.PORT || 5000;
app.listen(PORT, async () => {
  console.log(`🚀 KyoMarket API running on port ${PORT}`);
  console.log(`📦 Node version: ${process.version}`);
  console.log(`✅ Loaded routes: ${loadedRoutes.length}/${routeFiles.length}`);
  if (failedRoutes.length > 0) {
    console.error(`❌ Failed routes:`, JSON.stringify(failedRoutes, null, 2));
  }
  try {
    await initDb();
    console.log('✅ Database ready');
  } catch (error) {
    console.error('⚠️ DB init error:', error.message);
  }
});

module.exports = app;
