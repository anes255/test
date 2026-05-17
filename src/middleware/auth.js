const jwt=require('jsonwebtoken');require('dotenv').config();
const pool=require('../config/db');
const SECRET=process.env.JWT_SECRET||'kyomarket-secret-key-2026-do-not-change';
const authMiddleware=(roles=[])=>(req,res,next)=>{(async()=>{try{const t=req.headers.authorization?.split(' ')[1];if(!t)return res.status(401).json({error:'Auth required'});const d=jwt.verify(t,SECRET);req.user=d;if(roles.length&&!roles.includes(d.role))return res.status(403).json({error:'Forbidden'});
// For platform_admin tokens from the admins table, verify the admin still exists and is active
if(d.role==='platform_admin'&&d.id&&d.id!=='admin'){try{const r=await pool.query('SELECT is_active FROM platform_admins WHERE id=$1',[d.id]);if(!r.rows.length)return res.status(401).json({error:'Admin account deleted'});if(r.rows[0].is_active===false)return res.status(401).json({error:'Admin account deactivated'});}catch(e){/* table may not exist yet, allow through */}}
next();}catch(e){res.status(401).json({error:'Invalid token'});}})();};
const generateToken=(p,exp='30d')=>jwt.sign(p,SECRET,{expiresIn:exp});
module.exports={authMiddleware,generateToken};
