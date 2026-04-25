const express=require('express'),router=express.Router(),pool=require('../config/db');
const chatbot=require('../services/chatbot');
const messaging=require('../services/messaging');

// Version check
router.get('/version',(req,res)=>res.json({version:'ai-v3-wa-debug'}));

// WhatsApp diagnostic
router.get('/whatsapp-debug',async(req,res)=>{
  const token=process.env.META_WHATSAPP_TOKEN;
  const phoneId=process.env.META_PHONE_NUMBER_ID;
  const result={token_set:!!token,token_length:token?token.length:0,token_preview:token?token.substring(0,20)+'...':'NOT SET',phone_id_set:!!phoneId,phone_id:phoneId||'NOT SET'};
  if(token&&phoneId){
    try{
      const r=await fetch('https://graph.facebook.com/v21.0/'+phoneId,{headers:{'Authorization':'Bearer '+token}});
      const d=await r.json();
      result.api_check=d.error?{error:d.error.message,code:d.error.code}:{ok:true,display_phone:d.display_phone_number,verified:d.verified_name,quality:d.quality_rating};
    }catch(e){result.api_check={error:e.message};}
  }
  res.json(result);
});

// WhatsApp send test with full debug
router.post('/whatsapp-test',async(req,res)=>{
  const token=process.env.META_WHATSAPP_TOKEN;
  const phoneId=process.env.META_PHONE_NUMBER_ID;
  if(!token||!phoneId)return res.status(400).json({error:'META_WHATSAPP_TOKEN or META_PHONE_NUMBER_ID not set on Render'});
  let phone=String(req.body.phone||'').replace(/[\s\-\+\(\)]/g,'');
  if(phone.startsWith('00213'))phone=phone.substring(2);
  else if(phone.startsWith('0'))phone='213'+phone.substring(1);
  else if(!phone.startsWith('213')&&phone.length<=10)phone='213'+phone;
  try{
    const r=await fetch('https://graph.facebook.com/v21.0/'+phoneId+'/messages',{
      method:'POST',headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json'},
      body:JSON.stringify({messaging_product:'whatsapp',to:phone,type:'template',template:{name:'hello_world',language:{code:'en_US'}}})
    });
    const d=await r.json();
    res.json({sent_to:phone,raw_response:d,success:!d.error});
  }catch(e){res.status(500).json({error:e.message});}
});

// Fake order detection — AI-powered
router.post('/detect-fake',async(req,res)=>{try{
  const order=req.body.order||req.body;
  const store_id=req.body.store_id||order.store_id;
  const customer_phone=order.customer_phone||'';
  const order_total=parseFloat(order.total||order.order_total||0);

  let history={cancelled:0,total_orders:0,total_spent:0};
  if(store_id&&customer_phone){
    try{
      const stats=await pool.query(
        "SELECT COUNT(*) FILTER(WHERE status='cancelled') as cancelled, COUNT(*) as total_orders, COALESCE(SUM(total),0) as total_spent FROM orders WHERE store_id=$1 AND customer_phone=$2",
        [store_id,customer_phone]
      );
      if(stats.rows[0]){
        history.cancelled=parseInt(stats.rows[0].cancelled);
        history.total_orders=parseInt(stats.rows[0].total_orders);
        history.total_spent=parseFloat(stats.rows[0].total_spent);
      }
    }catch(e){}
  }

  let isBlacklisted=false;
  if(store_id&&customer_phone){
    try{
      const bl=await pool.query('SELECT id FROM blacklist WHERE store_id=$1 AND phone=$2 AND is_active=TRUE',[store_id,customer_phone]);
      if(bl.rows.length)isBlacklisted=true;
    }catch(e){}
  }

  const result=await chatbot.detectFakeOrder(
    {total:order_total||0,customer_phone,customer_email:req.body.customer_email},
    history
  );

  if(isBlacklisted){result.score=100;result.level='high';result.flags.push('Customer is blacklisted');}

  res.json({fakeScore:result.score,riskLevel:result.level,flags:result.flags,isBlacklisted});
}catch(e){res.status(500).json({error:'Detection failed'});}});

