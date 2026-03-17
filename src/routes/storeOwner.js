const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { authMiddleware, generateToken } = require('../middleware/auth');
const slugify = require('slugify');

// Test endpoint
router.get('/test', (req, res) => {
  res.json({ status: 'ok', message: 'Owner routes working' });
});

// Database diagnostic — shows table status
router.get('/debug-db', async (req, res) => {
  try {
    // Check if table exists
    const tableCheck = await pool.query(`
      SELECT table_name FROM information_schema.tables 
      WHERE table_schema = 'public' ORDER BY table_name
    `);
    const tables = tableCheck.rows.map(r => r.table_name);

    let columns = [];
    if (tables.includes('store_owners')) {
      const colCheck = await pool.query(`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns 
        WHERE table_name = 'store_owners' ORDER BY ordinal_position
      `);
      columns = colCheck.rows;
    }

    // Check constraints
    let constraints = [];
    try {
      const conCheck = await pool.query(`
        SELECT constraint_name, constraint_type
        FROM information_schema.table_constraints
        WHERE table_name = 'store_owners'
      `);
      constraints = conCheck.rows;
    } catch(e) {}

    res.json({ tables, store_owners_columns: columns, store_owners_constraints: constraints });
  } catch (error) {
    res.status(500).json({ error: error.message, stack: error.stack });
  }
});

// Register store owner
router.post('/register', async (req, res) => {
  try {
    const { name, email, phone, password, address, city, wilaya } = req.body;

    if (!name || !password) {
      return res.status(400).json({ error: 'Name and password are required' });
    }

    if (!email && !phone) {
      return res.status(400).json({ error: 'Email or phone number is required' });
    }

    // Check for existing email
    if (email) {
      const existingEmail = await pool.query('SELECT id FROM store_owners WHERE email = $1', [email]);
      if (existingEmail.rows.length > 0) {
        return res.status(409).json({ error: 'Email already registered' });
      }
    }

    // Check for existing phone
    if (phone) {
      const existingPhone = await pool.query('SELECT id FROM store_owners WHERE phone = $1', [phone]);
      if (existingPhone.rows.length > 0) {
        return res.status(409).json({ error: 'Phone number already registered' });
      }
    }

    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(`
      INSERT INTO store_owners (name, email, phone, password_hash, address, city, wilaya, subscription_end)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + INTERVAL '14 days')
      RETURNING id, name, email, phone, subscription_plan, subscription_end, created_at
    `, [name, email || null, phone || null, hash, address || null, city || null, wilaya || null]);

    const owner = result.rows[0];
    const token = generateToken({ id: owner.id, role: 'store_owner', name: owner.name });

    res.status(201).json({ token, owner });
  } catch (error) {
    console.error('Registration error:', error);
    // RETURN THE ACTUAL ERROR so we can debug
    res.status(500).json({ 
      error: 'Registration failed', 
      detail: error.message,
      code: error.code,
      constraint: error.constraint
    });
  }
});

