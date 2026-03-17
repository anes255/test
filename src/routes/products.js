const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authMiddleware } = require('../middleware/auth');
const slugify = require('slugify');

// ============ PRODUCTS ============
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
    // Map for frontend: images jsonb -> thumbnail
    const products = r.rows.map(p => ({
      ...p,
      name_en: p.name, name_fr: p.name, name_ar: p.name,
      thumbnail: Array.isArray(p.images) && p.images.length > 0 ? p.images[0] : (p.images?.url || null),
      compare_at_price: p.compare_price,
    }));
    res.json({ products, total: parseInt(count.rows[0].count) });
  } catch(e) { res.status(500).json({ error:'Failed', detail:e.message }); }
});

router.post('/stores/:storeId/products', authMiddleware(['store_owner','store_staff']), async (req, res) => {
  try {
    const { name_en, name_fr, name_ar, description_en, price, compare_at_price, cost_price, sku, barcode, stock_quantity, category_id, images, thumbnail, is_featured, tags, variants } = req.body;
    const name = name_en || name_fr || name_ar || 'Product';
    const slug = slugify(name, { lower:true, strict:true }) + '-' + Date.now().toString(36);
    // images: frontend sends array of URLs or thumbnail, store as jsonb array
    let imgJson = [];
    if (images && Array.isArray(images)) imgJson = images;
    else if (thumbnail) imgJson = [thumbnail];

    const r = await pool.query(`
      INSERT INTO products (store_id, category_id, name, slug, description, price, compare_price, cost_price, sku, barcode, stock_quantity, images, is_featured, tags, variants)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [req.params.storeId, category_id||null, name, slug, description_en||null, price, compare_at_price||null, cost_price||null, sku||null, barcode||null, stock_quantity||0, JSON.stringify(imgJson), is_featured||false, tags||[], variants?JSON.stringify(variants):null]);
    const p = r.rows[0];
    res.status(201).json({ ...p, name_en:p.name, thumbnail: Array.isArray(p.images)&&p.images[0]||null, compare_at_price:p.compare_price });
  } catch(e) { console.error(e); res.status(500).json({ error:'Failed to create product', detail:e.message }); }
});

router.put('/stores/:storeId/products/:productId', authMiddleware(['store_owner','store_staff']), async (req, res) => {
  try {
    const f = req.body;
    const fieldMap = { name_en:'name', name_fr:'name', name_ar:'name', description_en:'description', price:'price',
      compare_at_price:'compare_price', cost_price:'cost_price', sku:'sku', barcode:'barcode',
      stock_quantity:'stock_quantity', category_id:'category_id', is_active:'is_active', is_featured:'is_featured',
      tags:'tags', variants:'variants', track_inventory:'track_inventory' };
    const updates=[], values=[];
    let idx=1;
    for (const [key,val] of Object.entries(f)) {
      const col = fieldMap[key];
      if (!col) continue;
      updates.push(`${col}=$${idx}`);
      values.push(col==='variants'?JSON.stringify(val):val);
      idx++;
    }
    // Handle images/thumbnail
    if (f.thumbnail || f.images) {
      let imgs = f.images || (f.thumbnail ? [f.thumbnail] : []);
      updates.push(`images=$${idx}`);
      values.push(JSON.stringify(imgs));
      idx++;
    }
    if (!updates.length) return res.status(400).json({ error:'Nothing to update' });
    values.push(req.params.productId, req.params.storeId);
    const r = await pool.query(`UPDATE products SET ${updates.join(',')}, updated_at=NOW() WHERE id=$${idx} AND store_id=$${idx+1} RETURNING *`, values);
    const p = r.rows[0];
    res.json({ ...p, name_en:p.name, thumbnail:Array.isArray(p.images)&&p.images[0]||null, compare_at_price:p.compare_price });
  } catch(e) { res.status(500).json({ error:'Failed', detail:e.message }); }
});

router.delete('/stores/:storeId/products/:productId', authMiddleware(['store_owner']), async (req, res) => {
  try { await pool.query('DELETE FROM products WHERE id=$1 AND store_id=$2',[req.params.productId,req.params.storeId]); res.json({success:true}); }
  catch(e) { res.status(500).json({ error:'Failed', detail:e.message }); }
});

// ============ CATEGORIES ============
router.get('/stores/:storeId/categories', authMiddleware(['store_owner','store_staff']), async (req, res) => {
  try {
    const r = await pool.query('SELECT c.*, (SELECT COUNT(*) FROM products WHERE category_id=c.id) as product_count FROM categories c WHERE c.store_id=$1 ORDER BY c.sort_order',[req.params.storeId]);
    // Map for frontend
    res.json(r.rows.map(c => ({ ...c, name_en:c.name, name_fr:c.name, name_ar:c.name, image:c.image_url })));
  } catch(e) { res.json([]); }
});

router.post('/stores/:storeId/categories', authMiddleware(['store_owner']), async (req, res) => {
  try {
    const { name_en, name_fr, name_ar, image, parent_id, description } = req.body;
    const name = name_en || name_fr || name_ar || 'Category';
    const slug = slugify(name, { lower:true, strict:true }) + '-' + Date.now().toString(36);
    const r = await pool.query('INSERT INTO categories (store_id,name,slug,description,image_url,parent_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [req.params.storeId, name, slug, description||null, image||null, parent_id||null]);
    const c = r.rows[0];
    res.status(201).json({ ...c, name_en:c.name, image:c.image_url });
  } catch(e) { res.status(500).json({ error:'Failed', detail:e.message }); }
});

// ============ COUPONS (table doesn't exist — stub) ============
router.get('/stores/:storeId/coupons', authMiddleware(['store_owner']), async (req,res) => { res.json([]); });
router.post('/stores/:storeId/coupons', authMiddleware(['store_owner']), async (req,res) => { res.json({ message:'Coupons feature coming soon' }); });

module.exports = router;
