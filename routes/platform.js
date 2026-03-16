const express = require('express');
const pool = require('../config/db');
const { auth, platformAdmin } = require('../middleware/auth');
const router = express.Router();

router.use(auth, platformAdmin);

// Get platform settings
router.get('/settings', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM platform_settings WHERE id = 1');
    res.json(result.rows[0] || {});
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// Update platform settings
router.put('/settings', async (req, res) => {
  try {
    const { site_name, primary_color, secondary_color, accent_color,
      subscription_monthly_price, subscription_yearly_price, subscription_trial_days,
      currency, logo_url, meta_description, maintenance_mode } = req.body;
    const result = await pool.query(
      `UPDATE platform_settings SET 
        site_name = COALESCE($1, site_name),
        primary_color = COALESCE($2, primary_color),
        secondary_color = COALESCE($3, secondary_color),
        accent_color = COALESCE($4, accent_color),
        subscription_monthly_price = COALESCE($5, subscription_monthly_price),
        subscription_yearly_price = COALESCE($6, subscription_yearly_price),
        subscription_trial_days = COALESCE($7, subscription_trial_days),
        currency = COALESCE($8, currency),
        logo_url = COALESCE($9, logo_url),
        meta_description = COALESCE($10, meta_description),
        maintenance_mode = COALESCE($11, maintenance_mode),
        updated_at = NOW()
      WHERE id = 1 RETURNING *`,
      [site_name, primary_color, secondary_color, accent_color,
        subscription_monthly_price, subscription_yearly_price, subscription_trial_days,
        currency, logo_url, meta_description, maintenance_mode]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// Get all store owners
router.get('/users', async (req, res) => {
  try {
    const { page = 1, limit = 20, search } = req.query;
    const offset = (page - 1) * limit;
    let query = `SELECT id, full_name, email, phone, is_active, is_verified, 
                  subscription_plan, subscription_end, city, wilaya, created_at 
                 FROM store_owners WHERE subscription_plan != 'admin'`;
    const params = [];
    if (search) {
      params.push(`%${search}%`);
      query += ` AND (full_name ILIKE $${params.length} OR email ILIKE $${params.length} OR phone ILIKE $${params.length})`;
    }
    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);
    const result = await pool.query(query, params);
    const count = await pool.query("SELECT COUNT(*) FROM store_owners WHERE subscription_plan != 'admin'");
    res.json({ users: result.rows, total: parseInt(count.rows[0].count) });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// Toggle user active status
router.patch('/users/:id/toggle', async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE store_owners SET is_active = NOT is_active, updated_at = NOW() WHERE id = $1 RETURNING id, is_active',
      [req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// Get all stores
router.get('/stores', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.*, o.full_name as owner_name, o.email as owner_email, o.phone as owner_phone
       FROM stores s JOIN store_owners o ON s.owner_id = o.id ORDER BY s.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// Platform analytics
router.get('/analytics', async (req, res) => {
  try {
    const owners = await pool.query("SELECT COUNT(*) FROM store_owners WHERE subscription_plan != 'admin'");
    const stores = await pool.query('SELECT COUNT(*) FROM stores');
    const orders = await pool.query('SELECT COUNT(*) FROM orders');
    const revenue = await pool.query('SELECT COALESCE(SUM(total),0) as total FROM orders WHERE payment_status = $1', ['paid']);
    res.json({
      total_owners: parseInt(owners.rows[0].count),
      total_stores: parseInt(stores.rows[0].count),
      total_orders: parseInt(orders.rows[0].count),
      total_revenue: parseFloat(revenue.rows[0].total)
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
