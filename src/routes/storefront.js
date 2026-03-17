const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { authMiddleware, generateToken } = require('../middleware/auth');

// Get store by slug (public)
router.get('/:slug', async (req, res) => {
  try {
    const s = await pool.query('SELECT * FROM stores WHERE slug=$1 AND is_published=TRUE',[req.params.slug]);
    if (!s.rows.length) return res.status(404).json({ error:'Store not found' });
    // Get payment settings
    let pay = {};
    try { const p = await pool.query('SELECT * FROM payment_settings WHERE store_id=$1',[s.rows[0].id]); pay = p.rows[0]||{}; } catch(e){}
    // Increment visits
    try { await pool.query('UPDATE stores SET total_visits=COALESCE(total_visits,0)+1 WHERE slug=$1',[req.params.slug]); } catch(e){}

    const store = s.rows[0];
    // Map to frontend expected format
    res.json({
      id:store.id, name:store.store_name, slug:store.slug, description:store.description,
      logo:store.logo_url, favicon:store.favicon_url, meta_description:store.meta_description,
      primary_color:store.primary_color||'#7C3AED', secondary_color:store.secondary_color||'#10B981',
      accent_color:store.accent_color||'#F59E0B', bg_color:store.bg_color||'#FAFAFA', text_color:'#1F2937',
      currency:store.currency||'DZD', default_language:'en', is_live:store.is_published,
      hero_title:store.hero_title, hero_subtitle:store.hero_subtitle,
      contact_email:store.contact_email, contact_phone:store.contact_phone,
      social_facebook:store.social_facebook, social_instagram:store.social_instagram, social_tiktok:store.social_tiktok,
      whatsapp_number:store.contact_phone,
      // Payment from payment_settings
      enable_cod:pay.cod_enabled||false, enable_ccp:pay.ccp_enabled||false, ccp_account:pay.ccp_account, ccp_name:pay.ccp_name,
      enable_baridimob:pay.baridimob_enabled||false, baridimob_rip:pay.baridimob_rip,
      enable_bank_transfer:pay.bank_transfer_enabled||false, bank_name:pay.bank_name, bank_account:pay.bank_account, bank_rib:pay.bank_rib,
      shipping_default_price:400, free_shipping_threshold:null, cod_all_wilayas:true,
      // AI features — check store_apps
      ai_chatbot_enabled:false, ai_chatbot_name:'Support Bot', ai_chatbot_greeting:'Hello! How can I help?',
      footer_text:`© ${new Date().getFullYear()} ${store.store_name}. All rights reserved.`,
    });
  } catch(e) { res.status(500).json({ error:'Failed', detail:e.message }); }
});

// Products (public)
router.get('/:slug/products', async (req, res) => {
  try {
    const store = await pool.query('SELECT id FROM stores WHERE slug=$1',[req.params.slug]);
    if (!store.rows.length) return res.status(404).json({ error:'Store not found' });
    const sid = store.rows[0].id;
    const { page=1, limit=20, category, search, sort, featured } = req.query;
    const offset = (page-1)*limit;
    let q = 'SELECT * FROM products WHERE store_id=$1 AND is_active=TRUE';
    const params = [sid];
    if (category) { params.push(category); q += ` AND category_id=$${params.length}`; }
    if (search) { params.push(`%${search}%`); q += ` AND name ILIKE $${params.length}`; }
    if (featured==='true') q += ' AND is_featured=TRUE';
    if (sort==='price_asc') q += ' ORDER BY price ASC';
    else if (sort==='price_desc') q += ' ORDER BY price DESC';
    else if (sort==='popular') q += ' ORDER BY total_sold DESC NULLS LAST';
    else q += ' ORDER BY created_at DESC';
    params.push(limit, offset);
    q += ` LIMIT $${params.length-1} OFFSET $${params.length}`;
    const r = await pool.query(q, params);
    const count = await pool.query('SELECT COUNT(*) FROM products WHERE store_id=$1 AND is_active=TRUE',[sid]);
    const products = r.rows.map(p => ({
      ...p, name_en:p.name, name_fr:p.name, name_ar:p.name,
      thumbnail: Array.isArray(p.images)&&p.images.length?p.images[0]:null,
      compare_at_price: p.compare_price,
    }));
    res.json({ products, total:parseInt(count.rows[0].count) });
  } catch(e) { res.status(500).json({ error:'Failed', detail:e.message }); }
});

