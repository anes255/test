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
    else if(channel==='SMS')results.sms=await messaging.sendSMS(order.customer_phone,msg);
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
  const chResult=result.whatsapp||result.sms||result.email||{};
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

module.exports=router;
