const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authMiddleware } = require('../middleware/auth');
const slugify = require('slugify');

// Get products
router.get('/stores/:storeId/products', authMiddleware(['store_owner','store_staff']), async (req, res) => {
  try {
    const { page=1, limit=20, search, category, status } = req.query;
    const offset = (page-1)*limit;
    let q = 'SELECT p.*, c.name as category_name FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE p.store_id=$1';
    const params = [req.params.storeId];
    if (search) { params.push(`%${search}%`); q += ` AND (p.name ILIKE $${params.length} OR p.sku ILIKE $${params.length})`; }
    if (category) { params.push(category); q += ` AND p.category_id=$${params.length}`; }
    if (status==='active') q += ' AND p.is_active=TRUE';
    if (status==='inactive') q += ' AND p.is_active=FALSE';
    q += ' ORDER BY p.created_at DESC';
    params.push(limit, offset);
    q += ` LIMIT $${params.length-1} OFFSET $${params.length}`;
    const r = await pool.query(q, params);
    const count = await pool.query('SELECT COUNT(*) FROM products WHERE store_id=$1',[req.params.storeId]);
    const products = r.rows.map(p => {
      let imgs = p.images;
      if (typeof imgs === 'string') try { imgs = JSON.parse(imgs); } catch(e) { imgs = []; }
      if (!Array.isArray(imgs)) imgs = [];
      return { ...p, name_en:p.name, name_fr:p.name, name_ar:p.name, images:imgs, thumbnail:imgs[0]||null, compare_at_price:p.compare_price };
    });
    res.json({ products, total: parseInt(count.rows[0].count) });
  } catch(e) { console.error(e); res.status(500).json({ error:'Failed', detail:e.message }); }
});

// Create product
router.post('/stores/:storeId/products', authMiddleware(['store_owner','store_staff']), async (req, res) => {
  try {
    const { name_en, description_en, price, compare_at_price, cost_price, sku, barcode, stock_quantity, category_id, images, is_featured, tags, variants } = req.body;
    const name = name_en || 'Product';
    const slug = slugify(name, { lower:true, strict:true }) + '-' + Date.now().toString(36);
    let imgJson = Array.isArray(images) ? images : [];

    const r = await pool.query(`
      INSERT INTO products (store_id, category_id, name, slug, description, price, compare_price, cost_price, sku, barcode, stock_quantity, images, is_featured, tags, variants)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15::jsonb) RETURNING *`,
      [req.params.storeId, category_id||null, name, slug, description_en||null, price, compare_at_price||null, cost_price||null, sku||null, barcode||null, stock_quantity||0, JSON.stringify(imgJson), is_featured||false, tags||[], variants?JSON.stringify(variants):null]);
    const p = r.rows[0];
    res.status(201).json({ ...p, name_en:p.name, thumbnail:imgJson[0]||null, compare_at_price:p.compare_price });
  } catch(e) { console.error(e); res.status(500).json({ error:'Failed to create product', detail:e.message }); }
});

// Update product
router.put('/stores/:storeId/products/:productId', authMiddleware(['store_owner','store_staff']), async (req, res) => {
  try {
    const f = req.body;
    const updates=[], values=[];
    let idx=1;

    // Simple field mapping
    const simpleFields = { name_en:'name', description_en:'description', price:'price', compare_at_price:'compare_price',
      cost_price:'cost_price', sku:'sku', barcode:'barcode', stock_quantity:'stock_quantity',
      category_id:'category_id', is_active:'is_active', is_featured:'is_featured', track_inventory:'track_inventory' };

    for (const [key,col] of Object.entries(simpleFields)) {
      if (f[key] !== undefined) { updates.push(`${col}=$${idx}`); values.push(f[key]); idx++; }
    }

    // Handle images separately — cast to jsonb
    if (f.images !== undefined) {
      let imgs = Array.isArray(f.images) ? f.images : [];
      updates.push(`images=$${idx}::jsonb`);
      values.push(JSON.stringify(imgs));
      idx++;
    }

    // Handle tags
    if (f.tags !== undefined) {
      updates.push(`tags=$${idx}`);
      values.push(f.tags || []);
      idx++;
    }

    // Handle variants
    if (f.variants !== undefined) {
      updates.push(`variants=$${idx}::jsonb`);
      values.push(f.variants ? JSON.stringify(f.variants) : null);
      idx++;
    }

    if (!updates.length) return res.status(400).json({ error:'Nothing to update' });

    values.push(req.params.productId, req.params.storeId);
    const r = await pool.query(`UPDATE products SET ${updates.join(',')}, updated_at=NOW() WHERE id=$${idx} AND store_id=$${idx+1} RETURNING *`, values);
    if (!r.rows.length) return res.status(404).json({ error:'Product not found' });
    const p = r.rows[0];
    let imgs = p.images;
    if (typeof imgs === 'string') try { imgs = JSON.parse(imgs); } catch(e) { imgs = []; }
    if (!Array.isArray(imgs)) imgs = [];
    res.json({ ...p, name_en:p.name, images:imgs, thumbnail:imgs[0]||null, compare_at_price:p.compare_price });
  } catch(e) { console.error(e); res.status(500).json({ error:'Update failed', detail:e.message }); }
});

