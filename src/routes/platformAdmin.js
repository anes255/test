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
router.post('/login',async(req,res)=>{
  const{phone,password}=req.body||{};
  const p=(phone||'').trim();
  const pw=(password||'').trim();
  console.log('[Admin Login] phone:', JSON.stringify(p), 'pw_len:', pw.length);

  const DEFAULT_PHONE = (process.env.PLATFORM_ADMIN_PHONE || '0669003298').trim();
  const DEFAULT_PW    = (process.env.PLATFORM_ADMIN_PASSWORD || 'admin123').trim();

  // 1) DB-backed overrides (set via PUT /platform/profile/password)
  let dbRow = {};
  let hasHash = false;
  try {
    try { await pool.query("ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS admin_phone VARCHAR(50)"); } catch {}
    try { await pool.query("ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS admin_password_hash TEXT"); } catch {}
    try { await pool.query("ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS admin_name VARCHAR(100)"); } catch {}
    dbRow = (await pool.query('SELECT admin_phone, admin_password_hash, admin_name FROM platform_settings LIMIT 1')).rows[0] || {};
    hasHash = !!dbRow.admin_password_hash;

    // The "active phone" is whatever is stored in DB, otherwise the default.
    const activePhone = ((dbRow.admin_phone || '') + '').trim() || DEFAULT_PHONE;

    if (hasHash) {
      // Once a custom password hash exists, it is the ONLY accepted credential.
      // No legacy/env fallback — that was the bug allowing admin123 forever.
      if (p === activePhone) {
        const ok = await bcrypt.compare(pw, dbRow.admin_password_hash);
        if (ok) {
          console.log('[Admin Login] ✅ DB hash match');
          const token=generateToken({id:'admin',role:'platform_admin',name:dbRow.admin_name||'Super Admin'});
          return res.json({token,admin:{id:'admin',name:dbRow.admin_name||'Super Admin',role:'super_admin'}});
        }
      }
      console.log('[Admin Login] ❌ hash exists, DB credentials did not match — falling through to platform_admins');
    }
  } catch (e) { console.log('[Admin Login] DB check failed:', e.message); }

  // 2) Check the platform_admins table (admins added via the Super Admins page)
  try {
    await ensureAdminsTable();
    // Normalize: strip leading '+', spaces, dashes; also try last-9 digits match (DZ mobile)
    const digits = p.replace(/[^0-9]/g,'');
    const last9 = digits.slice(-9);
    const all = await pool.query("SELECT id,full_name,phone,email,is_active,password_hash FROM platform_admins");
    console.log('[Admin Login] platform_admins rows:', all.rows.map(r=>({phone:r.phone,active:r.is_active,hash_len:(r.password_hash||'').length})));
    const admin = all.rows.find(r=>{
      const rp=(r.phone||'').toString();
      const rd=rp.replace(/[^0-9]/g,'');
      return rp.trim()===p || rd===digits || (last9 && rd.slice(-9)===last9);
    });
    console.log('[Admin Login] match for', JSON.stringify(p), '→', admin?.phone, 'active:', admin?.is_active);
    if (admin) {
      let pwOk=false;
      try{ pwOk = await bcrypt.compare(pw, admin.password_hash||''); }catch(err){ console.log('[Admin Login] bcrypt error:',err.message); }
      console.log('[Admin Login] bcrypt compare:', pwOk, 'hash_len:', (admin.password_hash||'').length);
      if (admin.is_active !== false && pwOk) {
        console.log('[Admin Login] ✅ platform_admins match');
        const token = generateToken({ id: admin.id, role: 'platform_admin', name: admin.full_name || 'Admin' });
        return res.json({ token, admin: { id: admin.id, name: admin.full_name || 'Admin', role: admin.role || 'platform_admin' } });
      }
    }
  } catch (e) { console.log('[Admin Login] admins table check failed:', e.message, e.stack); }

  // 3) No DB hash yet → accept hardcoded/env defaults
  if (p === DEFAULT_PHONE && pw === DEFAULT_PW) {
    console.log('[Admin Login] ✅ default credentials');
    const token=generateToken({id:'admin',role:'platform_admin',name:'Super Admin'});
    return res.json({token,admin:{id:'admin',name:'Super Admin',role:'super_admin'}});
  }

  console.log('[Admin Login] ❌ Failed');
  return res.status(401).json({error:'Invalid credentials'});
});

