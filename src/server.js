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
app.get('/api/platform-info',async(req,res)=>{try{const r=await pool.query('SELECT * FROM platform_settings LIMIT 1');const s=r.rows[0]||{};res.json({site_name:s.site_name||'KyoMarket',site_logo:s.logo_url,primary_color:s.primary_color||'#7C3AED',secondary_color:s.secondary_color||'#06B6D4',accent_color:s.accent_color||'#F59E0B',meta_description:s.meta_description,favicon:s.favicon_url,maintenance_mode:s.maintenance_mode,currency:s.currency||'DZD'});}catch(e){res.json({site_name:'KyoMarket'});}});

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
];
for(const[path,file]of routes){try{app.use(path,require(file));console.log('✅',path);}catch(e){console.error('❌',file,e.message);}}

// Error handlers
app.use((err,req,res,next)=>{console.error(err.message);res.status(500).json({error:err.message});});
app.use((req,res)=>res.status(404).json({error:'Not found',path:req.path}));

// Start
const{initDb}=require('./config/initDb');
const PORT=process.env.PORT||5000;
app.listen(PORT,async()=>{console.log(`🚀 Port ${PORT}`);try{await initDb();}catch(e){console.error(e.message);}});
module.exports=app;
