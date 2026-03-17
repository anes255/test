const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authMiddleware } = require('../middleware/auth');
const slugify = require('slugify');

// Get all products for a store (admin)
router.get('/stores/:storeId/products', authMiddleware(['store_owner', 'store_staff']), async (req, res) => {
  try {
    const { page = 1, limit = 20, search, category, status } = req.query;
    const offset = (page - 1) * limit;
    let query = 'SELECT p.*, c.name_en as category_name FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.store_id = $1';
    const params = [req.params.storeId];

    if (search) { params.push(`%${search}%`); query += ` AND (p.name_en ILIKE $${params.length} OR p.name_fr ILIKE $${params.length} OR p.sku ILIKE $${params.length})`; }
    if (category) { params.push(category); query += ` AND p.category_id = $${params.length}`; }
    if (status === 'active') query += ' AND p.is_active = TRUE';
    if (status === 'inactive') query += ' AND p.is_active = FALSE';

    query += ' ORDER BY p.created_at DESC';
    params.push(limit, offset);
    query += ` LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const result = await pool.query(query, params);
    const count = await pool.query('SELECT COUNT(*) FROM products WHERE store_id = $1', [req.params.storeId]);

    res.json({ products: result.rows, total: parseInt(count.rows[0].count) });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// Create product
router.post('/stores/:storeId/products', authMiddleware(['store_owner', 'store_staff']), async (req, res) => {
  try {
    const { name_en, name_fr, name_ar, description_en, description_fr, description_ar,
      price, compare_at_price, cost_price, sku, barcode, stock_quantity,
      category_id, images, thumbnail, is_featured, tags, variants } = req.body;

    const slug = slugify(name_en || name_fr || 'product', { lower: true, strict: true }) + '-' + Date.now().toString(36);

    const result = await pool.query(`
      INSERT INTO products (store_id, category_id, name_en, name_fr, name_ar, slug,
        description_en, description_fr, description_ar, price, compare_at_price, cost_price,
        sku, barcode, stock_quantity, images, thumbnail, is_featured, tags, variants)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
      RETURNING *
    `, [req.params.storeId, category_id, name_en, name_fr, name_ar, slug,
        description_en, description_fr, description_ar, price, compare_at_price, cost_price,
        sku, barcode, stock_quantity || 0, images || [], thumbnail, is_featured || false, tags || [], variants || null]);

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to create product' });
  }
});

// Update product
router.put('/stores/:storeId/products/:productId', authMiddleware(['store_owner', 'store_staff']), async (req, res) => {
  try {
    const fields = req.body;
    const allowed = ['name_en','name_fr','name_ar','description_en','description_fr','description_ar',
      'price','compare_at_price','cost_price','sku','barcode','stock_quantity','category_id',
      'images','thumbnail','is_active','is_featured','tags','variants','track_inventory'];

    const updates = []; const values = []; let idx = 1;
    for (const f of allowed) {
      if (fields[f] !== undefined) { updates.push(`${f} = $${idx}`); values.push(fields[f]); idx++; }
    }
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

    updates.push('updated_at = NOW()');
    values.push(req.params.productId, req.params.storeId);

    const result = await pool.query(
      `UPDATE products SET ${updates.join(', ')} WHERE id = $${idx} AND store_id = $${idx + 1} RETURNING *`, values
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update product' });
  }
});

// Delete product
router.delete('/stores/:storeId/products/:productId', authMiddleware(['store_owner']), async (req, res) => {
  try {
    await pool.query('DELETE FROM products WHERE id = $1 AND store_id = $2', [req.params.productId, req.params.storeId]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

// ============ CATEGORIES ============
router.get('/stores/:storeId/categories', authMiddleware(['store_owner', 'store_staff']), async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT c.*, (SELECT COUNT(*) FROM products WHERE category_id = c.id) as product_count FROM categories c WHERE c.store_id = $1 ORDER BY c.sort_order',
      [req.params.storeId]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

router.post('/stores/:storeId/categories', authMiddleware(['store_owner']), async (req, res) => {
  try {
    const { name_en, name_fr, name_ar, image, parent_id } = req.body;
    const slug = slugify(name_en || name_fr || 'cat', { lower: true, strict: true });
    const result = await pool.query(
      'INSERT INTO categories (store_id, name_en, name_fr, name_ar, slug, image, parent_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [req.params.storeId, name_en, name_fr, name_ar, slug, image, parent_id]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create category' });
  }
});

// ============ COUPONS ============
router.get('/stores/:storeId/coupons', authMiddleware(['store_owner']), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM coupons WHERE store_id = $1 ORDER BY created_at DESC', [req.params.storeId]);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch coupons' });
  }
});

router.post('/stores/:storeId/coupons', authMiddleware(['store_owner']), async (req, res) => {
  try {
    const { code, type, value, min_order, max_uses, starts_at, expires_at } = req.body;
    const result = await pool.query(
      'INSERT INTO coupons (store_id, code, type, value, min_order, max_uses, starts_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [req.params.storeId, code.toUpperCase(), type, value, min_order, max_uses, starts_at, expires_at]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create coupon' });
  }
});

module.exports = router;
