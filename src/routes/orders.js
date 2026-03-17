const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authMiddleware } = require('../middleware/auth');

// Get orders
router.get('/stores/:storeId/orders', authMiddleware(['store_owner','store_staff']), async (req, res) => {
  try {
    const { page=1, limit=20, status, search, payment_status } = req.query;
    const offset = (page-1)*limit;
    let q = 'SELECT * FROM orders WHERE store_id=$1';
    const params = [req.params.storeId];
    if (status && status!=='all') { params.push(status); q += ` AND status=$${params.length}`; }
    if (payment_status) { params.push(payment_status); q += ` AND payment_status=$${params.length}`; }
    if (search) { params.push(`%${search}%`); q += ` AND (customer_name ILIKE $${params.length} OR customer_phone ILIKE $${params.length} OR CAST(order_number AS TEXT) ILIKE $${params.length})`; }
    const countQ = q.replace('SELECT *','SELECT COUNT(*)');
    q += ' ORDER BY created_at DESC';
    params.push(limit, offset);
    q += ` LIMIT $${params.length-1} OFFSET $${params.length}`;
    const [r, c] = await Promise.all([pool.query(q,params), pool.query(countQ, params.slice(0,-2))]);
    // Map order_number int to string for frontend
    const orders = r.rows.map(o => ({ ...o, order_number: 'ORD-'+String(o.order_number).padStart(5,'0'), discount_amount: o.discount }));
    res.json({ orders, total: parseInt(c.rows[0].count) });
  } catch(e) { console.error(e); res.status(500).json({ error:'Failed', detail:e.message }); }
});

// Single order with items
router.get('/stores/:storeId/orders/:orderId', authMiddleware(['store_owner','store_staff']), async (req, res) => {
  try {
    const o = await pool.query('SELECT * FROM orders WHERE id=$1 AND store_id=$2',[req.params.orderId, req.params.storeId]);
    if (!o.rows.length) return res.status(404).json({ error:'Not found' });
    const items = await pool.query('SELECT * FROM order_items WHERE order_id=$1',[req.params.orderId]);
    const order = o.rows[0];
    res.json({ ...order, order_number:'ORD-'+String(order.order_number).padStart(5,'0'), discount_amount:order.discount, items:items.rows });
  } catch(e) { res.status(500).json({ error:'Failed', detail:e.message }); }
});

// Update order status
router.patch('/stores/:storeId/orders/:orderId/status', authMiddleware(['store_owner','store_staff']), async (req, res) => {
  try {
    const { status, cancel_reason } = req.body;
    const valid = ['pending','confirmed','preparing','shipped','delivered','cancelled','returned'];
    if (!valid.includes(status)) return res.status(400).json({ error:'Invalid status' });

    let extra = '';
    const params = [status, req.params.orderId, req.params.storeId];
    if (status==='shipped') extra = ', shipped_at=NOW()';
    if (status==='delivered') extra = ", delivered_at=NOW(), payment_status=CASE WHEN payment_method='cod' THEN 'paid' ELSE payment_status END";
    if (status==='cancelled') { extra = ', cancelled_at=NOW()'; if(cancel_reason){params.push(cancel_reason);extra+=`, cancel_reason=$${params.length}`;}}
    if (status==='confirmed') { params.push(req.user.id); extra+=`, confirmed_by=$${params.length}`; }
    if (status==='preparing') { params.push(req.user.id); extra+=`, prepared_by=$${params.length}`; }

    const r = await pool.query(`UPDATE orders SET status=$1, updated_at=NOW() ${extra} WHERE id=$2 AND store_id=$3 RETURNING *`, params);
    if (!r.rows.length) return res.status(404).json({ error:'Not found' });
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error:'Failed', detail:e.message }); }
});

// Update payment status
router.patch('/stores/:storeId/orders/:orderId/payment', authMiddleware(['store_owner','store_staff']), async (req, res) => {
  try {
    const r = await pool.query('UPDATE orders SET payment_status=$1, updated_at=NOW() WHERE id=$2 AND store_id=$3 RETURNING *',[req.body.payment_status, req.params.orderId, req.params.storeId]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error:'Failed', detail:e.message }); }
});

// Abandoned carts (uses 'carts' table with is_abandoned)
router.get('/stores/:storeId/abandoned-carts', authMiddleware(['store_owner']), async (req, res) => {
  try {
    const carts = await pool.query('SELECT * FROM carts WHERE store_id=$1 AND is_abandoned=TRUE ORDER BY created_at DESC',[req.params.storeId]);
    const stats = await pool.query(`SELECT
      COUNT(*) as total_carts,
      COUNT(CASE WHEN is_recovered=TRUE THEN 1 END) as recovered,
      COALESCE(SUM(CASE WHEN is_recovered=TRUE THEN total ELSE 0 END),0) as recovered_revenue,
      COALESCE(SUM(CASE WHEN is_recovered=FALSE OR is_recovered IS NULL THEN total ELSE 0 END),0) as lost_revenue
      FROM carts WHERE store_id=$1 AND is_abandoned=TRUE`,[req.params.storeId]);
    res.json({ carts:carts.rows, stats:stats.rows[0] });
  } catch(e) { res.json({ carts:[], stats:{ total_carts:0, recovered:0, recovered_revenue:0, lost_revenue:0 }}); }
});

// Customers
router.get('/stores/:storeId/customers', authMiddleware(['store_owner','store_staff']), async (req, res) => {
  try {
    const { page=1, limit=20, search } = req.query;
    const offset = (page-1)*limit;
    let q = 'SELECT * FROM customers WHERE store_id=$1';
    const params = [req.params.storeId];
    if (search) { params.push(`%${search}%`); q += ` AND (full_name ILIKE $${params.length} OR phone ILIKE $${params.length} OR email ILIKE $${params.length})`; }
    q += ' ORDER BY created_at DESC';
    params.push(limit, offset);
    q += ` LIMIT $${params.length-1} OFFSET $${params.length}`;
    const r = await pool.query(q, params);
    res.json(r.rows.map(c => ({ ...c, name:c.full_name })));
  } catch(e) { res.json([]); }
});

// Shipping wilayas
router.get('/stores/:storeId/shipping-wilayas', authMiddleware(['store_owner']), async (req, res) => {
  try { res.json((await pool.query('SELECT * FROM shipping_wilayas WHERE store_id=$1 ORDER BY wilaya_name',[req.params.storeId])).rows); }
  catch(e) { res.json([]); }
});
router.post('/stores/:storeId/shipping-wilayas', authMiddleware(['store_owner']), async (req, res) => {
  try {
    const { wilaya_name, wilaya_code, desk_delivery_price, home_delivery_price, delivery_days } = req.body;
    const r = await pool.query('INSERT INTO shipping_wilayas (store_id,wilaya_name,wilaya_code,desk_delivery_price,home_delivery_price,delivery_days) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [req.params.storeId, wilaya_name, wilaya_code, desk_delivery_price, home_delivery_price, delivery_days||3]);
    res.status(201).json(r.rows[0]);
  } catch(e) { res.status(500).json({ error:'Failed', detail:e.message }); }
});

module.exports = router;
