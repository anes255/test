const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { authMiddleware, generateToken } = require('../middleware/auth');

// Platform Admin Login — uses env vars since platform_admins table doesn't exist
router.post('/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    const adminPhone = process.env.PLATFORM_ADMIN_PHONE || '0661573805';
    const adminPassword = process.env.PLATFORM_ADMIN_PASSWORD || 'admin123';

    if (phone !== adminPhone || password !== adminPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = generateToken({ id: 'admin', role: 'platform_admin', name: 'Super Admin' });
    res.json({ token, admin: { id: 'admin', name: 'Super Admin', role: 'super_admin' } });
  } catch (error) {
    res.status(500).json({ error: 'Login failed', detail: error.message });
  }
});

// Get platform settings
router.get('/settings', authMiddleware(['platform_admin']), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM platform_settings LIMIT 1');
    res.json(result.rows[0] || {});
  } catch (error) {
    res.json({ site_name: 'KyoMarket' });
  }
});

// Update platform settings
router.put('/settings', authMiddleware(['platform_admin']), async (req, res) => {
  try {
    const fields = req.body;
    const updates = [];
    const values = [];
    let idx = 1;

    for (const [key, val] of Object.entries(fields)) {
      if (key === 'id' || key === 'created_at') continue;
      updates.push(`${key} = $${idx}`);
      values.push(val);
      idx++;
    }

    if (updates.length === 0) return res.json({});
    const result = await pool.query(`UPDATE platform_settings SET ${updates.join(', ')}, updated_at = NOW() WHERE id = (SELECT id FROM platform_settings LIMIT 1) RETURNING *`, values);
    res.json(result.rows[0] || {});
  } catch (error) {
    res.status(500).json({ error: 'Failed to update settings', detail: error.message });
  }
});

// Get all store owners
router.get('/store-owners', authMiddleware(['platform_admin']), async (req, res) => {
  try {
    const { page = 1, limit = 20, search } = req.query;
    const offset = (page - 1) * limit;
    let query = 'SELECT id, full_name, email, phone, is_active, subscription_plan, subscription_end, created_at FROM store_owners';
    const params = [];

    if (search) {
      params.push(`%${search}%`);
      query += ` WHERE (full_name ILIKE $1 OR email ILIKE $1 OR phone ILIKE $1)`;
    }
    query += ' ORDER BY created_at DESC';
    params.push(limit, offset);
    query += ` LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const result = await pool.query(query, params);
    const count = await pool.query('SELECT COUNT(*) FROM store_owners');

    // Map full_name -> name for frontend
    const owners = result.rows.map(o => ({ ...o, name: o.full_name }));

    res.json({ owners, total: parseInt(count.rows[0].count), page: parseInt(page) });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch store owners', detail: error.message });
  }
});

// Toggle store owner active status
router.patch('/store-owners/:id/toggle', authMiddleware(['platform_admin']), async (req, res) => {
  try {
    const result = await pool.query('UPDATE store_owners SET is_active = NOT is_active, updated_at = NOW() WHERE id = $1 RETURNING *', [req.params.id]);
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update', detail: error.message });
  }
});

// Get all stores
router.get('/stores', authMiddleware(['platform_admin']), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT s.*, so.full_name as owner_name, so.email as owner_email
      FROM stores s
      LEFT JOIN store_owners so ON so.id = s.owner_id
      ORDER BY s.created_at DESC
    `);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch stores', detail: error.message });
  }
});

// Dashboard stats
router.get('/dashboard', authMiddleware(['platform_admin']), async (req, res) => {
  try {
    let totalOwners = 0, totalStores = 0, totalOrders = 0, totalRevenue = 0;

    try { const r = await pool.query('SELECT COUNT(*) FROM store_owners'); totalOwners = parseInt(r.rows[0].count); } catch(e) {}
    try { const r = await pool.query('SELECT COUNT(*) FROM stores'); totalStores = parseInt(r.rows[0].count); } catch(e) {}
    try { const r = await pool.query('SELECT COUNT(*) FROM orders'); totalOrders = parseInt(r.rows[0].count); } catch(e) {}
    try { const r = await pool.query("SELECT COALESCE(SUM(total), 0) as total FROM orders WHERE payment_status = 'paid'"); totalRevenue = parseFloat(r.rows[0].total); } catch(e) {}

    let recentOrders = [], recentStores = [];
    try { const r = await pool.query('SELECT o.*, s.name as store_name FROM orders o LEFT JOIN stores s ON s.id = o.store_id ORDER BY o.created_at DESC LIMIT 10'); recentOrders = r.rows; } catch(e) {}
    try { const r = await pool.query('SELECT s.*, so.full_name as owner_name FROM stores s LEFT JOIN store_owners so ON so.id = s.owner_id ORDER BY s.created_at DESC LIMIT 5'); recentStores = r.rows; } catch(e) {}

    res.json({ stats: { totalOwners, totalStores, totalOrders, totalRevenue }, recentOrders, recentStores });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch dashboard', detail: error.message });
  }
});

module.exports = router;