// Cart recovery suggestions
router.post('/cart-recovery/suggest',async(req,res)=>{
  res.json({messages:[
    {sequence:1,delay:'30m',message:'👋 You left items in your cart! Complete your order before they sell out.'},
    {sequence:2,delay:'6h',message:'⏰ Your items are still waiting! Limited stock available.'},
    {sequence:3,delay:'24h',message:'🎁 Last chance! Use code COMEBACK10 for 10% off your cart.'},
  ]});
});

// Send cart recovery message manually
router.post('/cart-recovery/send',async(req,res)=>{try{
  const{store_id,customer_phone,customer_email,message,channel}=req.body;
  
  // Get store config for channel preference
  let ch=channel||'WHATSAPP';
  if(store_id){
    try{
      const s=await pool.query('SELECT config FROM stores WHERE id=$1',[store_id]);
      const cfg=s.rows[0]?.config||{};
      if(cfg.ai_channel)ch=cfg.ai_channel;
    }catch(e){}
  }

  const result=await messaging.sendNotification({
    channel:ch,
    phone:customer_phone,
    email:customer_email,
    message:message||'You left items in your cart! Complete your order now.',
    subject:'Complete your order',
  });

  res.json({sent:true,channel:ch,...result});
}catch(e){res.status(500).json({error:e.message});}});

// Send order notification (called internally or via API)
router.post('/notify/order',async(req,res)=>{try{
  const{store_id,order_id,type}=req.body; // type: 'confirmed','shipped','delivered'
  
  const store=(await pool.query('SELECT * FROM stores WHERE id=$1',[store_id])).rows[0];
  if(!store)return res.status(404).json({error:'Store not found'});
  const cfg=store.config||{};

  const order=(await pool.query('SELECT * FROM orders WHERE id=$1 AND store_id=$2',[order_id,store_id])).rows[0];
  if(!order)return res.status(404).json({error:'Order not found'});

  const orderNum='ORD-'+String(order.order_number).padStart(5,'0');
  const channel=cfg.ai_channel||'WHATSAPP';
  let msg='';

  if(type==='confirmed')msg=messaging.orderConfirmationMessage(store.store_name,orderNum,order.total,store.currency||'DZD');
  else if(type==='shipped')msg=messaging.orderShippedMessage(store.store_name,orderNum);
  else if(type==='delivered')msg=messaging.orderDeliveredMessage(store.store_name,orderNum);
  else msg=`Order ${orderNum} update: ${type}`;

  const results={};

  // Send via preferred channel
  if(order.customer_phone){
    if(channel==='WHATSAPP')results.whatsapp=await messaging.sendWhatsApp(order.customer_phone,msg);
  }

  // Always send email if available and customer has email
  if(order.customer_email){
    let items=[];
    try{items=(await pool.query('SELECT * FROM order_items WHERE order_id=$1',[order_id])).rows;}catch(e){}
    results.email=await messaging.sendEmail({
      to:order.customer_email,
      subject:`${store.store_name} — Order ${orderNum} ${type}`,
      html:messaging.orderConfirmationHTML(store.store_name,orderNum,order.total,store.currency||'DZD',items),
    });
  }

  res.json({sent:true,channel,results});
}catch(e){console.error('[Notify]',e.message);res.status(500).json({error:e.message});}});

// Get messaging status
router.get('/messaging/status',async(req,res)=>{
  const channels=messaging.getConfiguredChannels();
  const aiConfigured=chatbot.isConfigured();
  res.json({channels,ai:aiConfigured});
});

// TEST AI — send a test message and get response (for admin testing)
router.get('/test',async(req,res)=>{try{
  const aiOk=chatbot.isConfigured();
  const channels=messaging.getConfiguredChannels();
  
  // Test AI chatbot
  let aiResult=null;
  if(aiOk){
    aiResult=await chatbot.chat({message:'Hello, what payment methods do you accept?',store:{name:'Test Store',currency:'DZD',contact_phone:'0555000000',enable_cod:true,enable_ccp:true,enable_baridimob:true},history:[],language:'en'});
  }
  
  res.json({
    status:'ok',
    ai:{configured:aiOk,testResponse:aiResult?.response||'Not configured — add GEMINI_API_KEY',model:aiResult?.model||'none'},
    channels,
    instructions:'To fully test: POST /api/ai/{store-slug}/chatbot with {"message":"hello"} — this tests with real store data'
  });
}catch(e){res.status(500).json({error:e.message});}});

