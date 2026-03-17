const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { authMiddleware, generateToken } = require('../middleware/auth');

// Get store by slug (public)
router.get('/:slug', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, slug, custom_domain, logo, favicon, description, meta_description,
        primary_color, secondary_color, accent_color, bg_color, text_color, font_family,
        header_style, footer_text, social_facebook, social_instagram, social_tiktok,
        whatsapp_number, currency, default_language, supported_languages, is_live,
        enable_cod, enable_ccp, enable_baridimob, enable_bank_transfer,
        shipping_default_price, free_shipping_threshold, cod_all_wilayas,
        ai_chatbot_enabled, ai_chatbot_name, ai_chatbot_greeting
      FROM stores WHERE slug = $1 AND is_live = TRUE
    `, [req.params.slug]);

    if (result.rows.length === 0) return res.status(404).json({ error: 'Store not found' });

    // Increment visits
    await pool.query('UPDATE stores SET store_visits = store_visits + 1 WHERE slug = $1', [req.params.slug]);

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch store' });
  }
});

// Get store products (public)
router.get('/:slug/products', async (req, res) => {
  try {
    const store = await pool.query('SELECT id FROM stores WHERE slug = $1', [req.params.slug]);
    if (store.rows.length === 0) return res.status(404).json({ error: 'Store not found' });

    const { page = 1, limit = 20, category, search, sort, featured } = req.query;
    const offset = (page - 1) * limit;
    const storeId = store.rows[0].id;

    let query = 'SELECT * FROM products WHERE store_id = $1 AND is_active = TRUE';
    const params = [storeId];

    if (category) { params.push(category); query += ` AND category_id = $${params.length}`; }
    if (search) { params.push(`%${search}%`); query += ` AND (name_en ILIKE $${params.length} OR name_fr ILIKE $${params.length} OR name_ar ILIKE $${params.length})`; }
    if (featured === 'true') query += ' AND is_featured = TRUE';

    if (sort === 'price_asc') query += ' ORDER BY price ASC';
    else if (sort === 'price_desc') query += ' ORDER BY price DESC';
    else if (sort === 'newest') query += ' ORDER BY created_at DESC';
    else if (sort === 'popular') query += ' ORDER BY views DESC';
    else query += ' ORDER BY created_at DESC';

    params.push(limit, offset);
    query += ` LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const result = await pool.query(query, params);
    const count = await pool.query('SELECT COUNT(*) FROM products WHERE store_id = $1 AND is_active = TRUE', [storeId]);

    res.json({ products: result.rows, total: parseInt(count.rows[0].count) });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// Get single product (public)
router.get('/:slug/products/:productSlug', async (req, res) => {
  try {
    const store = await pool.query('SELECT id FROM stores WHERE slug = $1', [req.params.slug]);
    if (store.rows.length === 0) return res.status(404).json({ error: 'Store not found' });

    const result = await pool.query(
      'SELECT * FROM products WHERE store_id = $1 AND slug = $2 AND is_active = TRUE',
      [store.rows[0].id, req.params.productSlug]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Product not found' });

    // Increment views
    await pool.query('UPDATE products SET views = views + 1 WHERE id = $1', [result.rows[0].id]);

    // Get reviews
    const reviews = await pool.query(
      'SELECT r.*, c.name as customer_name FROM reviews r LEFT JOIN customers c ON c.id = r.customer_id WHERE r.product_id = $1 AND r.is_approved = TRUE ORDER BY r.created_at DESC',
      [result.rows[0].id]
    );

    res.json({ ...result.rows[0], reviews: reviews.rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch product' });
  }
});

// Get categories (public)
router.get('/:slug/categories', async (req, res) => {
  try {
    const store = await pool.query('SELECT id FROM stores WHERE slug = $1', [req.params.slug]);
    if (store.rows.length === 0) return res.status(404).json({ error: 'Store not found' });

    const result = await pool.query(
      'SELECT * FROM categories WHERE store_id = $1 AND is_active = TRUE ORDER BY sort_order',
      [store.rows[0].id]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

// ============ CUSTOMER AUTH ============
router.post('/:slug/customers/register', async (req, res) => {
  try {
    const store = await pool.query('SELECT id FROM stores WHERE slug = $1', [req.params.slug]);
    if (store.rows.length === 0) return res.status(404).json({ error: 'Store not found' });

    const { name, email, phone, password, address, city, wilaya } = req.body;
    if (!name || !phone || !password) return res.status(400).json({ error: 'Name, phone and password required' });

    const existing = await pool.query('SELECT id FROM customers WHERE store_id = $1 AND phone = $2', [store.rows[0].id, phone]);
    if (existing.rows.length > 0) return res.status(409).json({ error: 'Phone already registered for this store' });

    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      'INSERT INTO customers (store_id, name, email, phone, password_hash, address, city, wilaya) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, name, email, phone, created_at',
      [store.rows[0].id, name, email, phone, hash, address, city, wilaya]
    );

    const token = generateToken({ id: result.rows[0].id, role: 'customer', storeId: store.rows[0].id, name });
    res.status(201).json({ token, customer: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

router.post('/:slug/customers/login', async (req, res) => {
  try {
    const store = await pool.query('SELECT id FROM stores WHERE slug = $1', [req.params.slug]);
    if (store.rows.length === 0) return res.status(404).json({ error: 'Store not found' });

    const { phone, password } = req.body;
    const customer = await pool.query('SELECT * FROM customers WHERE store_id = $1 AND phone = $2', [store.rows[0].id, phone]);
    if (customer.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, customer.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = generateToken({ id: customer.rows[0].id, role: 'customer', storeId: store.rows[0].id, name: customer.rows[0].name });
    res.json({ token, customer: { id: customer.rows[0].id, name: customer.rows[0].name, email: customer.rows[0].email, phone: customer.rows[0].phone }});
  } catch (error) {
    res.status(500).json({ error: 'Login failed' });
  }
});

// Customer profile with orders
router.get('/:slug/customers/profile', authMiddleware(['customer']), async (req, res) => {
  try {
    const customer = await pool.query(
      'SELECT id, name, email, phone, address, city, wilaya, total_orders, total_spent, created_at FROM customers WHERE id = $1',
      [req.user.id]
    );
    const orders = await pool.query(
      'SELECT * FROM orders WHERE customer_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json({ ...customer.rows[0], orders: orders.rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// ============ CHECKOUT ============
router.post('/:slug/orders', async (req, res) => {
  try {
    const store = await pool.query('SELECT * FROM stores WHERE slug = $1', [req.params.slug]);
    if (store.rows.length === 0) return res.status(404).json({ error: 'Store not found' });
    const storeData = store.rows[0];

    const { items, customer_name, customer_phone, customer_email,
      shipping_address, shipping_city, shipping_wilaya, shipping_zip,
      payment_method, notes, coupon_code, customer_id } = req.body;

    if (!items || items.length === 0) return res.status(400).json({ error: 'Cart is empty' });

    // Validate payment method
    const validMethods = [];
    if (storeData.enable_cod) validMethods.push('cod');
    if (storeData.enable_ccp) validMethods.push('ccp');
    if (storeData.enable_baridimob) validMethods.push('baridimob');
    if (storeData.enable_bank_transfer) validMethods.push('bank_transfer');

    if (!validMethods.includes(payment_method)) {
      return res.status(400).json({ error: 'Invalid payment method' });
    }

    // Calculate totals
    let subtotal = 0;
    const orderItems = [];
    for (const item of items) {
      const product = await pool.query('SELECT * FROM products WHERE id = $1 AND store_id = $2', [item.product_id, storeData.id]);
      if (product.rows.length === 0) continue;
      const p = product.rows[0];
      const itemTotal = p.price * item.quantity;
      subtotal += itemTotal;
      orderItems.push({
        product_id: p.id, product_name: p.name_en || p.name_fr, product_image: p.thumbnail,
        variant: item.variant, quantity: item.quantity, unit_price: p.price, total_price: itemTotal
      });
    }

    // Shipping cost
    let shippingCost = parseFloat(storeData.shipping_default_price) || 0;
    if (shipping_wilaya) {
      const wilayaRate = await pool.query(
        'SELECT * FROM shipping_wilayas WHERE store_id = $1 AND wilaya_name = $2',
        [storeData.id, shipping_wilaya]
      );
      if (wilayaRate.rows.length > 0) shippingCost = parseFloat(wilayaRate.rows[0].home_price) || shippingCost;
    }
    if (storeData.free_shipping_threshold && subtotal >= storeData.free_shipping_threshold) shippingCost = 0;

    // Coupon
    let discount = 0;
    if (coupon_code) {
      const coupon = await pool.query(
        "SELECT * FROM coupons WHERE store_id = $1 AND code = $2 AND is_active = TRUE AND (expires_at IS NULL OR expires_at > NOW()) AND (max_uses IS NULL OR used_count < max_uses)",
        [storeData.id, coupon_code.toUpperCase()]
      );
      if (coupon.rows.length > 0) {
        const c = coupon.rows[0];
        if (!c.min_order || subtotal >= c.min_order) {
          discount = c.type === 'percentage' ? (subtotal * c.value / 100) : c.value;
          await pool.query('UPDATE coupons SET used_count = used_count + 1 WHERE id = $1', [c.id]);
        }
      }
    }

    const total = subtotal + shippingCost - discount;
    const orderNumber = 'ORD-' + Date.now().toString(36).toUpperCase();

    const order = await pool.query(`
      INSERT INTO orders (store_id, customer_id, order_number, payment_method, subtotal, shipping_cost,
        discount_amount, total, customer_name, customer_phone, customer_email,
        shipping_address, shipping_city, shipping_wilaya, shipping_zip, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *
    `, [storeData.id, customer_id, orderNumber, payment_method, subtotal, shippingCost,
        discount, total, customer_name, customer_phone, customer_email,
        shipping_address, shipping_city, shipping_wilaya, shipping_zip, notes]);

    // Insert order items
    for (const item of orderItems) {
      await pool.query(
        'INSERT INTO order_items (order_id, product_id, product_name, product_image, variant, quantity, unit_price, total_price) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [order.rows[0].id, item.product_id, item.product_name, item.product_image, item.variant, item.quantity, item.unit_price, item.total_price]
      );
    }

    // Update customer stats
    if (customer_id) {
      await pool.query(
        'UPDATE customers SET total_orders = total_orders + 1, total_spent = total_spent + $1 WHERE id = $2',
        [total, customer_id]
      );
    }

    res.status(201).json(order.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

// Validate coupon
router.post('/:slug/validate-coupon', async (req, res) => {
  try {
    const store = await pool.query('SELECT id FROM stores WHERE slug = $1', [req.params.slug]);
    if (store.rows.length === 0) return res.status(404).json({ error: 'Store not found' });

    const { code, subtotal } = req.body;
    const coupon = await pool.query(
      "SELECT * FROM coupons WHERE store_id = $1 AND code = $2 AND is_active = TRUE AND (expires_at IS NULL OR expires_at > NOW())",
      [store.rows[0].id, code.toUpperCase()]
    );

    if (coupon.rows.length === 0) return res.status(404).json({ error: 'Invalid coupon' });
    const c = coupon.rows[0];
    if (c.max_uses && c.used_count >= c.max_uses) return res.status(400).json({ error: 'Coupon expired' });
    if (c.min_order && subtotal < c.min_order) return res.status(400).json({ error: `Minimum order: ${c.min_order} ${store.rows[0].currency || 'DZD'}` });

    const discount = c.type === 'percentage' ? (subtotal * c.value / 100) : c.value;
    res.json({ valid: true, discount, type: c.type, value: c.value });
  } catch (error) {
    res.status(500).json({ error: 'Validation failed' });
  }
});

// Get store pages (public)
router.get('/:slug/pages', async (req, res) => {
  try {
    const store = await pool.query('SELECT id FROM stores WHERE slug = $1', [req.params.slug]);
    if (store.rows.length === 0) return res.status(404).json({ error: 'Store not found' });
    const result = await pool.query('SELECT * FROM store_pages WHERE store_id = $1 AND is_published = TRUE', [store.rows[0].id]);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch pages' });
  }
});

module.exports = router;
