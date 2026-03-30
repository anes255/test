const jwt=require('jsonwebtoken');require('dotenv').config();
const SECRET=process.env.JWT_SECRET||'kyomarket-secret-key-2026-do-not-change';
const authMiddleware=(roles=[])=>(req,res,next)=>{try{const t=req.headers.authorization?.split(' ')[1];if(!t)return res.status(401).json({error:'Auth required'});const d=jwt.verify(t,SECRET);req.user=d;if(roles.length&&!roles.includes(d.role))return res.status(403).json({error:'Forbidden'});next();}catch(e){res.status(401).json({error:'Invalid token'});}};
const generateToken=(p,exp='30d')=>jwt.sign(p,SECRET,{expiresIn:exp});
module.exports={authMiddleware,generateToken};