// Test AI chatbot — for admin testing
router.post('/test-chat',async(req,res)=>{try{
  const{message,store_name,history,language}=req.body;
  const testStore={name:store_name||'Test Store',store_name:store_name||'Test Store',currency:'DZD',contact_phone:'0555123456',enable_cod:true,enable_ccp:true,enable_baridimob:true,products_summary:'Products: Test Product 1 (2500 DZD), Test Product 2 (4000 DZD)'};
  const result=await chatbot.chat({message:message||'hello',store:testStore,history:history||[],language:language||'en'});
  res.json({...result,test:true,ai_configured:chatbot.isConfigured()});
}catch(e){console.error('[Test Chat Error]',e);res.status(500).json({error:e.message});}});

// Test send message — for admin testing
router.post('/test-send',async(req,res)=>{try{
  const{channel,phone,email,message,subject}=req.body;
  const ch=(channel||'WHATSAPP').toUpperCase();
  if(ch==='EMAIL'&&!email)return res.status(400).json({error:'Email address required'});
  if(ch!=='EMAIL'&&!phone)return res.status(400).json({error:'Phone number required'});
  const result=await messaging.sendNotification({channel:ch,phone,email,message:message||'Test message',subject:subject||'Test from your store'});
  const chResult=result.whatsapp||result.email||{};
  if(chResult.success===false)return res.status(400).json({error:chResult.reason||'Send failed',details:chResult});
  res.json({...result,test:true,sent:true});
}catch(e){res.status(500).json({error:e.message});}});

// AI: Generate product description
router.post('/generate-description',async(req,res)=>{try{
  const{product_name,category,language}=req.body;
  const desc=await chatbot.generateProductDescription(product_name||'Product',category,language||'ar');
  res.json({description:desc||'Could not generate description. Please try again.'});
}catch(e){res.status(500).json({error:e.message});}});

// AI: Generate cart recovery message
router.post('/generate-recovery',async(req,res)=>{try{
  const{store_name,items,language}=req.body;
  const msg=await chatbot.generateCartRecoveryMessage(store_name||'Store',items||['Product'],language||'ar');
  res.json({message:msg||'You left items in your cart! Complete your order now.'});
}catch(e){res.status(500).json({error:e.message});}});

// AI: Moderate a review
router.post('/moderate-review',async(req,res)=>{try{
  const{content,rating}=req.body;
  const result=await chatbot.moderateReview(content||'',rating||5);
  res.json(result);
}catch(e){res.status(500).json({error:e.message});}});

// AI: Generate product description (multi-language)
router.post('/generate-description-multi',async(req,res)=>{try{
  const{product_name,category}=req.body;
  const[en,fr,ar]=await Promise.all([
    chatbot.generateProductDescription(product_name||'Product',category,'en'),
    chatbot.generateProductDescription(product_name||'Product',category,'fr'),
    chatbot.generateProductDescription(product_name||'Product',category,'ar'),
  ]);
  res.json({en:en||'',fr:fr||'',ar:ar||''});
}catch(e){res.status(500).json({error:e.message});}});

