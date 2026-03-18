const express=require('express'),router=express.Router(),pool=require('../config/db'),{authMiddleware,generateToken}=require('../middleware/auth');

// Login (env-based, no platform_admins table)
router.post('/login',(req,res)=>{
  const{phone,password}=req.body;
  if(phone!==(process.env.PLATFORM_ADMIN_PHONE||'0661573805')||password!==(process.env.PLATFORM_ADMIN_PASSWORD||'admin123'))return res.status(401).json({error:'Invalid credentials'});
  const token=generateToken({id:'admin',role:'platform_admin',name:'Super Admin'});
  res.json({token,admin:{id:'admin',name:'Super Admin',role:'super_admin'}});
});

// Settings
router.get('/settings',authMiddleware(['platform_admin']),async(req,res)=>{try{const r=await pool.query('SELECT * FROM platform_settings LIMIT 1');const s=r.rows[0]||{};res.json({...s,site_logo:s.logo_url,favicon:s.favicon_url,trial_days:s.subscription_trial_days});}catch(e){res.json({site_name:'KyoMarket'});}});

router.put('/settings',authMiddleware(['platform_admin']),async(req,res)=>{try{const f=req.body;const map={site_name:'site_name',primary_color:'primary_color',secondary_color:'secondary_color',accent_color:'accent_color',subscription_monthly_price:'subscription_monthly_price',subscription_yearly_price:'subscription_yearly_price',trial_days:'subscription_trial_days',site_logo:'logo_url',favicon:'favicon_url',meta_description:'meta_description',maintenance_mode:'maintenance_mode',currency:'currency'};const u=[],v=[];let i=1;for(const[k,val]of Object.entries(f)){const col=map[k];if(!col)continue;u.push(`${col}=$${i}`);v.push(val);i++;}if(!u.length)return res.json({});const r=await pool.query(`UPDATE platform_settings SET ${u.join(',')},updated_at=NOW() WHERE id=(SELECT id FROM platform_settings LIMIT 1) RETURNING *`,v);const s=r.rows[0]||{};res.json({...s,site_logo:s.logo_url,favicon:s.favicon_url,trial_days:s.subscription_trial_days});}catch(e){res.status(500).json({error:e.message});}});

// Store owners
router.get('/store-owners',authMiddleware(['platform_admin']),async(req,res)=>{try{const{search}=req.query;let q='SELECT * FROM store_owners';const p=[];if(search){p.push(`%${search}%`);q+=' WHERE (full_name ILIKE $1 OR email ILIKE $1 OR phone ILIKE $1)';}q+=' ORDER BY created_at DESC';const r=await pool.query(q,p);const c=await pool.query('SELECT COUNT(*) FROM store_owners');res.json({owners:r.rows.map(o=>({...o,name:o.full_name})),total:parseInt(c.rows[0].count)});}catch(e){res.status(500).json({error:e.message});}});

router.patch('/store-owners/:id/toggle',authMiddleware(['platform_admin']),async(req,res)=>{try{const r=await pool.query('UPDATE store_owners SET is_active=NOT is_active,updated_at=NOW() WHERE id=$1 RETURNING *',[req.params.id]);res.json({...r.rows[0],name:r.rows[0].full_name});}catch(e){res.status(500).json({error:e.message});}});

// Stores
router.get('/stores',authMiddleware(['platform_admin']),async(req,res)=>{try{const r=await pool.query('SELECT s.*,so.full_name as owner_name FROM stores s LEFT JOIN store_owners so ON so.id=s.owner_id ORDER BY s.created_at DESC');res.json(r.rows.map(s=>({...s,name:s.store_name,is_live:s.is_published})));}catch(e){res.status(500).json({error:e.message});}});

// Dashboard
router.get('/dashboard',authMiddleware(['platform_admin']),async(req,res)=>{try{let to=0,ts=0,tord=0,tr=0,ro=[],rs=[];try{to=parseInt((await pool.query('SELECT COUNT(*) FROM store_owners')).rows[0].count);}catch(e){}try{ts=parseInt((await pool.query('SELECT COUNT(*) FROM stores')).rows[0].count);}catch(e){}try{tord=parseInt((await pool.query('SELECT COUNT(*) FROM orders')).rows[0].count);}catch(e){}try{tr=parseFloat((await pool.query("SELECT COALESCE(SUM(total),0) as t FROM orders WHERE payment_status='paid'")).rows[0].t);}catch(e){}try{ro=(await pool.query("SELECT o.*,s.store_name as store_name FROM orders o LEFT JOIN stores s ON s.id=o.store_id ORDER BY o.created_at DESC LIMIT 10")).rows.map(o=>({...o,order_number:'ORD-'+String(o.order_number).padStart(5,'0')}));}catch(e){}try{rs=(await pool.query("SELECT s.*,so.full_name as owner_name FROM stores s LEFT JOIN store_owners so ON so.id=s.owner_id ORDER BY s.created_at DESC LIMIT 5")).rows.map(s=>({...s,name:s.store_name,is_live:s.is_published}));}catch(e){}res.json({stats:{totalOwners:to,totalStores:ts,totalOrders:tord,totalRevenue:tr},recentOrders:ro,recentStores:rs});}catch(e){res.status(500).json({error:e.message});}});

module.exports=router;
