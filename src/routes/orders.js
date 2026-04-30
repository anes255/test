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
  // Self-heal: audit columns may not exist on older databases. Add every
  // timestamp/audit column the UPDATE below might reference so it doesn't 500.
  try{await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ");}catch{}
  try{await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS prepared_at TIMESTAMPTZ");}catch{}
  try{await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipped_at TIMESTAMPTZ");}catch{}
  try{await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ");}catch{}
  try{await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ");}catch{}
  try{await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS confirmed_by VARCHAR(64)");}catch{}
  try{await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS prepared_by VARCHAR(64)");}catch{}
  try{await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancel_reason TEXT");}catch{}
  try{await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20)");}catch{}
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
    // Load order_items so {product_name}/{product_list}/{variant}/{quantity}
    // can resolve correctly. Loaded once and reused for both WA and email.
    let itemsForSubs = [];
    try { itemsForSubs = (await pool.query('SELECT * FROM order_items WHERE order_id=$1', [order.id])).rows; } catch {}
    const sharedFields = {
      store_name:           store.store_name,
      store_phone:          store.contact_phone || '',
      store_email:          store.contact_email || '',
      order_number:         orderNum,
      order_date:           order.created_at,
      order_time:           order.created_at,
      customer_name:        order.customer_name,
      customer_phone:       order.customer_phone,
      customer_email:       order.customer_email,
      total:                order.total,
      subtotal:             order.subtotal,
      shipping_cost:        order.shipping_cost,
      discount:             order.discount,
      currency:             store.currency || 'DZD',
      shipping_address:     order.shipping_address,
      shipping_city:        order.shipping_city,
      shipping_wilaya:      order.shipping_wilaya,
      shipping_zip:         order.shipping_zip,
      shipping_type:        order.shipping_type,
      payment_method:       order.payment_method,
      tracking_number:      order.tracking_number,
      tracking_url:         order.tracking_url || (order.tracking_number ? `https://track.${(store.contact_email||'').split('@')[1]||'store'}/${order.tracking_number}` : ''),
      delivery_company:     order.delivery_company_name || '',
      delivery_company_name:order.delivery_company_name || '',
      items:                itemsForSubs,
      item_count:           itemsForSubs.length,
    };
    let msg=messaging.generateOrderMessage({wa_templates:waTemplates},tplKey,sharedFields,waLang);
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
    
    // ── Email notifications (per-status, admin-configurable templates) ──
    // The admin configures email_enabled_statuses, email_templates, and
    // email_subjects in the EmailConfigModal. We send only when the status is
    // enabled (defaults to ON) and substitute the same variables WhatsApp uses.
    if (order.customer_email) {
      let emailEnabled = {};
      try { emailEnabled = typeof cfg.email_enabled_statuses === 'string' ? JSON.parse(cfg.email_enabled_statuses || '{}') : (cfg.email_enabled_statuses || {}); } catch {}
      const emailEnabledForStatus = emailEnabled[tplKey] !== false; // default ON
      if (emailEnabledForStatus) {
        const emailLang = cfg.email_language || waLang || 'fr';
        let emailTemplates = cfg.email_templates;
        let emailSubjects  = cfg.email_subjects;
        if (typeof emailTemplates === 'string') { try { emailTemplates = JSON.parse(emailTemplates); } catch { emailTemplates = null; } }
        if (typeof emailSubjects === 'string')  { try { emailSubjects  = JSON.parse(emailSubjects);  } catch { emailSubjects  = null; } }

        const subjectTpl = emailSubjects?.[emailLang]?.[tplKey] || emailSubjects?.fr?.[tplKey] || emailSubjects?.en?.[tplKey] || `${store.store_name} — Order ${orderNum} ${statusLabels[status] || status}`;
        const bodyTpl    = emailTemplates?.[emailLang]?.[tplKey] || emailTemplates?.fr?.[tplKey] || emailTemplates?.en?.[tplKey] || null;

        // Re-use generateOrderMessage with the SAME enriched payload as WA so
        // every localized variable alias and every {token} resolves identically.
        const subjectFilled = messaging.generateOrderMessage({ wa_templates: { [emailLang]: { [tplKey]: subjectTpl } } }, tplKey, sharedFields, emailLang) || subjectTpl;
        let htmlBody;
        if (bodyTpl) {
          const filled = messaging.generateOrderMessage({ wa_templates: { [emailLang]: { [tplKey]: bodyTpl } } }, tplKey, sharedFields, emailLang) || bodyTpl;
          // Convert plain text newlines to <br> so the HTML renders with line breaks.
          htmlBody = `<div style="font-family:Arial,Helvetica,sans-serif;line-height:1.55;font-size:14px;color:#1f2937;white-space:pre-wrap;">${filled.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>')}</div>`;
        } else {
          // No custom template — keep the rich confirmation card. Reuse the
          // items array we already loaded for variable substitution.
          htmlBody = messaging.orderConfirmationHTML(store.store_name, orderNum, order.total, store.currency || 'DZD', itemsForSubs, status);
        }

        console.log(`[Order ${orderNum}] Email → ${order.customer_email} | status: ${status} | enabled: ${emailEnabledForStatus} | template: ${bodyTpl ? 'admin' : 'default'}`);
        messaging.sendEmail({ to: order.customer_email, subject: subjectFilled, html: htmlBody })
          .then(r => {
            pool.query('INSERT INTO message_log(store_id,channel,recipient,message,status,error) VALUES($1,$2,$3,$4,$5,$6)', [req.params.sid, 'email', order.customer_email, (subjectFilled || '').substring(0, 200), r.success ? 'sent' : 'failed', r.reason || null]).catch(()=>{});
          })
          .catch(e => console.log('[Email] Error:', e.message));
      } else {
        console.log(`[Order ${orderNum}] Email skipped — admin disabled "${tplKey}" status for email.`);
      }
    } else {
      console.log('[Order] No customer email, skipping');
    }
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

  // Append to the per-store activity log for the Settings → Users feed.
  try{const{logActivity}=require('./storeOwner');await logActivity(req.params.sid,req,'order_status_change','order',r.rows[0]?.order_number||req.params.oid,`→ ${status}`);}catch{}
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
router.post('/stores/:sid/delivery-companies',authMiddleware(['store_owner']),async(req,res)=>{try{
  const{name,api_key,base_rate,provider_type,tracking_url,phone,api_base_url,api_auth_type,api_headers,api_query_params,oauth2_token_url,oauth2_credentials,api_method,api_body_template,api_tracking_endpoint,api_status_path,api_create_endpoint,api_create_method,api_create_body_template,api_create_tracking_path}=req.body;
  const r=await pool.query(`INSERT INTO delivery_companies(
    store_id,name,api_key,base_rate,provider_type,tracking_url,phone,api_base_url,api_auth_type,api_headers,
    api_query_params,oauth2_token_url,oauth2_credentials,api_method,api_body_template,api_tracking_endpoint,api_status_path,
    api_create_endpoint,api_create_method,api_create_body_template,api_create_tracking_path
  ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13::jsonb,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING *`,
    [req.params.sid,name,api_key||null,base_rate||0,provider_type||'manual',tracking_url||null,phone||null,
     api_base_url||null,api_auth_type||'none',JSON.stringify(api_headers||{}),
     JSON.stringify(api_query_params||{}),oauth2_token_url||null,JSON.stringify(oauth2_credentials||{}),
     api_method||'GET',api_body_template||null,api_tracking_endpoint||null,api_status_path||null,
     api_create_endpoint||null,api_create_method||'POST',api_create_body_template||null,api_create_tracking_path||null]);
  res.status(201).json(r.rows[0]);
}catch(e){console.error('[delivery-companies POST]',e.message);res.status(500).json({error:e.message});}});
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
  // Include any order that's BEEN ASSIGNED TO A CARRIER, even without a
  // tracking number yet (the carrier may not have returned one, or we're
  // still polling). These orders are "carrier-managed" and should appear in
  // the tracking page so the admin can monitor them. Orders with neither a
  // carrier nor a tracking number are excluded.
  let q=`SELECT o.*,dc.name as company_name,dc.provider_type,dc.api_key as company_api_key,dc.tracking_url
    FROM orders o LEFT JOIN delivery_companies dc ON dc.id=o.delivery_company_id
    WHERE o.store_id=$1
      AND (
        o.tracking_number IS NOT NULL
        OR o.delivery_company_id IS NOT NULL
        OR o.status IN ('shipped','delivered','returned')
      )`;
  const p=[req.params.sid];
  // "tracked" = has a tracking number from the carrier.
  // "untracked" = assigned to a carrier but no tracking number yet (still
  // syncing) — these are still trackable by external_id / order_number,
  // they just don't have the carrier's return tracking ref.
  if(status==='tracked'){q+=' AND o.tracking_number IS NOT NULL';}
  else if(status==='untracked'){q+=' AND o.tracking_number IS NULL';}
  q+=' ORDER BY o.updated_at DESC LIMIT 200';
  const r=await pool.query(q,p);
  res.json(r.rows.map(o=>({...o,order_number:'ORD-'+String(o.order_number).padStart(5,'0')})));
}catch(e){res.status(500).json({error:e.message});}});

// Fetch live tracking — generic for ANY delivery API
router.get('/stores/:sid/track/:trackingNumber',authMiddleware(['store_owner','store_staff']),async(req,res)=>{try{
  const param=req.params.trackingNumber;
  // Match by tracking_number OR by external_id OR by order_number — so an
  // order that's been dispatched to a carrier but doesn't have a returned
  // tracking number yet can still be queried using its own ID.
  const order=await pool.query(
    `SELECT o.*,dc.api_key,dc.provider_type,dc.name as company_name,dc.tracking_url,
     dc.api_base_url,dc.api_auth_type,dc.api_headers,dc.api_tracking_endpoint,dc.api_status_path,
     dc.api_query_params,dc.oauth2_token_url,dc.oauth2_credentials,dc.api_method,dc.api_body_template
     FROM orders o LEFT JOIN delivery_companies dc ON dc.id=o.delivery_company_id
     WHERE o.store_id=$1
       AND (o.tracking_number=$2 OR o.external_id=$2 OR o.id::text=$2 OR o.order_number::text=$2)
     LIMIT 1`,[req.params.sid,param]);
  if(!order.rows.length)return res.status(404).json({error:'Tracking not found'});
  const o=order.rows[0];
  // If we matched by something other than the tracking_number, use whichever
  // identifier the carrier API expects (tracking_number first, then any fallback).
  const tn=o.tracking_number||o.external_id||String(o.order_number||o.id);

  // If company has API config, call it via the shared carrierRequest helper
  // (handles bearer / token_prefix / custom_headers / query_params / OAuth2).
  if(o.api_base_url && o.api_tracking_endpoint){
    try{
      console.log(`[Track] ${o.company_name}: ${o.api_method||'GET'} ${o.api_base_url}${o.api_tracking_endpoint}`);
      const cr=await carrierRequest(o,tn);
      const raw=cr.body||'';
      console.log(`[Track] Response ${cr.status}: ${raw.substring(0,300)}`);

      if(cr.ok){
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
        error:cr.status===401?'Invalid API credentials (401)':cr.status===404?'Parcel not found (404)':`API error (${cr.status||cr.err||'no response'})`,
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
// Push an existing order to the carrier's create-order endpoint, save the
// returned tracking number, and flip the order to shipped.
router.post('/stores/:sid/orders/:oid/dispatch',authMiddleware(['store_owner','store_staff']),async(req,res)=>{try{
  const{ delivery_company_id }=req.body||{};
  // Self-heal in case the cols haven't been added yet
  for(const sql of [
    "ALTER TABLE delivery_companies ADD COLUMN IF NOT EXISTS api_create_endpoint VARCHAR(500)",
    "ALTER TABLE delivery_companies ADD COLUMN IF NOT EXISTS api_create_method VARCHAR(10) DEFAULT 'POST'",
    "ALTER TABLE delivery_companies ADD COLUMN IF NOT EXISTS api_create_body_template TEXT",
    "ALTER TABLE delivery_companies ADD COLUMN IF NOT EXISTS api_create_tracking_path VARCHAR(255)",
  ]) { try { await pool.query(sql); } catch {} }

  const order=(await pool.query('SELECT * FROM orders WHERE id=$1 AND store_id=$2',[req.params.oid,req.params.sid])).rows[0];
  if(!order)return res.status(404).json({error:'Order not found'});
  const dcId = delivery_company_id || order.delivery_company_id;
  if(!dcId)return res.status(400).json({error:'No delivery company specified'});
  const dc=(await pool.query('SELECT * FROM delivery_companies WHERE id=$1 AND store_id=$2',[dcId,req.params.sid])).rows[0];
  if(!dc)return res.status(404).json({error:'Delivery company not found'});

  // Make sure the delivery_company_id is saved before we push so the carrier
  // record is associated with the order even if push fails.
  if (order.delivery_company_id !== dcId) {
    await pool.query('UPDATE orders SET delivery_company_id=$1,updated_at=NOW() WHERE id=$2',[dcId,order.id]);
    order.delivery_company_id = dcId;
  }

  // Pre-flight credential check — hit the carrier's tracking/list endpoint
  // with a dummy reference so we surface auth errors BEFORE saying "transfer
  // ok". Without this, fake credentials silently succeeded.
  if (dc.api_base_url && (dc.api_tracking_endpoint || dc.api_create_endpoint)) {
    const probe = await carrierRequest({ ...dc, api_tracking_endpoint: dc.api_tracking_endpoint || '/' }, 'CRED_CHECK');
    if (probe.err) {
      let hint = probe.err;
      if (/fetch failed|ENOTFOUND|EAI_AGAIN/.test(probe.err)) hint = `Cannot reach ${dc.api_base_url} — verify the URL with the carrier.`;
      else if (/timeout|ECONN/i.test(probe.err)) hint = `${dc.name} API timed out. Try again or check the URL.`;
      return res.status(502).json({ ok:false, error:`Transfer rejected — ${hint}` });
    }
    if (probe.status === 401 || probe.status === 403) {
      return res.status(401).json({ ok:false, error:`Transfer rejected — invalid credentials for ${dc.name} (HTTP ${probe.status}). Update your API token in Shipping Partners and try again.` });
    }
  }

  // Carriers without ANY API → manual mode (admin acknowledges this in
  // Shipping Partners by leaving api_base_url empty).
  if(!dc.api_base_url){
    return res.json({ok:true,manual:true,message:`${dc.name} is a manual carrier. Order saved — paste the tracking number once you create it on their platform.`});
  }
  if(!dc.api_create_endpoint){
    // Carrier has tracking but no create endpoint configured → still verified
    // above, so we accept the assignment as "manual create".
    return res.json({ok:true,manual:true,message:`${dc.name} has tracking-only API. Credentials verified — paste the tracking number once you create it on their platform.`});
  }

  const items=(await pool.query('SELECT * FROM order_items WHERE order_id=$1',[order.id])).rows;
  const result=await carrierCreateOrder(dc,order,items);
  // Trim massive carrier responses (HTML pages, dump payloads) so the JSON
  // we return stays well under proxy size limits and never crashes the
  // worker. Render then can't intercept with its own 502 overlay.
  const trimResp = (r) => {
    try {
      if (r == null) return r;
      const s = typeof r === 'string' ? r : JSON.stringify(r);
      return s.length > 4000 ? (s.slice(0, 4000) + '…(truncated)') : r;
    } catch { return String(r).slice(0, 4000); }
  };
  if(!result.ok){
    // Return a 200 with ok:false so Render's proxy doesn't treat this as
    // a gateway error (the carrier rejected the order — that's our app's
    // payload, not an upstream failure). Frontend already inspects ok.
    return res.json({ok:false,error:result.err||'Carrier rejected the order',carrier_response:trimResp(result.carrier_response),carrier_status:result.status});
  }
  // Save the tracking number returned by the carrier and mark order shipped.
  const tn=result.tracking_number||'';
  if(tn){
    await pool.query('UPDATE orders SET tracking_number=$1,updated_at=NOW() WHERE id=$2',[tn,order.id]);
  }
  // Flip status to shipped (re-uses /status endpoint logic by issuing a similar UPDATE)
  try{
    for(const sql of [
      "ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipped_at TIMESTAMPTZ",
      "ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20)",
    ]) { try { await pool.query(sql); } catch {} }
    await pool.query("UPDATE orders SET status='shipped',shipped_at=NOW(),updated_at=NOW() WHERE id=$1",[order.id]);
  }catch{}
  // Append to the activity log so the admin can audit the dispatch.
  try{const{logActivity}=require('./storeOwner');await logActivity(req.params.sid,req,'order_dispatched','order',order.order_number||order.id,JSON.stringify({carrier:dc.name,tracking_number:tn||null}));}catch{}
  res.json({ok:true,tracking_number:tn,carrier_response:trimResp(result.carrier_response),message:`Order pushed to ${dc.name}`+(tn?` · TN: ${tn}`:'')});
}catch(e){
  // Always return JSON, never let the route propagate to a 502 from Render.
  console.error('[dispatch] uncaught:',e?.message,e?.stack);
  res.status(500).json({ok:false,error:e?.message||'Dispatch failed unexpectedly'});
}});

// ─────────────────────────────────────────────────────────────────────────────
// Pull every shipment / parcel from the carrier into our orders table.
// Used by the Tracking Orders page's "Sync from carrier" button so the admin
// can manage parcels created directly on the carrier's site (e.g. by phone
// agents) alongside the orders our storefront placed.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/stores/:sid/delivery-companies/:did/sync',authMiddleware(['store_owner']),async(req,res)=>{
  try{
    const dc=(await pool.query('SELECT * FROM delivery_companies WHERE id=$1 AND store_id=$2',[req.params.did,req.params.sid])).rows[0];
    if(!dc)return res.status(404).json({error:'Carrier not found'});
    if(!dc.api_base_url)return res.status(400).json({error:'Carrier has no API configured. Add credentials first.'});

    // Pick the carrier's "list parcels" endpoint based on host.
    const host=(()=>{try{return new URL(dc.api_base_url).host.toLowerCase();}catch{return '';}})();
    let listCfg=dc, body=null;
    if(/yalidine\.app|yalidine/.test(host)){
      listCfg={...dc,api_tracking_endpoint:'/parcels/?page_size=200'};
    }else if(/noest|app\.noest-dz/.test(host)){
      listCfg={...dc,api_tracking_endpoint:'/get/parcels'};
    }else if(/procolis|dhd\./.test(host)){
      listCfg={...dc,api_tracking_endpoint:'/lire',api_method:'POST',api_body_template:'{"Colis":[]}'};
      body='{"Colis":[]}';
    }else if(/ecotrack/.test(host)){
      listCfg={...dc,api_tracking_endpoint:'/get/orders?limit=200'};
    }else{
      return res.status(400).json({error:`No list-parcels endpoint known for ${host}. Sync supports Yalidine, NOEST, DHD/Procolis and EcoTrack.`});
    }

    // Use carrierRequest to apply the same auth scheme (headers, query params, oauth2).
    const r=await carrierRequest(listCfg,'',body);
    if(r.err)return res.json({ok:false,error:r.err,url:r.url});
    let data=null;try{data=JSON.parse(r.body||'');}catch{}
    if(!data)return res.json({ok:false,error:`Carrier returned non-JSON (HTTP ${r.status}). First 240 chars: ${(r.body||'').slice(0,240)}`});

    // Normalize the parcel list across carriers.
    const flatten=(d)=>{
      if(Array.isArray(d))return d;
      if(d&&typeof d==='object'){
        for(const k of ['data','parcels','results','list','Colis','orders','rows','items'])
          if(Array.isArray(d[k]))return d[k];
        // last resort: any array on root
        for(const v of Object.values(d))if(Array.isArray(v))return v;
      }
      return [];
    };
    const list=flatten(data);
    if(!list.length){
      return res.json({ok:true,synced:0,inserted:0,updated:0,message:'Carrier accepted credentials but returned 0 parcels. Nothing to sync.'});
    }

    // Self-heal columns we use during the upsert.
    for(const sql of [
      "ALTER TABLE orders ADD COLUMN IF NOT EXISTS source VARCHAR(40)",
      "ALTER TABLE orders ADD COLUMN IF NOT EXISTS external_id VARCHAR(120)",
      "ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_status VARCHAR(80)",
    ]){try{await pool.query(sql);}catch{}}

    // Map carrier-specific fields → our order shape.
    const pick=(o,...keys)=>{for(const k of keys){if(o&&o[k]!=null&&o[k]!=='')return o[k];}return null;};
    const mapStatus=(s)=>{
      const t=String(s||'').toLowerCase();
      if(/livr[éeè]|deliver|تم التسليم/.test(t))return 'delivered';
      if(/exp[éeè]di|ship|في الطريق/.test(t))return 'shipped';
      if(/retour|return|مرتجع/.test(t))return 'returned';
      if(/annul|cancel|ملغ/.test(t))return 'cancelled';
      if(/transit|center|en cours/.test(t))return 'shipped';
      if(/r[ée]ception|prepar/.test(t))return 'preparing';
      return 'shipped';
    };
    let inserted=0,updated=0;
    for(const p of list){
      const tracking=String(pick(p,'tracking','tracking_number','code','Tracking','parcel_id','id','orderId')||'').trim();
      if(!tracking)continue;
      const phone=String(pick(p,'to_commune_phone','contact_phone','customer_phone','phone','MobileA','client_phone')||'').replace(/[^\d+]/g,'');
      const name=String(pick(p,'firstname','customer_name','client','Client','recipient','to_name')||'').trim()
        +(pick(p,'familyname')?' '+pick(p,'familyname'):'');
      const wilaya=String(pick(p,'to_wilaya_name','wilaya','Wilaya','shipping_wilaya')||'');
      const commune=String(pick(p,'to_commune_name','commune','Commune','shipping_city')||'');
      const address=String(pick(p,'address','adresse','Adresse','shipping_address')||'');
      const total=parseFloat(pick(p,'price','total','montant','Total','order_total'))||0;
      const stRaw=String(pick(p,'last_status','Situation','status','statut','tracking_status')||'');
      const ourStatus=mapStatus(stRaw);
      const createdAt=pick(p,'date_creation','created_at','createdAt','date');
      const externalId=String(pick(p,'order_id','external_id','id','reference','Tracking')||tracking);

      // Upsert by (store_id, tracking_number) so re-running sync updates state.
      const existing=(await pool.query('SELECT id FROM orders WHERE store_id=$1 AND tracking_number=$2 LIMIT 1',[req.params.sid,tracking])).rows[0];
      if(existing){
        await pool.query(
          `UPDATE orders SET status=$1,tracking_status=$2,delivery_company_id=$3,updated_at=NOW() WHERE id=$4`,
          [ourStatus,stRaw||null,dc.id,existing.id]
        );
        updated++;
      }else{
        const num=parseInt((await pool.query('SELECT COALESCE(MAX(order_number),0)+1 as n FROM orders WHERE store_id=$1',[req.params.sid])).rows[0].n);
        await pool.query(
          `INSERT INTO orders(store_id,order_number,customer_name,customer_phone,shipping_address,shipping_city,shipping_wilaya,total,subtotal,shipping_cost,discount,payment_method,status,tracking_status,tracking_number,delivery_company_id,source,external_id,created_at,updated_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,0,0,$10,$11,$12,$13,$14,$15,$16,$17,NOW())`,
          [req.params.sid,num,name||'(carrier import)',phone||null,address||null,commune||null,wilaya||null,total,total,'cod',ourStatus,stRaw||null,tracking,dc.id,'carrier_'+host,externalId,createdAt||new Date()]
        );
        inserted++;
      }
    }
    res.json({ok:true,synced:list.length,inserted,updated,message:`Synced ${list.length} parcels from ${dc.name} (${inserted} new, ${updated} updated).`});
  }catch(e){console.error('[carrier sync]',e.message);res.status(500).json({ok:false,error:e.message||'Sync failed'});}
});

router.post('/stores/:sid/delivery-companies/:did/test',authMiddleware(['store_owner']),async(req,res)=>{try{
  const dc=(await pool.query('SELECT * FROM delivery_companies WHERE id=$1 AND store_id=$2',[req.params.did,req.params.sid])).rows[0];
  if(!dc)return res.status(404).json({error:'Company not found'});
  if(!dc.api_base_url)return res.json({ok:false,error:'No API Base URL configured.'});
  const r=await carrierRequest(dc,'TEST00000');
  if(r.err){
    let hint=r.err;
    if(/fetch failed|ENOTFOUND|EAI_AGAIN/.test(r.err))hint='DNS failed — '+dc.api_base_url+' is unreachable. Verify the URL.';
    return res.json({ok:false,error:hint});
  }
  if(r.status===401||r.status===403)return res.json({ok:false,error:`Authentication failed (HTTP ${r.status}). Check your credentials.`});
  return res.json({ok:true,message:`Connected to ${dc.name} (HTTP ${r.status})`});
}catch(e){res.status(500).json({error:e.message});}});

// ─────────────────────────────────────────────────────────────────────────────
// Shared carrier request helper. Resolves auth (Bearer / Token prefix /
// custom headers / query params / OAuth2 client_credentials) and substitutes
// {tracking_number} into the URL + body template. Returns {ok,status,body,err}.
// ─────────────────────────────────────────────────────────────────────────────
async function carrierRequest(cfg, trackingNumber) {
  const tn = trackingNumber || 'TEST00000';
  const parse = (v) => typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch { return {}; } })() : (v || {});
  const headersIn = parse(cfg.api_headers);
  const queryIn = parse(cfg.api_query_params);
  const oauth = parse(cfg.oauth2_credentials);
  const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };

  // Auth resolution
  if (cfg.api_auth_type === 'bearer' && cfg.api_key) headers['Authorization'] = 'Bearer ' + cfg.api_key;
  else if (cfg.api_auth_type === 'token_prefix' && cfg.api_key) headers['Authorization'] = 'Token ' + cfg.api_key;
  else if (cfg.api_auth_type === 'custom_headers') Object.assign(headers, headersIn);
  else if (cfg.api_auth_type === 'oauth2') {
    if (!cfg.oauth2_token_url) return { ok:false, err:'OAuth2 token URL missing' };
    if (!oauth.client_id || !oauth.client_secret) return { ok:false, err:'OAuth2 client_id/client_secret missing' };
    try {
      const tokenBody = new URLSearchParams({ grant_type:'client_credentials', client_id:oauth.client_id, client_secret:oauth.client_secret });
      const tr = await fetch(cfg.oauth2_token_url, { method:'POST', headers:{ 'Content-Type':'application/x-www-form-urlencoded' }, body:tokenBody, signal:AbortSignal.timeout(15000) });
      const tj = await tr.json().catch(() => ({}));
      if (!tr.ok || !tj.access_token) return { ok:false, status:tr.status, err:'OAuth2 token request failed: ' + (tj.error_description || tj.error || ('HTTP '+tr.status)) };
      headers['Authorization'] = 'Bearer ' + tj.access_token;
    } catch (e) { return { ok:false, err:'OAuth2 token fetch failed: ' + e.message }; }
  }

  // Build URL with tracking number + query-param auth
  let path = (cfg.api_tracking_endpoint || '').replace(/\{tracking_number\}/g, encodeURIComponent(tn))
                                                .replace(/\{number\}/g, encodeURIComponent(tn))
                                                .replace(/\{tn\}/g, encodeURIComponent(tn));
  let url = (cfg.api_base_url || '').replace(/\/$/, '');
  if (path) url += (path.startsWith('/') || path.startsWith('?')) ? path : ('/' + path);
  if (cfg.api_auth_type === 'query_params') {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(queryIn)) if (v) params.set(k, v);
    if (params.toString()) url += (url.includes('?') ? '&' : '?') + params.toString();
  }

  // Build body
  const method = (cfg.api_method || 'GET').toUpperCase();
  let body;
  if (method !== 'GET' && cfg.api_body_template) {
    let tpl = cfg.api_body_template.replace(/\{tracking_number\}/g, tn);
    // Substitute custom-header values into the body too (Aramex needs UserName/Password in body)
    for (const [k, v] of Object.entries(headersIn)) tpl = tpl.split('{' + k + '}').join(String(v || ''));
    body = tpl;
  }

  try {
    const r = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(15000) });
    const txt = await r.text();
    return { ok: r.ok, status: r.status, body: txt, url };
  } catch (e) {
    return { ok:false, err:e.message, url };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Push an order to the carrier's create-order endpoint. Uses the same auth
// resolution as carrierRequest, but POSTs the order payload (after template
// substitution) and parses the carrier's response for the new tracking number.
// Returns { ok, tracking_number, carrier_response, err }.
// ─────────────────────────────────────────────────────────────────────────────
async function carrierCreateOrder(cfg, order, items) {
  const parse = (v) => typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch { return {}; } })() : (v || {});
  const headersIn = parse(cfg.api_headers);
  const queryIn   = parse(cfg.api_query_params);
  const oauth     = parse(cfg.oauth2_credentials);
  const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };

  // Auth resolution (same logic as carrierRequest)
  if (cfg.api_auth_type === 'bearer' && cfg.api_key) headers['Authorization'] = 'Bearer ' + cfg.api_key;
  else if (cfg.api_auth_type === 'token_prefix' && cfg.api_key) headers['Authorization'] = 'Token ' + cfg.api_key;
  else if (cfg.api_auth_type === 'custom_headers') Object.assign(headers, headersIn);
  else if (cfg.api_auth_type === 'oauth2') {
    if (!cfg.oauth2_token_url || !oauth.client_id || !oauth.client_secret) return { ok:false, err:'OAuth2 credentials missing' };
    try {
      const tokenBody = new URLSearchParams({ grant_type:'client_credentials', client_id:oauth.client_id, client_secret:oauth.client_secret });
      const tr = await fetch(cfg.oauth2_token_url, { method:'POST', headers:{ 'Content-Type':'application/x-www-form-urlencoded' }, body:tokenBody, signal:AbortSignal.timeout(15000) });
      const tj = await tr.json().catch(() => ({}));
      if (!tj.access_token) return { ok:false, err:'OAuth2 token request failed' };
      headers['Authorization'] = 'Bearer ' + tj.access_token;
    } catch (e) { return { ok:false, err:'OAuth2 token fetch failed: ' + e.message }; }
  }

  // Build URL
  const path = (cfg.api_create_endpoint || '').trim();
  if (!path) return { ok:false, err:'Carrier has no create-order endpoint configured' };
  let url = (cfg.api_base_url || '').replace(/\/$/, '');
  url += (path.startsWith('/') || path.startsWith('?')) ? path : ('/' + path);
  if (cfg.api_auth_type === 'query_params') {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(queryIn)) if (v) params.set(k, v);
    if (params.toString()) url += (url.includes('?') ? '&' : '?') + params.toString();
  }

  // Substitute order fields into the body template.
  const productList = (items || []).map(i => `${i.product_name || i.name || 'Item'} ×${i.quantity || 1}`).join(', ');
  const fullName = order.customer_name || '';
  const nameParts = fullName.trim().split(/\s+/);
  const firstName = nameParts[0] || fullName;
  const lastName = nameParts.slice(1).join(' ') || '';
  const subs = {
    tracking_number:    order.tracking_number || '',
    order_id:           order.order_number || order.id || '',
    customer_name:      fullName,
    customer_firstname: firstName,
    customer_lastname:  lastName,
    customer_phone:     (order.customer_phone || '').replace(/[^\d+]/g, ''),
    customer_email:     order.customer_email || '',
    shipping_address:   order.shipping_address || '',
    shipping_city:      order.shipping_city || '',
    shipping_wilaya:    order.shipping_wilaya || '',
    shipping_zip:       order.shipping_zip || '',
    wilaya_code:        order.shipping_wilaya_code || '',
    total:              String(parseFloat(order.total || 0) || 0),
    subtotal:           String(parseFloat(order.subtotal || 0) || 0),
    shipping_cost:      String(parseFloat(order.shipping_cost || 0) || 0),
    discount:           String(parseFloat(order.discount || 0) || 0),
    currency:           order.currency || 'DZD',
    is_stopdesk:        order.shipping_type === 'desk' ? 'true' : 'false',
    is_stopdesk_int:    order.shipping_type === 'desk' ? '1' : '0',
    payment_method:     order.payment_method || 'cod',
    notes:              order.notes || '',
    item_count:         String((items || []).reduce((s, i) => s + (parseInt(i.quantity) || 1), 0)),
    product_list:       productList,
    weight:             String((items || []).reduce((s, i) => s + (parseFloat(i.weight) || 0), 0) || 1),
  };

  // Build body. If api_create_body_template is empty, build a generic JSON
  // payload from the substitutions so ANY carrier expecting a flat shape works.
  const tpl = (cfg.api_create_body_template || '').trim();
  let body;
  if (tpl) {
    // Templates often contain JSON with `{customer_phone}` placeholders. Encode
    // each substitution for JSON safety, then string-replace.
    let filled = tpl;
    for (const [k, v] of Object.entries(subs)) {
      // Use a JSON-encoded string so quotes/newlines in values don't break the JSON.
      const safe = JSON.stringify(String(v ?? '')).slice(1, -1); // strip outer quotes
      filled = filled.split('{' + k + '}').join(safe);
    }
    // Also substitute custom-header values (Aramex pattern).
    for (const [k, v] of Object.entries(headersIn)) {
      const safe = JSON.stringify(String(v ?? '')).slice(1, -1);
      filled = filled.split('{' + k + '}').join(safe);
    }
    body = filled;
  } else {
    body = JSON.stringify(subs);
  }

  const method = (cfg.api_create_method || 'POST').toUpperCase();
  try {
    const r = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(20000) });
    const txt = await r.text();
    let data; try { data = JSON.parse(txt); } catch { data = null; }

    // ── Strict success detection ─────────────────────────────────────────
    // Carriers like NOEST return HTTP 200 with {"success":false,"message":
    // "Token invalide"} for bad creds. We MUST scan the body — not just
    // r.ok — and only accept the response if it carries a real tracking
    // number AND no auth-failure markers.
    const flatten = (obj, depth=0) => {
      if (depth > 4 || obj == null) return '';
      if (typeof obj === 'string') return obj + ' ';
      if (typeof obj !== 'object') return '';
      let out = '';
      for (const v of Array.isArray(obj) ? obj : Object.values(obj)) out += flatten(v, depth+1);
      return out;
    };
    const blob = (typeof txt === 'string' ? txt : '').toLowerCase() + ' ' + flatten(data).toLowerCase();
    const authFailKeywords = [
      'invalid token','invalid api','invalid key','invalid credentials','invalid auth',
      'unauthor','authentication failed','auth failed','access denied','forbidden',
      'wrong token','wrong key','token invalid','token expir','token incorrect',
      'clé invalide','jeton invalide','erreur de token','erreur token',
      'token invalide','user_guid','utilisateur introuvable','non autorisé','non autorise',
      'permission denied','not allowed','please login','login required',
      'jwt expired','jwt malformed','bad token',
    ];
    const matched = authFailKeywords.find(k => blob.includes(k));
    if (matched) {
      return { ok:false, err:`Carrier rejected your credentials (response contains "${matched}"). Re-check the API token / key and try again.`, status:r.status, carrier_response:data || txt };
    }
    // Explicit `success:false` at the root.
    if (data && typeof data === 'object' && data.success === false) {
      return { ok:false, err:`Carrier returned success:false. ${data.message ? `Reason: "${String(data.message).slice(0,200)}"` : 'Bad credentials or carrier rejected the order.'}`, status:r.status, carrier_response:data };
    }
    if (!r.ok) {
      return { ok:false, err:`Carrier rejected the order (HTTP ${r.status}). ${data?.message ? `Reason: "${String(data.message).slice(0,200)}"` : ''}`.trim(), status:r.status, carrier_response:data || txt };
    }

    // Walk the configured tracking-path to extract the new tracking number.
    let tracking = '';
    if (data && cfg.api_create_tracking_path) {
      let val = data;
      for (const p of cfg.api_create_tracking_path.split('.')) { if (val == null) break; val = !isNaN(p) ? val[parseInt(p)] : val[p]; }
      if (val != null && typeof val !== 'object') tracking = String(val);
    }
    // Common fallbacks if no path or path missed
    if (!tracking && data) {
      const pickFrom = (obj) => obj && (obj.tracking || obj.tracking_number || obj.tracking_id || obj.parcel_id || obj.shipment_id || obj.id || '');
      tracking = pickFrom(data) || pickFrom(Array.isArray(data) ? data[0] : null) || pickFrom(data?.data) || pickFrom(data?.result) || '';
    }

    // No tracking number returned → the carrier didn't actually create the
    // parcel. This is the strongest "credentials are wrong" signal carriers
    // like NOEST give (HTTP 200 + empty {"message":""} payload). Refuse to
    // mark the order as dispatched.
    if (!tracking) {
      const sample = (typeof txt === 'string' ? txt : JSON.stringify(data)).slice(0, 240);
      return {
        ok: false,
        err: `Carrier returned no tracking number — credentials are likely wrong, or the request was malformed. The carrier said: ${sample || '(empty response)'}`,
        status: r.status,
        carrier_response: data || txt,
      };
    }

    return { ok:true, tracking_number:String(tracking), carrier_response:data || txt, status:r.status };
  } catch (e) {
    return { ok:false, err:e.message };
  }
}

