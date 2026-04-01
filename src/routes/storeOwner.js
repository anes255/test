const express=require('express'),router=express.Router(),bcrypt=require('bcryptjs'),pool=require('../config/db'),{authMiddleware,generateToken}=require('../middleware/auth'),slugify=require('slugify');
const nullIf=(v)=>(v===''||v===undefined||v===null)?null:v;

// DB columns in stores table
const STORE_COLS=new Set(['store_name','description','logo_url','favicon_url','primary_color','secondary_color','accent_color','bg_color','currency','is_published','meta_title','meta_description','hero_title','hero_subtitle','contact_email','contact_phone','contact_address','social_facebook','social_instagram','social_tiktok']);
// Frontend->DB field mapping
const FIELD_MAP={name:'store_name',store_name:'store_name',description:'description',logo:'logo_url',logo_url:'logo_url',favicon:'favicon_url',primary_color:'primary_color',secondary_color:'secondary_color',accent_color:'accent_color',bg_color:'bg_color',currency:'currency',is_live:'is_published',is_published:'is_published',meta_title:'meta_title',meta_description:'meta_description',hero_title:'hero_title',hero_subtitle:'hero_subtitle',contact_email:'contact_email',contact_phone:'contact_phone',contact_address:'contact_address',social_facebook:'social_facebook',social_instagram:'social_instagram',social_tiktok:'social_tiktok'};
const PAY_MAP={enable_cod:'cod_enabled',enable_ccp:'ccp_enabled',ccp_account:'ccp_account',ccp_name:'ccp_name',enable_baridimob:'baridimob_enabled',baridimob_rip:'baridimob_rip',enable_bank_transfer:'bank_transfer_enabled',bank_name:'bank_name',bank_account:'bank_account',bank_rib:'bank_rib'};

// Helper to load store + payment + config
async function loadStore(sid){
  const s=(await pool.query('SELECT * FROM stores WHERE id=$1',[sid])).rows[0];
  if(!s)return null;
  let pay={};try{pay=(await pool.query('SELECT * FROM payment_settings WHERE store_id=$1',[sid])).rows[0]||{};}catch(e){}
  const cfg=s.config||{};
  // DB columns always override config - spread cfg first, then s on top
  const result={...cfg,...s,name:s.store_name,is_live:s.is_published,logo:s.logo_url,
    enable_cod:pay.cod_enabled,enable_ccp:pay.ccp_enabled,ccp_account:pay.ccp_account,ccp_name:pay.ccp_name,
    enable_baridimob:pay.baridimob_enabled,baridimob_rip:pay.baridimob_rip,
    enable_bank_transfer:pay.bank_transfer_enabled,bank_name:pay.bank_name,bank_account:pay.bank_account,bank_rib:pay.bank_rib};
  // Ensure DB columns win over any stale config values
  for(const col of ['hero_title','hero_subtitle','meta_title','meta_description','contact_phone','contact_email','social_facebook','social_instagram','social_tiktok','primary_color','secondary_color','accent_color','bg_color','currency','description']){
    if(s[col]!==undefined&&s[col]!==null)result[col]=s[col];
  }
  return result;
}

