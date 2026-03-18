const pool=require('./db');
const initDb=async()=>{const r=await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");console.log('DB:',r.rows.length,'tables');};
module.exports={initDb};
