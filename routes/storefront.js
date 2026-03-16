const express = require('express');
const pool = require('../config/db');
const router = express.Router();

// Get store by slug (public)
router.get('/store/:slug', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, store_name, slug, description, logo_url, primary_color, secondary_color,
        accent_color, bg_color, currency, hero_title, hero_subtitle, contact_email,
        contact_phone, contact_address, social_facebook, social_instagram, social_tiktok, is_published
       FROM stores WHERE slug = $1 AND is_active = true`,
      [req.params.slug]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Store not found.' });
    
    // Increment visit counter
    await pool.query('UPDATE stores SET total_visits = total_visits + 1 WHERE slug = $1', [req.params.slug]);
    
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// Get products for a store (public)
router.get('/store/:slug/products', async (req, res) => {
  try {
    const store = await pool.query('SELECT id FROM stores WHERE slug = $1', [req.params.slug]);
    if (store.rows.length === 0) return res.status(404).json({ error: 'Store not found.' });
    const storeId = store.rows[0].id;
    
    const { category, search, page = 1, limit = 20, sort } = req.query;
    const offset = (page - 1) * limit;
    let query = 'SELECT * FROM products WHERE store_id = $1 AND is_active = true';
    const params = [storeId];
    
    if (category) { params.push(category); query += ` AND category_id = $${params.length}`; }
    if (search) { params.push(`%${search}%`); query += ` AND (name ILIKE $${params.length} OR description ILIKE $${params.length})`; }
    
    if (sort === 'price_asc') query += ' ORDER BY price ASC';
    else if (sort === 'price_desc') query += ' ORDER BY price DESC';
    else if (sort === 'newest') query += ' ORDER BY created_at DESC';
    else if (sort === 'popular') query += ' ORDER BY total_sold DESC';
    else query += ' ORDER BY created_at DESC';
    
    params.push(limit, offset);
    query += ` LIMIT $${params.length - 1} OFFSET $${params.length}`;
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// Get single product (public)
router.get('/product/:slug/:productSlug', async (req, res) => {
  try {
    const store = await pool.query('SELECT id FROM stores WHERE slug = $1', [req.params.slug]);
    if (store.rows.length === 0) return res.status(404).json({ error: 'Store not found.' });
    const result = await pool.query(
      'SELECT * FROM products WHERE store_id = $1 AND slug = $2 AND is_active = true',
      [store.rows[0].id, req.params.productSlug]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Product not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// Get categories (public)
router.get('/store/:slug/categories', async (req, res) => {
  try {
    const store = await pool.query('SELECT id FROM stores WHERE slug = $1', [req.params.slug]);
    if (store.rows.length === 0) return res.status(404).json({ error: 'Store not found.' });
    const result = await pool.query(
      'SELECT * FROM categories WHERE store_id = $1 AND is_active = true ORDER BY sort_order',
      [store.rows[0].id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// Place order (public)
router.post('/store/:slug/order', async (req, res) => {
  try {
    const store = await pool.query('SELECT id, currency FROM stores WHERE slug = $1', [req.params.slug]);
    if (store.rows.length === 0) return res.status(404).json({ error: 'Store not found.' });
    const storeId = store.rows[0].id;
    
    const { customer_name, customer_phone, customer_email, shipping_address,
      shipping_city, shipping_wilaya, shipping_zip, items, payment_method,
      shipping_cost, notes, customer_id, save_info } = req.body;
    
    if (!customer_name || !customer_phone || !shipping_address || !items?.length) {
      return res.status(400).json({ error: 'Required fields missing.' });
    }
    
    let subtotal = 0;
    const orderItems = [];
    
    for (const item of items) {
      const product = await pool.query('SELECT * FROM products WHERE id = $1', [item.product_id]);
      if (product.rows.length === 0) continue;
      const p = product.rows[0];
      const itemTotal = p.price * item.quantity;
      subtotal += itemTotal;
      orderItems.push({
        product_id: p.id,
        product_name: p.name,
        product_image: Array.isArray(p.images) ? p.images[0] : null,
        variant_info: item.variant_info || null,
        quantity: item.quantity,
        unit_price: p.price,
        total_price: itemTotal
      });
    }
    
    const total = subtotal + (shipping_cost || 0);
    
    const order = await pool.query(
      `INSERT INTO orders (store_id, customer_id, customer_name, customer_phone, customer_email,
        shipping_address, shipping_city, shipping_wilaya, shipping_zip, subtotal, shipping_cost,
        total, payment_method, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [storeId, customer_id, customer_name, customer_phone, customer_email,
        shipping_address, shipping_city, shipping_wilaya, shipping_zip,
        subtotal, shipping_cost || 0, total, payment_method || 'cod', notes]
    );
    
    for (const item of orderItems) {
      await pool.query(
        `INSERT INTO order_items (order_id, product_id, product_name, product_image, variant_info, quantity, unit_price, total_price)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [order.rows[0].id, item.product_id, item.product_name, item.product_image,
         JSON.stringify(item.variant_info), item.quantity, item.unit_price, item.total_price]
      );
      // Update stock
      await pool.query(
        'UPDATE products SET stock_quantity = stock_quantity - $1, total_sold = total_sold + $1 WHERE id = $2',
        [item.quantity, item.product_id]
      );
    }
    
    // Update customer stats if logged in
    if (customer_id) {
      await pool.query(
        'UPDATE customers SET total_orders = total_orders + 1, total_spent = total_spent + $1 WHERE id = $2',
        [total, customer_id]
      );
    }
    
    res.status(201).json(order.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// Get payment methods for store (public)
router.get('/store/:slug/payment-methods', async (req, res) => {
  try {
    const store = await pool.query('SELECT id FROM stores WHERE slug = $1', [req.params.slug]);
    if (store.rows.length === 0) return res.status(404).json({ error: 'Store not found.' });
    const result = await pool.query('SELECT * FROM payment_settings WHERE store_id = $1', [store.rows[0].id]);
    res.json(result.rows[0] || {});
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// Get shipping rates (public)
router.get('/store/:slug/shipping', async (req, res) => {
  try {
    const store = await pool.query('SELECT id FROM stores WHERE slug = $1', [req.params.slug]);
    if (store.rows.length === 0) return res.status(404).json({ error: 'Store not found.' });
    const result = await pool.query(
      'SELECT * FROM shipping_wilayas WHERE store_id = $1 AND is_active = true ORDER BY wilaya_code',
      [store.rows[0].id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// Store pages (public)
router.get('/store/:slug/pages', async (req, res) => {
  try {
    const store = await pool.query('SELECT id FROM stores WHERE slug = $1', [req.params.slug]);
    if (store.rows.length === 0) return res.status(404).json({ error: 'Store not found.' });
    const result = await pool.query(
      'SELECT * FROM store_pages WHERE store_id = $1 AND is_published = true ORDER BY sort_order',
      [store.rows[0].id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// AI Chatbot endpoint
router.post('/store/:slug/chat', async (req, res) => {
  try {
    const store = await pool.query('SELECT * FROM stores WHERE slug = $1', [req.params.slug]);
    if (store.rows.length === 0) return res.status(404).json({ error: 'Store not found.' });
    const storeData = store.rows[0];
    const { message, session_id } = req.body;
    
    // Save user message
    await pool.query(
      'INSERT INTO chatbot_messages (store_id, session_id, role, message) VALUES ($1,$2,$3,$4)',
      [storeData.id, session_id, 'user', message]
    );
    
    // Simple AI-like response logic
    const lowerMsg = message.toLowerCase();
    let reply = '';
    
    if (lowerMsg.includes('shipping') || lowerMsg.includes('delivery') || lowerMsg.includes('livraison')) {
      const wilayas = await pool.query('SELECT COUNT(*) FROM shipping_wilayas WHERE store_id = $1 AND is_active = true', [storeData.id]);
      reply = `We deliver to ${wilayas.rows[0].count} wilayas across Algeria! Shipping rates vary by location. You can see the full rates during checkout. Is there anything else I can help with?`;
    } else if (lowerMsg.includes('price') || lowerMsg.includes('cost') || lowerMsg.includes('prix')) {
      reply = `Our products range in price. You can browse all products on our store page and filter by category. Would you like me to help you find something specific?`;
    } else if (lowerMsg.includes('contact') || lowerMsg.includes('phone') || lowerMsg.includes('email')) {
      reply = `You can reach us at:\n📧 ${storeData.contact_email || 'N/A'}\n📞 ${storeData.contact_phone || 'N/A'}\n📍 ${storeData.contact_address || 'N/A'}`;
    } else if (lowerMsg.includes('best') || lowerMsg.includes('popular') || lowerMsg.includes('recommend')) {
      const products = await pool.query('SELECT name, price FROM products WHERE store_id = $1 AND is_active = true ORDER BY total_sold DESC LIMIT 3', [storeData.id]);
      if (products.rows.length) {
        reply = `Here are our top sellers:\n${products.rows.map((p, i) => `${i + 1}. ${p.name} - ${p.price} ${storeData.currency}`).join('\n')}`;
      } else {
        reply = `Check out our latest products on the store page! We're adding new items regularly.`;
      }
    } else if (lowerMsg.includes('hello') || lowerMsg.includes('hi') || lowerMsg.includes('bonjour') || lowerMsg.includes('سلام')) {
      reply = `Hello! Welcome to ${storeData.store_name}! 🎉 How can I assist you today? I can help with shipping rates, product info, or contact details.`;
    } else if (lowerMsg.includes('return') || lowerMsg.includes('refund')) {
      reply = `For returns and refunds, please contact us directly. We're happy to help resolve any issues with your order!`;
    } else if (lowerMsg.includes('order') || lowerMsg.includes('track')) {
      reply = `To track your order, please check your profile page if you're logged in. You can also contact us with your order number for updates!`;
    } else {
      reply = `Thank you for your message! I'm the AI assistant for ${storeData.store_name}. I can help you with:\n• Shipping rates\n• Product information\n• Contact info\n• Best sellers\n\nHow can I assist you?`;
    }
    
    // Save bot response
    await pool.query(
      'INSERT INTO chatbot_messages (store_id, session_id, role, message) VALUES ($1,$2,$3,$4)',
      [storeData.id, session_id, 'assistant', reply]
    );
    
    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
