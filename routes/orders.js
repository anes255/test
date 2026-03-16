const express = require('express');
const pool = require('../config/db');
const { auth } = require('../middleware/auth');
const router = express.Router();

// Get orders for a store
router.get('/store/:storeId', auth, async (req, res) => {
  try {
    const { page = 1, limit = 20, status, search } = req.query;
    const offset = (page - 1) * limit;
    let query = 'SELECT * FROM orders WHERE store_id = $1';
    const params = [req.params.storeId];
    if (status && status !== 'all') { params.push(status); query += ` AND status = $${params.length}`; }
    if (search) { params.push(`%${search}%`); query += ` AND (customer_name ILIKE $${params.length} OR customer_phone ILIKE $${params.length} OR id::text ILIKE $${params.length})`; }
    query += ' ORDER BY created_at DESC';
    params.push(limit, offset);
    query += ` LIMIT $${params.length - 1} OFFSET $${params.length}`;
    const result = await pool.query(query, params);
    const count = await pool.query('SELECT COUNT(*) FROM orders WHERE store_id = $1', [req.params.storeId]);
    res.json({ orders: result.rows, total: parseInt(count.rows[0].count) });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// Get single order with items
router.get('/:id', auth, async (req, res) => {
  try {
    const order = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    if (order.rows.length === 0) return res.status(404).json({ error: 'Order not found.' });
    const items = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [req.params.id]);
    res.json({ ...order.rows[0], items: items.rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// Update order status
router.patch('/:id/status', auth, async (req, res) => {
  try {
    const { status, cancel_reason } = req.body;
    let extra = '';
    const params = [status, req.params.id];
    if (status === 'shipped') extra = ', shipped_at = NOW()';
    if (status === 'delivered') extra = ', delivered_at = NOW()';
    if (status === 'cancelled') { extra = ', cancelled_at = NOW(), cancel_reason = $3'; params.push(cancel_reason); }
    const result = await pool.query(
      `UPDATE orders SET status = $1, updated_at = NOW()${extra} WHERE id = $2 RETURNING *`, params
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// Abandoned carts
router.get('/abandoned/store/:storeId', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM carts WHERE store_id = $1 AND is_abandoned = true ORDER BY created_at DESC',
      [req.params.storeId]
    );
    const total = result.rows.length;
    const recovered = result.rows.filter(c => c.is_recovered).length;
    const recoveredRevenue = result.rows.filter(c => c.is_recovered).reduce((s, c) => s + parseFloat(c.total), 0);
    const lostRevenue = result.rows.filter(c => !c.is_recovered).reduce((s, c) => s + parseFloat(c.total), 0);
    res.json({
      carts: result.rows,
      stats: { total, recovered, recovery_rate: total > 0 ? ((recovered / total) * 100).toFixed(1) : 0, recovered_revenue: recoveredRevenue, lost_revenue: lostRevenue }
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// Customer orders (for customer profile)
router.get('/customer/:customerId', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM orders WHERE customer_id = $1 ORDER BY created_at DESC', [req.params.customerId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// Get customers for a store
router.get('/customers/store/:storeId', auth, async (req, res) => {
  try {
    const { search, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    let query = 'SELECT id, full_name, email, phone, city, wilaya, total_orders, total_spent, created_at FROM customers WHERE store_id = $1';
    const params = [req.params.storeId];
    if (search) { params.push(`%${search}%`); query += ` AND (full_name ILIKE $${params.length} OR phone ILIKE $${params.length})`; }
    query += ' ORDER BY created_at DESC';
    params.push(limit, offset);
    query += ` LIMIT $${params.length - 1} OFFSET $${params.length}`;
    const result = await pool.query(query, params);
    const count = await pool.query('SELECT COUNT(*) FROM customers WHERE store_id = $1', [req.params.storeId]);
    res.json({ customers: result.rows, total: parseInt(count.rows[0].count) });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
