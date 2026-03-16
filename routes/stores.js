const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { auth, storeOwner, storeStaff } = require('../middleware/auth');
const router = express.Router();

// Create a new store
router.post('/', auth, storeOwner, async (req, res) => {
  try {
    const ownerId = req.user.ownerId || req.user.id;
    const { store_name, slug, description, contact_email, contact_phone } = req.body;
    if (!store_name || !slug) return res.status(400).json({ error: 'Store name and URL slug required.' });
    
    const slugCheck = await pool.query('SELECT id FROM stores WHERE slug = $1', [slug.toLowerCase()]);
    if (slugCheck.rows.length > 0) return res.status(400).json({ error: 'This URL is already taken.' });
    
    const result = await pool.query(
      `INSERT INTO stores (owner_id, store_name, slug, description, contact_email, contact_phone)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [ownerId, store_name, slug.toLowerCase(), description, contact_email, contact_phone]
    );
    const store = result.rows[0];
    
    // Create default admin staff from owner
    const owner = await pool.query('SELECT * FROM store_owners WHERE id = $1', [ownerId]);
    const ownerData = owner.rows[0];
    const defaultHash = await bcrypt.hash('admin123', 10);
    await pool.query(
      `INSERT INTO store_staff (store_id, name, email, phone, password_hash, role)
       VALUES ($1, $2, $3, $4, $5, 'admin')`,
      [store.id, ownerData.full_name, ownerData.email, ownerData.phone, defaultHash]
    );
    
    // Create default payment settings
    await pool.query(
      'INSERT INTO payment_settings (store_id) VALUES ($1)', [store.id]
    );

    res.status(201).json(store);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// Get stores for current owner
router.get('/my-stores', auth, storeOwner, async (req, res) => {
  try {
    const ownerId = req.user.ownerId || req.user.id;
    const result = await pool.query(
      'SELECT * FROM stores WHERE owner_id = $1 ORDER BY created_at DESC', [ownerId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// Get single store details
router.get('/:id', auth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM stores WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Store not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// Update store settings
router.put('/:id', auth, async (req, res) => {
  try {
    const fields = req.body;
    const setClauses = [];
    const values = [];
    let idx = 1;
    const allowed = ['store_name','description','logo_url','favicon_url','primary_color','secondary_color',
      'accent_color','bg_color','currency','is_published','meta_title','meta_description','hero_title',
      'hero_subtitle','contact_email','contact_phone','contact_address','social_facebook',
      'social_instagram','social_tiktok'];
    
    for (const key of allowed) {
      if (fields[key] !== undefined) {
        setClauses.push(`${key} = $${idx}`);
        values.push(fields[key]);
        idx++;
      }
    }
    if (setClauses.length === 0) return res.status(400).json({ error: 'No fields to update.' });
    
    setClauses.push(`updated_at = NOW()`);
    values.push(req.params.id);
    const result = await pool.query(
      `UPDATE stores SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`, values
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ==================== STORE STAFF MANAGEMENT ====================

router.get('/:id/staff', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, email, phone, role, is_active, last_login, created_at FROM store_staff WHERE store_id = $1 ORDER BY role',
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

router.post('/:id/staff', auth, async (req, res) => {
  try {
    const { name, email, phone, password, role } = req.body;
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO store_staff (store_id, name, email, phone, password_hash, role)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name, email, phone, role`,
      [req.params.id, name, email, phone, hash, role]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

router.delete('/:storeId/staff/:staffId', auth, async (req, res) => {
  try {
    await pool.query('DELETE FROM store_staff WHERE id = $1 AND store_id = $2', [req.params.staffId, req.params.storeId]);
    res.json({ message: 'Staff removed.' });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// ==================== STORE DASHBOARD ANALYTICS ====================

router.get('/:id/dashboard', auth, async (req, res) => {
  try {
    const storeId = req.params.id;
    const store = await pool.query('SELECT * FROM stores WHERE id = $1', [storeId]);
    const products = await pool.query('SELECT COUNT(*) FROM products WHERE store_id = $1', [storeId]);
    const orders = await pool.query('SELECT COUNT(*) FROM orders WHERE store_id = $1', [storeId]);
    const sales = await pool.query("SELECT COALESCE(SUM(total),0) as total FROM orders WHERE store_id = $1 AND payment_status = 'paid'", [storeId]);
    const newOrders = await pool.query(
      "SELECT COUNT(*) FROM orders WHERE store_id = $1 AND created_at > NOW() - INTERVAL '24 hours'", [storeId]
    );
    const avgOrder = await pool.query(
      "SELECT COALESCE(AVG(total),0) as avg FROM orders WHERE store_id = $1 AND status != 'cancelled'", [storeId]
    );
    const recentOrders = await pool.query(
      'SELECT * FROM orders WHERE store_id = $1 ORDER BY created_at DESC LIMIT 5', [storeId]
    );
    
    // Sales last 7 days
    const salesChart = await pool.query(
      `SELECT DATE(created_at) as date, COALESCE(SUM(total),0) as total, COUNT(*) as count
       FROM orders WHERE store_id = $1 AND created_at > NOW() - INTERVAL '7 days'
       GROUP BY DATE(created_at) ORDER BY date`, [storeId]
    );
    
    // Order status counts
    const statusCounts = await pool.query(
      `SELECT status, COUNT(*) FROM orders WHERE store_id = $1 GROUP BY status`, [storeId]
    );

    res.json({
      store: store.rows[0],
      stats: {
        total_visits: store.rows[0]?.total_visits || 0,
        total_sales: parseFloat(sales.rows[0].total),
        total_orders: parseInt(orders.rows[0].count),
        avg_order_value: parseFloat(avgOrder.rows[0].avg),
        total_products: parseInt(products.rows[0].count),
        new_orders: parseInt(newOrders.rows[0].count)
      },
      recent_orders: recentOrders.rows,
      sales_chart: salesChart.rows,
      order_statuses: statusCounts.rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ==================== PAYMENT SETTINGS ====================

router.get('/:id/payment-settings', auth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM payment_settings WHERE store_id = $1', [req.params.id]);
    res.json(result.rows[0] || {});
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

router.put('/:id/payment-settings', auth, async (req, res) => {
  try {
    const f = req.body;
    const result = await pool.query(
      `UPDATE payment_settings SET
        cod_enabled=COALESCE($1,cod_enabled), ccp_enabled=COALESCE($2,ccp_enabled),
        ccp_account=COALESCE($3,ccp_account), ccp_name=COALESCE($4,ccp_name),
        baridimob_enabled=COALESCE($5,baridimob_enabled), baridimob_rip=COALESCE($6,baridimob_rip),
        bank_transfer_enabled=COALESCE($7,bank_transfer_enabled), bank_name=COALESCE($8,bank_name),
        bank_account=COALESCE($9,bank_account), bank_rib=COALESCE($10,bank_rib), updated_at=NOW()
       WHERE store_id=$11 RETURNING *`,
      [f.cod_enabled, f.ccp_enabled, f.ccp_account, f.ccp_name,
       f.baridimob_enabled, f.baridimob_rip, f.bank_transfer_enabled,
       f.bank_name, f.bank_account, f.bank_rib, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// ==================== STORE APPS ====================

router.get('/:id/apps', auth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM store_apps WHERE store_id = $1', [req.params.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

router.post('/:id/apps', auth, async (req, res) => {
  try {
    const { app_name, app_slug } = req.body;
    const result = await pool.query(
      `INSERT INTO store_apps (store_id, app_name, app_slug, is_active) VALUES ($1,$2,$3,true)
       ON CONFLICT DO NOTHING RETURNING *`,
      [req.params.id, app_name, app_slug]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// ==================== DELIVERY COMPANIES ====================

router.get('/:id/delivery', auth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM delivery_companies WHERE store_id = $1', [req.params.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

router.post('/:id/delivery', auth, async (req, res) => {
  try {
    const { name, base_rate } = req.body;
    const result = await pool.query(
      'INSERT INTO delivery_companies (store_id, name, base_rate) VALUES ($1,$2,$3) RETURNING *',
      [req.params.id, name, base_rate || 0]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// Shipping wilayas
router.get('/:id/shipping-wilayas', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM shipping_wilayas WHERE store_id = $1 ORDER BY wilaya_code', [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

router.post('/:id/shipping-wilayas', auth, async (req, res) => {
  try {
    const { wilaya_name, wilaya_code, home_delivery_price, desk_delivery_price, delivery_days } = req.body;
    const result = await pool.query(
      `INSERT INTO shipping_wilayas (store_id, wilaya_name, wilaya_code, home_delivery_price, desk_delivery_price, delivery_days)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.params.id, wilaya_name, wilaya_code, home_delivery_price, desk_delivery_price, delivery_days]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// ==================== STORE PAGES ====================

router.get('/:id/pages', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM store_pages WHERE store_id = $1 ORDER BY sort_order', [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

router.post('/:id/pages', auth, async (req, res) => {
  try {
    const { title, slug, content } = req.body;
    const result = await pool.query(
      'INSERT INTO store_pages (store_id, title, slug, content) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.params.id, title, slug, content]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
