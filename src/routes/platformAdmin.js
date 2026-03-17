const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { authMiddleware, generateToken } = require('../middleware/auth');

// Platform Admin Login
router.post('/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    const result = await pool.query('SELECT * FROM platform_admins WHERE phone = $1', [phone]);
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const admin = result.rows[0];
    const validPassword = await bcrypt.compare(password, admin.password_hash);
    
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = generateToken({ id: admin.id, role: 'platform_admin', name: admin.name });
    res.json({ token, admin: { id: admin.id, name: admin.name, phone: admin.phone, role: admin.role } });
  } catch (error) {
    console.error('Platform admin login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get platform settings
router.get('/settings', authMiddleware(['platform_admin']), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM platform_settings LIMIT 1');
    res.json(result.rows[0] || {});
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// Update platform settings
router.put('/settings', authMiddleware(['platform_admin']), async (req, res) => {
  try {
    const { site_name, site_logo, primary_color, secondary_color, accent_color,
      subscription_monthly_price, subscription_yearly_price, trial_days,
      default_language, custom_css, meta_description, favicon, maintenance_mode } = req.body;
    
    const result = await pool.query(`
      UPDATE platform_settings SET
        site_name = COALESCE($1, site_name),
        site_logo = COALESCE($2, site_logo),
        primary_color = COALESCE($3, primary_color),
        secondary_color = COALESCE($4, secondary_color),
        accent_color = COALESCE($5, accent_color),
        subscription_monthly_price = COALESCE($6, subscription_monthly_price),
        subscription_yearly_price = COALESCE($7, subscription_yearly_price),
        trial_days = COALESCE($8, trial_days),
        default_language = COALESCE($9, default_language),
        custom_css = COALESCE($10, custom_css),
        meta_description = COALESCE($11, meta_description),
        favicon = COALESCE($12, favicon),
        maintenance_mode = COALESCE($13, maintenance_mode),
        updated_at = NOW()
      WHERE id = 1 RETURNING *
    `, [site_name, site_logo, primary_color, secondary_color, accent_color,
        subscription_monthly_price, subscription_yearly_price, trial_days,
        default_language, custom_css, meta_description, favicon, maintenance_mode]);
    
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// Get all store owners
router.get('/store-owners', authMiddleware(['platform_admin']), async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status } = req.query;
    const offset = (page - 1) * limit;
    let query = `
      SELECT so.*, COUNT(s.id) as store_count,
        COALESCE(SUM(s.store_visits), 0) as total_visits
      FROM store_owners so
      LEFT JOIN stores s ON s.owner_id = so.id
    `;
    const params = [];
    const conditions = [];

    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(so.name ILIKE $${params.length} OR so.email ILIKE $${params.length} OR so.phone ILIKE $${params.length})`);
    }
    if (status === 'active') conditions.push('so.is_active = TRUE');
    if (status === 'inactive') conditions.push('so.is_active = FALSE');

    if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND ');
    query += ' GROUP BY so.id ORDER BY so.created_at DESC';
    params.push(limit, offset);
    query += ` LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const result = await pool.query(query, params);
    const countResult = await pool.query('SELECT COUNT(*) FROM store_owners');

    res.json({
      owners: result.rows,
      total: parseInt(countResult.rows[0].count),
      page: parseInt(page),
      totalPages: Math.ceil(countResult.rows[0].count / limit)
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch store owners' });
  }
});

// Toggle store owner status
router.patch('/store-owners/:id/toggle', authMiddleware(['platform_admin']), async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE store_owners SET is_active = NOT is_active, updated_at = NOW() WHERE id = $1 RETURNING *',
      [req.params.id]
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update store owner' });
  }
});

// Get all stores
router.get('/stores', authMiddleware(['platform_admin']), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT s.*, so.name as owner_name, so.email as owner_email,
        (SELECT COUNT(*) FROM orders WHERE store_id = s.id) as order_count,
        (SELECT COALESCE(SUM(total), 0) FROM orders WHERE store_id = s.id AND payment_status = 'paid') as revenue
      FROM stores s
      JOIN store_owners so ON so.id = s.owner_id
      ORDER BY s.created_at DESC
    `);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch stores' });
  }
});

// Platform dashboard stats
router.get('/dashboard', authMiddleware(['platform_admin']), async (req, res) => {
  try {
    const [owners, stores, orders, revenue] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM store_owners'),
      pool.query('SELECT COUNT(*) FROM stores'),
      pool.query('SELECT COUNT(*) FROM orders'),
      pool.query("SELECT COALESCE(SUM(total), 0) as total FROM orders WHERE payment_status = 'paid'"),
    ]);

    const recentOrders = await pool.query(`
      SELECT o.*, s.name as store_name FROM orders o
      JOIN stores s ON s.id = o.store_id
      ORDER BY o.created_at DESC LIMIT 10
    `);

    const recentStores = await pool.query(`
      SELECT s.*, so.name as owner_name FROM stores s
      JOIN store_owners so ON so.id = s.owner_id
      ORDER BY s.created_at DESC LIMIT 5
    `);

    res.json({
      stats: {
        totalOwners: parseInt(owners.rows[0].count),
        totalStores: parseInt(stores.rows[0].count),
        totalOrders: parseInt(orders.rows[0].count),
        totalRevenue: parseFloat(revenue.rows[0].total),
      },
      recentOrders: recentOrders.rows,
      recentStores: recentStores.rows,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

module.exports = router;
