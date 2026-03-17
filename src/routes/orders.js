const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authMiddleware } = require('../middleware/auth');

// Get orders for a store
router.get('/stores/:storeId/orders', authMiddleware(['store_owner', 'store_staff']), async (req, res) => {
  try {
    const { page = 1, limit = 20, status, search, payment_status } = req.query;
    const offset = (page - 1) * limit;
    let query = 'SELECT * FROM orders WHERE store_id = $1';
    const params = [req.params.storeId];

    if (status && status !== 'all') { params.push(status); query += ` AND status = $${params.length}`; }
    if (payment_status) { params.push(payment_status); query += ` AND payment_status = $${params.length}`; }
    if (search) { params.push(`%${search}%`); query += ` AND (order_number ILIKE $${params.length} OR customer_name ILIKE $${params.length} OR customer_phone ILIKE $${params.length})`; }

    const countQ = query.replace('SELECT *', 'SELECT COUNT(*)');
    query += ' ORDER BY created_at DESC';
    params.push(limit, offset);
    query += ` LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const [result, count] = await Promise.all([
      pool.query(query, params),
      pool.query(countQ, params.slice(0, -2))
    ]);

    res.json({ orders: result.rows, total: parseInt(count.rows[0].count) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// Get single order with items
router.get('/stores/:storeId/orders/:orderId', authMiddleware(['store_owner', 'store_staff']), async (req, res) => {
  try {
    const order = await pool.query('SELECT * FROM orders WHERE id = $1 AND store_id = $2', [req.params.orderId, req.params.storeId]);
    if (order.rows.length === 0) return res.status(404).json({ error: 'Order not found' });

    const items = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [req.params.orderId]);
    res.json({ ...order.rows[0], items: items.rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch order' });
  }
});

// Update order status
router.patch('/stores/:storeId/orders/:orderId/status', authMiddleware(['store_owner', 'store_staff']), async (req, res) => {
  try {
    const { status, tracking_number, delivery_company, cancel_reason } = req.body;
    const validStatuses = ['pending', 'confirmed', 'preparing', 'shipped', 'delivered', 'cancelled', 'returned'];
    if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });

    let extraFields = '';
    const params = [status, req.params.orderId, req.params.storeId];

    if (status === 'shipped') {
      extraFields = ', shipped_at = NOW()';
      if (tracking_number) { params.push(tracking_number); extraFields += `, tracking_number = $${params.length}`; }
      if (delivery_company) { params.push(delivery_company); extraFields += `, delivery_company = $${params.length}`; }
    }
    if (status === 'delivered') extraFields = ', delivered_at = NOW(), payment_status = CASE WHEN payment_method = \'cod\' THEN \'paid\' ELSE payment_status END';
    if (status === 'cancelled') { extraFields = ', cancelled_at = NOW()'; if (cancel_reason) { params.push(cancel_reason); extraFields += `, cancel_reason = $${params.length}`; }}
    if (status === 'confirmed') { params.push(req.user.id); extraFields += `, confirmed_by = $${params.length}`; }
    if (status === 'preparing') { params.push(req.user.id); extraFields += `, prepared_by = $${params.length}`; }

    const result = await pool.query(
      `UPDATE orders SET status = $1, updated_at = NOW() ${extraFields} WHERE id = $2 AND store_id = $3 RETURNING *`,
      params
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update order status' });
  }
});

// Update payment status
router.patch('/stores/:storeId/orders/:orderId/payment', authMiddleware(['store_owner', 'store_staff']), async (req, res) => {
  try {
    const { payment_status } = req.body;
    const result = await pool.query(
      'UPDATE orders SET payment_status = $1, updated_at = NOW() WHERE id = $2 AND store_id = $3 RETURNING *',
      [payment_status, req.params.orderId, req.params.storeId]
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update payment status' });
  }
});

// Get abandoned carts
router.get('/stores/:storeId/abandoned-carts', authMiddleware(['store_owner']), async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM abandoned_carts WHERE store_id = $1 ORDER BY created_at DESC',
      [req.params.storeId]
    );
    const stats = await pool.query(`
      SELECT 
        COUNT(*) as total_carts,
        COUNT(CASE WHEN recovery_status = 'recovered' THEN 1 END) as recovered,
        COALESCE(SUM(CASE WHEN recovery_status = 'recovered' THEN total ELSE 0 END), 0) as recovered_revenue,
        COALESCE(SUM(CASE WHEN recovery_status = 'abandoned' THEN total ELSE 0 END), 0) as lost_revenue
      FROM abandoned_carts WHERE store_id = $1
    `, [req.params.storeId]);

    res.json({ carts: result.rows, stats: stats.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch abandoned carts' });
  }
});

// Get customers for a store
router.get('/stores/:storeId/customers', authMiddleware(['store_owner', 'store_staff']), async (req, res) => {
  try {
    const { page = 1, limit = 20, search } = req.query;
    const offset = (page - 1) * limit;
    let query = 'SELECT * FROM customers WHERE store_id = $1';
    const params = [req.params.storeId];

    if (search) { params.push(`%${search}%`); query += ` AND (name ILIKE $${params.length} OR phone ILIKE $${params.length} OR email ILIKE $${params.length})`; }
    query += ' ORDER BY created_at DESC';
    params.push(limit, offset);
    query += ` LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch customers' });
  }
});

// Shipping wilayas
router.get('/stores/:storeId/shipping-wilayas', authMiddleware(['store_owner']), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM shipping_wilayas WHERE store_id = $1 ORDER BY wilaya_name', [req.params.storeId]);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch wilayas' });
  }
});

router.post('/stores/:storeId/shipping-wilayas', authMiddleware(['store_owner']), async (req, res) => {
  try {
    const { wilaya_name, wilaya_code, desk_price, home_price, delivery_days } = req.body;
    const result = await pool.query(
      'INSERT INTO shipping_wilayas (store_id, wilaya_name, wilaya_code, desk_price, home_price, delivery_days) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [req.params.storeId, wilaya_name, wilaya_code, desk_price, home_price, delivery_days]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to add wilaya' });
  }
});

module.exports = router;
