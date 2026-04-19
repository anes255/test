const express=require('express'),compression=require('compression'),cookieParser=require('cookie-parser'),rateLimit=require('express-rate-limit');
require('dotenv').config();
const app=express();

// CORS — raw headers, first thing
app.use((req,res,next)=>{res.setHeader('Access-Control-Allow-Origin',req.headers.origin||'*');res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,PATCH,DELETE,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization,x-store-slug');res.setHeader('Access-Control-Allow-Credentials','true');if(req.method==='OPTIONS')return res.status(204).end();next();});

app.use(compression());app.use(cookieParser());app.use(express.json({limit:'50mb'}));app.use(express.urlencoded({extended:true,limit:'50mb'}));
app.use('/api/',rateLimit({windowMs:15*60*1000,max:1000}));

const pool=require('./config/db');

// Root + health
app.get('/',(req,res)=>res.json({name:'KyoMarket API',status:'running'}));
app.get('/favicon.ico',(req,res)=>res.status(204).end());
app.get('/api/health',(req,res)=>res.json({status:'ok'}));

// Platform info
app.get('/api/platform-info',async(req,res)=>{try{const r=await pool.query('SELECT * FROM platform_settings LIMIT 1');const s=r.rows[0]||{};res.json({site_name:s.site_name||'KyoMarket',site_logo:s.logo_url,primary_color:s.primary_color||'#7C3AED',secondary_color:s.secondary_color||'#06B6D4',accent_color:s.accent_color||'#F59E0B',meta_description:s.meta_description,favicon:s.favicon_url,maintenance_mode:s.maintenance_mode,currency:s.currency||'DZD',landing_blocks:s.landing_blocks||'[]',google_client_id:s.google_client_id||'',trial_days:parseInt(s.subscription_trial_days||0,10)||14,trial_enabled:s.subscription_trial_enabled!==false});}catch(e){res.json({site_name:'KyoMarket',landing_blocks:'[]',trial_days:14,trial_enabled:true});}});

// Schema dump (debug)
app.get('/api/dump-schema',async(req,res)=>{try{const t=await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");const s={};for(const r of t.rows){const c=await pool.query("SELECT column_name,data_type FROM information_schema.columns WHERE table_name=$1",[r.table_name]);s[r.table_name]=c.rows.map(x=>x.column_name);}res.json(s);}catch(e){res.status(500).json({error:e.message});}});

// Load routes
const routes=[
  ['/api/platform','./routes/platformAdmin'],
  ['/api/owner','./routes/storeOwner'],
  ['/api/manage','./routes/products'],
  ['/api/manage','./routes/orders'],
  ['/api/store','./routes/storefront'],
  ['/api/ai','./routes/ai'],
  ['/api/payments','./routes/payments'],
];
for(const[path,file]of routes){try{app.use(path,require(file));console.log('✅',path);}catch(e){console.error('❌',file,e.message);}}

// Error handlers
app.use((err,req,res,next)=>{console.error(err.message);res.status(500).json({error:err.message});});
app.use((req,res)=>res.status(404).json({error:'Not found',path:req.path}));

// Start
const{initDb}=require('./config/initDb');
const PORT=process.env.PORT||5000;
app.listen(PORT,async()=>{console.log(`🚀 Port ${PORT}`);try{await initDb();}catch(e){console.error(e.message);}console.log('WA_SERVICE_URL:',process.env.WA_SERVICE_URL||'NOT SET');

// ═══ ABANDONED CART RECOVERY CRON ═══
const abandonedCartCheck=async()=>{
  try{
    const pool=require('./config/db');
    let messaging;
    try{messaging=require('./services/messaging');}catch(e){/* messaging service unavailable */}

    // Mark carts as abandoned if older than 7 days and not already abandoned
    await pool.query(`UPDATE carts SET is_abandoned=TRUE WHERE is_abandoned=FALSE AND is_recovered=FALSE
      AND updated_at < NOW() - INTERVAL '7 days'`);

    // Find abandoned carts that haven't had recovery sent.
    // Include carts that have either a phone or email so we can reach them.
    const carts=await pool.query(`SELECT c.*,s.store_name,s.slug,s.config,s.currency
      FROM carts c JOIN stores s ON s.id=c.store_id
      WHERE c.is_abandoned=TRUE AND c.is_recovered=FALSE AND c.recovery_sent_at IS NULL
      AND (c.customer_phone IS NOT NULL AND c.customer_phone!='')
      LIMIT 10`);

    if(!carts.rows.length)return;
    console.log(`[Cart Recovery] Found ${carts.rows.length} abandoned carts`);

    const WA_URL=process.env.WA_SERVICE_URL;
    const WA_SECRET=process.env.WA_API_SECRET||'mymarket-wa-secret-2026';

    for(const cart of carts.rows){
      const cfg=cart.config||{};
      if(!cfg.ai_cart_recovery)continue; // Only if cart recovery is enabled for this store

      let items=cart.items;
      if(typeof items==='string')try{items=JSON.parse(items);}catch{items=[];}
      if(!Array.isArray(items)||!items.length)continue;

      const productNames=items.map(i=>i.name||'Product').join(', ');
      const total=parseFloat(cart.total)||0;
      const storeName=cart.store_name||'Our Store';
      const baseUrl=process.env.FRONTEND_URL||'localhost:5173';
      const storeUrl=baseUrl.includes('://')?`${baseUrl}/s/${cart.slug}`:`https://${baseUrl}/s/${cart.slug}`;
      const itemCount=items.reduce((s,i)=>s+(i.quantity||1),0);
      const currency=cart.currency||'DZD';
      const customerName=cart.customer_name||'Valued Customer';

      // WhatsApp message (Arabic)
      const waMessage=`مرحباً ${customerName} 👋\n\nلاحظنا أنك تركت بعض المنتجات في سلة التسوق الخاصة بك في ${storeName}:\n\n🛍️ ${productNames}\n💰 المجموع: ${total.toLocaleString()} ${currency}\n\nهل تحتاج مساعدة في إتمام طلبك؟ منتجاتك لا تزال متاحة!\n\n🔗 أكمل طلبك الآن: ${storeUrl}\n\nشكراً لك على ثقتك بنا ❤️`;

      // Email HTML
      const emailHtml=`<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
        <h2 style="color:#333;">Hi ${customerName}! 👋</h2>
        <p style="color:#555;font-size:15px;">We noticed you left some items in your shopping cart at <strong>${storeName}</strong>. Your products are still available!</p>
        <div style="background:#f8f8f8;border-radius:12px;padding:16px;margin:20px 0;">
          <p style="font-weight:bold;color:#333;margin:0 0 8px 0;">🛍️ Your cart (${itemCount} item${itemCount>1?'s':''}):</p>
          ${items.map(i=>`<div style="display:flex;align-items:center;padding:8px 0;border-bottom:1px solid #eee;"><span style="flex:1;color:#333;">${i.name||'Product'} × ${i.quantity||1}</span><span style="font-weight:bold;color:#333;">${((parseFloat(i.price)||0)*(i.quantity||1)).toLocaleString()} ${currency}</span></div>`).join('')}
          <div style="text-align:right;padding:12px 0 0;"><strong style="font-size:18px;color:#7C3AED;">Total: ${total.toLocaleString()} ${currency}</strong></div>
        </div>
        <a href="${storeUrl}" style="display:inline-block;padding:14px 32px;background:#7C3AED;color:#fff;text-decoration:none;border-radius:12px;font-weight:bold;font-size:16px;">Complete Your Order →</a>
        <p style="color:#888;font-size:12px;margin-top:24px;">If you need help, just reply to this email. Thank you for shopping with us! ❤️</p>
      </div>`;

      let waSent=false;
      let emailSent=false;

      // 1) Try WhatsApp via Railway service
      if(WA_URL&&cart.customer_phone){
        try{
          const statusR=await fetch(WA_URL+'/status/'+cart.store_id,{headers:{'x-api-secret':WA_SECRET}});
          const status=await statusR.json();
          if(status.connected){
            const sendR=await fetch(WA_URL+'/send',{method:'POST',headers:{'x-api-secret':WA_SECRET,'Content-Type':'application/json'},
              body:JSON.stringify({storeId:String(cart.store_id),phone:cart.customer_phone,message:waMessage})});
            const sendResult=await sendR.json();
            waSent=!!sendResult.success;
            console.log(`[Cart Recovery] WhatsApp to ${cart.customer_phone}: ${waSent?'SENT':'FAILED'}`);
            try{await pool.query('INSERT INTO message_log(store_id,channel,recipient,message_type,message,status,error) VALUES($1,$2,$3,$4,$5,$6,$7)',
              [cart.store_id,'whatsapp',cart.customer_phone,'cart_recovery',waMessage.substring(0,200),waSent?'sent':'failed',sendResult.reason||null]);}catch{}
          }
        }catch(e){console.log('[Cart Recovery] WA error:',e.message);}
      }

      // 2) Try WhatsApp via Meta Cloud API if Railway didn't work
      if(!waSent&&cart.customer_phone&&messaging){
        try{
          const waResult=await messaging.sendWhatsApp(cart.customer_phone,waMessage,cart.store_id);
          if(waResult&&waResult.success){waSent=true;console.log(`[Cart Recovery] WhatsApp (Meta) to ${cart.customer_phone}: SENT`);}
        }catch(e){/* ignore */}
      }

      // 3) Send Email if available (always, as a complement or fallback)
      if(cart.customer_email&&messaging){
        try{
          const emailResult=await messaging.sendEmail({
            to:cart.customer_email,
            subject:`${customerName}, you left items in your cart at ${storeName}!`,
            html:emailHtml,
          });
          emailSent=!!(emailResult&&emailResult.id);
          if(emailSent)console.log(`[Cart Recovery] Email to ${cart.customer_email}: SENT`);
          try{await pool.query('INSERT INTO message_log(store_id,channel,recipient,message_type,message,status) VALUES($1,$2,$3,$4,$5,$6)',
            [cart.store_id,'email',cart.customer_email,'cart_recovery','Cart recovery email',emailSent?'sent':'failed']);}catch{}
        }catch(e){console.log('[Cart Recovery] Email error:',e.message);}
      }

      // Mark recovery sent if at least one channel succeeded
      if(waSent||emailSent){
        await pool.query('UPDATE carts SET recovery_sent_at=NOW() WHERE id=$1',[cart.id]);
      }
    }
  }catch(e){console.log('[Cart Recovery Error]',e.message);}
};

// Run every hour
setInterval(abandonedCartCheck,60*60*1000);
// First run after 30 seconds
setTimeout(abandonedCartCheck,30000);
console.log('✅ Abandoned cart recovery cron started (every 1h, 7-day threshold)');

// ═══ KEEP-ALIVE PING (prevents Render free-tier shutdown) ═══
const SELF_URL=process.env.RENDER_EXTERNAL_URL||process.env.BACKEND_URL||`http://localhost:${PORT}`;
const keepAlive=()=>{
  fetch(`${SELF_URL}/api/health`).then(r=>r.json()).then(()=>console.log('[Keep-Alive] Ping OK')).catch(e=>console.log('[Keep-Alive] Ping failed:',e.message));
};
// Ping every 14 minutes (Render shuts down after 15 min of inactivity)
setInterval(keepAlive,14*60*1000);
console.log(`✅ Keep-alive ping started (every 14min → ${SELF_URL}/api/health)`);
});
module.exports=app;
