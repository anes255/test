const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { authMiddleware, generateToken } = require('../middleware/auth');
const slugify = require('slugify');

// Debug
router.get('/test', (req, res) => res.json({ status: 'ok' }));

// Register
router.post('/register', async (req, res) => {
  try {
    const { name, email, phone, password, address, city, wilaya } = req.body;
    if (!name || !email || !phone || !password) return res.status(400).json({ error: 'All fields required' });

    const dup = await pool.query('SELECT id FROM store_owners WHERE email=$1 OR phone=$2', [email, phone]);
    if (dup.rows.length > 0) return res.status(409).json({ error: 'Email or phone already registered' });

    const hash = await bcrypt.hash(password, 12);
    const r = await pool.query(
      `INSERT INTO store_owners (full_name,email,phone,password_hash,address,city,wilaya) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [name, email, phone, hash, address||null, city||null, wilaya||null]
    );
    const o = r.rows[0];
    const token = generateToken({ id: o.id, role: 'store_owner', name: o.full_name });
    res.status(201).json({ token, owner: { id:o.id, name:o.full_name, email:o.email, phone:o.phone, subscription_plan:o.subscription_plan, subscription_end:o.subscription_end }});
  } catch (e) { console.error(e); res.status(500).json({ error:'Registration failed', detail:e.message }); }
});

// Login (email or phone)
router.post('/login', async (req, res) => {
  try {
    const { identifier, password } = req.body;
    if (!identifier || !password) return res.status(400).json({ error: 'Credentials required' });

    let r = await pool.query('SELECT * FROM store_owners WHERE email=$1', [identifier]);
    if (!r.rows.length) r = await pool.query('SELECT * FROM store_owners WHERE phone=$1', [identifier]);
    if (!r.rows.length) return res.status(401).json({ error: 'Invalid credentials' });

    const o = r.rows[0];
    if (o.is_active === false) return res.status(403).json({ error: 'Account suspended' });
    if (!(await bcrypt.compare(password, o.password_hash))) return res.status(401).json({ error: 'Invalid credentials' });

    const token = generateToken({ id: o.id, role: 'store_owner', name: o.full_name });
    const stores = await pool.query('SELECT * FROM stores WHERE owner_id=$1', [o.id]);

    res.json({ token, owner: { id:o.id, name:o.full_name, email:o.email, phone:o.phone, subscription_plan:o.subscription_plan, subscription_end:o.subscription_end }, stores: stores.rows });
  } catch (e) { console.error(e); res.status(500).json({ error:'Login failed', detail:e.message }); }
});

// Create store
router.post('/stores', authMiddleware(['store_owner']), async (req, res) => {
  try {
    const { name, description } = req.body;
    const slug = slugify(name, { lower:true, strict:true }) + '-' + Date.now().toString(36);
    const r = await pool.query(
      `INSERT INTO stores (owner_id, store_name, slug, description, is_published, is_active) VALUES ($1,$2,$3,$4,TRUE,TRUE) RETURNING *`,
      [req.user.id, name, slug, description||null]
    );
    // Also create payment_settings for this store
    try { await pool.query('INSERT INTO payment_settings (store_id, cod_enabled) VALUES ($1, true)', [r.rows[0].id]); } catch(e) {}
    res.status(201).json(r.rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error:'Failed to create store', detail:e.message }); }
});

// Get stores
router.get('/stores', authMiddleware(['store_owner']), async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT s.*,
        (SELECT COUNT(*) FROM products WHERE store_id=s.id) as product_count,
        (SELECT COUNT(*) FROM orders WHERE store_id=s.id) as order_count,
        (SELECT COALESCE(SUM(total),0) FROM orders WHERE store_id=s.id AND payment_status='paid') as revenue
      FROM stores s WHERE s.owner_id=$1 ORDER BY s.created_at DESC`, [req.user.id]);
    // Map store_name -> name for frontend
    res.json(r.rows.map(s => ({ ...s, name: s.store_name, is_live: s.is_published, logo: s.logo_url })));
  } catch (e) { res.status(500).json({ error:'Failed', detail:e.message }); }
});

