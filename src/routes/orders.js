const express=require('express'),router=express.Router(),pool=require('../config/db'),{authMiddleware}=require('../middleware/auth');
const messaging=require('../services/messaging');
function formatOrderNumber(num,cfg){cfg=cfg||{};const prefix=cfg.order_prefix||'ORD-';const suffix=cfg.order_suffix||'';const start=parseInt(cfg.order_start_number)||0;const pad=parseInt(cfg.order_pad_length)||5;const n=(parseInt(num)||0)+(start>0?start-1:0);return `${prefix}${String(n).padStart(pad,'0')}${suffix}`;}
// Auto-archive orders older than store-configured days. Per-store, debounced in-memory.
const _lastArchiveRun={};
async function autoArchive(storeId,cfg){
  try{
    const enabled=cfg?.auto_archive!==false; // default on
    if(!enabled)return;
    const days=parseInt(cfg?.auto_archive_days)||30;
    const now=Date.now();
    if(_lastArchiveRun[storeId]&&now-_lastArchiveRun[storeId]<60000)return; // 1-min debounce
    _lastArchiveRun[storeId]=now;
    await pool.query(
      `UPDATE orders SET is_archived=TRUE,archived_at=NOW(),updated_at=NOW()
       WHERE store_id=$1 AND (is_archived IS NULL OR is_archived=FALSE)
       AND (is_deleted IS NULL OR is_deleted=FALSE)
       AND created_at < NOW() - ($2::int || ' days')::interval`,
      [storeId,days]
    );
  }catch(e){console.error('[autoArchive]',e.message);}
}
// Ensure orders.is_archived column exists (idempotent, awaited on first request)
let _archiveColReady=null;
function ensureArchiveCol(){
  if(!_archiveColReady){
    _archiveColReady=(async()=>{
      try{await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT FALSE');}catch(e){console.error('[orders is_archived]',e.message);}
      try{await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ');}catch(e){console.error('[orders archived_at]',e.message);}
      try{await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE');}catch(e){console.error('[orders is_deleted]',e.message);}
      try{await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ');}catch(e){console.error('[orders deleted_at]',e.message);}
      try{await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS deleted_by UUID');}catch(e){console.error('[orders deleted_by]',e.message);}
    })();
  }
  return _archiveColReady;
}
ensureArchiveCol();

// Orders
router.get('/stores/:sid/orders',authMiddleware(['store_owner','store_staff']),async(req,res)=>{try{
  await ensureArchiveCol();
  // Load store config once for auto-archive + custom order formatting
  let _storeCfg={};try{_storeCfg=(await pool.query('SELECT config FROM stores WHERE id=$1',[req.params.sid])).rows[0]?.config||{};}catch(e){}
  autoArchive(req.params.sid,_storeCfg).catch(()=>{});
  const{status,search,archived}=req.query;let q='SELECT * FROM orders WHERE store_id=$1';const p=[req.params.sid];
  // archived: 'only' = archived only, 'all' = active+archived (no deleted), 'vault' = EVERYTHING incl deleted, 'deleted' = only deleted, default = non-archived non-deleted
  if(archived==='vault'){/* no extra filter — all-time archive incl deleted */}
  else if(archived==='deleted')q+=' AND is_deleted=TRUE';
  else if(archived==='only')q+=' AND is_archived=TRUE AND (is_deleted IS NULL OR is_deleted=FALSE)';
  else if(archived==='all')q+=' AND (is_deleted IS NULL OR is_deleted=FALSE)';
  else q+=' AND (is_archived IS NULL OR is_archived=FALSE) AND (is_deleted IS NULL OR is_deleted=FALSE)';
  if(status&&status!=='all'){
    if(status==='preparing'){q+=` AND status IN ('preparing','under_preparation')`;}
    else{p.push(status);q+=` AND status=$${p.length}`;}
  }
  if(search){p.push(`%${search}%`);q+=` AND (customer_name ILIKE $${p.length} OR customer_phone ILIKE $${p.length} OR CAST(order_number AS TEXT) ILIKE $${p.length})`;}
  const cq=q.replace('SELECT *','SELECT COUNT(*)');q+=' ORDER BY created_at DESC LIMIT 50';
  let r,c;
  try{[r,c]=await Promise.all([pool.query(q,p),pool.query(cq,p)]);}
  catch(e){
    // Fallback: if is_archived column still missing, run query without archive filter
    console.error('[orders fallback]',e.message);
    let q2='SELECT * FROM orders WHERE store_id=$1';const p2=[req.params.sid];
    if(status&&status!=='all'){p2.push(status);q2+=` AND status=$${p2.length}`;}
    if(search){p2.push(`%${search}%`);q2+=` AND (customer_name ILIKE $${p2.length} OR customer_phone ILIKE $${p2.length} OR CAST(order_number AS TEXT) ILIKE $${p2.length})`;}
    const cq2=q2.replace('SELECT *','SELECT COUNT(*)');q2+=' ORDER BY created_at DESC LIMIT 50';
    [r,c]=await Promise.all([pool.query(q2,p2),pool.query(cq2,p2)]);
  }
  const ids=r.rows.map(o=>o.id);let itemsByOrder={};
  if(ids.length){try{const ir=await pool.query("SELECT oi.order_id,oi.product_id,oi.product_name,oi.product_image,oi.variant_info,oi.quantity,oi.unit_price,oi.total_price,p.images AS p_images FROM order_items oi LEFT JOIN products p ON p.id=oi.product_id WHERE oi.order_id=ANY($1::uuid[])",[ids]);for(const it of ir.rows){let img=it.product_image||null;if(!img){try{const imgs=Array.isArray(it.p_images)?it.p_images:(typeof it.p_images==='string'?JSON.parse(it.p_images||'[]'):[]);img=imgs[0]||null;}catch(e){}}(itemsByOrder[it.order_id]=itemsByOrder[it.order_id]||[]).push({product_id:it.product_id,product_name:it.product_name,variant_info:it.variant_info,quantity:it.quantity,price:it.unit_price,total_price:it.total_price,image:img});}}catch(e){console.error('[order items join]',e.message);}}
  res.json({orders:r.rows.map(o=>({...o,order_number:formatOrderNumber(o.order_number,_storeCfg),discount_amount:o.discount,items:itemsByOrder[o.id]||[],first_image:(itemsByOrder[o.id]||[]).find(i=>i.image)?.image||null})),total:parseInt(c.rows[0].count)});
}catch(e){console.error('[GET orders]',e.message);res.status(500).json({error:e.message});}});

// Archive / unarchive order
router.patch('/stores/:sid/orders/:oid/archive',authMiddleware(['store_owner','store_staff']),async(req,res)=>{try{
  const archived=req.body?.archived!==false;
  const r=await pool.query('UPDATE orders SET is_archived=$1,archived_at=CASE WHEN $1 THEN NOW() ELSE NULL END,updated_at=NOW() WHERE id=$2 AND store_id=$3 RETURNING *',[archived,req.params.oid,req.params.sid]);
  if(!r.rows.length)return res.status(404).json({error:'Not found'});
  res.json({ok:true,is_archived:r.rows[0].is_archived});
}catch(e){res.status(500).json({error:e.message});}});

// Bulk archive
router.patch('/stores/:sid/orders/bulk-archive',authMiddleware(['store_owner','store_staff']),async(req,res)=>{try{
  const{ids,archived}=req.body||{};
  if(!Array.isArray(ids)||!ids.length)return res.status(400).json({error:'ids required'});
  await pool.query('UPDATE orders SET is_archived=$1,archived_at=CASE WHEN $1 THEN NOW() ELSE NULL END,updated_at=NOW() WHERE id=ANY($2::uuid[]) AND store_id=$3',[archived!==false,ids,req.params.sid]);
  res.json({ok:true,count:ids.length});
}catch(e){res.status(500).json({error:e.message});}});

// Soft-delete order (still kept in vault archive)
router.delete('/stores/:sid/orders/:oid',authMiddleware(['store_owner','store_staff']),async(req,res)=>{try{
  await ensureArchiveCol();
  const r=await pool.query('UPDATE orders SET is_deleted=TRUE,deleted_at=NOW(),deleted_by=$1,updated_at=NOW() WHERE id=$2 AND store_id=$3 RETURNING id',[req.user?.id||null,req.params.oid,req.params.sid]);
  if(!r.rows.length)return res.status(404).json({error:'Not found'});
  res.json({ok:true});
}catch(e){console.error('[soft delete order]',e.message);res.status(500).json({error:e.message});}});

// Manual order creation (admin / staff). Mirrors the storefront placeOrder
// flow but skips customer-side concerns (no abandoned-cart cleanup, no
// stock decrement on out-of-stock items, no payment redirect).
router.post('/stores/:sid/orders',authMiddleware(['store_owner','store_staff']),async(req,res)=>{
  try{
    const sid=req.params.sid;
    const b=req.body||{};
    if(!b.customer_name||!b.customer_phone)return res.status(400).json({error:'Customer name and phone required'});
    if(!Array.isArray(b.items)||!b.items.length)return res.status(400).json({error:'At least one item required'});
    const subtotal=b.items.reduce((s,it)=>s+(parseFloat(it.price)||0)*(parseInt(it.quantity)||1),0);
    const ship=parseFloat(b.shipping_cost)||0;
    const total=subtotal+ship;
    const num=parseInt((await pool.query('SELECT COALESCE(MAX(order_number),0)+1 as n FROM orders WHERE store_id=$1',[sid])).rows[0].n);
    const sType=b.shipping_type==='desk'?'desk':'home';
    const o=await pool.query(
      'INSERT INTO orders(store_id,order_number,customer_name,customer_phone,customer_email,shipping_address,shipping_city,shipping_wilaya,shipping_zip,subtotal,shipping_cost,discount,total,payment_method,notes,notification_preference,shipping_type,status) '+
      'VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *',
      [sid,num,b.customer_name,b.customer_phone,b.customer_email||null,b.shipping_address||null,b.shipping_city||null,b.shipping_wilaya||null,b.shipping_zip||null,subtotal,ship,0,total,b.payment_method||'cod',b.notes||null,b.notification_preference||'whatsapp',sType,b.status||'new_order']
    );
    for(const it of b.items){
      try{
        await pool.query(
          'INSERT INTO order_items(order_id,product_id,product_name,product_image,variant_info,quantity,unit_price,total_price) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [o.rows[0].id,it.product_id||null,it.name||it.product_name||'Item',it.image||it.product_image||null,it.variant?JSON.stringify(it.variant):null,parseInt(it.quantity)||1,parseFloat(it.price)||0,(parseFloat(it.price)||0)*(parseInt(it.quantity)||1)]
        );
      }catch(e){console.log('[manual order item]',e.message);}
    }
    res.status(201).json(o.rows[0]);
  }catch(e){console.error('[manual order create]',e.message);res.status(500).json({error:e.message||'Failed to create order'});}
});

// Bulk soft-delete
router.post('/stores/:sid/orders/bulk-delete',authMiddleware(['store_owner','store_staff']),async(req,res)=>{try{
  await ensureArchiveCol();
  const{ids}=req.body||{};
  if(!Array.isArray(ids)||!ids.length)return res.status(400).json({error:'ids required'});
  await pool.query('UPDATE orders SET is_deleted=TRUE,deleted_at=NOW(),deleted_by=$1,updated_at=NOW() WHERE id=ANY($2::uuid[]) AND store_id=$3',[req.user?.id||null,ids,req.params.sid]);
  res.json({ok:true,count:ids.length});
}catch(e){res.status(500).json({error:e.message});}});

// Restore soft-deleted order from vault
router.patch('/stores/:sid/orders/:oid/restore',authMiddleware(['store_owner','store_staff']),async(req,res)=>{try{
  await ensureArchiveCol();
  const r=await pool.query('UPDATE orders SET is_deleted=FALSE,deleted_at=NULL,deleted_by=NULL,updated_at=NOW() WHERE id=$1 AND store_id=$2 RETURNING id',[req.params.oid,req.params.sid]);
  if(!r.rows.length)return res.status(404).json({error:'Not found'});
  res.json({ok:true});
}catch(e){res.status(500).json({error:e.message});}});

// Permanent purge (irreversible) — only platform_admin via separate route normally; restricting here to store_owner only
router.delete('/stores/:sid/orders/:oid/purge',authMiddleware(['store_owner']),async(req,res)=>{try{
  await pool.query('DELETE FROM order_items WHERE order_id=$1',[req.params.oid]);
  await pool.query('DELETE FROM orders WHERE id=$1 AND store_id=$2',[req.params.oid,req.params.sid]);
  res.json({ok:true});
}catch(e){res.status(500).json({error:e.message});}});

// Single order with items
router.get('/stores/:sid/orders/:oid',authMiddleware(['store_owner','store_staff']),async(req,res)=>{try{const o=await pool.query('SELECT * FROM orders WHERE id=$1 AND store_id=$2',[req.params.oid,req.params.sid]);if(!o.rows.length)return res.status(404).json({error:'Not found'});const items=await pool.query('SELECT * FROM order_items WHERE order_id=$1',[req.params.oid]);const order=o.rows[0];res.json({...order,order_number:'ORD-'+String(order.order_number).padStart(5,'0'),discount_amount:order.discount,items:items.rows});}catch(e){res.status(500).json({error:e.message});}});

// Update status
router.patch('/stores/:sid/orders/:oid/status',authMiddleware(['store_owner','store_staff']),async(req,res)=>{try{
  // Self-heal: confirmed_/prepared_ audit columns may not exist on older
  // databases. Add them on demand so the UPDATE below doesn't 500.
  try{await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ");}catch{}
  try{await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS prepared_at TIMESTAMPTZ");}catch{}
  try{await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS confirmed_by VARCHAR(64)");}catch{}
  try{await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS prepared_by VARCHAR(64)");}catch{}
  try{await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancel_reason TEXT");}catch{}
  const{status,cancel_reason}=req.body;let extra='';const p=[status,req.params.oid,req.params.sid];if(status==='shipped')extra=',shipped_at=NOW()';if(status==='delivered')extra=",delivered_at=NOW(),payment_status=CASE WHEN payment_method='cod' THEN 'paid' ELSE payment_status END";if(status==='cancelled'){extra=',cancelled_at=NOW()';if(cancel_reason){p.push(cancel_reason);extra+=`,cancel_reason=$${p.length}`;}}if(status==='confirmed'){p.push(String(req.user.id));extra+=`,confirmed_at=NOW(),confirmed_by=$${p.length}`;}if(status==='preparing'){p.push(String(req.user.id));extra+=`,prepared_at=NOW(),prepared_by=$${p.length}`;}const r=await pool.query(`UPDATE orders SET status=$1,updated_at=NOW()${extra} WHERE id=$2 AND store_id=$3 RETURNING *`,p);if(!r.rows.length)return res.status(404).json({error:'Not found'});

  // Send notifications to customer on EVERY status change
  try{
    const store=(await pool.query('SELECT * FROM stores WHERE id=$1',[req.params.sid])).rows[0];
    const order=r.rows[0];
    const pref=(order.notification_preference||'whatsapp').toUpperCase();
    const orderNum='ORD-'+String(order.order_number).padStart(5,'0');
    console.log(`[Order ${orderNum}] Status → ${status} | Pref: ${pref} | Phone: ${order.customer_phone} | Email: ${order.customer_email}`);
    
    // Build message for WhatsApp — use configured language + templates
    let cfg=store.config||{};
    if(typeof cfg==='string'){try{cfg=JSON.parse(cfg);}catch{cfg={};}}
    const waLang=cfg.wa_language||'ar';
    let waTemplates=cfg.wa_templates;
    if(typeof waTemplates==='string'){try{waTemplates=JSON.parse(waTemplates);}catch{waTemplates=null;}}
    const statusKeyMap={pending:'new_order',new_order:'new_order',confirmed:'confirmed',preparing:'under_preparation',under_preparation:'under_preparation',ready:'shipped',shipped:'shipped',delivered:'delivered',cancelled:'cancelled',returned:'returned',awaiting:'awaiting',failed_call_1:'failed_call_1',failed_call_2:'failed_call_2',failed_call_3:'failed_call_3',archived:'cancelled'};
    const tplKey=statusKeyMap[status]||status;
    let msg=messaging.generateOrderMessage({wa_templates:waTemplates},tplKey,{
      store_name:store.store_name,
      order_number:orderNum,
      customer_name:order.customer_name,
      total:order.total,
      currency:store.currency||'DZD',
      shipping_address:order.shipping_address,
      shipping_city:order.shipping_city,
      shipping_wilaya:order.shipping_wilaya,
      payment_method:order.payment_method,
      tracking_number:order.tracking_number,
    },waLang);
    // Hoisted so the email-subject path below can also use it.
    const statusLabels={pending:'received',confirmed:'confirmed',preparing:'being prepared',shipped:'shipped',delivered:'delivered',cancelled:'cancelled'};
    if(!msg){
      msg=`Your order ${orderNum} from ${store.store_name} has been ${statusLabels[status]||status}. Total: ${order.total} ${store.currency||'DZD'}`;
    }

    // Send via preferred channel (WhatsApp). Fire on EVERY status change so
    // the customer sees pending / preparing / failed_call_X / returned etc.
    // Respect the per-status enabled flag the admin configured.
    if(order.customer_phone && pref==='WHATSAPP'){
      let waEnabled={};try{waEnabled=typeof cfg.wa_enabled_statuses==='string'?JSON.parse(cfg.wa_enabled_statuses||'{}'):(cfg.wa_enabled_statuses||{});}catch{}
      const enabledForStatus=waEnabled[tplKey]!==false; // default ON unless explicitly false
      if(enabledForStatus){
        messaging.sendWhatsApp(order.customer_phone,msg,req.params.sid).then(r=>{
          pool.query('INSERT INTO message_log(store_id,channel,recipient,message,status,error) VALUES($1,$2,$3,$4,$5,$6)',[req.params.sid,'whatsapp',order.customer_phone,msg.substring(0,200),r.success?'sent':'failed',r.reason||null]).catch(()=>{});
        }).catch(e=>console.log('WA skip:',e.message));
      }
    }
    
    // ALWAYS send email on ANY status change
    if(order.customer_email){
      console.log(`[Order] Sending email to ${order.customer_email} for status: ${status}`);
      const items=(await pool.query('SELECT * FROM order_items WHERE order_id=$1',[order.id])).rows;
      const subject=`${store.store_name} — Order ${orderNum} ${statusLabels[status]||status}`;
      const html=messaging.orderConfirmationHTML(store.store_name,orderNum,order.total,store.currency||'DZD',items,status);
      messaging.sendEmail({to:order.customer_email,subject,html}).then(r=>console.log('[Email] Result:',JSON.stringify(r))).catch(e=>console.log('[Email] Error:',e.message));
    } else { console.log('[Order] No customer email, skipping'); }
  }catch(e){console.log('[Order Notification Error]',e.message);}

  // Auto-blacklist on cancellation if enabled
  if(status==='cancelled'){
    try{
      const store=(await pool.query('SELECT config FROM stores WHERE id=$1',[req.params.sid])).rows[0];
      const cfg=store?.config||{};
      if(cfg.auto_blacklist){
        const order=r.rows[0];
        const threshold=parseInt(cfg.blacklist_threshold)||3;
        const cnt=parseInt((await pool.query("SELECT COUNT(*) FROM orders WHERE store_id=$1 AND customer_phone=$2 AND status='cancelled'",[req.params.sid,order.customer_phone])).rows[0].count);
        if(cnt>=threshold){
          await pool.query('INSERT INTO blacklist(store_id,phone,name,reason,cancelled_count) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[req.params.sid,order.customer_phone,order.customer_name,'Auto-blacklisted: exceeded cancellation threshold',cnt]);
        }
      }
    }catch(e){}
  }

  // Only notify admin on cancellations (new orders are notified in storefront.js)
  if(status==='cancelled'){
    try{
      const order=r.rows[0];const orderNum='ORD-'+String(order.order_number).padStart(5,'0');
      await pool.query("INSERT INTO notifications(store_id,type,title,message,link) VALUES($1,$2,$3,$4,$5)",[req.params.sid,'order',`Order ${orderNum} cancelled`,`${order.customer_name} — ${order.total} DZD`,'/dashboard/orders']);
      const{sendStorePush}=require('./storeOwner');sendStorePush(req.params.sid,`Order ${orderNum} cancelled`,`${order.customer_name} — ${order.total} DZD`);
    }catch(e){}
  }

  res.json(r.rows[0]);}catch(e){res.status(500).json({error:e.message});}});

// Debug: check order email status
router.get('/stores/:sid/orders/:oid/email-debug',authMiddleware(['store_owner']),async(req,res)=>{try{
  const o=(await pool.query('SELECT id,order_number,customer_name,customer_phone,customer_email,notification_preference,status FROM orders WHERE id=$1 AND store_id=$2',[req.params.oid,req.params.sid])).rows[0];
  if(!o)return res.status(404).json({error:'Order not found'});
  const hasResend=!!process.env.RESEND_API_KEY;
  res.json({order_number:o.order_number,customer_email:o.customer_email||'NOT SET — customer did not enter email at checkout',notification_preference:o.notification_preference,status:o.status,resend_configured:hasResend,will_send_email:!!(o.customer_email&&hasResend)});
}catch(e){res.status(500).json({error:e.message});}});

// Manual send email for an order
router.post('/stores/:sid/orders/:oid/send-email',authMiddleware(['store_owner']),async(req,res)=>{try{
  const{email}=req.body;
  const o=(await pool.query('SELECT * FROM orders WHERE id=$1 AND store_id=$2',[req.params.oid,req.params.sid])).rows[0];
  if(!o)return res.status(404).json({error:'Order not found'});
  const store=(await pool.query('SELECT * FROM stores WHERE id=$1',[req.params.sid])).rows[0];
  const items=(await pool.query('SELECT * FROM order_items WHERE order_id=$1',[o.id])).rows;
  const orderNum='ORD-'+String(o.order_number).padStart(5,'0');
  const toEmail=email||o.customer_email;
  if(!toEmail)return res.status(400).json({error:'No email address. Customer did not provide email at checkout.'});
  const result=await messaging.sendEmail({to:toEmail,subject:`${store.store_name} — Order ${orderNum} ${o.status}`,html:messaging.orderConfirmationHTML(store.store_name,orderNum,o.total,store.currency||'DZD',items,o.status)});
  res.json(result);
}catch(e){res.status(500).json({error:e.message});}});

// Payment status
router.patch('/stores/:sid/orders/:oid/payment',authMiddleware(['store_owner','store_staff']),async(req,res)=>{try{const r=await pool.query('UPDATE orders SET payment_status=$1,updated_at=NOW() WHERE id=$2 AND store_id=$3 RETURNING *',[req.body.payment_status,req.params.oid,req.params.sid]);res.json(r.rows[0]);}catch(e){res.status(500).json({error:e.message});}});

// Generic order field update — whitelist-guarded. Powers the Quick Action drawer on the Orders page.
router.patch('/stores/:sid/orders/:oid',authMiddleware(['store_owner','store_staff']),async(req,res)=>{try{
  // Make sure any columns we allow editing exist (no-op if already present).
  const migrateCols=[
    ["customer_name","TEXT"],["customer_phone","TEXT"],["customer_email","TEXT"],
    ["shipping_address","TEXT"],["shipping_city","TEXT"],["shipping_wilaya","TEXT"],["shipping_wilaya_code","TEXT"],["shipping_zip","TEXT"],["shipping_type","TEXT"],
    ["billing_name","TEXT"],["billing_street","TEXT"],["billing_city","TEXT"],["billing_zip","TEXT"],["billing_country","TEXT"],
    ["shipping_cost","NUMERIC"],["currency","TEXT"],["tax_total","NUMERIC"],
    ["discount_code","TEXT"],["discount_total","NUMERIC"],
    ["source","TEXT"],["notes","TEXT"],
    ["tracking_number","TEXT"],["delivery_company_id","UUID"],
    ["processed_at","TIMESTAMP"],["payment_status","TEXT"]
  ];
  for(const[c,t] of migrateCols){try{await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS ${c} ${t}`);}catch(e){}}
  const allowed=new Set(migrateCols.map(m=>m[0]));
  const sets=[];const vals=[];let i=1;
  for(const[k,v] of Object.entries(req.body||{})){
    if(!allowed.has(k))continue;
    sets.push(`${k}=$${i++}`);vals.push(v===''?null:v);
  }
  if(!sets.length)return res.status(400).json({error:'No updatable fields'});
  vals.push(req.params.oid);vals.push(req.params.sid);
  const r=await pool.query(`UPDATE orders SET ${sets.join(',')},updated_at=NOW() WHERE id=$${i++} AND store_id=$${i} RETURNING *`,vals);
  if(!r.rows.length)return res.status(404).json({error:'Not found'});
  res.json(r.rows[0]);
}catch(e){res.status(500).json({error:e.message});}});

// Abandoned carts
router.get('/stores/:sid/abandoned-carts',authMiddleware(['store_owner']),async(req,res)=>{try{const carts=await pool.query('SELECT * FROM carts WHERE store_id=$1 AND is_abandoned=TRUE ORDER BY created_at DESC',[req.params.sid]);const stats=await pool.query("SELECT COUNT(*) as total_carts,COUNT(CASE WHEN is_recovered THEN 1 END) as recovered,COALESCE(SUM(CASE WHEN is_recovered THEN total ELSE 0 END),0) as recovered_revenue,COALESCE(SUM(CASE WHEN NOT is_recovered OR is_recovered IS NULL THEN total ELSE 0 END),0) as lost_revenue FROM carts WHERE store_id=$1 AND is_abandoned=TRUE",[req.params.sid]);res.json({carts:carts.rows,stats:stats.rows[0]});}catch(e){res.json({carts:[],stats:{total_carts:0,recovered:0,recovered_revenue:0,lost_revenue:0}});}});

// Customers
router.get('/stores/:sid/customers',authMiddleware(['store_owner','store_staff']),async(req,res)=>{try{const{search}=req.query;let q='SELECT * FROM customers WHERE store_id=$1';const p=[req.params.sid];if(search){p.push(`%${search}%`);q+=` AND (full_name ILIKE $${p.length} OR phone ILIKE $${p.length})`;}q+=' ORDER BY created_at DESC LIMIT 50';const r=await pool.query(q,p);res.json(r.rows.map(c=>({...c,name:c.full_name})));}catch(e){res.json([]);}});

// Shipping wilayas
async function ensureShippingCols(){try{await pool.query("ALTER TABLE shipping_wilayas ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE");await pool.query("ALTER TABLE shipping_wilayas ADD COLUMN IF NOT EXISTS home_enabled BOOLEAN DEFAULT TRUE");await pool.query("ALTER TABLE shipping_wilayas ADD COLUMN IF NOT EXISTS desk_enabled BOOLEAN DEFAULT TRUE");await pool.query("ALTER TABLE stores ADD COLUMN IF NOT EXISTS shipping_mode TEXT DEFAULT 'wilaya'");await pool.query("ALTER TABLE stores ADD COLUMN IF NOT EXISTS free_shipping_enabled BOOLEAN DEFAULT FALSE");await pool.query("ALTER TABLE stores ADD COLUMN IF NOT EXISTS free_shipping_threshold NUMERIC DEFAULT 0");}catch(e){}}
ensureShippingCols();
router.get('/stores/:sid/shipping-wilayas',authMiddleware(['store_owner']),async(req,res)=>{try{await ensureShippingCols();const wr=await pool.query('SELECT * FROM shipping_wilayas WHERE store_id=$1 ORDER BY wilaya_code',[req.params.sid]);const sr=await pool.query('SELECT shipping_mode,free_shipping_enabled,free_shipping_threshold FROM stores WHERE id=$1',[req.params.sid]);const s=sr.rows[0]||{};res.json({wilayas:wr.rows,shipping_mode:s.shipping_mode||'wilaya',free_shipping_enabled:!!s.free_shipping_enabled,free_shipping_threshold:Number(s.free_shipping_threshold||0)});}catch(e){res.json({wilayas:[],shipping_mode:'wilaya',free_shipping_enabled:false,free_shipping_threshold:0});}});
router.post('/stores/:sid/shipping-wilayas',authMiddleware(['store_owner']),async(req,res)=>{try{const{wilaya_name,wilaya_code,desk_delivery_price,home_delivery_price,delivery_days,is_active}=req.body;const r=await pool.query('INSERT INTO shipping_wilayas(store_id,wilaya_name,wilaya_code,desk_delivery_price,home_delivery_price,delivery_days,is_active) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[req.params.sid,wilaya_name,wilaya_code,desk_delivery_price,home_delivery_price,delivery_days||3,is_active!==false]);res.status(201).json(r.rows[0]);}catch(e){res.status(500).json({error:e.message});}});
router.put('/stores/:sid/shipping-wilayas',authMiddleware(['store_owner']),async(req,res)=>{const client=await pool.connect();try{await ensureShippingCols();const sid=req.params.sid;const{wilayas,shipping_mode,free_shipping_enabled,free_shipping_threshold}=req.body||{};await client.query('BEGIN');await client.query('UPDATE stores SET shipping_mode=COALESCE($2,shipping_mode),free_shipping_enabled=COALESCE($3,free_shipping_enabled),free_shipping_threshold=COALESCE($4,free_shipping_threshold) WHERE id=$1',[sid,shipping_mode||null,typeof free_shipping_enabled==='boolean'?free_shipping_enabled:null,typeof free_shipping_threshold==='number'?free_shipping_threshold:null]);if(Array.isArray(wilayas)){for(const w of wilayas){const active=w.is_active!==false;const homeOn=w.home_enabled!==false;const deskOn=w.desk_enabled!==false;if(w.id&&!String(w.id).startsWith('local-')){await client.query('UPDATE shipping_wilayas SET wilaya_name=$2,wilaya_code=$3,desk_delivery_price=$4,home_delivery_price=$5,delivery_days=$6,is_active=$7,home_enabled=$8,desk_enabled=$9 WHERE id=$1 AND store_id=$10',[w.id,w.wilaya_name,w.wilaya_code,w.desk_delivery_price||0,w.home_delivery_price||0,w.delivery_days||3,active,homeOn,deskOn,sid]);}else{await client.query('INSERT INTO shipping_wilayas(store_id,wilaya_name,wilaya_code,desk_delivery_price,home_delivery_price,delivery_days,is_active,home_enabled,desk_enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING',[sid,w.wilaya_name,w.wilaya_code,w.desk_delivery_price||0,w.home_delivery_price||0,w.delivery_days||3,active,homeOn,deskOn]);}}}await client.query('COMMIT');res.json({ok:true});}catch(e){await client.query('ROLLBACK');res.status(500).json({error:e.message});}finally{client.release();}});
router.put('/stores/:sid/shipping-wilayas/:wid',authMiddleware(['store_owner']),async(req,res)=>{try{await ensureShippingCols();const{wilaya_name,wilaya_code,desk_delivery_price,home_delivery_price,delivery_days,is_active,home_enabled,desk_enabled}=req.body;const r=await pool.query('UPDATE shipping_wilayas SET wilaya_name=COALESCE($3,wilaya_name),wilaya_code=COALESCE($4,wilaya_code),desk_delivery_price=COALESCE($5,desk_delivery_price),home_delivery_price=COALESCE($6,home_delivery_price),delivery_days=COALESCE($7,delivery_days),is_active=COALESCE($8,is_active),home_enabled=COALESCE($9,home_enabled),desk_enabled=COALESCE($10,desk_enabled) WHERE id=$1 AND store_id=$2 RETURNING *',[req.params.wid,req.params.sid,wilaya_name||null,wilaya_code||null,desk_delivery_price??null,home_delivery_price??null,delivery_days??null,typeof is_active==='boolean'?is_active:null,typeof home_enabled==='boolean'?home_enabled:null,typeof desk_enabled==='boolean'?desk_enabled:null]);res.json(r.rows[0]||{ok:true});}catch(e){res.status(500).json({error:e.message});}});
router.delete('/stores/:sid/shipping-wilayas/:wid',authMiddleware(['store_owner']),async(req,res)=>{try{await pool.query('DELETE FROM shipping_wilayas WHERE id=$1 AND store_id=$2',[req.params.wid,req.params.sid]);res.json({ok:true});}catch(e){res.status(500).json({error:e.message});}});

// Seed 58 wilayas
router.post('/stores/:sid/shipping-wilayas/seed',authMiddleware(['store_owner']),async(req,res)=>{try{const sid=req.params.sid;const ex=await pool.query('SELECT COUNT(*) FROM shipping_wilayas WHERE store_id=$1',[sid]);if(parseInt(ex.rows[0].count)>10)return res.json({message:'Already seeded'});const w=[['Adrar','01',800,1000,5],['Chlef','02',400,600,2],['Laghouat','03',600,800,3],['Oum El Bouaghi','04',400,600,2],['Batna','05',400,600,2],['Béjaïa','06',400,550,2],['Biskra','07',500,700,3],['Béchar','08',800,1000,5],['Blida','09',300,450,1],['Bouira','10',350,500,2],['Tamanrasset','11',1000,1200,7],['Tébessa','12',500,700,3],['Tlemcen','13',400,600,2],['Tiaret','14',400,600,2],['Tizi Ouzou','15',350,500,2],['Alger','16',300,400,1],['Djelfa','17',500,700,3],['Jijel','18',400,550,2],['Sétif','19',400,550,2],['Saïda','20',500,700,3],['Skikda','21',400,600,2],['Sidi Bel Abbès','22',400,600,2],['Annaba','23',400,600,2],['Guelma','24',400,600,2],['Constantine','25',400,550,2],['Médéa','26',350,500,2],['Mostaganem','27',400,600,2],["M'Sila",'28',500,700,3],['Mascara','29',400,600,2],['Ouargla','30',600,800,4],['Oran','31',400,550,2],['El Bayadh','32',600,800,4],['Illizi','33',1000,1200,7],['Bordj Bou Arréridj','34',400,550,2],['Boumerdès','35',300,450,1],['El Tarf','36',400,600,2],['Tindouf','37',1000,1200,7],['Tissemsilt','38',500,700,3],['El Oued','39',600,800,4],['Khenchela','40',500,700,3],['Souk Ahras','41',400,600,2],['Tipaza','42',300,450,1],['Mila','43',400,600,2],['Aïn Defla','44',400,550,2],['Naâma','45',600,800,4],['Aïn Témouchent','46',400,600,2],['Ghardaïa','47',600,800,4],['Relizane','48',400,600,2],["El M'Ghair",'49',600,800,4],['El Meniaa','50',700,900,5],['Ouled Djellal','51',600,800,4],['Bordj Badji Mokhtar','52',1200,1400,7],['Béni Abbès','53',900,1100,6],['Timimoun','54',900,1100,6],['Touggourt','55',600,800,4],['Djanet','56',1100,1300,7],['In Salah','57',1000,1200,7],['In Guezzam','58',1200,1400,7]];for(const[n,c,d,h,dy]of w){await pool.query('INSERT INTO shipping_wilayas(store_id,wilaya_name,wilaya_code,desk_delivery_price,home_delivery_price,delivery_days) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',[sid,n,c,d,h,dy]);}res.json({message:'58 wilayas seeded'});}catch(e){res.status(500).json({error:e.message});}});

// Delivery companies
router.get('/stores/:sid/delivery-companies',authMiddleware(['store_owner']),async(req,res)=>{try{res.json((await pool.query('SELECT * FROM delivery_companies WHERE store_id=$1 ORDER BY created_at DESC',[req.params.sid])).rows);}catch(e){res.json([]);}});
router.post('/stores/:sid/delivery-companies',authMiddleware(['store_owner']),async(req,res)=>{try{const{name,api_key,base_rate,provider_type,tracking_url,phone,api_base_url,api_auth_type,api_headers,api_tracking_endpoint,api_status_path}=req.body;const r=await pool.query('INSERT INTO delivery_companies(store_id,name,api_key,base_rate,provider_type,tracking_url,phone,api_base_url,api_auth_type,api_headers,api_tracking_endpoint,api_status_path) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12) RETURNING *',[req.params.sid,name,api_key||null,base_rate||0,provider_type||'manual',tracking_url||null,phone||null,api_base_url||null,api_auth_type||'none',JSON.stringify(api_headers||{}),api_tracking_endpoint||null,api_status_path||null]);res.status(201).json(r.rows[0]);}catch(e){res.status(500).json({error:e.message});}});
// delivery companies update moved to tracking section below
router.delete('/stores/:sid/delivery-companies/:did',authMiddleware(['store_owner']),async(req,res)=>{try{await pool.query('DELETE FROM delivery_companies WHERE id=$1 AND store_id=$2',[req.params.did,req.params.sid]);res.json({ok:true});}catch(e){res.status(500).json({error:e.message});}});

// ═══ BLACKLIST CRUD ═══
router.get('/stores/:sid/blacklist',authMiddleware(['store_owner']),async(req,res)=>{try{res.json((await pool.query('SELECT * FROM blacklist WHERE store_id=$1 ORDER BY created_at DESC',[req.params.sid])).rows);}catch(e){res.json([]);}});
router.post('/stores/:sid/blacklist',authMiddleware(['store_owner']),async(req,res)=>{try{const{phone,name,reason}=req.body;if(!phone)return res.status(400).json({error:'Phone required'});const r=await pool.query('INSERT INTO blacklist(store_id,phone,name,reason) VALUES($1,$2,$3,$4) RETURNING *',[req.params.sid,phone,name||'',reason||'Manual']);res.status(201).json(r.rows[0]);}catch(e){res.status(500).json({error:e.message});}});
router.delete('/stores/:sid/blacklist/:bid',authMiddleware(['store_owner']),async(req,res)=>{try{await pool.query('DELETE FROM blacklist WHERE id=$1 AND store_id=$2',[req.params.bid,req.params.sid]);res.json({ok:true});}catch(e){res.status(500).json({error:e.message});}});

// ═══ EXPENSES CRUD ═══
router.get('/stores/:sid/expenses',authMiddleware(['store_owner']),async(req,res)=>{try{res.json((await pool.query('SELECT * FROM expenses WHERE store_id=$1 ORDER BY date DESC',[req.params.sid])).rows);}catch(e){res.json([]);}});
router.post('/stores/:sid/expenses',authMiddleware(['store_owner']),async(req,res)=>{try{const{description,category,amount,date,status}=req.body;if(!description||!amount)return res.status(400).json({error:'Description and amount required'});const r=await pool.query('INSERT INTO expenses(store_id,description,category,amount,date,status) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[req.params.sid,description,category||'Other',amount,date||new Date().toISOString().split('T')[0],status||'Paid']);res.status(201).json(r.rows[0]);}catch(e){res.status(500).json({error:e.message});}});
router.put('/stores/:sid/expenses/:eid',authMiddleware(['store_owner']),async(req,res)=>{try{const{description,category,amount,date,status}=req.body;const r=await pool.query('UPDATE expenses SET description=COALESCE($1,description),category=COALESCE($2,category),amount=COALESCE($3,amount),date=COALESCE($4,date),status=COALESCE($5,status) WHERE id=$6 AND store_id=$7 RETURNING *',[description,category,amount,date,status,req.params.eid,req.params.sid]);res.json(r.rows[0]);}catch(e){res.status(500).json({error:e.message});}});
router.delete('/stores/:sid/expenses/:eid',authMiddleware(['store_owner']),async(req,res)=>{try{await pool.query('DELETE FROM expenses WHERE id=$1 AND store_id=$2',[req.params.eid,req.params.sid]);res.json({ok:true});}catch(e){res.status(500).json({error:e.message});}});

// ═══ STORE PAGES (FAQs, About) ═══
router.get('/stores/:sid/pages',authMiddleware(['store_owner']),async(req,res)=>{try{res.json((await pool.query('SELECT * FROM store_pages WHERE store_id=$1 ORDER BY sort_order ASC',[req.params.sid])).rows);}catch(e){res.json([]);}});
router.post('/stores/:sid/pages',authMiddleware(['store_owner']),async(req,res)=>{try{const{page_type,title,content,is_published,sort_order}=req.body;const r=await pool.query('INSERT INTO store_pages(store_id,page_type,title,content,is_published,sort_order) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[req.params.sid,page_type||'faq',title||'',content||'',is_published!==false,sort_order||0]);res.status(201).json(r.rows[0]);}catch(e){res.status(500).json({error:e.message});}});
router.put('/stores/:sid/pages/:pid',authMiddleware(['store_owner']),async(req,res)=>{try{const{title,content,is_published,sort_order}=req.body;const r=await pool.query('UPDATE store_pages SET title=COALESCE($1,title),content=COALESCE($2,content),is_published=COALESCE($3,is_published),sort_order=COALESCE($4,sort_order) WHERE id=$5 AND store_id=$6 RETURNING *',[title,content,is_published,sort_order,req.params.pid,req.params.sid]);res.json(r.rows[0]);}catch(e){res.status(500).json({error:e.message});}});
router.delete('/stores/:sid/pages/:pid',authMiddleware(['store_owner']),async(req,res)=>{try{await pool.query('DELETE FROM store_pages WHERE id=$1 AND store_id=$2',[req.params.pid,req.params.sid]);res.json({ok:true});}catch(e){res.status(500).json({error:e.message});}});
// Bulk save FAQs
router.put('/stores/:sid/faqs',authMiddleware(['store_owner']),async(req,res)=>{try{const{faqs}=req.body;await pool.query('DELETE FROM store_pages WHERE store_id=$1 AND page_type=$2',[req.params.sid,'faq']);const results=[];for(let i=0;i<faqs.length;i++){const f=faqs[i];const r=await pool.query('INSERT INTO store_pages(store_id,page_type,title,content,sort_order) VALUES($1,$2,$3,$4,$5) RETURNING *',[req.params.sid,'faq',f.q||f.title||'',f.a||f.content||'',i]);results.push(r.rows[0]);}res.json(results);}catch(e){res.status(500).json({error:e.message});}});

// ═══ STOCK INLINE UPDATE ═══
router.patch('/stores/:sid/products/:pid/stock',authMiddleware(['store_owner','store_staff']),async(req,res)=>{try{const{stock_quantity}=req.body;const n=(stock_quantity===null||stock_quantity===undefined||stock_quantity==='')?0:parseInt(stock_quantity);const r=await pool.query('UPDATE products SET stock_quantity=$1 WHERE id=$2 AND store_id=$3 RETURNING id,name,stock_quantity',[Number.isFinite(n)?n:0,req.params.pid,req.params.sid]);res.json(r.rows[0]);}catch(e){res.status(500).json({error:e.message});}});

// ═══ ORDER TRACKING ═══

// Assign tracking number to order
router.patch('/stores/:sid/orders/:oid/tracking',authMiddleware(['store_owner','store_staff']),async(req,res)=>{try{
  const{tracking_number,delivery_company_id}=req.body;
  const r=await pool.query(
    'UPDATE orders SET tracking_number=$1,delivery_company_id=$2,tracking_status=$3,tracking_updated_at=NOW(),updated_at=NOW() WHERE id=$4 AND store_id=$5 RETURNING *',
    [tracking_number||null,delivery_company_id||null,tracking_number?'in_transit':null,req.params.oid,req.params.sid]
  );
  if(!r.rows.length)return res.status(404).json({error:'Not found'});
  res.json(r.rows[0]);
}catch(e){res.status(500).json({error:e.message});}});

// Get orders with tracking info
router.get('/stores/:sid/tracking-orders',authMiddleware(['store_owner','store_staff']),async(req,res)=>{try{
  const{status}=req.query;
  let q=`SELECT o.*,dc.name as company_name,dc.provider_type,dc.api_key as company_api_key,dc.tracking_url
    FROM orders o LEFT JOIN delivery_companies dc ON dc.id=o.delivery_company_id
    WHERE o.store_id=$1 AND o.status IN ('shipped','delivered')`;
  const p=[req.params.sid];
  if(status==='tracked'){q+=' AND o.tracking_number IS NOT NULL';}
  else if(status==='untracked'){q+=' AND o.tracking_number IS NULL AND o.status=\'shipped\'';}
  q+=' ORDER BY o.updated_at DESC LIMIT 100';
  const r=await pool.query(q,p);
  res.json(r.rows.map(o=>({...o,order_number:'ORD-'+String(o.order_number).padStart(5,'0')})));
}catch(e){res.status(500).json({error:e.message});}});

// Fetch live tracking — generic for ANY delivery API
router.get('/stores/:sid/track/:trackingNumber',authMiddleware(['store_owner','store_staff']),async(req,res)=>{try{
  const tn=req.params.trackingNumber;
  const order=await pool.query(
    `SELECT o.*,dc.api_key,dc.provider_type,dc.name as company_name,dc.tracking_url,
     dc.api_base_url,dc.api_auth_type,dc.api_headers,dc.api_tracking_endpoint,dc.api_status_path
     FROM orders o LEFT JOIN delivery_companies dc ON dc.id=o.delivery_company_id
     WHERE o.store_id=$1 AND o.tracking_number=$2`,[req.params.sid,tn]);
  if(!order.rows.length)return res.status(404).json({error:'Tracking not found'});
  const o=order.rows[0];

  // If company has API config, call it
  if(o.api_base_url && o.api_tracking_endpoint){
    try{
      // Build URL: replace {tracking_number} placeholder
      const endpoint=o.api_tracking_endpoint.replace(/\{tracking_number\}/g,tn).replace(/\{number\}/g,tn).replace(/\{tn\}/g,tn);
      const url=o.api_base_url.replace(/\/$/,'') + (endpoint.startsWith('/')?'':'/') + endpoint;

      // Build headers from config
      const headers={'Content-Type':'application/json'};
      const authType=o.api_auth_type||'none';
      const storedHeaders=typeof o.api_headers==='string'?JSON.parse(o.api_headers):(o.api_headers||{});

      if(authType==='bearer' && o.api_key){
        headers['Authorization']=`Bearer ${o.api_key}`;
      } else if(authType==='custom_headers'){
        Object.assign(headers,storedHeaders);
      }

      console.log(`[Track] ${o.company_name}: GET ${url}`);
      const r=await fetch(url,{headers});
      const raw=await r.text();
      console.log(`[Track] Response ${r.status}: ${raw.substring(0,300)}`);

      if(r.ok){
        let data;
        try{data=JSON.parse(raw);}catch{data=null;}
        if(data){
          // Try to extract status from response using api_status_path (e.g. "data.0.last_status" or "status")
          let extractedStatus=null;
          let history=[];
          let extra={};

          if(o.api_status_path){
            try{
              const parts=o.api_status_path.split('.');
              let val=data;
              for(const p of parts){
                if(val==null)break;
                if(!isNaN(p))val=val[parseInt(p)];
                else val=val[p];
              }
              if(typeof val==='string')extractedStatus=val;
            }catch{}
          }

          // Auto-detect common response shapes
          if(!extractedStatus){
            const d=data.data||data.results||data;
            const item=Array.isArray(d)?d[0]:d;
            if(item){
              extractedStatus=item.last_status||item.status||item.current_status||item.state||null;
              history=item.historique||item.history||item.tracking_history||item.events||[];
              if(item.commune_name)extra.destination=item.commune_name;
              if(item.wilaya_name)extra.wilaya=item.wilaya_name;
              if(item.commune)extra.destination=item.commune;
              if(item.wilaya)extra.wilaya=item.wilaya;
            }
          }

          // Normalize history to {status,date,location}
          if(Array.isArray(history)){
            history=history.map(h=>({
              status:h.status||h.label||h.note||h.event||h.description||JSON.stringify(h),
              date:h.date||h.created_at||h.timestamp||h.time||'',
              location:h.centre||h.center||h.location||h.city||'',
            }));
          }

          const normalizedStatus=(extractedStatus||'').toLowerCase().replace(/\s+/g,'_');
          if(extractedStatus){
            await pool.query('UPDATE orders SET tracking_status=$1,tracking_updated_at=NOW() WHERE id=$2',[normalizedStatus,o.id]);
          }

          return res.json({
            provider:o.company_name,tracking_number:tn,status:normalizedStatus||o.tracking_status||'in_transit',
            raw_status:extractedStatus||'',history,...extra,
            last_update:new Date().toISOString(),company:o.company_name,has_api:true
          });
        }
      }

      return res.json({provider:o.company_name,tracking_number:tn,status:o.tracking_status||'unknown',
        error:r.status===401?'Invalid API credentials (401)':r.status===404?'Parcel not found (404)':`API error (${r.status})`,
        company:o.company_name,has_api:true,api_error:true});
    }catch(e){
      console.error(`[Track] ${o.company_name} API error:`,e.message);
      return res.json({provider:o.company_name,tracking_number:tn,status:o.tracking_status||'unknown',
        error:'API connection failed: '+e.message,company:o.company_name,has_api:true,api_error:true});
    }
  }

  // Manual tracking — return stored status + external tracking URL if set
  const trackUrl=o.tracking_url?(o.tracking_url.replace(/\{tracking_number\}/g,tn).replace(/\{number\}/g,tn)):null;
  res.json({provider:'manual',tracking_number:tn,status:o.tracking_status||'in_transit',
    company:o.company_name||'Unknown',last_update:o.tracking_updated_at,has_api:false,tracking_url:trackUrl});
}catch(e){res.status(500).json({error:e.message});}});

// Test a saved delivery company
router.post('/stores/:sid/delivery-companies/:did/test',authMiddleware(['store_owner']),async(req,res)=>{try{
  const dc=(await pool.query('SELECT * FROM delivery_companies WHERE id=$1 AND store_id=$2',[req.params.did,req.params.sid])).rows[0];
  if(!dc)return res.status(404).json({error:'Company not found'});
  if(!dc.api_base_url)return res.json({ok:false,error:'No API Base URL configured.'});
  const headers={'Content-Type':'application/json'};
  const storedHeaders=typeof dc.api_headers==='string'?JSON.parse(dc.api_headers||'{}'):(dc.api_headers||{});
  if(dc.api_auth_type==='bearer'&&dc.api_key)headers['Authorization']=`Bearer ${dc.api_key}`;
  else if(dc.api_auth_type==='custom_headers')Object.assign(headers,storedHeaders);
  try{
    const r=await fetch(dc.api_base_url.replace(/\/$/,''),{headers,signal:AbortSignal.timeout(10000)});
    if(r.ok||r.status===404)return res.json({ok:true,message:`Connected to ${dc.name} API (HTTP ${r.status})`});
    if(r.status===401||r.status===403)return res.json({ok:false,error:`Authentication failed (HTTP ${r.status}).`});
    return res.json({ok:false,error:`API returned HTTP ${r.status}`});
  }catch(e){return res.json({ok:false,error:`Cannot reach API: ${e.message}`});}
}catch(e){res.status(500).json({error:e.message});}});

// Test API config WITHOUT saving — for the form "Test Connection" button
router.post('/stores/:sid/delivery-companies/test-config',authMiddleware(['store_owner']),async(req,res)=>{try{
  const{api_base_url,api_auth_type,api_key,api_headers,api_tracking_endpoint,api_status_path}=req.body;
  const results={connection:null,tracking:null,status_extraction:null};
  if(!api_base_url)return res.json({ok:false,error:'API Base URL is required',results});

  const headers={'Content-Type':'application/json'};
  const custom=typeof api_headers==='string'?JSON.parse(api_headers||'{}'):(api_headers||{});
  if(api_auth_type==='bearer'&&api_key)headers['Authorization']=`Bearer ${api_key}`;
  else if(api_auth_type==='custom_headers')Object.assign(headers,custom);

  // Step 1: Base URL reachable?
  try{
    const r=await fetch(api_base_url.replace(/\/$/,''),{headers,signal:AbortSignal.timeout(10000)});
    if(r.status===401||r.status===403){results.connection={ok:false,status:r.status,message:'Authentication failed'};return res.json({ok:false,error:'Auth failed ('+r.status+')',results});}
    results.connection={ok:true,status:r.status,message:'Server reached (HTTP '+r.status+')'};
  }catch(e){results.connection={ok:false,message:e.message};return res.json({ok:false,error:'Cannot reach: '+e.message,results});}

  // Step 2: Tracking endpoint responds?
  if(api_tracking_endpoint){
    try{
      const ep=api_tracking_endpoint.replace(/\{tracking_number\}/g,'TEST000').replace(/\{number\}/g,'TEST000').replace(/\{tn\}/g,'TEST000');
      const url=api_base_url.replace(/\/$/,'')+(ep.startsWith('/')?'':'/')+ep;
      const r=await fetch(url,{headers,signal:AbortSignal.timeout(10000)});
      const body=await r.text();
      results.tracking={ok:true,status:r.status,message:r.ok?'Endpoint works (HTTP '+r.status+')':'Returned '+r.status+' (normal for test number)'};

      // Step 3: Can we read the status path?
      if(api_status_path&&body){
        try{
          const data=JSON.parse(body);
          let val=data;
          for(const p of api_status_path.split('.')){if(val==null)break;val=!isNaN(p)?val[parseInt(p)]:val[p];}
          if(val!=null)results.status_extraction={ok:true,value:String(val),message:'Found: "'+String(val)+'"'};
          else results.status_extraction={ok:false,message:'Path returned empty (expected for test tracking number)'};
        }catch{results.status_extraction={ok:false,message:'Response is not JSON'};}
      }
    }catch(e){results.tracking={ok:false,message:e.message};}
  }

  const ok=results.connection?.ok&&results.tracking?.ok!==false;
  res.json({ok,message:ok?'API configuration looks good!':'Issues found',results});
}catch(e){res.status(500).json({error:e.message});}});

// Test API credentials before saving — accepts raw config from request body
router.post('/stores/:sid/delivery-companies/test-credentials',authMiddleware(['store_owner']),async(req,res)=>{try{
  const{api_base_url,api_auth_type,api_key,api_headers,api_tracking_endpoint,name}=req.body;
  if(!api_base_url)return res.json({ok:false,error:'API Base URL is required'});

  const headers={'Content-Type':'application/json'};
  const parsed=typeof api_headers==='string'?JSON.parse(api_headers||'{}'):(api_headers||{});
  if(api_auth_type==='bearer'&&api_key)headers['Authorization']=`Bearer ${api_key}`;
  else if(api_auth_type==='custom_headers')Object.assign(headers,parsed);

  // Step 1: Test base URL connectivity
  const baseUrl=api_base_url.replace(/\/$/,'');
  console.log(`[TestCreds] ${name||'Company'}: GET ${baseUrl}`);
  try{
    const r=await fetch(baseUrl,{headers,signal:AbortSignal.timeout(10000)});
    const status=r.status;
    if(status===401||status===403)return res.json({ok:false,error:`Authentication failed (HTTP ${status}). Your credentials are incorrect.`,step:'auth'});

    // Step 2: If tracking endpoint provided, test it with a fake tracking number
    if(api_tracking_endpoint){
      const testTN='TEST000000';
      const endpoint=api_tracking_endpoint.replace(/\{tracking_number\}/g,testTN).replace(/\{number\}/g,testTN);
      const trackUrl=baseUrl+(endpoint.startsWith('/')?'':'/')+endpoint;
      console.log(`[TestCreds] Tracking test: GET ${trackUrl}`);
      try{
        const tr=await fetch(trackUrl,{headers,signal:AbortSignal.timeout(10000)});
        const tStatus=tr.status;
        if(tStatus===401||tStatus===403)return res.json({ok:false,error:`Base URL works but tracking endpoint rejected credentials (HTTP ${tStatus}).`,step:'tracking_auth'});
        if(tStatus===404||tStatus===200||tStatus===422||tStatus===400){
          // 404/400 with fake tracking = expected, means endpoint exists and auth works
          return res.json({ok:true,message:`Connected to ${name||'API'}! Base URL and tracking endpoint are reachable. Authentication passed.`,step:'complete'});
        }
        return res.json({ok:true,message:`Connected (HTTP ${tStatus}). Tracking endpoint responded.`,step:'complete'});
      }catch(te){
        return res.json({ok:true,message:`Base URL works but tracking endpoint unreachable: ${te.message}. Check the endpoint path.`,step:'tracking_fail',partial:true});
      }
    }

    return res.json({ok:true,message:`Connected to ${name||'API'} (HTTP ${status}). Add a tracking endpoint to enable live tracking.`,step:'base_only'});
  }catch(e){
    return res.json({ok:false,error:`Cannot reach ${baseUrl}: ${e.message}. Check the URL.`,step:'unreachable'});
  }
}catch(e){res.status(500).json({error:e.message});}});

// Update delivery company — full API config
router.put('/stores/:sid/delivery-companies/:did',authMiddleware(['store_owner']),async(req,res)=>{try{
  const{name,api_key,base_rate,provider_type,tracking_url,phone,api_base_url,api_auth_type,api_headers,api_tracking_endpoint,api_status_path}=req.body;
  const r=await pool.query(
    `UPDATE delivery_companies SET name=COALESCE($1,name),api_key=$2,base_rate=COALESCE($3,base_rate),
     provider_type=COALESCE($4,provider_type),tracking_url=$5,phone=$6,
     api_base_url=$7,api_auth_type=COALESCE($8,api_auth_type),api_headers=$9::jsonb,api_tracking_endpoint=$10,api_status_path=$11
     WHERE id=$12 AND store_id=$13 RETURNING *`,
    [name,api_key||null,base_rate,provider_type||'manual',tracking_url||null,phone||null,
     api_base_url||null,api_auth_type||'none',JSON.stringify(api_headers||{}),api_tracking_endpoint||null,api_status_path||null,
     req.params.did,req.params.sid]
  );
  res.json(r.rows[0]);
}catch(e){res.status(500).json({error:e.message});}});

// ═══ REVIEWS CRUD (store owner) ═══
router.get('/stores/:sid/reviews',authMiddleware(['store_owner']),async(req,res)=>{try{
  const{filter}=req.query;
  let q='SELECT r.*,p.name as product_name FROM reviews r LEFT JOIN products p ON p.id=r.product_id WHERE r.store_id=$1';
  if(filter==='pending')q+=' AND r.is_approved=FALSE AND r.is_rejected=FALSE';
  else if(filter==='approved')q+=' AND r.is_approved=TRUE';
  else if(filter==='rejected')q+=' AND r.is_rejected=TRUE';
  q+=' ORDER BY r.created_at DESC LIMIT 100';
  const r=await pool.query(q,[req.params.sid]);
  const stats=await pool.query("SELECT COUNT(*) as total,COUNT(*) FILTER(WHERE is_approved) as approved,COUNT(*) FILTER(WHERE is_rejected) as rejected,COUNT(*) FILTER(WHERE NOT is_approved AND NOT is_rejected) as pending,ROUND(AVG(rating),1) as avg_rating FROM reviews WHERE store_id=$1",[req.params.sid]);
  res.json({reviews:r.rows,stats:stats.rows[0]});
}catch(e){res.json({reviews:[],stats:{}});}});

router.patch('/stores/:sid/reviews/:rid/approve',authMiddleware(['store_owner']),async(req,res)=>{try{
  const r=await pool.query('UPDATE reviews SET is_approved=TRUE,is_rejected=FALSE,admin_notes=$1 WHERE id=$2 AND store_id=$3 RETURNING *',[req.body.notes||null,req.params.rid,req.params.sid]);
  res.json(r.rows[0]);
}catch(e){res.status(500).json({error:e.message});}});

router.patch('/stores/:sid/reviews/:rid/reject',authMiddleware(['store_owner']),async(req,res)=>{try{
  const r=await pool.query('UPDATE reviews SET is_rejected=TRUE,is_approved=FALSE,admin_notes=$1 WHERE id=$2 AND store_id=$3 RETURNING *',[req.body.notes||null,req.params.rid,req.params.sid]);
  res.json(r.rows[0]);
}catch(e){res.status(500).json({error:e.message});}});

router.delete('/stores/:sid/reviews/:rid',authMiddleware(['store_owner']),async(req,res)=>{try{
  await pool.query('DELETE FROM reviews WHERE id=$1 AND store_id=$2',[req.params.rid,req.params.sid]);
  res.json({ok:true});
}catch(e){res.status(500).json({error:e.message});}});

// ═══ GOOGLE SHEETS - orders export for frontend sync ═══
router.get('/stores/:sid/orders-export',authMiddleware(['store_owner']),async(req,res)=>{try{
  const orders=await pool.query(`SELECT o.*,
    (SELECT json_agg(json_build_object('product_name',oi.product_name,'quantity',oi.quantity,'unit_price',oi.unit_price))
     FROM order_items oi WHERE oi.order_id=o.id) as items
    FROM orders o WHERE o.store_id=$1 ORDER BY o.created_at DESC LIMIT 500`,[req.params.sid]);
  const rows=orders.rows.map(o=>{
    let items='';if(o.items&&Array.isArray(o.items))items=o.items.map(i=>`${i.product_name} x${i.quantity}`).join(', ');
    return['ORD-'+String(o.order_number).padStart(5,'0'),o.created_at?new Date(o.created_at).toLocaleString():'',
      o.customer_name||'',o.customer_phone||'',o.customer_email||'',
      o.shipping_address||'',o.shipping_wilaya||'',items,
      o.subtotal||0,o.shipping_cost||0,o.total||0,
      o.payment_method||'',o.payment_status||'',o.status||'',
      o.tracking_number||'',o.notes||''];
  });
  res.json({header:['Order #','Date','Customer','Phone','Email','Address','Wilaya','Items','Subtotal','Shipping','Total','Payment','Pay Status','Status','Tracking','Notes'],rows});
}catch(e){res.status(500).json({error:e.message});}});

// ═══ STATUS TEMPLATES (per-store customization of order statuses) ═══
let _statusTemplatesReady=null;
function ensureStatusTemplatesTable(){
  if(!_statusTemplatesReady){
    _statusTemplatesReady=(async()=>{
      try{await pool.query(`CREATE TABLE IF NOT EXISTS store_status_templates(
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        store_id UUID NOT NULL,
        key TEXT NOT NULL,
        label TEXT,
        color TEXT,
        enabled BOOLEAN DEFAULT TRUE,
        notify_customer BOOLEAN DEFAULT TRUE,
        position INT DEFAULT 0,
        is_builtin BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(store_id,key)
      )`);}catch(e){console.error('[status_templates table]',e.message);}
    })();
  }
  return _statusTemplatesReady;
}
ensureStatusTemplatesTable();

router.get('/stores/:sid/status-templates',authMiddleware(['store_owner','store_staff']),async(req,res)=>{try{
  await ensureStatusTemplatesTable();
  const r=await pool.query('SELECT * FROM store_status_templates WHERE store_id=$1 ORDER BY position ASC, created_at ASC',[req.params.sid]);
  res.json(r.rows);
}catch(e){console.error('[GET status-templates]',e.message);res.status(500).json({error:e.message});}});

router.put('/stores/:sid/status-templates',authMiddleware(['store_owner']),async(req,res)=>{try{
  await ensureStatusTemplatesTable();
  const statuses=Array.isArray(req.body?.statuses)?req.body.statuses:[];
  const sid=req.params.sid;
  await pool.query('DELETE FROM store_status_templates WHERE store_id=$1',[sid]);
  for(let i=0;i<statuses.length;i++){
    const s=statuses[i];
    if(!s||!s.key)continue;
    try{
      await pool.query(
        `INSERT INTO store_status_templates(store_id,key,label,color,enabled,notify_customer,position,is_builtin)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [sid,s.key,s.label||s.key,s.color||'#64748b',s.enabled!==false,s.notify_customer!==false,i,!!s.is_builtin]
      );
    }catch(e){console.error('[PUT status-templates row]',s.key,e.message);}
  }
  const r=await pool.query('SELECT * FROM store_status_templates WHERE store_id=$1 ORDER BY position ASC',[sid]);
  res.json({ok:true,statuses:r.rows});
}catch(e){console.error('[PUT status-templates]',e.message);res.status(500).json({error:e.message});}});

// Public (no auth) — used by the buyer TrackOrder page to render localized status labels.
router.get('/public/stores/:sid/status-templates',async(req,res)=>{try{
  await ensureStatusTemplatesTable();
  const r=await pool.query('SELECT key,label,color,enabled,notify_customer FROM store_status_templates WHERE store_id=$1 AND enabled=TRUE ORDER BY position ASC',[req.params.sid]);
  res.json(r.rows);
}catch(e){res.json([]);}});

module.exports=router;