// ═══ BUYER CHATBOT — MUST be LAST route (/:slug catches everything) ═══
router.post('/:slug/chatbot',async(req,res)=>{try{
  const s=(await pool.query('SELECT * FROM stores WHERE slug=$1',[req.params.slug])).rows[0];
  if(!s)return res.status(404).json({error:'Store not found'});
  const{message,history,language}=req.body;
  const cfg=s.config||{};
  let productsSummary='';
  try{
    const prods=await pool.query(`SELECT p.name, p.price, p.stock_quantity, p.description,
      (SELECT COUNT(*) FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.product_id=p.id AND o.status!='cancelled') as order_count
      FROM products p WHERE p.store_id=$1 AND p.is_active=TRUE ORDER BY order_count DESC, p.created_at DESC LIMIT 20`,[s.id]);
    if(prods.rows.length){
      productsSummary='PRODUCT CATALOG:\n'+prods.rows.map(p=>{
        let line=`- ${p.name}: ${p.price} ${s.currency||'DZD'}`;
        if(parseInt(p.order_count)>0) line+=` (${p.order_count} orders - popular)`;
        if(p.stock_quantity<=0) line+=' [OUT OF STOCK]';
        else if(p.stock_quantity<=5) line+=` [${p.stock_quantity} left]`;
        if(p.description) line+=` | ${(p.description||'').substring(0,80)}`;
        return line;
      }).join('\n');
    }
  }catch(e){}
  let pay={};try{pay=(await pool.query('SELECT * FROM payment_settings WHERE store_id=$1',[s.id])).rows[0]||{};}catch(e){}
  const storeData={name:s.store_name,store_name:s.store_name,currency:s.currency||'DZD',contact_phone:s.contact_phone,enable_cod:pay.cod_enabled,enable_ccp:pay.ccp_enabled,enable_baridimob:pay.baridimob_enabled,enable_bank_transfer:pay.bank_transfer_enabled,products_summary:productsSummary};
  const result=await chatbot.chat({message,store:storeData,history:history||[],language:language||'auto'});
  res.json(result);
}catch(e){console.error('[AI Chat]',e.message);res.status(500).json({error:'Chatbot error'});}});

// ═══════ WHATSAPP BAILEYS (QR CODE) ═══════
// ═══════ WHATSAPP QR (via Railway microservice) ═══════
const WA_SERVICE_URL = process.env.WA_SERVICE_URL || '';
const WA_API_SECRET = process.env.WA_API_SECRET || 'mymarket-wa-secret-2026';

