const express=require('express'),router=express.Router(),pool=require('../config/db');
const chatbot=require('../services/chatbot');
const messaging=require('../services/messaging');

// AI Chatbot — powered by OpenAI GPT
router.post('/:slug/chatbot',async(req,res)=>{try{
  const s=(await pool.query('SELECT * FROM stores WHERE slug=$1',[req.params.slug])).rows[0];
  if(!s)return res.status(404).json({error:'Not found'});

  const{message,history,language}=req.body;
  const cfg=s.config||{};

  // Build store context for the AI
  let productsSummary='';
  try{
    const prods=await pool.query('SELECT name,price,stock_quantity FROM products WHERE store_id=$1 AND is_active=TRUE ORDER BY created_at DESC LIMIT 20',[s.id]);
    if(prods.rows.length){
      productsSummary='TOP PRODUCTS:\n'+prods.rows.map(p=>`- ${p.name}: ${p.price} ${s.currency||'DZD'} (stock: ${p.stock_quantity})`).join('\n');
    }
  }catch(e){}

  // Get payment info
  let pay={};try{pay=(await pool.query('SELECT * FROM payment_settings WHERE store_id=$1',[s.id])).rows[0]||{};}catch(e){}

  const storeData={
    name:s.store_name,
    store_name:s.store_name,
    currency:s.currency||'DZD',
    contact_phone:s.contact_phone,
    enable_cod:pay.cod_enabled,
    enable_ccp:pay.ccp_enabled,
    ccp_account:pay.ccp_account,
    enable_baridimob:pay.baridimob_enabled,
    enable_bank_transfer:pay.bank_transfer_enabled,
    bank_name:pay.bank_name,
    chargily_enabled:cfg.chargily_enabled,
    products_summary:productsSummary,
  };

  const result=await chatbot.chat({message,store:storeData,history:history||[],language:language||'auto'});
  res.json(result);
}catch(e){console.error('[AI Chat]',e.message);res.status(500).json({error:'Chatbot error'});}});

// Fake order detection — AI-powered
router.post('/detect-fake',async(req,res)=>{try{
  const{store_id,customer_phone,order_total}=req.body;
  
  let history={cancelled:0,total_orders:0,total_spent:0};
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

  // Check blacklist
  let isBlacklisted=false;
  try{
    const bl=await pool.query('SELECT id FROM blacklist WHERE store_id=$1 AND phone=$2 AND is_active=TRUE',[store_id,customer_phone]);
    if(bl.rows.length)isBlacklisted=true;
  }catch(e){}

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

module.exports=router;
