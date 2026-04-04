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
app.get('/api/platform-info',async(req,res)=>{try{const r=await pool.query('SELECT * FROM platform_settings LIMIT 1');const s=r.rows[0]||{};res.json({site_name:s.site_name||'KyoMarket',site_logo:s.logo_url,primary_color:s.primary_color||'#7C3AED',secondary_color:s.secondary_color||'#06B6D4',accent_color:s.accent_color||'#F59E0B',meta_description:s.meta_description,favicon:s.favicon_url,maintenance_mode:s.maintenance_mode,currency:s.currency||'DZD',landing_blocks:s.landing_blocks||'[]'});}catch(e){res.json({site_name:'KyoMarket',landing_blocks:'[]'});}});

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

    // Mark carts as abandoned if older than 7 days and not already abandoned
    await pool.query(`UPDATE carts SET is_abandoned=TRUE WHERE is_abandoned=FALSE AND is_recovered=FALSE
      AND updated_at < NOW() - INTERVAL '7 days'`);

    // Find abandoned carts that haven't had recovery sent
    const carts=await pool.query(`SELECT c.*,s.store_name,s.slug,s.config,s.currency
      FROM carts c JOIN stores s ON s.id=c.store_id
      WHERE c.is_abandoned=TRUE AND c.is_recovered=FALSE AND c.recovery_sent_at IS NULL
      AND c.customer_phone IS NOT NULL AND c.customer_phone!=''
      LIMIT 10`);

    if(!carts.rows.length)return;
    console.log(`[Cart Recovery] Found ${carts.rows.length} abandoned carts`);

    const WA_URL=process.env.WA_SERVICE_URL;
    const WA_SECRET=process.env.WA_API_SECRET||'mymarket-wa-secret-2026';

    for(const cart of carts.rows){
      const cfg=cart.config||{};
      if(!cfg.ai_cart_recovery)continue; // Only if cart recovery app is enabled

      let items=cart.items;
      if(typeof items==='string')try{items=JSON.parse(items);}catch{items=[];}
      if(!Array.isArray(items)||!items.length)continue;

      const productNames=items.map(i=>i.name||'منتج').join('، ');
      const total=parseFloat(cart.total)||0;
      const storeName=cart.store_name||'متجرنا';
      const storeUrl=`https://${process.env.FRONTEND_URL||'localhost:3000'}/s/${cart.slug}`;

      const message=`مرحباً ${cart.customer_name||'عزيزي العميل'} 👋

لاحظنا أنك تركت بعض المنتجات في سلة التسوق الخاصة بك في ${storeName}:

🛍️ ${productNames}
💰 المجموع: ${total.toLocaleString()} ${cart.currency||'دج'}

هل تحتاج مساعدة في إتمام طلبك؟ منتجاتك لا تزال متاحة!

🔗 أكمل طلبك الآن: ${storeUrl}

شكراً لك على ثقتك بنا ❤️`;

      // Send via WhatsApp (Railway service)
      if(WA_URL){
        try{
          // Find store's WhatsApp session
          const statusR=await fetch(WA_URL+'/status/'+cart.store_id,{headers:{'x-api-secret':WA_SECRET}});
          const status=await statusR.json();
          if(status.connected){
            const sendR=await fetch(WA_URL+'/send',{method:'POST',headers:{'x-api-secret':WA_SECRET,'Content-Type':'application/json'},
              body:JSON.stringify({storeId:String(cart.store_id),phone:cart.customer_phone,message})});
            const sendResult=await sendR.json();
            console.log(`[Cart Recovery] WhatsApp to ${cart.customer_phone}: ${sendResult.success?'SENT':'FAILED'}`);

            // Log message
            try{await pool.query('INSERT INTO message_log(store_id,channel,recipient,message,status,error) VALUES($1,$2,$3,$4,$5,$6)',
              [cart.store_id,'whatsapp',cart.customer_phone,message.substring(0,200),sendResult.success?'sent':'failed',sendResult.reason||null]);}catch{}
          }
        }catch(e){console.log('[Cart Recovery] WA error:',e.message);}
      }

      // Mark recovery sent
      await pool.query('UPDATE carts SET recovery_sent_at=NOW() WHERE id=$1',[cart.id]);
    }
  }catch(e){console.log('[Cart Recovery Error]',e.message);}
};

// Run every hour
setInterval(abandonedCartCheck,60*60*1000);
// First run after 30 seconds
setTimeout(abandonedCartCheck,30000);
console.log('✅ Abandoned cart recovery cron started (every 1h, 7-day threshold)');
});
module.exports=app;