// Store dashboard
router.get('/stores/:storeId/dashboard', authMiddleware(['store_owner']), async (req, res) => {
  try {
    const sid = req.params.storeId;
    const store = await pool.query('SELECT * FROM stores WHERE id=$1 AND owner_id=$2', [sid, req.user.id]);
    if (!store.rows.length) return res.status(404).json({ error:'Store not found' });
    const s = store.rows[0];

    let totalOrders=0, totalRevenue=0, totalProducts=0, totalCustomers=0, recentOrders=[], salesData=[];
    try { totalOrders = parseInt((await pool.query('SELECT COUNT(*) FROM orders WHERE store_id=$1',[sid])).rows[0].count); } catch(e){}
    try { totalRevenue = parseFloat((await pool.query("SELECT COALESCE(SUM(total),0) as t FROM orders WHERE store_id=$1 AND payment_status='paid'",[sid])).rows[0].t); } catch(e){}
    try { totalProducts = parseInt((await pool.query('SELECT COUNT(*) FROM products WHERE store_id=$1',[sid])).rows[0].count); } catch(e){}
    try { totalCustomers = parseInt((await pool.query('SELECT COUNT(*) FROM customers WHERE store_id=$1',[sid])).rows[0].count); } catch(e){}
    try { recentOrders = (await pool.query('SELECT * FROM orders WHERE store_id=$1 ORDER BY created_at DESC LIMIT 10',[sid])).rows; } catch(e){}
    try { salesData = (await pool.query("SELECT DATE(created_at) as date, COUNT(*) as orders, COALESCE(SUM(total),0) as revenue FROM orders WHERE store_id=$1 AND created_at > NOW()-INTERVAL '30 days' GROUP BY DATE(created_at) ORDER BY date",[sid])).rows; } catch(e){}

    res.json({
      store: { ...s, name: s.store_name, is_live: s.is_published, logo: s.logo_url, store_visits: s.total_visits },
      stats: { totalOrders, totalRevenue, totalProducts, totalCustomers, storeVisits: s.total_visits||0, avgOrderValue: totalOrders>0?(totalRevenue/totalOrders).toFixed(2):0 },
      recentOrders, salesData
    });
  } catch (e) { res.status(500).json({ error:'Failed', detail:e.message }); }
});

// Update store
router.put('/stores/:storeId', authMiddleware(['store_owner']), async (req, res) => {
  try {
    const sid = req.params.storeId;
    const own = await pool.query('SELECT id FROM stores WHERE id=$1 AND owner_id=$2', [sid, req.user.id]);
    if (!own.rows.length) return res.status(404).json({ error:'Not found' });

    const f = req.body;
    // Map frontend field names to DB column names
    const fieldMap = {
      name:'store_name', store_name:'store_name', description:'description',
      logo:'logo_url', logo_url:'logo_url', favicon:'favicon_url', favicon_url:'favicon_url',
      primary_color:'primary_color', secondary_color:'secondary_color', accent_color:'accent_color', bg_color:'bg_color',
      currency:'currency', is_live:'is_published', is_published:'is_published',
      meta_title:'meta_title', meta_description:'meta_description',
      hero_title:'hero_title', hero_subtitle:'hero_subtitle',
      contact_email:'contact_email', contact_phone:'contact_phone', contact_address:'contact_address',
      social_facebook:'social_facebook', social_instagram:'social_instagram', social_tiktok:'social_tiktok',
    };

    const updates=[], values=[];
    let idx=1;
    for (const [key, val] of Object.entries(f)) {
      const col = fieldMap[key];
      if (!col) continue;
      updates.push(`${col}=$${idx}`);
      values.push(val);
      idx++;
    }
    if (!updates.length) return res.status(400).json({ error:'Nothing to update' });
    values.push(sid);
    const r = await pool.query(`UPDATE stores SET ${updates.join(',')}, updated_at=NOW() WHERE id=$${idx} RETURNING *`, values);
    const s = r.rows[0];

    // Also update payment_settings if payment fields present
    const payFields = { enable_cod:'cod_enabled', enable_ccp:'ccp_enabled', ccp_account:'ccp_account', ccp_name:'ccp_name',
      enable_baridimob:'baridimob_enabled', baridimob_rip:'baridimob_rip', enable_bank_transfer:'bank_transfer_enabled',
      bank_name:'bank_name', bank_account:'bank_account', bank_rib:'bank_rib' };
    const payUpdates=[], payValues=[];
    let pidx=1;
    for (const [key, val] of Object.entries(f)) {
      const col = payFields[key];
      if (!col) continue;
      payUpdates.push(`${col}=$${pidx}`);
      payValues.push(val);
      pidx++;
    }
    if (payUpdates.length) {
      payValues.push(sid);
      try { await pool.query(`UPDATE payment_settings SET ${payUpdates.join(',')}, updated_at=NOW() WHERE store_id=$${pidx}`, payValues); } catch(e) {}
    }

    res.json({ ...s, name: s.store_name, is_live: s.is_published, logo: s.logo_url });
  } catch (e) { res.status(500).json({ error:'Failed', detail:e.message }); }
});

