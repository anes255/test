const express=require('express'),router=express.Router(),pool=require('../config/db'),{authMiddleware,generateToken}=require('../middleware/auth'),bcrypt=require('bcryptjs');

// Version check
router.get('/version',(req,res)=>res.json({version:'2025-03-25-v4',credentials:'0669003298/admin123'}));

// Debug - shows exactly what the server receives (remove after fixing)
router.post('/debug-login',(req,res)=>{
  const raw = req.body;
  const phone = (raw.phone||'').trim();
  const pw = (raw.password||'').trim();
  res.json({
    received_keys: Object.keys(raw),
    phone_value: phone,
    phone_length: phone.length,
    pw_length: pw.length,
    phone_match: phone === '0669003298',
    pw_match: pw === 'admin123',
    would_login: phone === '0669003298' && pw === 'admin123',
    body_type: typeof raw,
    content_type: req.headers['content-type'],
  });
});

// Login
router.post('/login',(req,res)=>{
  const{phone,password}=req.body||{};
  const p=(phone||'').trim();
  const pw=(password||'').trim();
  console.log('[Admin Login] phone:', JSON.stringify(p), 'pw_len:', pw.length, 'body_keys:', Object.keys(req.body||{}));
  
  // Primary hardcoded superadmin
  if(p==='0669003298'&&pw==='admin123'){
    console.log('[Admin Login] ✅ Success');
    const token=generateToken({id:'admin',role:'platform_admin',name:'Super Admin'});
    return res.json({token,admin:{id:'admin',name:'Super Admin',role:'super_admin'}});
  }
  
  // Secondary: env var credentials
  const envPhone=process.env.PLATFORM_ADMIN_PHONE;
  const envPw=process.env.PLATFORM_ADMIN_PASSWORD;
  if(envPhone&&envPw&&p===envPhone.trim()&&pw===envPw.trim()){
    console.log('[Admin Login] ✅ Env match');
    const token=generateToken({id:'admin',role:'platform_admin',name:'Super Admin'});
    return res.json({token,admin:{id:'admin',name:'Super Admin',role:'super_admin'}});
  }
  
  console.log('[Admin Login] ❌ Failed. env_phone:', JSON.stringify(envPhone), 'env_pw_set:', !!envPw);
  return res.status(401).json({error:'Invalid credentials'});
});

// Settings
router.get('/settings',authMiddleware(['platform_admin']),async(req,res)=>{try{const r=await pool.query('SELECT * FROM platform_settings LIMIT 1');const s=r.rows[0]||{};res.json({...s,site_logo:s.logo_url,favicon:s.favicon_url,trial_days:s.subscription_trial_days});}catch(e){res.json({site_name:'KyoMarket'});}});
router.put('/settings',authMiddleware(['platform_admin']),async(req,res)=>{try{const f=req.body;const map={site_name:'site_name',primary_color:'primary_color',secondary_color:'secondary_color',accent_color:'accent_color',subscription_monthly_price:'subscription_monthly_price',subscription_yearly_price:'subscription_yearly_price',trial_days:'subscription_trial_days',site_logo:'logo_url',favicon:'favicon_url',meta_description:'meta_description',maintenance_mode:'maintenance_mode',currency:'currency'};const colMap=new Map();for(const[k,val]of Object.entries(f)){const col=map[k];if(!col)continue;colMap.set(col,val);}if(!colMap.size)return res.json({});const u=[],v=[];let i=1;for(const[col,val]of colMap){u.push(`${col}=$${i}`);v.push(val);i++;}const r=await pool.query(`UPDATE platform_settings SET ${u.join(',')},updated_at=NOW() WHERE id=(SELECT id FROM platform_settings LIMIT 1) RETURNING *`,v);const s=r.rows[0]||{};res.json({...s,site_logo:s.logo_url,favicon:s.favicon_url,trial_days:s.subscription_trial_days});}catch(e){res.status(500).json({error:e.message});}});

