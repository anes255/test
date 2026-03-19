const pool=require('./db');
const initDb=async()=>{
  try{
    const r=await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");
    console.log('DB:',r.rows.length,'tables');
    // Auto-add config column if missing
    try{await pool.query("ALTER TABLE stores ADD COLUMN IF NOT EXISTS config JSONB DEFAULT '{}'::jsonb");console.log('✅ config column ready');}catch(e){console.log('config col:',e.message);}
  }catch(e){console.error('DB init error:',e.message);}
};
module.exports={initDb};