// Staff
router.get('/stores/:storeId/staff', authMiddleware(['store_owner']), async (req, res) => {
  try { res.json((await pool.query('SELECT id,name,email,phone,role,is_active,created_at FROM store_staff WHERE store_id=$1 ORDER BY created_at',[req.params.storeId])).rows); } catch(e) { res.json([]); }
});
router.post('/stores/:storeId/staff', authMiddleware(['store_owner']), async (req, res) => {
  try {
    const {name,email,phone,password,role}=req.body;
    const hash = await bcrypt.hash(password,12);
    const r = await pool.query('INSERT INTO store_staff (store_id,name,email,phone,password_hash,role) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,name,email,phone,role,created_at',[req.params.storeId,name,email,phone,hash,role]);
    res.status(201).json(r.rows[0]);
  } catch(e) { res.status(500).json({ error:'Failed', detail:e.message }); }
});
router.post('/staff/login', async (req, res) => {
  try {
    const {storeSlug,email,password}=req.body;
    const store = await pool.query('SELECT id FROM stores WHERE slug=$1',[storeSlug]);
    if (!store.rows.length) return res.status(404).json({ error:'Store not found' });
    const staff = await pool.query('SELECT * FROM store_staff WHERE store_id=$1 AND email=$2 AND is_active=TRUE',[store.rows[0].id,email]);
    if (!staff.rows.length) return res.status(401).json({ error:'Invalid credentials' });
    if (!(await bcrypt.compare(password,staff.rows[0].password_hash))) return res.status(401).json({ error:'Invalid credentials' });
    const token = generateToken({id:staff.rows[0].id,role:'store_staff',staffRole:staff.rows[0].role,storeId:store.rows[0].id,name:staff.rows[0].name});
    res.json({token,staff:{id:staff.rows[0].id,name:staff.rows[0].name,role:staff.rows[0].role}});
  } catch(e) { res.status(500).json({ error:'Failed', detail:e.message }); }
});

// Domains (table doesn't exist — return empty)
router.get('/stores/:storeId/domains', authMiddleware(['store_owner']), async (req,res) => { res.json([]); });
router.post('/stores/:storeId/domains', authMiddleware(['store_owner']), async (req,res) => { res.json({ message:'Domain feature coming soon' }); });

// Profile
router.get('/profile', authMiddleware(['store_owner']), async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM store_owners WHERE id=$1',[req.user.id]);
    if (!r.rows.length) return res.status(404).json({ error:'Not found' });
    const o = r.rows[0];
    res.json({ ...o, name: o.full_name });
  } catch(e) { res.status(500).json({ error:'Failed', detail:e.message }); }
});

module.exports = router;