// Settings
router.get('/settings',authMiddleware(['platform_admin']),async(req,res)=>{try{const r=await pool.query('SELECT * FROM platform_settings LIMIT 1');const s=r.rows[0]||{};res.json({...s,site_logo:s.logo_url,favicon:s.favicon_url,trial_days:s.subscription_trial_days});}catch(e){res.json({site_name:'KyoMarket'});}});
router.put('/settings',authMiddleware(['platform_admin']),async(req,res)=>{try{const f=req.body;const map={site_name:'site_name',primary_color:'primary_color',secondary_color:'secondary_color',accent_color:'accent_color',subscription_monthly_price:'subscription_monthly_price',subscription_yearly_price:'subscription_yearly_price',trial_days:'subscription_trial_days',site_logo:'logo_url',favicon:'favicon_url',meta_description:'meta_description',maintenance_mode:'maintenance_mode',currency:'currency',landing_blocks:'landing_blocks',google_client_id:'google_client_id'};
  // Auto-add landing_blocks column if missing
  try{await pool.query("ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS landing_blocks TEXT DEFAULT '[]'");}catch(e){}
  const colMap=new Map();for(const[k,val]of Object.entries(f)){const col=map[k];if(!col)continue;colMap.set(col,val);}if(!colMap.size)return res.json({});const u=[],v=[];let i=1;for(const[col,val]of colMap){u.push(`${col}=$${i}`);v.push(val);i++;}const r=await pool.query(`UPDATE platform_settings SET ${u.join(',')},updated_at=NOW() WHERE id=(SELECT id FROM platform_settings LIMIT 1) RETURNING *`,v);const s=r.rows[0]||{};res.json({...s,site_logo:s.logo_url,favicon:s.favicon_url,trial_days:s.subscription_trial_days});}catch(e){res.status(500).json({error:e.message});}});

// Store owners
router.get('/store-owners',authMiddleware(['platform_admin']),async(req,res)=>{try{const{search}=req.query;let q="SELECT so.*,(SELECT COUNT(*) FROM stores WHERE owner_id=so.id) as store_count,(SELECT COALESCE(SUM(o.total),0) FROM orders o JOIN stores s ON s.id=o.store_id WHERE s.owner_id=so.id AND o.payment_status='paid') as total_revenue FROM store_owners so";const p=[];if(search){p.push(`%${search}%`);q+=' WHERE (so.full_name ILIKE $1 OR so.email ILIKE $1 OR so.phone ILIKE $1)';}q+=' ORDER BY so.created_at DESC';const r=await pool.query(q,p);res.json({owners:r.rows.map(o=>({...o,name:o.full_name})),total:r.rows.length});}catch(e){res.status(500).json({error:e.message});}});
router.patch('/store-owners/:id/toggle',authMiddleware(['platform_admin']),async(req,res)=>{try{const r=await pool.query('UPDATE store_owners SET is_active=NOT is_active,updated_at=NOW() WHERE id=$1 RETURNING *',[req.params.id]);res.json({...r.rows[0],name:r.rows[0].full_name});}catch(e){res.status(500).json({error:e.message});}});
async function cascadeDeleteStores(client,storeIds){
  if(!storeIds.length)return;
  const t=['payment_receipts','blacklist','message_log','expenses','store_pages','notifications','push_subscriptions','reviews','carts','store_domains'];
  for(const table of t){await client.query(`DELETE FROM ${table} WHERE store_id=ANY($1::uuid[])`,[storeIds]).catch(()=>{});}
  await client.query('DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE store_id=ANY($1::uuid[]))',[storeIds]).catch(()=>{});
  await client.query('DELETE FROM orders WHERE store_id=ANY($1::uuid[])',[storeIds]).catch(()=>{});
  await client.query('DELETE FROM products WHERE store_id=ANY($1::uuid[])',[storeIds]).catch(()=>{});
}
router.delete('/store-owners/:id',authMiddleware(['platform_admin']),async(req,res)=>{const client=await pool.connect();try{await client.query('BEGIN');const id=req.params.id;const storeIds=(await client.query('SELECT id FROM stores WHERE owner_id=$1',[id])).rows.map(r=>r.id);await cascadeDeleteStores(client,storeIds);await client.query('DELETE FROM subscription_payments WHERE owner_id=$1',[id]).catch(()=>{});await client.query('DELETE FROM stores WHERE owner_id=$1',[id]);await client.query('DELETE FROM store_owners WHERE id=$1',[id]);await client.query('COMMIT');res.json({ok:true});}catch(e){await client.query('ROLLBACK').catch(()=>{});res.status(500).json({error:e.message});}finally{client.release();}});