// Store owners
router.get('/store-owners',authMiddleware(['platform_admin']),async(req,res)=>{try{const{search}=req.query;let q="SELECT so.*,(SELECT COUNT(*) FROM stores WHERE owner_id=so.id) as store_count,(SELECT COALESCE(SUM(o.total),0) FROM orders o JOIN stores s ON s.id=o.store_id WHERE s.owner_id=so.id AND o.payment_status='paid') as total_revenue FROM store_owners so";const p=[];if(search){p.push(`%${search}%`);q+=' WHERE (so.full_name ILIKE $1 OR so.email ILIKE $1 OR so.phone ILIKE $1)';}q+=' ORDER BY so.created_at DESC';const r=await pool.query(q,p);res.json({owners:r.rows.map(o=>({...o,name:o.full_name})),total:r.rows.length});}catch(e){res.status(500).json({error:e.message});}});
router.patch('/store-owners/:id/toggle',authMiddleware(['platform_admin']),async(req,res)=>{try{const r=await pool.query('UPDATE store_owners SET is_active=NOT is_active,updated_at=NOW() WHERE id=$1 RETURNING *',[req.params.id]);res.json({...r.rows[0],name:r.rows[0].full_name});}catch(e){res.status(500).json({error:e.message});}});
router.delete('/store-owners/:id',authMiddleware(['platform_admin']),async(req,res)=>{try{await pool.query('UPDATE stores SET is_active=FALSE,is_published=FALSE WHERE owner_id=$1',[req.params.id]);await pool.query('DELETE FROM store_owners WHERE id=$1',[req.params.id]);res.json({ok:true});}catch(e){res.status(500).json({error:e.message});}});

// Stores
router.get('/stores',authMiddleware(['platform_admin']),async(req,res)=>{try{const r=await pool.query("SELECT s.*,so.full_name as owner_name,so.email as owner_email,so.phone as owner_phone,(SELECT COUNT(*) FROM products WHERE store_id=s.id) as product_count,(SELECT COUNT(*) FROM orders WHERE store_id=s.id) as order_count,(SELECT COALESCE(SUM(total),0) FROM orders WHERE store_id=s.id AND payment_status='paid') as revenue FROM stores s LEFT JOIN store_owners so ON so.id=s.owner_id ORDER BY s.created_at DESC");res.json(r.rows.map(s=>({...s,name:s.store_name,is_live:s.is_published})));}catch(e){res.status(500).json({error:e.message});}});
router.patch('/stores/:id/toggle',authMiddleware(['platform_admin']),async(req,res)=>{try{const r=await pool.query('UPDATE stores SET is_published=NOT is_published,updated_at=NOW() WHERE id=$1 RETURNING *',[req.params.id]);res.json({...r.rows[0],name:r.rows[0].store_name,is_live:r.rows[0].is_published});}catch(e){res.status(500).json({error:e.message});}});
router.delete('/stores/:id',authMiddleware(['platform_admin']),async(req,res)=>{try{await pool.query('DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE store_id=$1)',[req.params.id]);await pool.query('DELETE FROM orders WHERE store_id=$1',[req.params.id]);await pool.query('DELETE FROM products WHERE store_id=$1',[req.params.id]);await pool.query('DELETE FROM stores WHERE id=$1',[req.params.id]);res.json({ok:true});}catch(e){res.status(500).json({error:e.message});}});

// All orders
router.get('/orders',authMiddleware(['platform_admin']),async(req,res)=>{try{const{status,search}=req.query;let q="SELECT o.*,s.store_name FROM orders o LEFT JOIN stores s ON s.id=o.store_id";const p=[];const wh=[];if(status&&status!=='all'){p.push(status);wh.push(`o.status=$${p.length}`);}if(search){p.push(`%${search}%`);wh.push(`(o.customer_name ILIKE $${p.length} OR o.customer_phone ILIKE $${p.length} OR CAST(o.order_number AS TEXT) ILIKE $${p.length})`);}if(wh.length)q+=' WHERE '+wh.join(' AND ');q+=' ORDER BY o.created_at DESC LIMIT 100';const r=await pool.query(q,p);const cnt=await pool.query('SELECT COUNT(*) FROM orders');res.json({orders:r.rows.map(o=>({...o,order_number:'ORD-'+String(o.order_number).padStart(5,'0')})),total:parseInt(cnt.rows[0].count)});}catch(e){res.status(500).json({error:e.message});}});

