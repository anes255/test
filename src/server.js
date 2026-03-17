const express = require('express');
const cors = require('cors');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');
require('dotenv').config();

const app = express();

// ============================================================
// CORS — MANUAL HEADERS FIRST (before ANY other middleware)
// This guarantees CORS headers are on EVERY response,
// even if the server crashes or other middleware interferes.
// ============================================================
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-store-slug, X-Requested-With, Accept, Origin');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Max-Age', '86400');
  
  // Handle preflight immediately — don't let it fall through to other middleware
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});

// Now the rest of middleware
app.use(compression());
app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// NOTE: Removed helmet entirely — it was stripping/overriding CORS headers

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

// ============ ROOT & HEALTH ============
app.get('/', (req, res) => {
  res.json({ 
    name: 'KyoMarket API',
    status: 'running',
    version: '1.0.0',
    cors: 'enabled',
    endpoints: ['/api/health', '/api/platform-info', '/api/owner/register', '/api/owner/login']
  });
});

app.get('/favicon.ico', (req, res) => res.status(204).end());

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============ PLATFORM INFO ============
const pool = require('./config/db');

app.get('/api/platform-info', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT site_name, site_logo, primary_color, secondary_color, accent_color, default_language, meta_description, favicon, maintenance_mode FROM platform_settings LIMIT 1'
    );
    res.json(result.rows[0] || { site_name: 'KyoMarket' });
  } catch (error) {
    console.log('platform_settings query failed:', error.message);
    res.json({ site_name: 'KyoMarket', primary_color: '#7C3AED', secondary_color: '#06B6D4', accent_color: '#F59E0B' });
  }
});

// ============ ROUTES ============
const platformAdminRoutes = require('./routes/platformAdmin');
const storeOwnerRoutes = require('./routes/storeOwner');
const productRoutes = require('./routes/products');
const orderRoutes = require('./routes/orders');
const storefrontRoutes = require('./routes/storefront');
const aiRoutes = require('./routes/ai');

app.use('/api/platform', platformAdminRoutes);
app.use('/api/owner', storeOwnerRoutes);
app.use('/api/manage', productRoutes);
app.use('/api/manage', orderRoutes);
app.use('/api/store', storefrontRoutes);
app.use('/api/ai', aiRoutes);

// ============ ERROR HANDLING ============
// This also has CORS headers because of the middleware above
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error', details: err.message });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found', path: req.path });
});

// ============ START + AUTO-INIT DB ============
const { initDb } = require('./config/initDb');

const PORT = process.env.PORT || 5000;
app.listen(PORT, async () => {
  console.log(`🚀 KyoMarket API running on port ${PORT}`);
  try {
    await initDb();
    console.log('✅ Database ready');
  } catch (error) {
    console.error('⚠️ DB init error:', error.message);
  }
});

module.exports = app;
