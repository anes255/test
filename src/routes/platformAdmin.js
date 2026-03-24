const express=require('express'),router=express.Router(),pool=require('../config/db'),{authMiddleware,generateToken}=require('../middleware/auth'),bcrypt=require('bcryptjs');

// Login
router.post('/login',(req,res)=>{
  const{phone,password}=req.body;
  if(phone!==(process.env.PLATFORM_ADMIN_PHONE||'000000000')||password!==(process.env.PLATFORM_ADMIN_PASSWORD||'admin'))return res.status(401).json({error:'Invalid credentials'});
  const token=generateToken({id:'admin',role:'platform_admin',name:'Super Admin'});
  res.json({token,admin:{id:'admin',name:'Super Admin',role:'super_admin'}});
});

// Dashboard stats
router.get('/dashboard',authMiddleware(['platform_admin']),async(req,res)=>{try{
  let to=0,ts=0,tord=0,tr=0,tp=0,tc=0,ro=[],rs=[],growth=[];
  try{to=parseInt((await pool.query('SELECT COUNT(*) FROM store_owners')).rows[0].count);}catch(e){}
  try{ts=parseInt((await pool.query('SELECT COUNT(*) FROM stores')).rows[0].count);}catch(e){}
  try{tord=parseInt((await pool.query('SELECT COUNT(*) FROM orders')).rows[0].count);}catch(e){}
  try{tr=parseFloat((await pool.query("SELECT COALESCE(SUM(total),0) as t FROM orders WHERE payment_status='paid'")).rows[0].t);}catch(e){}
  try{tp=parseInt((await pool.query('SELECT COUNT(*) FROM products')).rows[0].count);}catch(e){}
  try{tc=parseInt((await pool.query('SELECT COUNT(*) FROM customers')).rows[0].count);}catch(e){}
  try{ro=(await pool.query("SELECT o.*,s.store_name FROM orders o LEFT JOIN stores s ON s.id=o.store_id ORDER BY o.created_at DESC LIMIT 15")).rows.map(o=>({...o,order_number:'ORD-'+String(o.order_number).padStart(5,'0')}));}catch(e){}
  try{rs=(await pool.query("SELECT s.*,so.full_name as owner_name,(SELECT COUNT(*) FROM products WHERE store_id=s.id) as product_count,(SELECT COUNT(*) FROM orders WHERE store_id=s.id) as order_count,(SELECT COALESCE(SUM(total),0) FROM orders WHERE store_id=s.id AND payment_status='paid') as revenue FROM stores s LEFT JOIN store_owners so ON so.id=s.owner_id ORDER BY s.created_at DESC LIMIT 10")).rows.map(s=>({...s,name:s.store_name,is_live:s.is_published}));}catch(e){}
  try{growth=(await pool.query("SELECT DATE(created_at) as date,COUNT(*) as orders,COALESCE(SUM(total),0) as revenue FROM orders WHERE created_at>NOW()-INTERVAL '30 days' GROUP BY DATE(created_at) ORDER BY date")).rows;}catch(e){}
  // Today
  let todayOrders=0,todayRevenue=0;
  try{const t=await pool.query("SELECT COUNT(*) as c,COALESCE(SUM(total),0) as r FROM orders WHERE DATE(created_at)=CURRENT_DATE");todayOrders=parseInt(t.rows[0].c);todayRevenue=parseFloat(t.rows[0].r);}catch(e){}
  // This week new owners
  let weekOwners=0;
  try{weekOwners=parseInt((await pool.query("SELECT COUNT(*) FROM store_owners WHERE created_at>NOW()-INTERVAL '7 days'")).rows[0].count);}catch(e){}
  res.json({stats:{totalOwners:to,totalStores:ts,totalOrders:tord,totalRevenue:tr,totalProducts:tp,totalCustomers:tc,todayOrders,todayRevenue,weekOwners},recentOrders:ro,recentStores:rs,growth});
}catch(e){res.status(500).json({error:e.message});}});

// Settings
router.get('/settings',authMiddleware(['platform_admin']),async(req,res)=>{try{const r=await pool.query('SELECT * FROM platform_settings LIMIT 1');const s=r.rows[0]||{};res.json({...s,site_logo:s.logo_url,favicon:s.favicon_url,trial_days:s.subscription_trial_days});}catch(e){res.json({site_name:'KyoMarket'});}});
router.put('/settings',authMiddleware(['platform_admin']),async(req,res)=>{try{const f=req.body;const map={site_name:'site_name',primary_color:'primary_color',secondary_color:'secondary_color',accent_color:'accent_color',subscription_monthly_price:'subscription_monthly_price',subscription_yearly_price:'subscription_yearly_price',trial_days:'subscription_trial_days',site_logo:'logo_url',favicon:'favicon_url',meta_description:'meta_description',maintenance_mode:'maintenance_mode',currency:'currency'};const colMap=new Map();for(const[k,val]of Object.entries(f)){const col=map[k];if(!col)continue;colMap.set(col,val);}if(!colMap.size)return res.json({});const u=[],v=[];let i=1;for(const[col,val]of colMap){u.push(`${col}=$${i}`);v.push(val);i++;}const r=await pool.query(`UPDATE platform_settings SET ${u.join(',')},updated_at=NOW() WHERE id=(SELECT id FROM platform_settings LIMIT 1) RETURNING *`,v);const s=r.rows[0]||{};res.json({...s,site_logo:s.logo_url,favicon:s.favicon_url,trial_days:s.subscription_trial_days});}catch(e){res.status(500).json({error:e.message});}});