// Delete product
router.delete('/stores/:storeId/products/:productId', authMiddleware(['store_owner']), async (req, res) => {
  try { await pool.query('DELETE FROM products WHERE id=$1 AND store_id=$2',[req.params.productId,req.params.storeId]); res.json({success:true}); }
  catch(e) { res.status(500).json({ error:'Failed', detail:e.message }); }
});

// Categories
router.get('/stores/:storeId/categories', authMiddleware(['store_owner','store_staff']), async (req, res) => {
  try {
    const r = await pool.query('SELECT c.*, (SELECT COUNT(*) FROM products WHERE category_id=c.id) as product_count FROM categories c WHERE c.store_id=$1 ORDER BY c.sort_order',[req.params.storeId]);
    res.json(r.rows.map(c => ({ ...c, name_en:c.name, name_fr:c.name, name_ar:c.name, image:c.image_url })));
  } catch(e) { res.json([]); }
});

router.post('/stores/:storeId/categories', authMiddleware(['store_owner']), async (req, res) => {
  try {
    const { name_en, image, parent_id, description } = req.body;
    const name = name_en || 'Category';
    const slug = slugify(name, {lower:true,strict:true}) + '-' + Date.now().toString(36);
    const r = await pool.query('INSERT INTO categories (store_id,name,slug,description,image_url,parent_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [req.params.storeId, name, slug, description||null, image||null, parent_id||null]);
    res.status(201).json({ ...r.rows[0], name_en:r.rows[0].name });
  } catch(e) { res.status(500).json({ error:'Failed', detail:e.message }); }
});

// Coupons stub
router.get('/stores/:storeId/coupons', authMiddleware(['store_owner']), async (req,res) => res.json([]));
router.post('/stores/:storeId/coupons', authMiddleware(['store_owner']), async (req,res) => res.json({message:'Coming soon'}));

// ============ STORE APPS ============
router.get('/stores/:storeId/apps', authMiddleware(['store_owner']), async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM store_apps WHERE store_id=$1',[req.params.storeId]);
    res.json(r.rows);
  } catch(e) { res.json([]); }
});

router.post('/stores/:storeId/apps/install', authMiddleware(['store_owner']), async (req, res) => {
  try {
    const { app_name, app_slug } = req.body;
    // Check if already installed
    const existing = await pool.query('SELECT id FROM store_apps WHERE store_id=$1 AND app_slug=$2',[req.params.storeId, app_slug]);
    if (existing.rows.length) {
      // Toggle active
      const r = await pool.query('UPDATE store_apps SET is_active=NOT is_active WHERE store_id=$1 AND app_slug=$2 RETURNING *',[req.params.storeId, app_slug]);
      return res.json(r.rows[0]);
    }
    const r = await pool.query('INSERT INTO store_apps (store_id,app_name,app_slug,is_active) VALUES ($1,$2,$3,TRUE) RETURNING *',[req.params.storeId, app_name, app_slug]);
    res.status(201).json(r.rows[0]);
  } catch(e) { res.status(500).json({ error:'Failed', detail:e.message }); }
});

module.exports = router;
