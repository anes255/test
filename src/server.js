const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');
require('dotenv').config();

const app = express();

// Middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-store-slug']
}));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

// Routes
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

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Get platform public settings
const pool = require('./config/db');
app.get('/api/platform-info', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT site_name, site_logo, primary_color, secondary_color, accent_color, default_language, meta_description, favicon, maintenance_mode FROM platform_settings LIMIT 1'
    );
    res.json(result.rows[0] || {});
  } catch (error) {
    res.json({ site_name: 'KyoMarket' });
  }
});

// Serve frontend in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../../frontend/dist')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../../frontend/dist/index.html'));
  });
}

// Error handling
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 KyoMarket API running on port ${PORT}`);
});

module.exports = app;