// Store owners - full CRUD
router.get('/store-owners',authMiddleware(['platform_admin']),async(req,res)=>{try{const{search}=req.query;let q="SELECT so.*,(SELECT COUNT(*) FROM stores WHERE owner_id=so.id) as store_count,(SELECT COALESCE(SUM(o.total),0) FROM orders o JOIN stores s ON s.id=o.store_id WHERE s.owner_id=so.id AND o.payment_status='paid') as total_revenue FROM store_owners so";const p=[];if(search){p.push(`%${search}%`);q+=' WHERE (so.full_name ILIKE $1 OR so.email ILIKE $1 OR so.phone ILIKE $1)';}q+=' ORDER BY so.created_at DESC';const r=await pool.query(q,p);res.json({owners:r.rows.map(o=>({...o,name:o.full_name})),total:r.rows.length});}catch(e){res.status(500).json({error:e.message});}});
router.patch('/store-owners/:id/toggle',authMiddleware(['platform_admin']),async(req,res)=>{try{const r=await pool.query('UPDATE store_owners SET is_active=NOT is_active,updated_at=NOW() WHERE id=$1 RETURNING *',[req.params.id]);res.json({...r.rows[0],name:r.rows[0].full_name});}catch(e){res.status(500).json({error:e.message});}});
router.delete('/store-owners/:id',authMiddleware(['platform_admin']),async(req,res)=>{try{await pool.query('UPDATE stores SET is_active=FALSE,is_published=FALSE WHERE owner_id=$1',[req.params.id]);await pool.query('DELETE FROM store_owners WHERE id=$1',[req.params.id]);res.json({ok:true});}catch(e){res.status(500).json({error:e.message});}});

// Stores management
router.get('/stores',authMiddleware(['platform_admin']),async(req,res)=>{try{const r=await pool.query("SELECT s.*,so.full_name as owner_name,so.email as owner_email,so.phone as owner_phone,(SELECT COUNT(*) FROM products WHERE store_id=s.id) as product_count,(SELECT COUNT(*) FROM orders WHERE store_id=s.id) as order_count,(SELECT COALESCE(SUM(total),0) FROM orders WHERE store_id=s.id AND payment_status='paid') as revenue FROM stores s LEFT JOIN store_owners so ON so.id=s.owner_id ORDER BY s.created_at DESC");res.json(r.rows.map(s=>({...s,name:s.store_name,is_live:s.is_published})));}catch(e){res.status(500).json({error:e.message});}});
router.patch('/stores/:id/toggle',authMiddleware(['platform_admin']),async(req,res)=>{try{const r=await pool.query('UPDATE stores SET is_published=NOT is_published,updated_at=NOW() WHERE id=$1 RETURNING *',[req.params.id]);res.json({...r.rows[0],name:r.rows[0].store_name,is_live:r.rows[0].is_published});}catch(e){res.status(500).json({error:e.message});}});
router.delete('/stores/:id',authMiddleware(['platform_admin']),async(req,res)=>{try{await pool.query('DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE store_id=$1)',[req.params.id]);await pool.query('DELETE FROM orders WHERE store_id=$1',[req.params.id]);await pool.query('DELETE FROM products WHERE store_id=$1',[req.params.id]);await pool.query('DELETE FROM stores WHERE id=$1',[req.params.id]);res.json({ok:true});}catch(e){res.status(500).json({error:e.message});}});

// All orders across platform
router.get('/orders',authMiddleware(['platform_admin']),async(req,res)=>{try{const{status,search}=req.query;let q="SELECT o.*,s.store_name FROM orders o LEFT JOIN stores s ON s.id=o.store_id";const p=[];const wh=[];if(status&&status!=='all'){p.push(status);wh.push(`o.status=$${p.length}`);}if(search){p.push(`%${search}%`);wh.push(`(o.customer_name ILIKE $${p.length} OR o.customer_phone ILIKE $${p.length} OR CAST(o.order_number AS TEXT) ILIKE $${p.length})`);}if(wh.length)q+=' WHERE '+wh.join(' AND ');q+=' ORDER BY o.created_at DESC LIMIT 100';const r=await pool.query(q,p);const cnt=await pool.query('SELECT COUNT(*) FROM orders');res.json({orders:r.rows.map(o=>({...o,order_number:'ORD-'+String(o.order_number).padStart(5,'0')})),total:parseInt(cnt.rows[0].count)});}catch(e){res.status(500).json({error:e.message});}});

// All products across platform
router.get('/products',authMiddleware(['platform_admin']),async(req,res)=>{try{const r=await pool.query("SELECT p.*,s.store_name FROM products p LEFT JOIN stores s ON s.id=p.store_id ORDER BY p.created_at DESC LIMIT 100");res.json(r.rows.map(p=>{let imgs=p.images;if(typeof imgs==='string')try{imgs=JSON.parse(imgs);}catch(e){imgs=[];}return{...p,name_en:p.name,thumbnail:Array.isArray(imgs)?imgs[0]:null};}));}catch(e){res.status(500).json({error:e.message});}});

// System info
router.get('/system',authMiddleware(['platform_admin']),async(req,res)=>{try{const tables=await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");const dbSize=await pool.query("SELECT pg_size_pretty(pg_database_size(current_database())) as size");const messaging=require('../services/messaging');const chatbot=require('../services/chatbot');const chargily=require('../services/chargily');res.json({tables:tables.rows.map(t=>t.table_name),dbSize:dbSize.rows[0]?.size,services:{whatsapp:messaging.getConfiguredChannels().whatsapp,sms:messaging.getConfiguredChannels().sms,email:messaging.getConfiguredChannels().email,ai:chatbot.isConfigured(),payments:chargily.isConfigured()},node:process.version,uptime:Math.floor(process.uptime())+'s'});}catch(e){res.status(500).json({error:e.message});}});

module.exports=router;
