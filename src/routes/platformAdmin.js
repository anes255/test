const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authMiddleware, generateToken } = require('../middleware/auth');

// Login — env-based (no platform_admins table)
router.post('/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    if (phone !== (process.env.PLATFORM_ADMIN_PHONE||'0661573805') || password !== (process.env.PLATFORM_ADMIN_PASSWORD||'admin123'))
      return res.status(401).json({ error:'Invalid credentials' });
    const token = generateToken({ id:'admin', role:'platform_admin', name:'Super Admin' });
    res.json({ token, admin:{ id:'admin', name:'Super Admin', role:'super_admin' }});
  } catch(e) { res.status(500).json({ error:'Login failed' }); }
});

// Settings — platform_settings columns: site_name, primary_color, secondary_color, accent_color, subscription_monthly_price, subscription_yearly_price, subscription_trial_days, currency, logo_url, favicon_url, meta_description, maintenance_mode
router.get('/settings', authMiddleware(['platform_admin']), async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM platform_settings LIMIT 1');
    if (!r.rows.length) return res.json({ site_name:'KyoMarket' });
    const s = r.rows[0];
    res.json({ ...s, site_logo:s.logo_url, favicon:s.favicon_url, trial_days:s.subscription_trial_days });
  } catch(e) { res.json({ site_name:'KyoMarket' }); }
});

router.put('/settings', authMiddleware(['platform_admin']), async (req, res) => {
  try {
    const f = req.body;
    const fieldMap = { site_name:'site_name', primary_color:'primary_color', secondary_color:'secondary_color', accent_color:'accent_color',
      subscription_monthly_price:'subscription_monthly_price', subscription_yearly_price:'subscription_yearly_price',
      trial_days:'subscription_trial_days', subscription_trial_days:'subscription_trial_days',
      currency:'currency', site_logo:'logo_url', logo_url:'logo_url', favicon:'favicon_url', favicon_url:'favicon_url',
      meta_description:'meta_description', maintenance_mode:'maintenance_mode' };
    const updates=[], values=[];
    let idx=1;
    for (const [key,val] of Object.entries(f)) {
      const col = fieldMap[key]; if (!col) continue;
      updates.push(`${col}=$${idx}`); values.push(val); idx++;
    }
    if (!updates.length) return res.json({});
    const r = await pool.query(`UPDATE platform_settings SET ${updates.join(',')}, updated_at=NOW() WHERE id=(SELECT id FROM platform_settings LIMIT 1) RETURNING *`, values);
    const s = r.rows[0]||{};
    res.json({ ...s, site_logo:s.logo_url, favicon:s.favicon_url, trial_days:s.subscription_trial_days });
  } catch(e) { res.status(500).json({ error:'Failed', detail:e.message }); }
});

// Store owners
router.get('/store-owners', authMiddleware(['platform_admin']), async (req, res) => {
  try {
    const { page=1, limit=20, search } = req.query;
    const offset = (page-1)*limit;
    let q = 'SELECT * FROM store_owners';
    const params = [];
    if (search) { params.push(`%${search}%`); q += ` WHERE (full_name ILIKE $1 OR email ILIKE $1 OR phone ILIKE $1)`; }
    q += ' ORDER BY created_at DESC';
    params.push(limit,offset);
    q += ` LIMIT $${params.length-1} OFFSET $${params.length}`;
    const r = await pool.query(q, params);
    const count = await pool.query('SELECT COUNT(*) FROM store_owners');
    res.json({ owners:r.rows.map(o=>({...o, name:o.full_name})), total:parseInt(count.rows[0].count), page:parseInt(page) });
  } catch(e) { res.status(500).json({ error:'Failed', detail:e.message }); }
});

router.patch('/store-owners/:id/toggle', authMiddleware(['platform_admin']), async (req, res) => {
  try { const r = await pool.query('UPDATE store_owners SET is_active=NOT is_active, updated_at=NOW() WHERE id=$1 RETURNING *',[req.params.id]); res.json({...r.rows[0],name:r.rows[0].full_name}); }
  catch(e) { res.status(500).json({ error:'Failed' }); }
});

// Stores
router.get('/stores', authMiddleware(['platform_admin']), async (req, res) => {
  try {
    const r = await pool.query('SELECT s.*, so.full_name as owner_name, so.email as owner_email FROM stores s LEFT JOIN store_owners so ON so.id=s.owner_id ORDER BY s.created_at DESC');
    res.json(r.rows.map(s => ({ ...s, name:s.store_name, is_live:s.is_published })));
  } catch(e) { res.status(500).json({ error:'Failed' }); }
});

// Dashboard
router.get('/dashboard', authMiddleware(['platform_admin']), async (req, res) => {
  try {
    let totalOwners=0, totalStores=0, totalOrders=0, totalRevenue=0, recentOrders=[], recentStores=[];
    try { totalOwners=parseInt((await pool.query('SELECT COUNT(*) FROM store_owners')).rows[0].count); } catch(e){}
    try { totalStores=parseInt((await pool.query('SELECT COUNT(*) FROM stores')).rows[0].count); } catch(e){}
    try { totalOrders=parseInt((await pool.query('SELECT COUNT(*) FROM orders')).rows[0].count); } catch(e){}
    try { totalRevenue=parseFloat((await pool.query("SELECT COALESCE(SUM(total),0) as t FROM orders WHERE payment_status='paid'")).rows[0].t); } catch(e){}
    try { recentOrders=(await pool.query("SELECT o.*, s.store_name as store_name FROM orders o LEFT JOIN stores s ON s.id=o.store_id ORDER BY o.created_at DESC LIMIT 10")).rows.map(o=>({...o,order_number:'ORD-'+String(o.order_number).padStart(5,'0')})); } catch(e){}
    try { recentStores=(await pool.query("SELECT s.*, so.full_name as owner_name FROM stores s LEFT JOIN store_owners so ON so.id=s.owner_id ORDER BY s.created_at DESC LIMIT 5")).rows.map(s=>({...s,name:s.store_name,is_live:s.is_published})); } catch(e){}
    res.json({ stats:{totalOwners,totalStores,totalOrders,totalRevenue}, recentOrders, recentStores });
  } catch(e) { res.status(500).json({ error:'Failed' }); }
});

module.exports = router;