// Stores
router.get('/stores',authMiddleware(['platform_admin']),async(req,res)=>{try{const r=await pool.query("SELECT s.*,so.full_name as owner_name,so.email as owner_email,so.phone as owner_phone,so.is_active as owner_active,so.subscription_status,(SELECT COUNT(*) FROM products WHERE store_id=s.id) as product_count,(SELECT COUNT(*) FROM orders WHERE store_id=s.id) as order_count,(SELECT COALESCE(SUM(total),0) FROM orders WHERE store_id=s.id AND payment_status='paid') as revenue FROM stores s LEFT JOIN store_owners so ON so.id=s.owner_id ORDER BY s.created_at DESC");res.json(r.rows.map(s=>({...s,name:s.store_name,is_live:s.is_published})));}catch(e){res.status(500).json({error:e.message});}});
router.patch('/stores/:id/toggle',authMiddleware(['platform_admin']),async(req,res)=>{try{const r=await pool.query('UPDATE stores SET is_published=NOT is_published,updated_at=NOW() WHERE id=$1 RETURNING *',[req.params.id]);res.json({...r.rows[0],name:r.rows[0].store_name,is_live:r.rows[0].is_published});}catch(e){res.status(500).json({error:e.message});}});
router.delete('/stores/:id',authMiddleware(['platform_admin']),async(req,res)=>{const client=await pool.connect();try{await client.query('BEGIN');await cascadeDeleteStores(client,[req.params.id]);await client.query('DELETE FROM stores WHERE id=$1',[req.params.id]);await client.query('COMMIT');res.json({ok:true});}catch(e){await client.query('ROLLBACK').catch(()=>{});res.status(500).json({error:e.message});}finally{client.release();}});

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
router.get('/system',authMiddleware(['platform_admin']),async(req,res)=>{try{const tables=await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");const dbSize=await pool.query("SELECT pg_size_pretty(pg_database_size(current_database())) as size");const messaging=require('../services/messaging');const chatbot=require('../services/chatbot');const chargily=require('../services/chargily');res.json({tables:tables.rows.map(t=>t.table_name),dbSize:dbSize.rows[0]?.size,services:{whatsapp:messaging.getConfiguredChannels().whatsapp,email:messaging.getConfiguredChannels().email,ai:chatbot.isConfigured(),payments:chargily.isConfigured()},node:process.version,uptime:Math.floor(process.uptime())+'s'});}catch(e){res.status(500).json({error:e.message});}});

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

// Expiring subscriptions (within next 24h, or already expired in last 7 days)
router.get('/expiring-subscriptions',authMiddleware(['platform_admin']),async(req,res)=>{try{
  const r=await pool.query(`
    SELECT id,full_name,email,phone,subscription_plan,subscription_status,subscription_expires_at,
      EXTRACT(EPOCH FROM (subscription_expires_at - NOW()))/3600 AS hours_remaining
    FROM store_owners
    WHERE subscription_expires_at IS NOT NULL
      AND subscription_expires_at BETWEEN NOW() - INTERVAL '7 days' AND NOW() + INTERVAL '24 hours'
    ORDER BY subscription_expires_at ASC
  `);
  res.json({owners:r.rows.map(o=>({...o,name:o.full_name,hours_remaining:Math.round(Number(o.hours_remaining||0))}))});
}catch(e){res.status(500).json({error:e.message});}});

// Extend owner subscription for free (super admin grants N days)
router.post('/store-owners/:id/extend-subscription',authMiddleware(['platform_admin']),async(req,res)=>{try{
  const days=parseInt(req.body?.days||0,10);
  if(!days||days<1||days>3650)return res.status(400).json({error:'days must be 1-3650'});
  const cur=(await pool.query('SELECT subscription_expires_at FROM store_owners WHERE id=$1',[req.params.id])).rows[0];
  if(!cur)return res.status(404).json({error:'Owner not found'});
  const base=cur.subscription_expires_at&&new Date(cur.subscription_expires_at)>new Date()?new Date(cur.subscription_expires_at):new Date();
  const newExpiry=new Date(base.getTime()+days*24*60*60*1000);
  const r=await pool.query('UPDATE store_owners SET subscription_expires_at=$1,subscription_paid_until=$1,subscription_status=$2,is_active=TRUE,updated_at=NOW() WHERE id=$3 RETURNING *',[newExpiry,'active',req.params.id]);
  await pool.query('UPDATE stores SET is_published=TRUE WHERE owner_id=$1',[req.params.id]).catch(()=>{});
  res.json({ok:true,owner:{...r.rows[0],name:r.rows[0].full_name},extended_days:days,new_expiry:newExpiry});
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

// ═══ Subscription plans CRUD (super-admin) ═══
const { invalidatePlanCache } = require('../middleware/planFeatures');
const parseArr = v => { if (Array.isArray(v)) return v; if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } } return []; };
const mapPlan = r => ({
  id: r.id,
  slug: r.slug,
  name: { en: r.name_en, fr: r.name_fr || '', ar: r.name_ar || '' },
  tagline: { en: r.tagline_en || '', fr: r.tagline_fr || '', ar: r.tagline_ar || '' },
  price_monthly: parseFloat(r.price_monthly) || 0,
  price_yearly: parseFloat(r.price_yearly) || 0,
  currency: r.currency || 'DZD',
  features: { en: parseArr(r.features_en), fr: parseArr(r.features_fr), ar: parseArr(r.features_ar) },
  // Canonical feature flags the backend uses for gating. The store owner sees
  // the localized labels above, but the gate checks `feature_keys`.
  feature_keys: parseArr(r.feature_keys),
  // Hard quotas — 0 means unlimited.
  max_products: parseInt(r.max_products) || 0,
  max_orders_month: parseInt(r.max_orders_month) || 0,
  max_staff: parseInt(r.max_staff) || 0,
  is_popular: !!r.is_popular,
  is_active: !!r.is_active,
  sort_order: r.sort_order || 0,
});

// Public read — used by landing + billing pages. No auth.
router.get('/plans/public', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM plans WHERE is_active=TRUE ORDER BY sort_order ASC, price_monthly ASC');
    res.json({ plans: r.rows.map(mapPlan) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/plans', authMiddleware(['platform_admin']), async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM plans ORDER BY sort_order ASC, price_monthly ASC');
    res.json({ plans: r.rows.map(mapPlan) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/plans', authMiddleware(['platform_admin']), async (req, res) => {
  try {
    const b = req.body || {};
    const name = b.name || {}; const tagline = b.tagline || {}; const feats = b.features || {};
    const slug = (b.slug || name.en || 'plan').toString().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || ('plan-' + Date.now());
    const r = await pool.query(
      `INSERT INTO plans(slug,name_en,name_fr,name_ar,tagline_en,tagline_fr,tagline_ar,price_monthly,price_yearly,currency,features_en,features_fr,features_ar,feature_keys,max_products,max_orders_month,max_staff,is_popular,is_active,sort_order)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
      [
        slug,
        name.en || 'Untitled', name.fr || '', name.ar || '',
        tagline.en || '', tagline.fr || '', tagline.ar || '',
        b.price_monthly || 0, b.price_yearly || 0, b.currency || 'DZD',
        JSON.stringify(parseArr(feats.en)), JSON.stringify(parseArr(feats.fr)), JSON.stringify(parseArr(feats.ar)),
        JSON.stringify(parseArr(b.feature_keys)),
        parseInt(b.max_products)||0, parseInt(b.max_orders_month)||0, parseInt(b.max_staff)||0,
        !!b.is_popular, b.is_active !== false, b.sort_order || 0,
      ]
    );
    invalidatePlanCache();
    res.json(mapPlan(r.rows[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/plans/:id', authMiddleware(['platform_admin']), async (req, res) => {
  try {
    const b = req.body || {};
    const name = b.name || {}; const tagline = b.tagline || {}; const feats = b.features || {};
    const r = await pool.query(
      `UPDATE plans SET
         name_en=$1,name_fr=$2,name_ar=$3,
         tagline_en=$4,tagline_fr=$5,tagline_ar=$6,
         price_monthly=$7,price_yearly=$8,currency=$9,
         features_en=$10,features_fr=$11,features_ar=$12,
         feature_keys=$13,
         max_products=$14,max_orders_month=$15,max_staff=$16,
         is_popular=$17,is_active=$18,sort_order=$19,updated_at=NOW()
       WHERE id=$20 RETURNING *`,
      [
        name.en || 'Untitled', name.fr || '', name.ar || '',
        tagline.en || '', tagline.fr || '', tagline.ar || '',
        b.price_monthly || 0, b.price_yearly || 0, b.currency || 'DZD',
        JSON.stringify(parseArr(feats.en)), JSON.stringify(parseArr(feats.fr)), JSON.stringify(parseArr(feats.ar)),
        JSON.stringify(parseArr(b.feature_keys)),
        parseInt(b.max_products)||0, parseInt(b.max_orders_month)||0, parseInt(b.max_staff)||0,
        !!b.is_popular, b.is_active !== false, b.sort_order || 0,
        req.params.id,
      ]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Plan not found' });
    invalidatePlanCache();
    res.json(mapPlan(r.rows[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/plans/:id', authMiddleware(['platform_admin']), async (req, res) => {
  try {
    await pool.query('DELETE FROM plans WHERE id=$1', [req.params.id]);
    invalidatePlanCache();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ Staff role templates CRUD (super-admin) ═══
const mapTpl = r => ({
  id: r.id,
  name: { en: r.name_en, fr: r.name_fr || '', ar: r.name_ar || '' },
  description: { en: r.description_en || '', fr: r.description_fr || '', ar: r.description_ar || '' },
  permissions: parseArr(r.permissions),
  is_active: !!r.is_active,
  sort_order: r.sort_order || 0,
});

// Public read — used by store owners in the StoreStaff modal. Requires
// store_owner auth so we don't leak role configs to buyers.
router.get('/role-templates/public', authMiddleware(['store_owner']), async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM role_templates WHERE is_active=TRUE ORDER BY sort_order ASC, created_at ASC');
    res.json({ templates: r.rows.map(mapTpl) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/role-templates', authMiddleware(['platform_admin']), async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM role_templates ORDER BY sort_order ASC, created_at ASC');
    res.json({ templates: r.rows.map(mapTpl) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/role-templates', authMiddleware(['platform_admin']), async (req, res) => {
  try {
    const b = req.body || {};
    const name = b.name || {}; const desc = b.description || {};
    const r = await pool.query(
      `INSERT INTO role_templates(name_en,name_fr,name_ar,description_en,description_fr,description_ar,permissions,is_active,sort_order)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        name.en || 'Untitled', name.fr || '', name.ar || '',
        desc.en || '', desc.fr || '', desc.ar || '',
        JSON.stringify(parseArr(b.permissions)),
        b.is_active !== false, b.sort_order || 0,
      ]
    );
    res.json(mapTpl(r.rows[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/role-templates/:id', authMiddleware(['platform_admin']), async (req, res) => {
  try {
    const b = req.body || {};
    const name = b.name || {}; const desc = b.description || {};
    const r = await pool.query(
      `UPDATE role_templates SET
         name_en=$1,name_fr=$2,name_ar=$3,
         description_en=$4,description_fr=$5,description_ar=$6,
         permissions=$7,is_active=$8,sort_order=$9,updated_at=NOW()
       WHERE id=$10 RETURNING *`,
      [
        name.en || 'Untitled', name.fr || '', name.ar || '',
        desc.en || '', desc.fr || '', desc.ar || '',
        JSON.stringify(parseArr(b.permissions)),
        b.is_active !== false, b.sort_order || 0,
        req.params.id,
      ]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Template not found' });
    res.json(mapTpl(r.rows[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/role-templates/:id', authMiddleware(['platform_admin']), async (req, res) => {
  try {
    await pool.query('DELETE FROM role_templates WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ Super-admin profile (stubs) ═══
// The hardcoded super admin lives in env vars, not the DB, so we just echo
// back a simple profile object and persist updates to platform_settings so
// the super-admin profile page has something to read/write instead of 404ing
// and bouncing the user back to the login screen.
router.get('/profile', authMiddleware(['platform_admin']), async (req, res) => {
  try {
    let row = {};
    try { row = (await pool.query('SELECT * FROM platform_settings LIMIT 1')).rows[0] || {}; } catch {}
    res.json({
      id: req.user?.id || 'admin',
      name: row.admin_name || req.user?.name || 'Super Admin',
      email: row.admin_email || '',
      phone: row.admin_phone || process.env.PLATFORM_ADMIN_PHONE || '0669003298',
      role: 'super_admin',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/profile', authMiddleware(['platform_admin']), async (req, res) => {
  try {
    try { await pool.query("ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS admin_name VARCHAR(100)"); } catch {}
    try { await pool.query("ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS admin_email VARCHAR(255)"); } catch {}
    try { await pool.query("ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS admin_phone VARCHAR(50)"); } catch {}
    const b = req.body || {};
    await pool.query(
      'UPDATE platform_settings SET admin_name=$1, admin_email=$2, admin_phone=$3, updated_at=NOW() WHERE id=(SELECT id FROM platform_settings LIMIT 1)',
      [b.name || null, b.email || null, b.phone || null]
    );
    res.json({ id: 'admin', name: b.name || 'Super Admin', email: b.email || '', phone: b.phone || '', role: 'super_admin' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/profile/password', authMiddleware(['platform_admin']), async (req, res) => {
  try {
    const { current_password, new_password } = req.body || {};
    const cur = (current_password || '').trim();
    const nw = (new_password || '').trim();
    if (!cur) return res.status(400).json({ error: 'Current password is required' });
    if (!nw || nw.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
    try { await pool.query("ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS admin_password_hash TEXT"); } catch {}

    // Ensure a platform_settings row exists so UPDATE actually persists
    let row = (await pool.query('SELECT id, admin_password_hash FROM platform_settings LIMIT 1')).rows[0];
    if (!row) {
      const ins = await pool.query('INSERT INTO platform_settings(site_name) VALUES($1) RETURNING id, admin_password_hash', ['KyoMarket']);
      row = ins.rows[0];
    }

    // Verify current password strictly against whichever credential is active.
    // If a hash is already set in DB, that is the ONLY acceptable current
    // password. Legacy fallbacks (hardcoded / env) only apply when no hash
    // has been stored yet.
    let ok = false;
    if (row.admin_password_hash) {
      ok = await bcrypt.compare(cur, row.admin_password_hash);
    } else {
      if (cur === 'admin123') ok = true;
      const envPw = (process.env.PLATFORM_ADMIN_PASSWORD || '').trim();
      if (envPw && cur === envPw) ok = true;
    }
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });

    const hash = await bcrypt.hash(nw, 12);
    // Also seed admin_phone if missing so the login route's "active phone"
    // resolves to the same value the user expects (the default 0669003298
    // unless an explicit profile update has set something else).
    const defaultPhone = (process.env.PLATFORM_ADMIN_PHONE || '0669003298').trim();
    const upd = await pool.query(
      "UPDATE platform_settings SET admin_password_hash=$1, admin_phone=COALESCE(NULLIF(admin_phone,''),$2), updated_at=NOW() WHERE id=$3 RETURNING id",
      [hash, defaultPhone, row.id]
    );
    if (!upd.rows[0]) return res.status(500).json({ error: 'Failed to persist new password' });
    console.log('[Admin Password] ✅ updated for row', row.id);
    res.json({ ok: true });
  } catch (e) { console.log('[Admin Password] error:', e.message); res.status(500).json({ error: e.message }); }
});

async function ensureAdminsTable(){
  try{await pool.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');}catch(e){console.log('[ensureAdminsTable] pgcrypto ext:',e.message);}
  try{
    await pool.query(`CREATE TABLE IF NOT EXISTS platform_admins(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      full_name VARCHAR(255) NOT NULL DEFAULT '',
      phone VARCHAR(50) UNIQUE NOT NULL,
      email VARCHAR(255),
      password_hash TEXT NOT NULL,
      role VARCHAR(50) DEFAULT 'platform_admin',
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  }catch(e){console.log('[ensureAdminsTable] create failed:',e.message);}
  // Safety: ensure columns exist if table was created with older shape
  try{await pool.query("ALTER TABLE platform_admins ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE");}catch{}
  try{await pool.query("ALTER TABLE platform_admins ADD COLUMN IF NOT EXISTS role VARCHAR(50) DEFAULT 'platform_admin'");}catch{}
  try{await pool.query("ALTER TABLE platform_admins ADD COLUMN IF NOT EXISTS email VARCHAR(255)");}catch{}
  try{await pool.query("ALTER TABLE platform_admins ADD COLUMN IF NOT EXISTS full_name VARCHAR(255) DEFAULT ''");}catch{}
}
ensureAdminsTable();

// DEBUG: inspect admins table (no auth, temp)
router.get('/admins-debug',async(req,res)=>{
  try{await ensureAdminsTable();
    const r=await pool.query('SELECT id,full_name,phone,email,role,is_active,LENGTH(password_hash) as hash_len,created_at FROM platform_admins ORDER BY created_at DESC');
    res.json({count:r.rows.length,admins:r.rows});
  }catch(e){res.status(500).json({error:e.message,stack:e.stack});}
});
// DEBUG: test credentials without creating a session
router.post('/admins-test',async(req,res)=>{
  try{const{phone,password}=req.body||{};const p=(phone||'').trim();const pw=(password||'').trim();
    const digits=p.replace(/[^0-9]/g,'');const last9=digits.slice(-9);
    const all=(await pool.query('SELECT id,phone,is_active,password_hash FROM platform_admins')).rows;
    const admin=all.find(r=>{const rp=(r.phone||'').toString();const rd=rp.replace(/[^0-9]/g,'');return rp.trim()===p||rd===digits||(last9&&rd.slice(-9)===last9);});
    const pwOk=admin?await bcrypt.compare(pw,admin.password_hash||''):false;
    res.json({input_phone:p,input_digits:digits,total_rows:all.length,rows:all.map(r=>({phone:r.phone,active:r.is_active,hash_len:(r.password_hash||'').length})),matched:!!admin,matched_phone:admin?.phone,matched_active:admin?.is_active,password_match:pwOk});
  }catch(e){res.status(500).json({error:e.message});}
});

router.get('/admins', authMiddleware(['platform_admin']), async (req, res) => {
  try { await ensureAdminsTable();
    const r = await pool.query('SELECT id,full_name,phone,email,role,is_active,created_at FROM platform_admins ORDER BY created_at DESC');
    res.json({ admins: r.rows.map(a=>({...a,name:a.full_name})) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/admins', authMiddleware(['platform_admin']), async (req, res) => {
  console.log('[POST /admins] body:', JSON.stringify(req.body));
  try { await ensureAdminsTable();
    const { full_name, name, phone, email, password, role } = req.body || {};
    const fn = (full_name||name||'').trim();
    const ph = (phone||'').trim();
    const pw = (password||'').trim();
    console.log('[POST /admins] parsed → fn:',fn,'phone:',ph,'pw_len:',pw.length);
    if (!ph || !pw) return res.status(400).json({ error: 'Phone and password are required' });
    const existing = await pool.query('SELECT id FROM platform_admins WHERE phone=$1',[ph]);
    console.log('[POST /admins] existing:',existing.rows.length);
    if (existing.rows[0]) return res.status(409).json({ error: 'An admin with this phone already exists' });
    const hash = await bcrypt.hash(pw, 10);
    console.log('[POST /admins] hashed, len:', hash.length);
    const r = await pool.query(
      'INSERT INTO platform_admins(full_name,phone,email,password_hash,role,is_active) VALUES ($1,$2,$3,$4,$5,TRUE) RETURNING id,full_name,phone,email,role,is_active,created_at',
      [fn, ph, email||null, hash, role||'platform_admin']
    );
    console.log('[POST /admins] inserted id:', r.rows[0]?.id);
    const verify = await pool.query('SELECT COUNT(*)::int c FROM platform_admins');
    console.log('[POST /admins] total rows after insert:', verify.rows[0].c);
    res.json({ ok: true, admin: { ...r.rows[0], name: r.rows[0].full_name }, total_admins: verify.rows[0].c });
  } catch (e) { console.error('[POST /admins] ERROR:', e.message, e.stack); res.status(500).json({ error: e.message }); }
});
router.delete('/admins/:id', authMiddleware(['platform_admin']), async (req, res) => {
  try { await pool.query('DELETE FROM platform_admins WHERE id=$1',[req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.patch('/admins/:id/toggle', authMiddleware(['platform_admin']), async (req, res) => {
  try { const r = await pool.query('UPDATE platform_admins SET is_active=NOT is_active,updated_at=NOW() WHERE id=$1 RETURNING id,full_name,phone,email,role,is_active',[req.params.id]);
    res.json({ ...r.rows[0], name: r.rows[0]?.full_name }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports=router;