// Dashboard
router.get('/dashboard',authMiddleware(['platform_admin']),async(req,res)=>{try{let to=0,ts=0,tord=0,tr=0,tp=0,tc=0,ro=[],rs=[],growth=[];
try{to=parseInt((await pool.query('SELECT COUNT(*) FROM store_owners')).rows[0].count);}catch(e){}
try{ts=parseInt((await pool.query('SELECT COUNT(*) FROM stores')).rows[0].count);}catch(e){}
try{tord=parseInt((await pool.query('SELECT COUNT(*) FROM orders')).rows[0].count);}catch(e){}
try{tr=parseFloat((await pool.query("SELECT COALESCE(SUM(total),0) as t FROM orders WHERE payment_status='paid'")).rows[0].t);}catch(e){}
try{tp=parseInt((await pool.query('SELECT COUNT(*) FROM products')).rows[0].count);}catch(e){}
try{tc=parseInt((await pool.query('SELECT COUNT(*) FROM customers')).rows[0].count);}catch(e){}
try{ro=(await pool.query("SELECT o.*,s.store_name FROM orders o LEFT JOIN stores s ON s.id=o.store_id ORDER BY o.created_at DESC LIMIT 15")).rows.map(o=>({...o,order_number:'ORD-'+String(o.order_number).padStart(5,'0')}));}catch(e){}
try{rs=(await pool.query("SELECT s.*,so.full_name as owner_name,(SELECT COUNT(*) FROM products WHERE store_id=s.id) as product_count,(SELECT COUNT(*) FROM orders WHERE store_id=s.id) as order_count,(SELECT COALESCE(SUM(total),0) FROM orders WHERE store_id=s.id AND payment_status='paid') as revenue FROM stores s LEFT JOIN store_owners so ON so.id=s.owner_id ORDER BY s.created_at DESC LIMIT 10")).rows.map(s=>({...s,name:s.store_name,is_live:s.is_published}));}catch(e){}
let todayOrders=0,todayRevenue=0,weekOwners=0;
try{const t=await pool.query("SELECT COUNT(*) as c,COALESCE(SUM(total),0) as r FROM orders WHERE DATE(created_at)=CURRENT_DATE");todayOrders=parseInt(t.rows[0].c);todayRevenue=parseFloat(t.rows[0].r);}catch(e){}
try{weekOwners=parseInt((await pool.query("SELECT COUNT(*) FROM store_owners WHERE created_at>NOW()-INTERVAL '7 days'")).rows[0].count);}catch(e){}
res.json({stats:{totalOwners:to,totalStores:ts,totalOrders:tord,totalRevenue:tr,totalProducts:tp,totalCustomers:tc,todayOrders,todayRevenue,weekOwners},recentOrders:ro,recentStores:rs});}catch(e){res.status(500).json({error:e.message});}});

