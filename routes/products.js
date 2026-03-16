const express = require('express');
const pool = require('../config/db');
const { auth } = require('../middleware/auth');
const router = express.Router();

// Get all products for a store
router.get('/store/:storeId', auth, async (req, res) => {
  try {
    const { page = 1, limit = 20, category, search, sort = 'created_at', order = 'DESC' } = req.query;
    const offset = (page - 1) * limit;
    let query = 'SELECT p.*, c.name as category_name FROM products p LEFT JOIN categories c ON p.category_id = c.id WHERE p.store_id = $1';
    const params = [req.params.storeId];
    
    if (category) { params.push(category); query += ` AND p.category_id = $${params.length}`; }
    if (search) { params.push(`%${search}%`); query += ` AND (p.name ILIKE $${params.length} OR p.sku ILIKE $${params.length})`; }
    
    const allowedSort = ['created_at', 'price', 'name', 'stock_quantity', 'total_sold'];
    const sortField = allowedSort.includes(sort) ? sort : 'created_at';
    query += ` ORDER BY p.${sortField} ${order === 'ASC' ? 'ASC' : 'DESC'}`;
    params.push(limit, offset);
    query += ` LIMIT $${params.length - 1} OFFSET $${params.length}`;
    
    const result = await pool.query(query, params);
    const count = await pool.query('SELECT COUNT(*) FROM products WHERE store_id = $1', [req.params.storeId]);
    res.json({ products: result.rows, total: parseInt(count.rows[0].count) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// Create product
router.post('/store/:storeId', auth, async (req, res) => {
  try {
    const { name, slug, description, price, compare_price, cost_price, sku, barcode,
      stock_quantity, category_id, images, variants, tags, is_featured, track_inventory,
      weight, seo_title, seo_description } = req.body;
    
    const productSlug = slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const result = await pool.query(
      `INSERT INTO products (store_id, name, slug, description, price, compare_price, cost_price,
        sku, barcode, stock_quantity, category_id, images, variants, tags, is_featured,
        track_inventory, weight, seo_title, seo_description)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
      [req.params.storeId, name, productSlug, description, price, compare_price, cost_price,
        sku, barcode, stock_quantity || 0, category_id, JSON.stringify(images || []),
        JSON.stringify(variants || []), tags || [], is_featured || false,
        track_inventory !== false, weight, seo_title, seo_description]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// Update product
router.put('/:id', auth, async (req, res) => {
  try {
    const fields = req.body;
    const allowed = ['name','slug','description','price','compare_price','cost_price','sku','barcode',
      'stock_quantity','category_id','images','variants','tags','is_featured','is_active',
      'track_inventory','weight','seo_title','seo_description'];
    const setClauses = [];
    const values = [];
    let idx = 1;
    for (const key of allowed) {
      if (fields[key] !== undefined) {
        const val = (key === 'images' || key === 'variants') ? JSON.stringify(fields[key]) : fields[key];
        setClauses.push(`${key} = $${idx}`);
        values.push(val);
        idx++;
      }
    }
    if (!setClauses.length) return res.status(400).json({ error: 'No fields to update.' });
    setClauses.push('updated_at = NOW()');
    values.push(req.params.id);
    const result = await pool.query(
      `UPDATE products SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`, values
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// Delete product
router.delete('/:id', auth, async (req, res) => {
  try {
    await pool.query('DELETE FROM products WHERE id = $1', [req.params.id]);
    res.json({ message: 'Product deleted.' });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// ==================== CATEGORIES ====================

router.get('/categories/store/:storeId', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM categories WHERE store_id = $1 ORDER BY sort_order', [req.params.storeId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

router.post('/categories/store/:storeId', auth, async (req, res) => {
  try {
    const { name, slug, description, image_url, parent_id } = req.body;
    const catSlug = slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const result = await pool.query(
      'INSERT INTO categories (store_id, name, slug, description, image_url, parent_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [req.params.storeId, name, catSlug, description, image_url, parent_id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

router.delete('/categories/:id', auth, async (req, res) => {
  try {
    await pool.query('DELETE FROM categories WHERE id = $1', [req.params.id]);
    res.json({ message: 'Category deleted.' });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
