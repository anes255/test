const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { authMiddleware, generateToken } = require('../middleware/auth');
const slugify = require('slugify');

// ============ DEBUG ENDPOINTS ============
router.get('/test', (req, res) => {
  res.json({ status: 'ok', message: 'Owner routes working' });
});

router.get('/debug-db', async (req, res) => {
  try {
    const tables = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`);
    
    const getColumns = async (table) => {
      const cols = await pool.query(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`, [table]);
      return cols.rows;
    };

    const store_owners = await getColumns('store_owners');
    const stores = await getColumns('stores');
    const platform_admins_exists = tables.rows.some(r => r.table_name === 'platform_admins');
    let platform_admins = [];
    if (platform_admins_exists) {
      platform_admins = await getColumns('platform_admins');
    }
    const platform_settings = await getColumns('platform_settings');

    res.json({ 
      tables: tables.rows.map(r => r.table_name), 
      store_owners, stores, platform_admins, platform_settings
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ REGISTER ============
// Matches existing DB: full_name, email (NOT NULL), phone (NOT NULL), password_hash
router.post('/register', async (req, res) => {
  try {
    const { name, email, phone, password, address, city, wilaya } = req.body;

    if (!name || !password) {
      return res.status(400).json({ error: 'Name and password are required' });
    }
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    // Check duplicates
    const existingEmail = await pool.query('SELECT id FROM store_owners WHERE email = $1', [email]);
    if (existingEmail.rows.length > 0) {
      return res.status(409).json({ error: 'Email already registered' });
    }
    const existingPhone = await pool.query('SELECT id FROM store_owners WHERE phone = $1', [phone]);
    if (existingPhone.rows.length > 0) {
      return res.status(409).json({ error: 'Phone number already registered' });
    }

    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(`
      INSERT INTO store_owners (full_name, email, phone, password_hash, address, city, wilaya)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, full_name, email, phone, subscription_plan, subscription_end, created_at
    `, [name, email, phone, hash, address || null, city || null, wilaya || null]);

    const owner = result.rows[0];
    const token = generateToken({ 
      id: owner.id, role: 'store_owner', name: owner.full_name 
    });

    res.status(201).json({ 
      token, 
      owner: { 
        id: owner.id, name: owner.full_name, email: owner.email, phone: owner.phone,
        subscription_plan: owner.subscription_plan, subscription_end: owner.subscription_end 
      } 
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed', detail: error.message, code: error.code });
  }
});

// ============ LOGIN (email OR phone) ============
router.post('/login', async (req, res) => {
  try {
    const { identifier, password } = req.body;

    if (!identifier || !password) {
      return res.status(400).json({ error: 'Email/phone and password are required' });
    }

    // Try email first, then phone
    let result = await pool.query('SELECT * FROM store_owners WHERE email = $1', [identifier]);
    if (result.rows.length === 0) {
      result = await pool.query('SELECT * FROM store_owners WHERE phone = $1', [identifier]);
    }

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const owner = result.rows[0];
    if (owner.is_active === false) {
      return res.status(403).json({ error: 'Account suspended. Contact support.' });
    }

    const valid = await bcrypt.compare(password, owner.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = generateToken({ 
      id: owner.id, role: 'store_owner', name: owner.full_name 
    });

    // Get stores — handle different possible column names for owner reference
    let stores = { rows: [] };
    try {
      stores = await pool.query('SELECT * FROM stores WHERE owner_id = $1', [owner.id]);
    } catch(e) {
      console.log('Stores query failed:', e.message);
    }

    res.json({
      token,
      owner: { 
        id: owner.id, name: owner.full_name, email: owner.email, phone: owner.phone,
        subscription_plan: owner.subscription_plan, subscription_end: owner.subscription_end 
      },
      stores: stores.rows
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed', detail: error.message });
  }
});

// ============ CREATE STORE ============
router.post('/stores', authMiddleware(['store_owner']), async (req, res) => {
  try {
    const { name, description } = req.body;
    const slug = slugify(name, { lower: true, strict: true }) + '-' + Date.now().toString(36);

    // Try to insert — adapt to whatever columns the stores table has
    const result = await pool.query(`
      INSERT INTO stores (owner_id, name, slug, description)
      VALUES ($1, $2, $3, $4) RETURNING *
    `, [req.user.id, name, slug, description || null]);

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Store creation error:', error);
    res.status(500).json({ error: 'Failed to create store', detail: error.message });
  }
});

// ============ GET STORES ============
router.get('/stores', authMiddleware(['store_owner']), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM stores WHERE owner_id = $1 ORDER BY created_at DESC', [req.user.id]);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch stores', detail: error.message });
  }
});

// ============ STORE DASHBOARD ============
router.get('/stores/:storeId/dashboard', authMiddleware(['store_owner']), async (req, res) => {
  try {
    const storeId = req.params.storeId;
    const store = await pool.query('SELECT * FROM stores WHERE id = $1 AND owner_id = $2', [storeId, req.user.id]);
    if (store.rows.length === 0) return res.status(404).json({ error: 'Store not found' });

    // Safely query with fallbacks
    let totalOrders = 0, totalRevenue = 0, totalProducts = 0, totalCustomers = 0;
    let recentOrders = [], salesData = [];

    try { const r = await pool.query('SELECT COUNT(*) FROM orders WHERE store_id = $1', [storeId]); totalOrders = parseInt(r.rows[0].count); } catch(e) {}
    try { const r = await pool.query("SELECT COALESCE(SUM(total), 0) as total FROM orders WHERE store_id = $1 AND payment_status = 'paid'", [storeId]); totalRevenue = parseFloat(r.rows[0].total); } catch(e) {}
    try { const r = await pool.query('SELECT COUNT(*) FROM products WHERE store_id = $1', [storeId]); totalProducts = parseInt(r.rows[0].count); } catch(e) {}
    try { const r = await pool.query('SELECT COUNT(*) FROM customers WHERE store_id = $1', [storeId]); totalCustomers = parseInt(r.rows[0].count); } catch(e) {}
    try { const r = await pool.query('SELECT * FROM orders WHERE store_id = $1 ORDER BY created_at DESC LIMIT 10', [storeId]); recentOrders = r.rows; } catch(e) {}

    res.json({
      store: store.rows[0],
      stats: {
        totalOrders, totalRevenue, totalProducts, totalCustomers,
        storeVisits: store.rows[0].store_visits || 0,
        avgOrderValue: totalOrders > 0 ? (totalRevenue / totalOrders).toFixed(2) : 0
      },
      recentOrders,
      salesData,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch dashboard', detail: error.message });
  }
});

// ============ UPDATE STORE ============
router.put('/stores/:storeId', authMiddleware(['store_owner']), async (req, res) => {
  try {
    const storeId = req.params.storeId;
    const ownership = await pool.query('SELECT id FROM stores WHERE id = $1 AND owner_id = $2', [storeId, req.user.id]);
    if (ownership.rows.length === 0) return res.status(404).json({ error: 'Store not found' });

    const fields = req.body;
    const updates = [];
    const values = [];
    let idx = 1;

    // Dynamically build update from whatever fields are sent
    for (const [key, val] of Object.entries(fields)) {
      if (key === 'id' || key === 'owner_id' || key === 'created_at') continue; // skip protected
      updates.push(`${key} = $${idx}`);
      values.push(val);
      idx++;
    }

    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
    values.push(storeId);
    
    const result = await pool.query(`UPDATE stores SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`, values);
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update store', detail: error.message });
  }
});

// ============ STAFF ============
router.get('/stores/:storeId/staff', authMiddleware(['store_owner']), async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, email, phone, role, is_active, created_at FROM store_staff WHERE store_id = $1 ORDER BY created_at', [req.params.storeId]);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch staff', detail: error.message });
  }
});

router.post('/stores/:storeId/staff', authMiddleware(['store_owner']), async (req, res) => {
  try {
    const { name, email, phone, password, role } = req.body;
    const validRoles = ['admin', 'preparer', 'confirmer', 'accountant', 'viewer'];
    if (!validRoles.includes(role)) return res.status(400).json({ error: 'Invalid role' });
    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query('INSERT INTO store_staff (store_id, name, email, phone, password_hash, role) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name, email, phone, role, created_at', [req.params.storeId, name, email, phone, hash, role]);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to add staff', detail: error.message });
  }
});

router.post('/staff/login', async (req, res) => {
  try {
    const { storeSlug, email, password } = req.body;
    const store = await pool.query('SELECT id FROM stores WHERE slug = $1', [storeSlug]);
    if (store.rows.length === 0) return res.status(404).json({ error: 'Store not found' });
    const staff = await pool.query('SELECT * FROM store_staff WHERE store_id = $1 AND email = $2 AND is_active = TRUE', [store.rows[0].id, email]);
    if (staff.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, staff.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = generateToken({ id: staff.rows[0].id, role: 'store_staff', staffRole: staff.rows[0].role, storeId: store.rows[0].id, name: staff.rows[0].name });
    res.json({ token, staff: { id: staff.rows[0].id, name: staff.rows[0].name, role: staff.rows[0].role } });
  } catch (error) {
    res.status(500).json({ error: 'Staff login failed', detail: error.message });
  }
});

// ============ DOMAINS ============
router.get('/stores/:storeId/domains', authMiddleware(['store_owner']), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM domain_requests WHERE store_id = $1 ORDER BY created_at DESC', [req.params.storeId]);
    res.json(result.rows);
  } catch (error) {
    // Table might not exist
    res.json([]);
  }
});

router.post('/stores/:storeId/domains', authMiddleware(['store_owner']), async (req, res) => {
  try {
    const { domain_name } = req.body;
    const result = await pool.query('INSERT INTO domain_requests (store_id, domain_name, price) VALUES ($1, $2, 3500.00) RETURNING *', [req.params.storeId, domain_name]);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to request domain', detail: error.message });
  }
});

// ============ PROFILE ============
router.get('/profile', authMiddleware(['store_owner']), async (req, res) => {
  try {
    const result = await pool.query('SELECT id, full_name, email, phone, address, city, wilaya, subscription_plan, subscription_start, subscription_end, created_at FROM store_owners WHERE id = $1', [req.user.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Profile not found' });
    // Map full_name to name for frontend compatibility
    const row = result.rows[0];
    res.json({ ...row, name: row.full_name });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch profile', detail: error.message });
  }
});

module.exports = router;
