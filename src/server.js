const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');
require('dotenv').config();

const app = express();

// CORS MUST come first — before everything
app.use(cors({
  origin: function (origin, callback) {
    callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-store-slug', 'X-Requested-With', 'Accept', 'Origin'],
  preflightContinue: false,
  optionsSuccessStatus: 204
}));
app.options('*', cors());

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: false,
  crossOriginOpenerPolicy: false,
  crossOriginEmbedderPolicy: false,
}));
app.use(compression());
app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

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
    endpoints: '/api/health, /api/platform-info'
  });
});

app.get('/favicon.ico', (req, res) => res.status(204).end());

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============ PLATFORM INFO (safe — won't crash if DB not ready) ============
const pool = require('./config/db');

app.get('/api/platform-info', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT site_name, site_logo, primary_color, secondary_color, accent_color, default_language, meta_description, favicon, maintenance_mode FROM platform_settings LIMIT 1'
    );
    res.json(result.rows[0] || { site_name: 'KyoMarket' });
  } catch (error) {
    // Table might not exist yet — return defaults
    console.log('platform_settings not ready:', error.message);
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
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Something went wrong!' });
});

// Catch-all for unknown routes (return JSON, not 500)
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found', path: req.path });
});

// ============ START SERVER + AUTO-INIT DATABASE ============
const { initDb } = require('./config/initDb');

const PORT = process.env.PORT || 5000;
app.listen(PORT, async () => {
  console.log(`🚀 KyoMarket API running on port ${PORT}`);
  
  // Auto-initialize database on startup
  try {
    await initDb();
    console.log('✅ Database ready');
  } catch (error) {
    console.error('⚠️ Database init warning:', error.message);
    console.log('Server still running — DB may need manual init');
  }
});

module.exports = app;