// System
router.get('/system',authMiddleware(['platform_admin']),async(req,res)=>{try{const tables=await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");const dbSize=await pool.query("SELECT pg_size_pretty(pg_database_size(current_database())) as size");const messaging=require('../services/messaging');const chatbot=require('../services/chatbot');const chargily=require('../services/chargily');res.json({tables:tables.rows.map(t=>t.table_name),dbSize:dbSize.rows[0]?.size,services:{whatsapp:messaging.getConfiguredChannels().whatsapp,sms:messaging.getConfiguredChannels().sms,email:messaging.getConfiguredChannels().email,ai:chatbot.isConfigured(),payments:chargily.isConfigured()},node:process.version,uptime:Math.floor(process.uptime())+'s'});}catch(e){res.status(500).json({error:e.message});}});

// ═══ SUBSCRIPTION MANAGEMENT ═══
// Get all subscription payments
router.get('/subscriptions',authMiddleware(['platform_admin']),async(req,res)=>{try{
  const{status}=req.query;
  let q="SELECT sp.*,so.full_name as owner_name,so.email as owner_email,so.phone as owner_phone,so.subscription_plan,so.subscription_status FROM subscription_payments sp LEFT JOIN store_owners so ON so.id=sp.owner_id";
  const p=[];
  if(status&&status!=='all'){p.push(status);q+=` WHERE sp.status=$1`;}
  q+=' ORDER BY sp.created_at DESC';
  const r=await pool.query(q,p);
  const stats=await pool.query("SELECT status,COUNT(*) as c FROM subscription_payments GROUP BY status");
  const statsMap={};stats.rows.forEach(s=>{statsMap[s.status]=parseInt(s.c);});
  res.json({payments:r.rows,stats:statsMap});
}catch(e){res.status(500).json({error:e.message});}});

// Approve payment → activate subscription
router.patch('/subscriptions/:pid/approve',authMiddleware(['platform_admin']),async(req,res)=>{try{
  const payment=(await pool.query('UPDATE subscription_payments SET status=$1,reviewed_by=$2,reviewed_at=NOW() WHERE id=$3 RETURNING *',['approved','Super Admin',req.params.pid])).rows[0];
  if(!payment)return res.status(404).json({error:'Not found'});
  // Calculate expiry
  const months=payment.period==='yearly'?12:1;
  const expiry=new Date();expiry.setMonth(expiry.getMonth()+months);
  await pool.query('UPDATE store_owners SET subscription_plan=$1,subscription_status=$2,subscription_expires_at=$3,subscription_paid_until=$3 WHERE id=$4',[payment.plan,'active',expiry,payment.owner_id]);
  res.json({...payment,status:'approved'});
}catch(e){res.status(500).json({error:e.message});}});

// Reject payment
router.patch('/subscriptions/:pid/reject',authMiddleware(['platform_admin']),async(req,res)=>{try{
  const{notes}=req.body;
  const r=await pool.query('UPDATE subscription_payments SET status=$1,reviewed_by=$2,reviewed_at=NOW(),notes=$3 WHERE id=$4 RETURNING *',['rejected','Super Admin',notes||'Payment rejected',req.params.pid]);
  res.json(r.rows[0]);
}catch(e){res.status(500).json({error:e.message});}});

// Suspend/activate owner subscription
router.patch('/store-owners/:id/subscription',authMiddleware(['platform_admin']),async(req,res)=>{try{
  const{action}=req.body; // 'suspend' or 'activate'
  const newStatus=action==='suspend'?'suspended':'active';
  const isActive=action!=='suspend';
  const r=await pool.query('UPDATE store_owners SET subscription_status=$1,is_active=$2,updated_at=NOW() WHERE id=$3 RETURNING *',[newStatus,isActive,req.params.id]);
  // Also toggle all stores
  if(action==='suspend'){
    await pool.query('UPDATE stores SET is_published=FALSE WHERE owner_id=$1',[req.params.id]);
  }else{
    await pool.query('UPDATE stores SET is_published=TRUE WHERE owner_id=$1',[req.params.id]);
  }
  res.json({...r.rows[0],name:r.rows[0].full_name});
}catch(e){res.status(500).json({error:e.message});}});

// Update billing config (CCP, BaridiMob QR for payments TO admin)
router.put('/billing-config',authMiddleware(['platform_admin']),async(req,res)=>{try{
  const{billing_ccp_account,billing_ccp_name,billing_baridimob_rip,billing_baridimob_qr,subscription_monthly_price,subscription_yearly_price}=req.body;
  const updates=[];const vals=[];let i=1;
  if(billing_ccp_account!==undefined){updates.push(`billing_ccp_account=$${i}`);vals.push(billing_ccp_account);i++;}
  if(billing_ccp_name!==undefined){updates.push(`billing_ccp_name=$${i}`);vals.push(billing_ccp_name);i++;}
  if(billing_baridimob_rip!==undefined){updates.push(`billing_baridimob_rip=$${i}`);vals.push(billing_baridimob_rip);i++;}
  if(billing_baridimob_qr!==undefined){updates.push(`billing_baridimob_qr=$${i}`);vals.push(billing_baridimob_qr);i++;}
  if(subscription_monthly_price!==undefined){updates.push(`subscription_monthly_price=$${i}`);vals.push(subscription_monthly_price);i++;}
  if(subscription_yearly_price!==undefined){updates.push(`subscription_yearly_price=$${i}`);vals.push(subscription_yearly_price);i++;}
  if(!updates.length)return res.json({ok:true});
  // Add columns if they don't exist yet
  try{await pool.query("ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS billing_ccp_account VARCHAR(100)");}catch(e){}
  try{await pool.query("ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS billing_ccp_name VARCHAR(100)");}catch(e){}
  try{await pool.query("ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS billing_baridimob_rip VARCHAR(100)");}catch(e){}
  try{await pool.query("ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS billing_baridimob_qr TEXT");}catch(e){}
  const r=await pool.query(`UPDATE platform_settings SET ${updates.join(',')},updated_at=NOW() WHERE id=(SELECT id FROM platform_settings LIMIT 1) RETURNING *`,vals);
  res.json(r.rows[0]||{ok:true});
}catch(e){res.status(500).json({error:e.message});}});

module.exports=router;