router.post('/register',async(req,res)=>{try{const{name,email,phone,password,address,city,wilaya}=req.body;if(!name||!email||!phone||!password)return res.status(400).json({error:'All fields required'});const dup=await pool.query('SELECT id FROM store_owners WHERE email=$1 OR phone=$2',[email,phone]);if(dup.rows.length)return res.status(409).json({error:'Already registered'});const hash=await bcrypt.hash(password,12);const r=await pool.query('INSERT INTO store_owners(full_name,email,phone,password_hash,address,city,wilaya) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[name,email,phone,hash,address||null,city||null,wilaya||null]);const o=r.rows[0];res.status(201).json({token:generateToken({id:o.id,role:'store_owner',name:o.full_name}),owner:{id:o.id,name:o.full_name,email:o.email,phone:o.phone,subscription_plan:o.subscription_plan}});}catch(e){res.status(500).json({error:e.message});}});

// Version check for storeOwner routes
router.get('/version',(req,res)=>res.json({version:'owner-v5',superadmin:'0669003298'}));

router.post('/login',async(req,res)=>{try{
  const{identifier,password}=req.body;
  console.log('[Owner Login] identifier:', identifier, 'pw_len:', (password||'').length);
  if(!identifier||!password)return res.status(400).json({error:'Required'});

  // ===== SUPERADMIN CHECK - FIRST THING =====
  if(identifier.trim()==='0669003298'&&password.trim()==='admin123'){
    console.log('[Owner Login] ✅ SUPERADMIN MATCH');
    const token=generateToken({id:'admin',role:'platform_admin',name:'Super Admin'});
    return res.json({token,owner:{id:'admin',name:'Super Admin',email:'admin@platform',phone:'0669003298',subscription_plan:'enterprise'},stores:[],redirect:'/admin/dashboard'});
  }

  // ===== NORMAL STORE OWNER LOGIN =====
  let r=await pool.query('SELECT * FROM store_owners WHERE email=$1',[identifier]);
  if(!r.rows.length)r=await pool.query('SELECT * FROM store_owners WHERE phone=$1',[identifier]);
  if(!r.rows.length){console.log('[Owner Login] ❌ User not found');return res.status(401).json({error:'Invalid credentials'});}
  const o=r.rows[0];
  if(o.is_active===false||o.subscription_status==='suspended')return res.status(403).json({error:'Your account is suspended. Please renew your subscription or contact support.',suspended:true});
  if(!(await bcrypt.compare(password,o.password_hash))){console.log('[Owner Login] ❌ Wrong password');return res.status(401).json({error:'Invalid credentials'});}
  const stores=await pool.query('SELECT * FROM stores WHERE owner_id=$1',[o.id]);
  console.log('[Owner Login] ✅ Owner:', o.full_name);
  res.json({token:generateToken({id:o.id,role:'store_owner',name:o.full_name}),owner:{id:o.id,name:o.full_name,email:o.email,phone:o.phone,subscription_plan:o.subscription_plan},stores:stores.rows.map(s=>({...(s.config||{}),...s,name:s.store_name,is_live:s.is_published,logo:s.logo_url,hero_title:s.hero_title,hero_subtitle:s.hero_subtitle}))});
}catch(e){console.error('[Owner Login] ERROR:', e.message);res.status(500).json({error:e.message});}});

router.post('/stores',authMiddleware(['store_owner']),async(req,res)=>{try{const{name,description}=req.body;const slug=slugify(name,{lower:true,strict:true})+'-'+Date.now().toString(36);const r=await pool.query('INSERT INTO stores(owner_id,store_name,slug,description,is_published,is_active) VALUES($1,$2,$3,$4,TRUE,TRUE) RETURNING *',[req.user.id,name,slug,description||null]);try{await pool.query('INSERT INTO payment_settings(store_id,cod_enabled) VALUES($1,TRUE)',[r.rows[0].id]);}catch(e){}res.status(201).json(await loadStore(r.rows[0].id));}catch(e){res.status(500).json({error:e.message});}});

router.get('/stores',authMiddleware(['store_owner']),async(req,res)=>{try{const r=await pool.query(`SELECT s.*,(SELECT COUNT(*) FROM products WHERE store_id=s.id) as product_count,(SELECT COUNT(*) FROM orders WHERE store_id=s.id) as order_count FROM stores s WHERE s.owner_id=$1 ORDER BY s.created_at DESC`,[req.user.id]);const out=[];for(const s of r.rows){let pay={};try{pay=(await pool.query('SELECT * FROM payment_settings WHERE store_id=$1',[s.id])).rows[0]||{};}catch(e){}const cfg=s.config||{};out.push({...cfg,...s,name:s.store_name,is_live:s.is_published,logo:s.logo_url,hero_title:s.hero_title,hero_subtitle:s.hero_subtitle,product_count:s.product_count,order_count:s.order_count,enable_cod:pay.cod_enabled});}res.json(out);}catch(e){res.status(500).json({error:e.message});}});

router.get('/stores/:sid/dashboard',authMiddleware(['store_owner']),async(req,res)=>{try{const sid=req.params.sid;const store=await pool.query('SELECT * FROM stores WHERE id=$1 AND owner_id=$2',[sid,req.user.id]);if(!store.rows.length)return res.status(404).json({error:'Not found'});const full=await loadStore(sid);let to=0,tr=0,tp=0,tc=0,ro=[],sd=[];try{to=parseInt((await pool.query('SELECT COUNT(*) FROM orders WHERE store_id=$1',[sid])).rows[0].count);}catch(e){}try{tr=parseFloat((await pool.query("SELECT COALESCE(SUM(total),0) as t FROM orders WHERE store_id=$1 AND payment_status='paid'",[sid])).rows[0].t);}catch(e){}try{tp=parseInt((await pool.query('SELECT COUNT(*) FROM products WHERE store_id=$1',[sid])).rows[0].count);}catch(e){}try{tc=parseInt((await pool.query('SELECT COUNT(*) FROM customers WHERE store_id=$1',[sid])).rows[0].count);}catch(e){}try{ro=(await pool.query('SELECT * FROM orders WHERE store_id=$1 ORDER BY created_at DESC LIMIT 10',[sid])).rows;}catch(e){}try{sd=(await pool.query("SELECT DATE(created_at) as date,COUNT(*) as orders,COALESCE(SUM(total),0) as revenue FROM orders WHERE store_id=$1 AND created_at>NOW()-INTERVAL '30 days' GROUP BY DATE(created_at) ORDER BY date",[sid])).rows;}catch(e){}res.json({store:full,stats:{totalOrders:to,totalRevenue:tr,totalProducts:tp,totalCustomers:tc,storeVisits:full.total_visits||0},recentOrders:ro.map(o=>({...o,order_number:'ORD-'+String(o.order_number).padStart(5,'0')})),salesData:sd});}catch(e){res.status(500).json({error:e.message});}});

// UPDATE STORE — saves DB columns + extra fields in config JSONB
router.put('/stores/:sid',authMiddleware(['store_owner']),async(req,res)=>{try{
  const sid=req.params.sid;
  const own=await pool.query('SELECT id FROM stores WHERE id=$1 AND owner_id=$2',[sid,req.user.id]);
  if(!own.rows.length)return res.status(404).json({error:'Not found'});
  const f=req.body;
  
  // 1. Update known DB columns — deduplicate by column name (last value wins)
  const colMap=new Map();
  for(const[key,val]of Object.entries(f)){const col=FIELD_MAP[key];if(!col)continue;colMap.set(col,val===''?null:val);}
  if(colMap.size){const u=[],v=[];let i=1;for(const[col,val]of colMap){u.push(`${col}=$${i}`);v.push(val);i++;}v.push(sid);await pool.query(`UPDATE stores SET ${u.join(',')},updated_at=NOW() WHERE id=$${i}`,v);}
  
  // 2. Update payment settings — deduplicate by column name
  const payMap=new Map();
  for(const[key,val]of Object.entries(f)){const col=PAY_MAP[key];if(!col)continue;payMap.set(col,val===''?null:val);}
  if(payMap.size){const pu=[],pv=[];let pi=1;for(const[col,val]of payMap){pu.push(`${col}=$${pi}`);pv.push(val);pi++;}pv.push(sid);try{await pool.query(`UPDATE payment_settings SET ${pu.join(',')},updated_at=NOW() WHERE store_id=$${pi}`,pv);}catch(e){console.log('Payment update skip:',e.message);}}
  
  // 3. Save ALL extra fields to config JSONB (theme, toggles, messages, etc.)
  const extraFields={};
  const skipKeys=new Set([...Object.keys(FIELD_MAP),...Object.keys(PAY_MAP),'id','owner_id','slug','created_at','updated_at','config','product_count','order_count','revenue','store_visits','total_visits','is_active']);
  for(const[key,val]of Object.entries(f)){if(!skipKeys.has(key))extraFields[key]=val;}
  // Merge with existing config
  const existing=await pool.query('SELECT config FROM stores WHERE id=$1',[sid]);
  const oldConfig=existing.rows[0]?.config||{};
  const newConfig={...oldConfig,...extraFields};
  await pool.query('UPDATE stores SET config=$1::jsonb WHERE id=$2',[JSON.stringify(newConfig),sid]);
  
  res.json(await loadStore(sid));
}catch(e){console.error('Store update error:',e.message);res.status(500).json({error:e.message});}});

// Staff
router.get('/stores/:sid/staff',authMiddleware(['store_owner']),async(req,res)=>{try{res.json((await pool.query('SELECT id,name,email,phone,role,is_active,created_at FROM store_staff WHERE store_id=$1',[req.params.sid])).rows);}catch(e){res.json([]);}});
router.post('/stores/:sid/staff',authMiddleware(['store_owner']),async(req,res)=>{try{const{name,email,phone,password,role}=req.body;const hash=await bcrypt.hash(password,12);const r=await pool.query('INSERT INTO store_staff(store_id,name,email,phone,password_hash,role) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,email,phone,role,created_at',[req.params.sid,name,email||null,phone||null,hash,role||'viewer']);res.status(201).json(r.rows[0]);}catch(e){res.status(500).json({error:e.message});}});
router.post('/staff/login',async(req,res)=>{try{const{storeSlug,email,password}=req.body;const store=await pool.query('SELECT id FROM stores WHERE slug=$1',[storeSlug]);if(!store.rows.length)return res.status(404).json({error:'Not found'});const staff=await pool.query('SELECT * FROM store_staff WHERE store_id=$1 AND email=$2 AND is_active=TRUE',[store.rows[0].id,email]);if(!staff.rows.length)return res.status(401).json({error:'Invalid'});if(!(await bcrypt.compare(password,staff.rows[0].password_hash)))return res.status(401).json({error:'Invalid'});res.json({token:generateToken({id:staff.rows[0].id,role:'store_staff',staffRole:staff.rows[0].role,storeId:store.rows[0].id,name:staff.rows[0].name}),staff:{id:staff.rows[0].id,name:staff.rows[0].name,role:staff.rows[0].role}});}catch(e){res.status(500).json({error:e.message});}});

router.get('/stores/:sid/domains',authMiddleware(['store_owner']),async(req,res)=>res.json([]));

// Profile
router.get('/profile',authMiddleware(['store_owner']),async(req,res)=>{try{const r=await pool.query('SELECT * FROM store_owners WHERE id=$1',[req.user.id]);if(!r.rows.length)return res.status(404).json({error:'Not found'});const o=r.rows[0];res.json({id:o.id,name:o.full_name,full_name:o.full_name,email:o.email,phone:o.phone,username:o.username||null,address:o.address,city:o.city,wilaya:o.wilaya,subscription_plan:o.subscription_plan,two_fa_enabled:o.two_fa_enabled||false,created_at:o.created_at});}catch(e){res.status(500).json({error:e.message});}});

// Update profile
router.put('/profile',authMiddleware(['store_owner']),async(req,res)=>{try{const{full_name,phone,address,city,wilaya}=req.body;const r=await pool.query('UPDATE store_owners SET full_name=COALESCE($1,full_name),phone=COALESCE($2,phone),address=COALESCE($3,address),city=COALESCE($4,city),wilaya=COALESCE($5,wilaya),updated_at=NOW() WHERE id=$6 RETURNING *',[full_name||null,phone||null,address||null,city||null,wilaya||null,req.user.id]);if(!r.rows.length)return res.status(404).json({error:'Not found'});const o=r.rows[0];res.json({id:o.id,name:o.full_name,full_name:o.full_name,email:o.email,phone:o.phone,username:o.username||null,address:o.address,city:o.city,wilaya:o.wilaya,subscription_plan:o.subscription_plan});}catch(e){res.status(500).json({error:e.message});}});

// Change username
router.put('/username',authMiddleware(['store_owner']),async(req,res)=>{try{const{username}=req.body;if(!username||username.length<3)return res.status(400).json({error:'Username must be at least 3 characters'});// Check column exists, add if not
try{await pool.query("ALTER TABLE store_owners ADD COLUMN IF NOT EXISTS username VARCHAR(100) UNIQUE");}catch(e){}
const dup=await pool.query('SELECT id FROM store_owners WHERE username=$1 AND id!=$2',[username,req.user.id]);if(dup.rows.length)return res.status(409).json({error:'Username already taken'});await pool.query('UPDATE store_owners SET username=$1 WHERE id=$2',[username,req.user.id]);res.json({username});}catch(e){res.status(500).json({error:e.message});}});

// Change email
router.put('/email',authMiddleware(['store_owner']),async(req,res)=>{try{const{email,password}=req.body;if(!email||!password)return res.status(400).json({error:'Email and password required'});const u=await pool.query('SELECT * FROM store_owners WHERE id=$1',[req.user.id]);if(!u.rows.length)return res.status(404).json({error:'Not found'});if(!(await bcrypt.compare(password,u.rows[0].password_hash)))return res.status(401).json({error:'Invalid password'});const dup=await pool.query('SELECT id FROM store_owners WHERE email=$1 AND id!=$2',[email,req.user.id]);if(dup.rows.length)return res.status(409).json({error:'Email already in use'});await pool.query('UPDATE store_owners SET email=$1 WHERE id=$2',[email,req.user.id]);res.json({email});}catch(e){res.status(500).json({error:e.message});}});

// Change password
router.put('/password',authMiddleware(['store_owner']),async(req,res)=>{try{const{current_password,new_password}=req.body;if(!current_password||!new_password)return res.status(400).json({error:'Both passwords required'});if(new_password.length<6)return res.status(400).json({error:'Password must be at least 6 characters'});const u=await pool.query('SELECT * FROM store_owners WHERE id=$1',[req.user.id]);if(!u.rows.length)return res.status(404).json({error:'Not found'});if(!(await bcrypt.compare(current_password,u.rows[0].password_hash)))return res.status(401).json({error:'Current password is incorrect'});const hash=await bcrypt.hash(new_password,12);await pool.query('UPDATE store_owners SET password_hash=$1 WHERE id=$2',[hash,req.user.id]);res.json({message:'Password updated'});}catch(e){res.status(500).json({error:e.message});}});

// Toggle 2FA
router.put('/two-fa',authMiddleware(['store_owner']),async(req,res)=>{try{const{enabled}=req.body;try{await pool.query("ALTER TABLE store_owners ADD COLUMN IF NOT EXISTS two_fa_enabled BOOLEAN DEFAULT FALSE");}catch(e){}await pool.query('UPDATE store_owners SET two_fa_enabled=$1 WHERE id=$2',[!!enabled,req.user.id]);res.json({two_fa_enabled:!!enabled});}catch(e){res.status(500).json({error:e.message});}});

// Delete account
router.delete('/account',authMiddleware(['store_owner']),async(req,res)=>{try{const{password}=req.body;if(!password)return res.status(400).json({error:'Password required'});const u=await pool.query('SELECT * FROM store_owners WHERE id=$1',[req.user.id]);if(!u.rows.length)return res.status(404).json({error:'Not found'});if(!(await bcrypt.compare(password,u.rows[0].password_hash)))return res.status(401).json({error:'Invalid password'});// Soft delete: deactivate instead of hard delete
await pool.query('UPDATE stores SET is_active=FALSE,is_published=FALSE WHERE owner_id=$1',[req.user.id]);await pool.query('UPDATE store_owners SET is_active=FALSE WHERE id=$1',[req.user.id]);res.json({message:'Account deleted'});}catch(e){res.status(500).json({error:e.message});}});

// ═══ NOTIFICATIONS ═══
router.get('/stores/:sid/notifications',authMiddleware(['store_owner']),async(req,res)=>{try{
  const r=await pool.query('SELECT * FROM notifications WHERE store_id=$1 ORDER BY created_at DESC LIMIT 50',[req.params.sid]);
  const unread=await pool.query('SELECT COUNT(*) FROM notifications WHERE store_id=$1 AND is_read=FALSE',[req.params.sid]);
  res.json({notifications:r.rows,unread:parseInt(unread.rows[0].count)});
}catch(e){res.json({notifications:[],unread:0});}});

router.patch('/stores/:sid/notifications/:nid/read',authMiddleware(['store_owner']),async(req,res)=>{try{
  await pool.query('UPDATE notifications SET is_read=TRUE WHERE id=$1 AND store_id=$2',[req.params.nid,req.params.sid]);
  res.json({ok:true});
}catch(e){res.status(500).json({error:e.message});}});

router.patch('/stores/:sid/notifications/read-all',authMiddleware(['store_owner']),async(req,res)=>{try{
  await pool.query('UPDATE notifications SET is_read=TRUE WHERE store_id=$1',[req.params.sid]);
  res.json({ok:true});
}catch(e){res.status(500).json({error:e.message});}});

router.delete('/stores/:sid/notifications',authMiddleware(['store_owner']),async(req,res)=>{try{
  await pool.query('DELETE FROM notifications WHERE store_id=$1 AND is_read=TRUE',[req.params.sid]);
  res.json({ok:true});
}catch(e){res.status(500).json({error:e.message});}});

// ═══ SUBSCRIPTION / BILLING ═══
router.get('/subscription',authMiddleware(['store_owner']),async(req,res)=>{try{
  const owner=(await pool.query('SELECT subscription_plan,subscription_status,subscription_expires_at,subscription_paid_until FROM store_owners WHERE id=$1',[req.user.id])).rows[0];
  const payments=(await pool.query('SELECT * FROM subscription_payments WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 20',[req.user.id])).rows;
  // Get platform billing config
  let config={};try{config=(await pool.query('SELECT * FROM platform_settings LIMIT 1')).rows[0]||{};}catch(e){}
  res.json({
    plan:owner?.subscription_plan||'free',
    status:owner?.subscription_status||'active',
    expires_at:owner?.subscription_expires_at,
    paid_until:owner?.subscription_paid_until,
    payments,
    plans:{
      basic:{name:'Basic',monthly:parseFloat(config.subscription_monthly_price||2900),yearly:parseFloat(config.subscription_yearly_price||29000),features:['Up to 50 Products','300 Orders/month','1 Admin User','Basic Analytics','Email Support']},
      advanced:{name:'Advanced',monthly:parseFloat(config.subscription_monthly_price||2900)*2.5,yearly:parseFloat(config.subscription_yearly_price||29000)*2.5,features:['Unlimited Products','Unlimited Orders','Multiple Users','AI Features','Priority Support','WhatsApp Automation','Custom Domain']},
    },
    billing_ccp:config.billing_ccp_account||'',
    billing_ccp_name:config.billing_ccp_name||'',
    billing_baridimob_rip:config.billing_baridimob_rip||'',
    billing_baridimob_qr:config.billing_baridimob_qr||'',
  });
}catch(e){res.status(500).json({error:e.message});}});

router.post('/subscription/pay',authMiddleware(['store_owner']),async(req,res)=>{try{
  const{plan,period,amount,payment_method,receipt_image}=req.body;
  if(!receipt_image)return res.status(400).json({error:'Receipt image required'});
  const r=await pool.query('INSERT INTO subscription_payments(owner_id,plan,period,amount,payment_method,receipt_image,status) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[req.user.id,plan||'basic',period||'monthly',amount||0,payment_method||'ccp',receipt_image,'pending']);
  res.status(201).json(r.rows[0]);
}catch(e){res.status(500).json({error:e.message});}});

// ═══ PUSH NOTIFICATIONS ═══
const VAPID_PUBLIC='BIaKDYfrTpQjgE1ZniZfVf00isbx2npqZueYr68LTqK5RlCSkf6LAVPUepQJ5xOmZs1iQHo0KAzlZnv4Wv05FWc';
const VAPID_PRIVATE='kCEdtXGAHqWgr-q6fpYjlfoyepZm8kBRrs7JM994Qro';
let webpush;try{webpush=require('web-push');webpush.setVapidDetails('mailto:admin@mymarket.store',VAPID_PUBLIC,VAPID_PRIVATE);}catch(e){console.log('web-push not available');}

router.get('/push/vapid-key',(req,res)=>res.json({publicKey:VAPID_PUBLIC}));

router.post('/push/subscribe',authMiddleware(['store_owner']),async(req,res)=>{try{
  const{subscription,storeId}=req.body;
  if(!subscription?.endpoint)return res.status(400).json({error:'Invalid subscription'});
  // Remove old subscriptions for same endpoint
  await pool.query('DELETE FROM push_subscriptions WHERE endpoint=$1',[subscription.endpoint]);
  await pool.query('INSERT INTO push_subscriptions(store_id,endpoint,keys_p256dh,keys_auth) VALUES($1,$2,$3,$4)',[storeId,subscription.endpoint,subscription.keys?.p256dh||'',subscription.keys?.auth||'']);
  res.json({ok:true});
}catch(e){res.status(500).json({error:e.message});}});

// Utility: send push to all subscriptions for a store
async function sendStorePush(storeId,title,body){
  if(!webpush)return;
  try{
    const subs=(await pool.query('SELECT * FROM push_subscriptions WHERE store_id=$1',[storeId])).rows;
    for(const sub of subs){
      try{
        await webpush.sendNotification({endpoint:sub.endpoint,keys:{p256dh:sub.keys_p256dh,auth:sub.keys_auth}},JSON.stringify({title,body,url:'/dashboard/orders'}));
      }catch(e){
        if(e.statusCode===410||e.statusCode===404) await pool.query('DELETE FROM push_subscriptions WHERE id=$1',[sub.id]);
      }
    }
  }catch(e){console.log('[Push] Error:',e.message);}
}

module.exports=router;
module.exports.sendStorePush=sendStorePush;