async function waFetch(path, method = 'GET', body = null) {
  if (!WA_SERVICE_URL) throw new Error('WA_SERVICE_URL not set. Add your Railway URL to Render env vars.');
  const opts = { method, headers: { 'x-api-secret': WA_API_SECRET, 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(WA_SERVICE_URL + path, opts);
  return r.json();
}

router.get('/whatsapp-qr/debug', async (req, res) => {
  if (!WA_SERVICE_URL) return res.json({ error: 'WA_SERVICE_URL not set. Deploy WhatsApp service on Railway and add the URL to Render env vars.', setup_guide: '1. Create Railway project, 2. Deploy wa-service repo, 3. Add WA_SERVICE_URL on Render' });
  try { const data = await waFetch('/health'); res.json({ railway_url: WA_SERVICE_URL, railway_status: data }); } catch (e) { res.json({ railway_url: WA_SERVICE_URL, error: e.message }); }
});

router.post('/whatsapp-qr/start', async (req, res) => {
  try { const data = await waFetch('/start', 'POST', { storeId: req.body.storeId }); res.json(data); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/whatsapp-qr/status/:storeId', async (req, res) => {
  try { const data = await waFetch('/status/' + req.params.storeId); res.json(data); } catch (e) { res.json({ status: 'error', connected: false, error: e.message }); }
});

router.post('/whatsapp-qr/disconnect', async (req, res) => {
  try { const data = await waFetch('/disconnect', 'POST', { storeId: req.body.storeId }); res.json(data); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/whatsapp-qr/send', async (req, res) => {
  try {
    const { storeId, phone, message } = req.body;
    const data = await waFetch('/send', 'POST', { storeId, phone, message });
    try { await pool.query('INSERT INTO message_log(store_id,channel,recipient,message,status,error) VALUES($1,$2,$3,$4,$5,$6)', [storeId, 'whatsapp', phone, (message || '').substring(0, 200), data.success ? 'sent' : 'failed', data.reason || null]); } catch (e) {}
    if (data.success) res.json(data); else res.status(400).json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/whatsapp-qr/log/:storeId', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM message_log WHERE store_id=$1 ORDER BY created_at DESC LIMIT 50', [req.params.storeId]);
    const total = await pool.query("SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status='sent') as sent, COUNT(*) FILTER (WHERE status='failed') as failed FROM message_log WHERE store_id=$1", [req.params.storeId]);
    res.json({ messages: r.rows, stats: total.rows[0] });
  } catch (e) { res.json({ messages: [], stats: { total: 0, sent: 0, failed: 0 } }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Pixel validation proxy. Browsers can't read cross-origin pixel responses
// (CORS), so the frontend "test" button could only verify format. This route
// fetches the vendor's tracker URL server-side and returns whether the pixel
// is accepted (HTTP 200 / known good response). Works for FB / TikTok / GA4 /
// Snapchat / Google Sheets webhooks.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/pixels/verify', async (req, res) => {
  const { type, value } = req.body || {};
  const v = String(value || '').trim();
  if (!type || !v) return res.status(400).json({ ok: false, reason: 'Missing type or value' });
  try {
    let url, init = { method: 'GET', redirect: 'follow' };
    if (type === 'facebook_pixel') {
      // The Meta tracker accepts any 14–17 digit ID and returns a 1×1 GIF.
      // To distinguish real IDs we hit the GraphQL endpoint that exposes
      // public pixel info — invalid IDs return 400, real ones return 200.
      url = `https://graph.facebook.com/v18.0/${encodeURIComponent(v)}?fields=name&access_token=`;
    } else if (type === 'tiktok_pixel') {
      url = `https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=${encodeURIComponent(v)}&lib=ttq`;
    } else if (type === 'google_analytics') {
      url = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(v)}`;
    } else if (type === 'snapchat_pixel') {
      url = `https://tr.snapchat.com/p?p_id=${encodeURIComponent(v)}&_=${Date.now()}`;
    } else if (type === 'google_sheets') {
      url = v; init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ping: true, ts: Date.now() }) };
    } else {
      return res.status(400).json({ ok: false, reason: 'Unknown pixel type' });
    }

    // Use AbortController so a stalled vendor doesn't block the request.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let resp;
    try {
      resp = await fetch(url, { ...init, signal: controller.signal });
    } finally { clearTimeout(timer); }
    const status = resp.status;
    let bodySnippet = '';
    try { bodySnippet = (await resp.text()).slice(0, 600); } catch {}

    // Per-vendor heuristics for what counts as a real, in-use ID.
    if (type === 'facebook_pixel') {
      // Public pixel info: 200 → ID exists. Without a token Meta returns 400
      // for invalid IDs and a structured error for inaccessible-but-valid ones.
      if (status === 200) return res.json({ ok: true });
      // "An access token is required" or "object does not exist" → bad ID.
      if (/object .*does not exist|unsupported.*request|invalid.*id|nonexistent/i.test(bodySnippet)) return res.json({ ok: false, reason: 'Pixel ID not found on Meta' });
      // Fallback: treat 4xx as "format ok but no public visibility" — still a hint.
      return res.json({ ok: status < 500, reason: status >= 500 ? 'Meta unreachable' : 'ID may exist but is private (no public Graph access)' });
    }
    if (type === 'tiktok_pixel') {
      // The pixel SDK returns JS that contains the sdkid you requested when valid.
      // Invalid IDs return a 200 with a generic empty/error script body.
      const ok = status === 200 && /sdkid|TiktokAnalyticsObject|ttq/i.test(bodySnippet);
      return res.json({ ok, reason: ok ? '' : 'TikTok did not echo the pixel back — likely a bad ID' });
    }
    if (type === 'google_analytics') {
      // gtag.js loads regardless, but the response body for a valid ID
      // contains a config block referencing the measurement ID.
      const ok = status === 200 && bodySnippet.includes(v);
      return res.json({ ok, reason: ok ? '' : 'GA did not echo the measurement ID — invalid or unpublished' });
    }
    if (type === 'snapchat_pixel') {
      // Snap's tracker returns 200 GIF for any well-formed ID. There's no public
      // API to confirm existence, so we report network reachability only.
      return res.json({ ok: status === 200, reason: status === 200 ? '' : 'Snapchat tracker unreachable' });
    }
    if (type === 'google_sheets') {
      return res.json({ ok: status >= 200 && status < 400, reason: status >= 400 ? 'Webhook returned ' + status : '' });
    }
    res.json({ ok: false, reason: 'Unknown' });
  } catch (e) {
    res.json({ ok: false, reason: e.name === 'AbortError' ? 'Vendor timeout' : (e.message || 'Network error') });
  }
});

module.exports = router;