// Single product
router.get('/:slug/products/:productSlug', async (req, res) => {
  try {
    const store = await pool.query('SELECT id FROM stores WHERE slug=$1',[req.params.slug]);
    if (!store.rows.length) return res.status(404).json({ error:'Store not found' });
    const r = await pool.query('SELECT * FROM products WHERE store_id=$1 AND slug=$2 AND is_active=TRUE',[store.rows[0].id, req.params.productSlug]);
    if (!r.rows.length) return res.status(404).json({ error:'Product not found' });
    const p = r.rows[0];
    res.json({ ...p, name_en:p.name, name_fr:p.name, name_ar:p.name, description_en:p.description, description_fr:p.description, description_ar:p.description,
      thumbnail:Array.isArray(p.images)&&p.images.length?p.images[0]:null, compare_at_price:p.compare_price, reviews:[] });
  } catch(e) { res.status(500).json({ error:'Failed', detail:e.message }); }
});

// Categories
router.get('/:slug/categories', async (req, res) => {
  try {
    const store = await pool.query('SELECT id FROM stores WHERE slug=$1',[req.params.slug]);
    if (!store.rows.length) return res.status(404).json({ error:'Store not found' });
    const r = await pool.query('SELECT * FROM categories WHERE store_id=$1 AND is_active=TRUE ORDER BY sort_order',[store.rows[0].id]);
    res.json(r.rows.map(c => ({ ...c, name_en:c.name, name_fr:c.name, name_ar:c.name })));
  } catch(e) { res.json([]); }
});

// Customer register (per store)
router.post('/:slug/customers/register', async (req, res) => {
  try {
    const store = await pool.query('SELECT id FROM stores WHERE slug=$1',[req.params.slug]);
    if (!store.rows.length) return res.status(404).json({ error:'Store not found' });
    const { name, email, phone, password, address, city, wilaya } = req.body;
    if (!name || !phone || !password) return res.status(400).json({ error:'Name, phone and password required' });
    const dup = await pool.query('SELECT id FROM customers WHERE store_id=$1 AND phone=$2',[store.rows[0].id, phone]);
    if (dup.rows.length) return res.status(409).json({ error:'Phone already registered' });
    const hash = await bcrypt.hash(password, 12);
    const r = await pool.query('INSERT INTO customers (store_id,full_name,email,phone,password_hash,address,city,wilaya) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,full_name,email,phone,created_at',
      [store.rows[0].id, name, email||null, phone, hash, address||null, city||null, wilaya||null]);
    const c = r.rows[0];
    const token = generateToken({ id:c.id, role:'customer', storeId:store.rows[0].id, name:c.full_name });
    res.status(201).json({ token, customer:{ id:c.id, name:c.full_name, email:c.email, phone:c.phone }});
  } catch(e) { res.status(500).json({ error:'Registration failed', detail:e.message }); }
});

// Customer login
router.post('/:slug/customers/login', async (req, res) => {
  try {
    const store = await pool.query('SELECT id FROM stores WHERE slug=$1',[req.params.slug]);
    if (!store.rows.length) return res.status(404).json({ error:'Store not found' });
    const { phone, password } = req.body;
    const c = await pool.query('SELECT * FROM customers WHERE store_id=$1 AND phone=$2',[store.rows[0].id, phone]);
    if (!c.rows.length) return res.status(401).json({ error:'Invalid credentials' });
    if (!(await bcrypt.compare(password, c.rows[0].password_hash))) return res.status(401).json({ error:'Invalid credentials' });
    const cust = c.rows[0];
    const token = generateToken({ id:cust.id, role:'customer', storeId:store.rows[0].id, name:cust.full_name });
    res.json({ token, customer:{ id:cust.id, name:cust.full_name, email:cust.email, phone:cust.phone }});
  } catch(e) { res.status(500).json({ error:'Login failed', detail:e.message }); }
});

// Customer profile
router.get('/:slug/customers/profile', authMiddleware(['customer']), async (req, res) => {
  try {
    const c = await pool.query('SELECT * FROM customers WHERE id=$1',[req.user.id]);
    if (!c.rows.length) return res.status(404).json({ error:'Not found' });
    const orders = await pool.query('SELECT * FROM orders WHERE customer_id=$1 ORDER BY created_at DESC',[req.user.id]);
    const cust = c.rows[0];
    res.json({ ...cust, name:cust.full_name, orders:orders.rows.map(o=>({...o, order_number:'ORD-'+String(o.order_number).padStart(5,'0'), discount_amount:o.discount })) });
  } catch(e) { res.status(500).json({ error:'Failed', detail:e.message }); }
});