// Test API config WITHOUT saving — for the form "Test Connection" button.
// Strictly validates that the response actually proves working credentials.
router.post('/stores/:sid/delivery-companies/test-config',authMiddleware(['store_owner']),async(req,res)=>{try{
  const cfg = req.body || {};
  const results={connection:null,tracking:null,status_extraction:null};
  if(!cfg.api_base_url)return res.json({ok:false,error:'API Base URL is required',results});

  // ── Carrier-specific auth probe ────────────────────────────────────────
  // Hitting the tracking endpoint with a fake number is unreliable: many
  // carriers return an empty 200 (or "data:[]") whether or not the creds
  // are valid, which makes "verified" misleading.
  // Instead we hit a *known-real* endpoint per carrier — listing wilayas or
  // account info — that returns ACTUAL data only when authentication works.
  const host = (() => { try { return new URL(cfg.api_base_url).host.toLowerCase(); } catch { return ''; } })();
  let probeCfg = cfg;
  let probeNumber = 'ZZ_INVALID_TEST_000000';
  let probeNote = '';
  // CRITICAL: every probe below MUST hit an endpoint that REJECTS bad
  // credentials with a different response than it gives good credentials.
  // Some "list" endpoints (NOEST /get/wilayas, /get/parcels) return the
  // same payload for any creds, so we use the CREATE endpoint with
  // intentionally-incomplete data — bad creds give an auth error; good
  // creds give a field-validation error. The shape diff is what proves
  // auth was actually checked.
  let isCreateProbe = false;
  if (/yalidine\.app|yalidine/.test(host)) {
    // Yalidine /parcels (POST) with empty array: bad creds → 401/403,
    // good creds → 400 validation. Real auth differential.
    probeCfg = { ...cfg, api_tracking_endpoint: '/parcels/', method: 'POST', api_body_template: '[]' };
    probeNumber = '';
    probeNote = 'Probed /parcels CREATE (auth-required)';
    isCreateProbe = true;
  } else if (/noest|app\.noest-dz|noest-dz/.test(host)) {
    // NOEST /create/order with stub body: bad creds → "Token invalide",
    // good creds → field-validation error mentioning specific fields.
    probeCfg = { ...cfg, api_tracking_endpoint: '/create/order', method: 'POST', api_body_template: '{}' };
    probeNumber = '';
    probeNote = 'Probed /create/order (auth-required)';
    isCreateProbe = true;
  } else if (/procolis|dhd\./.test(host)) {
    // Procolis /lire with empty Colis: requires real token + key headers.
    probeCfg = { ...cfg, api_tracking_endpoint: '/lire', method: 'POST', api_body_template: '{"Colis":[]}' };
    probeNumber = '';
    probeNote = 'Probed /lire (auth-required)';
    isCreateProbe = true;
  } else if (/ecotrack/.test(host)) {
    // EcoTrack /create/order — bad creds → auth error, good creds → validation.
    probeCfg = { ...cfg, api_tracking_endpoint: '/create/order', method: 'POST', api_body_template: '{}' };
    probeNumber = '';
    probeNote = 'Probed /create/order (auth-required)';
    isCreateProbe = true;
  }

  // ── Differential auth test ────────────────────────────────────────────
  // Some carriers' "list" endpoints return 200 with empty data regardless
  // of credentials (public/cached responses), which let bogus creds pass
  // verification. To be CERTAIN, we make TWO calls:
  //   1) with the credentials the admin pasted
  //   2) with intentionally-corrupted credentials (suffix _BAD)
  // If both responses are identical, the endpoint isn't validating creds
  // and we cannot honestly say "verified".
  const corruptCreds = (c) => {
    const out = { ...c };
    try {
      const h = JSON.parse(out.api_headers || '{}');
      for (const k of Object.keys(h)) h[k] = String(h[k]) + '_INVALID_PROBE';
      out.api_headers = JSON.stringify(h);
    } catch {}
    try {
      const q = JSON.parse(out.api_query_params || '{}');
      for (const k of Object.keys(q)) q[k] = String(q[k]) + '_INVALID_PROBE';
      out.api_query_params = JSON.stringify(q);
    } catch {}
    if (out.api_key) out.api_key = String(out.api_key) + '_INVALID_PROBE';
    return out;
  };

  // Step 1: hit the auth-probe endpoint (or fallback to fake-tracking lookup).
  const r = await carrierRequest(probeCfg, probeNumber);
  if (r.err) {
    let hint = r.err;
    if (/fetch failed|ENOTFOUND|EAI_AGAIN/.test(r.err)) hint = 'DNS lookup failed — the API base URL host does not exist or is unreachable. Verify the URL with the carrier.';
    else if (/ECONN|timeout/i.test(r.err)) hint = 'Carrier API did not respond within 15s. Check the URL and try again.';
    else if (/CERT|SSL|TLS/i.test(r.err)) hint = 'TLS/SSL handshake failed — invalid certificate on the carrier host.';
    return res.json({ ok:false, error:hint, results:{connection:{ok:false,message:hint}}, url:r.url });
  }
  if (r.status === 401 || r.status === 403) {
    return res.json({ ok:false, error:'Authentication failed (HTTP '+r.status+'). Your credentials are wrong.', results:{connection:{ok:false,status:r.status}}, url:r.url });
  }

  // Step 2: parse the response body. If it's HTML we hit a generic landing
  // page / wrong path — NOT a real API response. Reject.
  const body = String(r.body || '').trim();
  const looksLikeHtml = /^<\s*(!doctype|html|head|body)/i.test(body) || /<\/html>/i.test(body);
  if (looksLikeHtml) {
    return res.json({ ok:false, error:`The endpoint returned an HTML page, not JSON (HTTP ${r.status}). The base URL or tracking endpoint is wrong — most carrier APIs return JSON.`, results:{connection:{ok:false,status:r.status,message:'HTML response, not API JSON'}}, url:r.url });
  }

  // Try to parse as JSON. Most real carrier APIs return JSON for every response
  // including errors. If it isn't JSON, the endpoint isn't a real API.
  let data = null;
  try { data = JSON.parse(body); } catch { /* not JSON */ }
  if (!data) {
    if (!body) {
      return res.json({ ok:false, error:`Empty response from carrier (HTTP ${r.status}). Endpoint exists but returned nothing — credentials likely wrong or endpoint path incorrect.`, results:{connection:{ok:false,status:r.status}}, url:r.url });
    }
    return res.json({ ok:false, error:`Response is not valid JSON (HTTP ${r.status}). First 120 chars: ${body.slice(0,120)}`, results:{connection:{ok:false,status:r.status}}, url:r.url });
  }

  // Step 3: scan the JSON body for known error indicators. Many carriers return
  // 200 OK with `{"detail":"Invalid token"}` instead of a proper 4xx — we
  // treat those as auth failures.
  const flatten = (obj, depth=0) => {
    if (depth > 4 || obj == null) return '';
    if (typeof obj === 'string') return obj + ' ';
    if (typeof obj !== 'object') return '';
    let out = '';
    for (const v of Array.isArray(obj) ? obj : Object.values(obj)) out += flatten(v, depth+1);
    return out;
  };
  const blob = flatten(data).toLowerCase();
  const authFailKeywords = [
    'invalid token','invalid api','invalid key','invalid credentials','invalid auth',
    'unauthor','authentication failed','auth failed','access denied','forbidden',
    'wrong token','wrong key','token invalid','token expir','clé invalide','jeton invalide',
    'erreur de token','erreur token','token incorrect','non autorisé','non autorise',
    'token invalide','user_guid','utilisateur introuvable','bad token','rate limit',
    'permission denied','not allowed','please login','login required','jwt expired','jwt malformed'
  ];
  const matched = authFailKeywords.find(k => blob.includes(k));
  // Also reject explicit `success:false` payloads at the root.
  if (!matched && data && typeof data === 'object' && data.success === false) {
    return res.json({
      ok:false,
      error:`Carrier returned success:false. ${data.message ? `Reason: "${String(data.message).slice(0,160)}"` : 'Credentials likely wrong.'}`,
      results:{ connection:{ ok:false, status:r.status, message:'success:false in response body' } },
      sample: body.slice(0, 240),
      url:r.url,
    });
  }
  if (matched) {
    return res.json({
      ok:false,
      error:`Carrier rejected your credentials (response contains "${matched}"). Double-check what you pasted.`,
      results:{ connection:{ ok:false, status:r.status, message:'Carrier reported credential error in response body' } },
      sample: body.slice(0, 240),
      url:r.url,
    });
  }

  // Step 4: verify the response has a recognisable carrier shape. Real
  // tracking responses contain at least one of:
  //   - a payload key (data / results / list / shipments / output / parcels / trackResponse / Colis / Tracking / TrackingResults / meta / links)
  //   - an error/info key (message / error / detail / errors / status / success)
  //     — those are valid responses for an invalid tracking number, and the
  //     auth-keyword scan above already rejected real credential failures.
  const payloadKeys = ['data','results','list','shipments','output','parcels','trackResponse','Colis','Tracking','TrackingResults','meta','links'];
  const infoKeys    = ['message','error','detail','errors','status','success','code','msg','result'];
  const knownKeys   = [...payloadKeys, ...infoKeys];
  const hasShape = data && typeof data === 'object' && (
    Array.isArray(data) || knownKeys.some(k => Object.prototype.hasOwnProperty.call(data, k))
  );
  if (!hasShape) {
    return res.json({
      ok:false,
      error:`Endpoint responded but the JSON shape doesn't look like a tracking API. Got keys: ${Object.keys(data||{}).slice(0,8).join(', ')||'(none)'}. The base URL or endpoint path is probably wrong.`,
      results:{ connection:{ ok:false, status:r.status, message:'Unrecognised JSON shape' } },
      sample: body.slice(0, 240),
      url:r.url,
    });
  }
  // If the only key is `message`/`error`/`detail`, surface its value to the
  // admin so they can confirm it's a "not found" response (good — auth works)
  // versus something they need to act on.
  const onlyHasInfo = !payloadKeys.some(k => Object.prototype.hasOwnProperty.call(data, k));
  let infoNote = '';
  if (onlyHasInfo) {
    const v = data.message || data.error || data.detail || data.msg || data.result;
    if (v) infoNote = ` Carrier said: "${String(v).slice(0,160)}"`;
  }

  // Step 5: success diagnostics. Count meaningful items so the admin sees
  // concrete proof the carrier returned real data, not just a shape-valid
  // empty placeholder. We look at ANY array on the root, then any array
  // value of any key (so {wilayas:[...]}, {communes:[...]}, {desks:[...]},
  // {data:[...]}, etc. all count correctly), then fall back to a key count.
  const itemCount = (() => {
    if (Array.isArray(data)) return data.length;
    if (data && typeof data === 'object') {
      // Find the largest array anywhere at the top level.
      let best = 0;
      for (const v of Object.values(data)) {
        if (Array.isArray(v) && v.length > best) best = v.length;
      }
      if (best > 0) return best;
      // Or the first nested object's key count, as a lower-bound signal.
      for (const v of Object.values(data)) {
        if (v && typeof v === 'object' && !Array.isArray(v)) return Object.keys(v).length;
      }
      // Object with only scalar fields → at least it returned data.
      return Object.keys(data).length;
    }
    return 0;
  })();
  results.connection = { ok:true, status:r.status, message:`Real carrier JSON received (HTTP ${r.status})` };
  results.tracking   = { ok:true, status:r.status, message: probeNote ? `${probeNote} · ${itemCount} item${itemCount===1?'':'s'} returned` : (r.ok ? 'Endpoint responded OK' : `Returned ${r.status} — normal for invalid tracking number`) };
  if (cfg.api_status_path && !probeNote) {
    try {
      let val = data;
      for (const p of cfg.api_status_path.split('.')) { if (val == null) break; val = !isNaN(p) ? val[parseInt(p)] : val[p]; }
      if (val != null) results.status_extraction = { ok:true, value:String(val).slice(0,120), message:`Sample status: "${String(val).slice(0,120)}"` };
      else results.status_extraction = { ok:true, message:'Status path is navigable but empty (expected for invalid tracking number)' };
    } catch { results.status_extraction = { ok:false, message:'Could not walk the status path' }; }
  } else if (probeNote) {
    results.status_extraction = { ok:true, message: itemCount > 0 ? `${itemCount} record${itemCount===1?'':'s'} returned — credentials are working.` : 'Endpoint accepted credentials but returned no records.' };
  }

  // If the probe was an account-scoped endpoint (parcels/orders) and the
  // response carries 0 items AND no recognizable carrier success markers,
  // we can't say credentials are valid — the endpoint might be public/
  // cached or the account may be empty. Surface as a warning, not green.
  const carrierConfirmsAuth = (() => {
    if (!data || typeof data !== 'object') return false;
    // Common positive markers carriers include only on authenticated calls.
    if (data.has_more === true || data.has_more === false) return true;
    if (typeof data.total_data === 'number' || typeof data.total === 'number' || typeof data.count === 'number') return true;
    if (data.success === true) return true;
    if (data.links && typeof data.links === 'object') return true;
    if (data.meta && typeof data.meta === 'object') return true;
    return false;
  })();

  // Recognise carrier-specific validation phrases — these are the GREEN
  // signal for a CREATE probe: it means "auth passed, data is bad" (which
  // is exactly what we expect when we send {} to /create/order).
  const validationKeywords = [
    'is required','required field','required.','obligatoire','le champ','les champs',
    'must be','doit être','validation','validation error','field is missing','missing field',
    'required:','must not be empty','cannot be empty','should not be empty','manquant',
    'invalid wilaya','invalid commune','invalid phone','invalid recipient','client est',
    'mobilea','adresse','wilaya_id','must be a string','must be an integer',
  ];
  const validationMatched = validationKeywords.find(k => blob.includes(k));
  if (isCreateProbe && validationMatched) {
    // Auth confirmed: carrier rejected our payload for DATA reasons, which
    // requires it to have actually authenticated us first.
    results.connection = { ok:true, status:r.status, message:`Authenticated — carrier returned a validation error ("${validationMatched}") which proves it accepted your credentials.` };
    results.tracking   = { ok:true, status:r.status, message:'CREATE endpoint reachable with real auth' };
    return res.json({
      ok:true,
      message:`Credentials verified — ${new URL(cfg.api_base_url).host} authenticated and returned a field-level validation error (expected, since the test payload was empty).`,
      results,
      sample: body.slice(0, 240),
      url:r.url,
    });
  }

  if (probeNote && itemCount === 0 && !carrierConfirmsAuth && !isCreateProbe) {
    return res.json({
      ok: true,
      unverified: true,
      message: `Configuration saved. The endpoint responded but returned 0 records — your account may simply have no parcels yet, or the credentials may be wrong. Click "Transfer" on a real order to confirm.`,
      results: { connection: { ok: true, warning: true, status: r.status, message: 'Empty response, cannot confirm auth — verify via real dispatch' } },
      sample: body.slice(0, 240),
      url: r.url,
    });
  }
  // ── Differential probe (run BEFORE the ambiguous warning) ─────────────
  // If validationMatched was already true we returned earlier. Otherwise
  // re-run the SAME request with intentionally-corrupted credentials and
  // compare. Real auth ALWAYS changes the response when creds change; if
  // the bodies differ, that's our positive proof.
  let differentialPassed = false;
  let differentialDetail = null;
  if (probeNote) {
    try {
      const corrupted = corruptCreds(probeCfg);
      const r2 = await carrierRequest(corrupted, probeNumber);
      const a = String(r.body || '').replace(/\s+/g, '').slice(0, 4000);
      const b = String(r2.body || '').replace(/\s+/g, '').slice(0, 4000);
      const sameStatus = r.status === r2.status;
      const sameBody   = a && a === b;
      differentialDetail = { real_status: r.status, fake_status: r2.status, real_sample: (r.body || '').slice(0, 200), fake_sample: (r2.body || '').slice(0, 200), same: sameStatus && sameBody };
      if (sameStatus && sameBody) {
        // The carrier's API doesn't react to credentials on this endpoint —
        // NOEST is the canonical example: /create/order replies with the same
        // {"message":""} for any creds, so we can't detect auth here. Don't
        // block the save: surface as a yellow informational pass with a clear
        // "real verification happens on dispatch" note. The admin's first
        // Transfer click will then either succeed or surface NOEST's real
        // error using the exact credentials they pasted.
        return res.json({
          ok: true,
          unverified: true,
          message: `Configuration saved. ${new URL(cfg.api_base_url).host} can't be auto-verified — its API returns the same response (${(body || '(empty)').slice(0, 60)}…) for any credentials. Click "Transfer" on a real order to do the actual end-to-end test; if your credentials are wrong, that call will surface the carrier's real error. ${infoNote}`,
          results: { connection: { ok: true, warning: true, status: r.status, message: 'Endpoint cannot differentiate credentials — verify via real dispatch' } },
          sample: body.slice(0, 240),
          differential: differentialDetail,
          url: r.url,
        });
      }
      // Bodies differ → real auth happened. Strength depends on whether the
      // corrupted call also showed an explicit auth error.
      const corruptedBlob = String(r2.body || '').toLowerCase();
      const corruptedRejected = r2.status === 401 || r2.status === 403 || authFailKeywords.some(k => corruptedBlob.includes(k));
      differentialPassed = true;
      results.connection = corruptedRejected
        ? { ok:true, status:r.status, message:`✓ Differential check passed — carrier rejected fake credentials (HTTP ${r2.status}) and accepted yours (HTTP ${r.status}).` }
        : { ok:true, status:r.status, message:`✓ Real and fake credentials produced different responses (real HTTP ${r.status} vs fake HTTP ${r2.status}) — credentials authenticated something on the carrier side.` };
    } catch (e) {
      console.log('[differential probe error]', e.message);
    }
  }

  // For CREATE probes that didn't return validation/auth/differential —
  // we have no automated way to confirm auth, but the credentials are still
  // saved and dispatch will be the real test. Don't block the form.
  if (isCreateProbe && !matched && !validationMatched && !differentialPassed) {
    return res.json({
      ok: true,
      unverified: true,
      message: `Configuration saved. ${new URL(cfg.api_base_url).host} responded but didn't give us a verifiable auth signal (sample: ${body.slice(0, 80)}…). Click "Transfer" on a real order to do the end-to-end test — that's the only authoritative validation for this carrier.`,
      results: { connection: { ok: true, warning: true, status: r.status, message: 'Ambiguous response — verify via real dispatch' } },
      sample: body.slice(0, 240),
      differential: differentialDetail,
      url: r.url,
    });
  }

  // Success message — depends on which signal proved auth.
  const verifiedMsg = differentialPassed
    ? `Credentials verified — ${new URL(cfg.api_base_url).host} accepted yours and rejected a deliberately-corrupted version (real ↔ fake responses differ). ${infoNote}`
    : probeNote
      ? `Credentials verified — ${new URL(cfg.api_base_url).host} returned ${itemCount} record${itemCount===1?'':'s'} from your account.${infoNote}`
      : `API configuration verified — credentials accepted by ${new URL(cfg.api_base_url).host}.${infoNote}`;

  res.json({
    ok:true,
    message: verifiedMsg,
    results,
    sample: body.slice(0, 240),
    differential: differentialDetail,
    url:r.url,
  });
}catch(e){console.error('[test-config]',e.message);res.status(500).json({error:e.message});}});

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
  const{name,api_key,base_rate,provider_type,tracking_url,phone,api_base_url,api_auth_type,api_headers,api_query_params,oauth2_token_url,oauth2_credentials,api_method,api_body_template,api_tracking_endpoint,api_status_path,api_create_endpoint,api_create_method,api_create_body_template,api_create_tracking_path}=req.body;
  const r=await pool.query(
    `UPDATE delivery_companies SET name=COALESCE($1,name),api_key=$2,base_rate=COALESCE($3,base_rate),
     provider_type=COALESCE($4,provider_type),tracking_url=$5,phone=$6,
     api_base_url=$7,api_auth_type=COALESCE($8,api_auth_type),api_headers=$9::jsonb,
     api_query_params=$10::jsonb,oauth2_token_url=$11,oauth2_credentials=$12::jsonb,
     api_method=COALESCE($13,api_method),api_body_template=$14,
     api_tracking_endpoint=$15,api_status_path=$16,
     api_create_endpoint=$17,api_create_method=COALESCE($18,api_create_method),api_create_body_template=$19,api_create_tracking_path=$20
     WHERE id=$21 AND store_id=$22 RETURNING *`,
    [name,api_key||null,base_rate,provider_type||'manual',tracking_url||null,phone||null,
     api_base_url||null,api_auth_type||'none',JSON.stringify(api_headers||{}),
     JSON.stringify(api_query_params||{}),oauth2_token_url||null,JSON.stringify(oauth2_credentials||{}),
     api_method||'GET',api_body_template||null,
     api_tracking_endpoint||null,api_status_path||null,
     api_create_endpoint||null,api_create_method||'POST',api_create_body_template||null,api_create_tracking_path||null,
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