// Login store owner — supports email OR phone
router.post('/login', async (req, res) => {
  try {
    const { identifier, password } = req.body;

    if (!identifier || !password) {
      return res.status(400).json({ error: 'Email/phone and password are required' });
    }

    // Try to find by email first, then by phone
    let result = await pool.query('SELECT * FROM store_owners WHERE email = $1', [identifier]);
    if (result.rows.length === 0) {
      result = await pool.query('SELECT * FROM store_owners WHERE phone = $1', [identifier]);
    }

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const owner = result.rows[0];
    if (!owner.is_active) {
      return res.status(403).json({ error: 'Account suspended. Contact support.' });
    }

    const valid = await bcrypt.compare(password, owner.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = generateToken({ id: owner.id, role: 'store_owner', name: owner.name });
    const stores = await pool.query('SELECT id, name, slug, logo, is_live FROM stores WHERE owner_id = $1', [owner.id]);

    res.json({
      token,
      owner: { id: owner.id, name: owner.name, email: owner.email, phone: owner.phone,
        subscription_plan: owner.subscription_plan, subscription_end: owner.subscription_end },
      stores: stores.rows
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed', detail: error.message });
  }
});

// Create a store
router.post('/stores', authMiddleware(['store_owner']), async (req, res) => {
  try {
    const { name, description } = req.body;
    const slug = slugify(name, { lower: true, strict: true }) + '-' + Date.now().toString(36);

    const result = await pool.query(`
      INSERT INTO stores (owner_id, name, slug, description)
      VALUES ($1, $2, $3, $4) RETURNING *
    `, [req.user.id, name, slug, description]);

    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create store', detail: error.message });
  }
});

// Get owner's stores
router.get('/stores', authMiddleware(['store_owner']), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT s.*,
        (SELECT COUNT(*) FROM products WHERE store_id = s.id) as product_count,
        (SELECT COUNT(*) FROM orders WHERE store_id = s.id) as order_count,
        (SELECT COALESCE(SUM(total), 0) FROM orders WHERE store_id = s.id AND payment_status = 'paid') as revenue
      FROM stores s WHERE s.owner_id = $1 ORDER BY s.created_at DESC
    `, [req.user.id]);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch stores', detail: error.message });
  }
});

// Get store dashboard
router.get('/stores/:storeId/dashboard', authMiddleware(['store_owner']), async (req, res) => {
  try {
    const storeId = req.params.storeId;
    const store = await pool.query('SELECT * FROM stores WHERE id = $1 AND owner_id = $2', [storeId, req.user.id]);
    if (store.rows.length === 0) return res.status(404).json({ error: 'Store not found' });

    const [orders, revenue, products, customers, recentOrders, salesData] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM orders WHERE store_id = $1', [storeId]),
      pool.query("SELECT COALESCE(SUM(total), 0) as total FROM orders WHERE store_id = $1 AND payment_status = 'paid'", [storeId]),
      pool.query('SELECT COUNT(*) FROM products WHERE store_id = $1', [storeId]),
      pool.query('SELECT COUNT(*) FROM customers WHERE store_id = $1', [storeId]),
      pool.query('SELECT * FROM orders WHERE store_id = $1 ORDER BY created_at DESC LIMIT 10', [storeId]),
      pool.query(`SELECT DATE(created_at) as date, COUNT(*) as orders, COALESCE(SUM(total), 0) as revenue FROM orders WHERE store_id = $1 AND created_at > NOW() - INTERVAL '30 days' GROUP BY DATE(created_at) ORDER BY date`, [storeId]),
    ]);

    res.json({
      store: store.rows[0],
      stats: {
        totalOrders: parseInt(orders.rows[0].count),
        totalRevenue: parseFloat(revenue.rows[0].total),
        totalProducts: parseInt(products.rows[0].count),
        totalCustomers: parseInt(customers.rows[0].count),
        storeVisits: store.rows[0].store_visits,
        avgOrderValue: parseInt(orders.rows[0].count) > 0 ? (parseFloat(revenue.rows[0].total) / parseInt(orders.rows[0].count)).toFixed(2) : 0
      },
      recentOrders: recentOrders.rows,
      salesData: salesData.rows,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch dashboard', detail: error.message });
  }
});

// Update store settings
router.put('/stores/:storeId', authMiddleware(['store_owner']), async (req, res) => {
  try {
    const storeId = req.params.storeId;
    const ownership = await pool.query('SELECT id FROM stores WHERE id = $1 AND owner_id = $2', [storeId, req.user.id]);
    if (ownership.rows.length === 0) return res.status(404).json({ error: 'Store not found' });

    const fields = req.body;
    const allowedFields = [
      'name', 'description', 'logo', 'favicon', 'meta_description',
      'primary_color', 'secondary_color', 'accent_color', 'bg_color', 'text_color',
      'font_family', 'header_style', 'footer_text',
      'social_facebook', 'social_instagram', 'social_tiktok', 'whatsapp_number',
      'currency', 'default_language', 'supported_languages', 'is_live',
      'enable_cod', 'enable_ccp', 'ccp_account', 'ccp_name',
      'enable_baridimob', 'baridimob_rip',
      'enable_bank_transfer', 'bank_name', 'bank_account', 'bank_rib',
      'shipping_default_price', 'free_shipping_threshold', 'cod_all_wilayas',
      'ai_chatbot_enabled', 'ai_chatbot_name', 'ai_chatbot_greeting', 'ai_chatbot_personality',
      'ai_fake_detection', 'ai_cart_recovery'
    ];

    const updates = [];
    const values = [];
    let paramIndex = 1;

    for (const field of allowedFields) {
      if (fields[field] !== undefined) {
        updates.push(`${field} = $${paramIndex}`);
        values.push(fields[field]);
        paramIndex++;
      }
    }

    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
    updates.push('updated_at = NOW()');
    values.push(storeId);

    const result = await pool.query(`UPDATE stores SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`, values);
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update store', detail: error.message });
  }
});

// Staff management
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
    const result = await pool.query(`INSERT INTO store_staff (store_id, name, email, phone, password_hash, role) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, email, phone, role, created_at`, [req.params.storeId, name, email, phone, hash, role]);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to add staff', detail: error.message });
  }
});

// Staff login
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
    res.status(500).json({ error: 'Login failed', detail: error.message });
  }
});

// Domain management
router.post('/stores/:storeId/domains', authMiddleware(['store_owner']), async (req, res) => {
  try {
    const { domain_name } = req.body;
    const result = await pool.query(`INSERT INTO domain_requests (store_id, domain_name, price, dns_records) VALUES ($1, $2, 3500.00, $3) RETURNING *`, [req.params.storeId, domain_name, JSON.stringify({ cname: { name: domain_name, value: 'stores.kyomarket.com' }, txt: { name: '_verify.' + domain_name, value: 'kyomarket-verify-' + Date.now() } })]);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to request domain', detail: error.message });
  }
});

router.get('/stores/:storeId/domains', authMiddleware(['store_owner']), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM domain_requests WHERE store_id = $1 ORDER BY created_at DESC', [req.params.storeId]);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch domains', detail: error.message });
  }
});

// Get profile
router.get('/profile', authMiddleware(['store_owner']), async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, email, phone, address, city, wilaya, subscription_plan, subscription_start, subscription_end, avatar, language, created_at FROM store_owners WHERE id = $1', [req.user.id]);
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch profile', detail: error.message });
  }
});

module.exports = router;