// Checkout — place order
router.post('/:slug/orders', async (req, res) => {
  try {
    const store = await pool.query('SELECT * FROM stores WHERE slug=$1',[req.params.slug]);
    if (!store.rows.length) return res.status(404).json({ error:'Store not found' });
    const sid = store.rows[0].id;
    // Get payment settings
    let pay = {};
    try { pay = (await pool.query('SELECT * FROM payment_settings WHERE store_id=$1',[sid])).rows[0]||{}; } catch(e){}

    const { items, customer_name, customer_phone, customer_email, shipping_address, shipping_city, shipping_wilaya, shipping_zip, payment_method, notes, customer_id } = req.body;
    if (!items || !items.length) return res.status(400).json({ error:'Cart is empty' });
    if (!customer_name || !customer_phone || !shipping_address) return res.status(400).json({ error:'Name, phone and address required' });

    // Validate payment
    const validMethods = ['cod'];
    if (pay.ccp_enabled) validMethods.push('ccp');
    if (pay.baridimob_enabled) validMethods.push('baridimob');
    if (pay.bank_transfer_enabled) validMethods.push('bank_transfer');
    if (payment_method && !validMethods.includes(payment_method)) return res.status(400).json({ error:'Invalid payment method' });

    // Calculate
    let subtotal = 0;
    const orderItems = [];
    for (const item of items) {
      const p = await pool.query('SELECT * FROM products WHERE id=$1 AND store_id=$2',[item.product_id, sid]);
      if (!p.rows.length) continue;
      const prod = p.rows[0];
      const itemTotal = prod.price * item.quantity;
      subtotal += itemTotal;
      orderItems.push({ product_id:prod.id, product_name:prod.name, product_image:Array.isArray(prod.images)&&prod.images[0]||null, variant_info:item.variant||null, quantity:item.quantity, unit_price:prod.price, total_price:itemTotal });
    }

    const shippingCost = 400; // default
    const total = subtotal + shippingCost;

    // Generate order number (get max + 1)
    const maxNum = await pool.query('SELECT COALESCE(MAX(order_number),0)+1 as next FROM orders WHERE store_id=$1',[sid]);
    const orderNumber = maxNum.rows[0].next;

    const order = await pool.query(`INSERT INTO orders (store_id,customer_id,order_number,customer_name,customer_phone,customer_email,shipping_address,shipping_city,shipping_wilaya,shipping_zip,subtotal,shipping_cost,discount,total,payment_method,notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [sid, customer_id||null, orderNumber, customer_name, customer_phone, customer_email||null, shipping_address, shipping_city||null, shipping_wilaya||null, shipping_zip||null, subtotal, shippingCost, 0, total, payment_method||'cod', notes||null]);

    for (const item of orderItems) {
      await pool.query('INSERT INTO order_items (order_id,product_id,product_name,product_image,variant_info,quantity,unit_price,total_price) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [order.rows[0].id, item.product_id, item.product_name, item.product_image, item.variant_info, item.quantity, item.unit_price, item.total_price]);
    }

    // Update customer stats
    if (customer_id) {
      try { await pool.query('UPDATE customers SET total_orders=COALESCE(total_orders,0)+1, total_spent=COALESCE(total_spent,0)+$1 WHERE id=$2',[total, customer_id]); } catch(e){}
    }

    const o = order.rows[0];
    res.status(201).json({ ...o, order_number:'ORD-'+String(o.order_number).padStart(5,'0') });
  } catch(e) { console.error(e); res.status(500).json({ error:'Order failed', detail:e.message }); }
});

// Validate coupon (stub)
router.post('/:slug/validate-coupon', async (req,res) => { res.status(404).json({ error:'No coupons available' }); });

// Store pages
router.get('/:slug/pages', async (req, res) => {
  try {
    const store = await pool.query('SELECT id FROM stores WHERE slug=$1',[req.params.slug]);
    if (!store.rows.length) return res.status(404).json({ error:'Store not found' });
    res.json((await pool.query('SELECT * FROM store_pages WHERE store_id=$1 AND is_published=TRUE',[store.rows[0].id])).rows);
  } catch(e) { res.json([]); }
});

module.exports = router;
