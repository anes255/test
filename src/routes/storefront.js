const express=require('express'),router=express.Router(),bcrypt=require('bcryptjs'),pool=require('../config/db'),{authMiddleware,generateToken}=require('../middleware/auth');

// Get store (public)
// Lookup store by custom domain
router.get('/by-domain/:domain',async(req,res)=>{try{
  const d=await pool.query('SELECT sd.store_id,s.slug FROM store_domains sd JOIN stores s ON s.id=sd.store_id WHERE sd.domain_name=$1 AND sd.status=$2',[req.params.domain,'active']);
  if(!d.rows.length)return res.status(404).json({error:'Domain not found'});
  res.json({slug:d.rows[0].slug,store_id:d.rows[0].store_id});
}catch(e){res.status(500).json({error:e.message});}});

router.get('/:slug',async(req,res)=>{try{const s=(await pool.query('SELECT * FROM stores WHERE slug=$1',[req.params.slug])).rows[0];if(!s)return res.status(404).json({error:'Store not found'});
  // Check owner subscription - only block if explicitly suspended
  let suspended=false;
  try{const owner=(await pool.query('SELECT subscription_status FROM store_owners WHERE id=$1',[s.owner_id])).rows[0];if(owner&&owner.subscription_status==='suspended')suspended=true;}catch(e){}
  if(suspended)return res.status(403).json({error:'Store suspended',suspended:true});
  let pay={};try{pay=(await pool.query('SELECT * FROM payment_settings WHERE store_id=$1',[s.id])).rows[0]||{};}catch(e){}const cfg=s.config||{};const chargilyOk=!!(process.env.CHARGILY_API_KEY);res.json({id:s.id,name:s.store_name,slug:s.slug,description:s.description,logo:s.logo_url,favicon:s.favicon_url,meta_title:s.meta_title,meta_description:s.meta_description,primary_color:s.primary_color||'#7C3AED',secondary_color:s.secondary_color||'#10B981',accent_color:s.accent_color||'#F59E0B',bg_color:s.bg_color||'#FAFAFA',text_color:cfg.text_color||'#1F2937',currency:s.currency||'DZD',default_language:cfg.default_language||'en',is_live:s.is_published,hero_title:s.hero_title,hero_subtitle:s.hero_subtitle,contact_email:s.contact_email,contact_phone:s.contact_phone,social_facebook:s.social_facebook,social_instagram:s.social_instagram,social_tiktok:s.social_tiktok,whatsapp_number:s.contact_phone,
    // Payment
    enable_cod:pay.cod_enabled||true,enable_ccp:pay.ccp_enabled||false,ccp_account:pay.ccp_account,ccp_name:pay.ccp_name,enable_baridimob:pay.baridimob_enabled||false,baridimob_rip:pay.baridimob_rip,baridimob_qr:cfg.baridimob_qr||null,enable_bank_transfer:pay.bank_transfer_enabled||false,bank_name:pay.bank_name,bank_account:pay.bank_account,bank_rib:pay.bank_rib,
    enable_chargily:chargilyOk&&(cfg.chargily_enabled!==false),
    // Shipping
    shipping_default_price:400,
    // AI & Chat
    ai_chatbot_enabled:cfg.ai_chatbot_enabled||cfg.ai_agent_enabled||false,ai_chatbot_name:cfg.ai_chatbot_name||'Support Bot',ai_chatbot_greeting:cfg.ai_chatbot_greeting||'مرحباً! كيف يمكنني مساعدتك؟',
    // Customization from config
    theme:cfg.theme||'classic',btn_add_cart:cfg.btn_add_cart||'Add to Cart',btn_order_now:cfg.btn_order_now||'Order Now',welcome_message:cfg.welcome_message,success_message:cfg.success_message,offer_enabled:cfg.offer_enabled,offer_title:cfg.offer_title,offer_discount:cfg.offer_discount,offer_bg:cfg.offer_bg,offer_tc:cfg.offer_tc,offer_hours:cfg.offer_hours,offer_minutes:cfg.offer_minutes,
    sticky_header:cfg.sticky_header,cart_drawer:cfg.cart_drawer,trust_signals:cfg.trust_signals,show_savings:cfg.show_savings,show_stock_storefront:cfg.show_stock_storefront,low_stock_threshold:cfg.low_stock_threshold||5,
    // Tracking pixels
    fb_pixel:cfg.fb_pixel,tiktok_pixel:cfg.tiktok_pixel,ga_id:cfg.ga_id,snap_pixel:cfg.snap_pixel,
    // Cover image
    cover_image:cfg.cover_image||null,
    page_builder:cfg.page_builder||null,
    // Owner-customizable header
    header_font:cfg.header_font||null,
    // Section animations (merchant-controlled, overrides template motion)
    animation_style:cfg.animation_style||null,
    animations_enabled:cfg.animations_enabled!==false,
    // Tax settings (read by checkout)
    tax_enabled:cfg.tax_enabled||false,tax_rate:cfg.tax_rate||0,tax_label:cfg.tax_label||'TVA',tax_inclusive:cfg.tax_inclusive||false,
    // Active domain selection
    active_domain:cfg.active_domain||'platform',
    // Full config exposed for buyer-side feature flags (chatbot, AI, etc.)
    config:cfg,
    // Footer
    footer_text:`© ${new Date().getFullYear()} ${s.store_name}. All rights reserved.`});}catch(e){res.status(500).json({error:e.message});}});

// Public shipping wilayas — used by checkout to show desk/home prices
router.get('/:slug/shipping-wilayas',async(req,res)=>{try{
  const store=(await pool.query('SELECT id FROM stores WHERE slug=$1',[req.params.slug])).rows[0];
  if(!store)return res.status(404).json({error:'Not found'});
  const rows=(await pool.query('SELECT wilaya_name,wilaya_code,desk_delivery_price,home_delivery_price,delivery_days FROM shipping_wilayas WHERE store_id=$1 ORDER BY wilaya_code',[store.id])).rows;
  res.json(rows);
}catch(e){res.json([]);}});

// Products (public)
router.get('/:slug/products',async(req,res)=>{try{const store=(await pool.query('SELECT id FROM stores WHERE slug=$1',[req.params.slug])).rows[0];if(!store)return res.status(404).json({error:'Not found'});const{search,category,sort,featured}=req.query;let q='SELECT * FROM products WHERE store_id=$1 AND is_active=TRUE';const p=[store.id];if(category){p.push(category);q+=` AND category_id=$${p.length}`;}if(search){p.push(`%${search}%`);q+=` AND name ILIKE $${p.length}`;}if(featured==='true')q+=' AND is_featured=TRUE';if(sort==='price_asc')q+=' ORDER BY price ASC';else if(sort==='price_desc')q+=' ORDER BY price DESC';else q+=' ORDER BY created_at DESC';q+=' LIMIT 50';const r=await pool.query(q,p);const products=r.rows.map(x=>{let imgs=x.images;if(typeof imgs==='string')try{imgs=JSON.parse(imgs);}catch(e){imgs=[];}if(!Array.isArray(imgs))imgs=[];return{...x,name_en:x.name,name_fr:x.name,name_ar:x.name,thumbnail:imgs[0]||null,compare_at_price:x.compare_price};});const count=await pool.query('SELECT COUNT(*) FROM products WHERE store_id=$1 AND is_active=TRUE',[store.id]);res.json({products,total:parseInt(count.rows[0].count)});}catch(e){res.status(500).json({error:e.message});}});

// Single product
router.get('/:slug/products/:pslug',async(req,res)=>{try{const store=(await pool.query('SELECT id FROM stores WHERE slug=$1',[req.params.slug])).rows[0];if(!store)return res.status(404).json({error:'Not found'});const r=await pool.query('SELECT * FROM products WHERE store_id=$1 AND slug=$2 AND is_active=TRUE',[store.id,req.params.pslug]);if(!r.rows.length)return res.status(404).json({error:'Not found'});const p=r.rows[0];let imgs=p.images;if(typeof imgs==='string')try{imgs=JSON.parse(imgs);}catch(e){imgs=[];}if(!Array.isArray(imgs))imgs=[];res.json({...p,name_en:p.name,name_fr:p.name,name_ar:p.name,description_en:p.description,thumbnail:imgs[0]||null,compare_at_price:p.compare_price,allow_oversell:!!p.allow_oversell,reviews:[]});}catch(e){res.status(500).json({error:e.message});}});

// Categories
router.get('/:slug/categories',async(req,res)=>{try{const store=(await pool.query('SELECT id FROM stores WHERE slug=$1',[req.params.slug])).rows[0];if(!store)return res.json([]);const r=await pool.query('SELECT * FROM categories WHERE store_id=$1 AND is_active=TRUE ORDER BY sort_order',[store.id]);res.json(r.rows.map(c=>({...c,name_en:c.name,name_fr:c.name,name_ar:c.name})));}catch(e){res.json([]);}});

// Customer register (per store)
router.post('/:slug/customers/register',async(req,res)=>{try{const store=(await pool.query('SELECT id FROM stores WHERE slug=$1',[req.params.slug])).rows[0];if(!store)return res.status(404).json({error:'Not found'});const{name,email,phone,password,address,city,wilaya}=req.body;if(!name||!phone||!password)return res.status(400).json({error:'Name, phone, password required'});const dup=await pool.query('SELECT id FROM customers WHERE store_id=$1 AND phone=$2',[store.id,phone]);if(dup.rows.length)return res.status(409).json({error:'Phone registered'});const hash=await bcrypt.hash(password,12);const r=await pool.query('INSERT INTO customers(store_id,full_name,email,phone,password_hash,address,city,wilaya) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,full_name,email,phone',[store.id,name,email||null,phone,hash,address||null,city||null,wilaya||null]);const c=r.rows[0];const token=generateToken({id:c.id,role:'customer',storeId:store.id,name:c.full_name});res.status(201).json({token,customer:{id:c.id,name:c.full_name,email:c.email,phone:c.phone}});}catch(e){res.status(500).json({error:e.message});}});

// Customer login
router.post('/:slug/customers/login',async(req,res)=>{try{const store=(await pool.query('SELECT id FROM stores WHERE slug=$1',[req.params.slug])).rows[0];if(!store)return res.status(404).json({error:'Not found'});const{phone,password}=req.body;const c=(await pool.query('SELECT * FROM customers WHERE store_id=$1 AND phone=$2',[store.id,phone])).rows[0];if(!c)return res.status(401).json({error:'Invalid'});if(!(await bcrypt.compare(password,c.password_hash)))return res.status(401).json({error:'Invalid'});const token=generateToken({id:c.id,role:'customer',storeId:store.id,name:c.full_name});res.json({token,customer:{id:c.id,name:c.full_name,email:c.email,phone:c.phone}});}catch(e){res.status(500).json({error:e.message});}});

// Customer profile
router.get('/:slug/customers/profile',authMiddleware(['customer']),async(req,res)=>{try{const c=(await pool.query('SELECT * FROM customers WHERE id=$1',[req.user.id])).rows[0];if(!c)return res.status(404).json({error:'Not found'});const orders=(await pool.query('SELECT * FROM orders WHERE customer_id=$1 ORDER BY created_at DESC',[req.user.id])).rows;res.json({...c,name:c.full_name,orders:orders.map(o=>({...o,order_number:'ORD-'+String(o.order_number).padStart(5,'0'),discount_amount:o.discount}))});}catch(e){res.status(500).json({error:e.message});}});
router.put('/:slug/customers/profile',authMiddleware(['customer']),async(req,res)=>{try{const b=req.body||{};await pool.query('UPDATE customers SET full_name=COALESCE($1,full_name),email=$2,phone=COALESCE($3,phone),address=$4,city=$5,wilaya=$6 WHERE id=$7',[b.name||null,b.email||null,b.phone||null,b.address||null,b.city||null,b.wilaya||null,req.user.id]);const c=(await pool.query('SELECT * FROM customers WHERE id=$1',[req.user.id])).rows[0];res.json({...c,name:c.full_name});}catch(e){res.status(500).json({error:e.message});}});

// Checkout
router.post('/:slug/orders',async(req,res)=>{try{const store=(await pool.query('SELECT * FROM stores WHERE slug=$1',[req.params.slug])).rows[0];if(!store)return res.status(404).json({error:'Not found'});const sid=store.id;const{items,customer_name,customer_phone,customer_email,shipping_address,shipping_city,shipping_wilaya,shipping_zip,shipping_type,payment_method,notes,customer_id,notification_preference}=req.body;if(!items||!items.length)return res.status(400).json({error:'Cart empty'});if(!customer_name||!customer_phone||!shipping_address)return res.status(400).json({error:'Info required'});let subtotal=0;const oi=[];for(const it of items){const p=(await pool.query('SELECT * FROM products WHERE id=$1 AND store_id=$2',[it.product_id,sid])).rows[0];if(!p)continue;
  // Check stock — skip if product allows oversell
  if(p.stock_quantity!==null&&p.stock_quantity<=0&&!p.allow_oversell&&p.track_inventory!==false){continue;}
  const t=p.price*it.quantity;subtotal+=t;let imgs=p.images;if(typeof imgs==='string')try{imgs=JSON.parse(imgs);}catch(e){imgs=[];}if(!Array.isArray(imgs))imgs=[];oi.push({product_id:p.id,product_name:p.name,product_image:imgs[0]||null,variant_info:it.variant||null,quantity:it.quantity,unit_price:p.price,total_price:t});}
  // Determine shipping cost from wilaya rates (desk vs home delivery)
  let ship=400; // default fallback
  const sType=(shipping_type||'desk').toLowerCase();
  if(shipping_wilaya){try{
    const wRow=(await pool.query('SELECT desk_delivery_price,home_delivery_price FROM shipping_wilayas WHERE store_id=$1 AND wilaya_name=$2',[sid,shipping_wilaya])).rows[0];
    if(wRow){ship=sType==='home'?parseFloat(wRow.home_delivery_price||400):parseFloat(wRow.desk_delivery_price||400);}
  }catch(e){}}
  const total=subtotal+ship;const num=parseInt((await pool.query('SELECT COALESCE(MAX(order_number),0)+1 as n FROM orders WHERE store_id=$1',[sid])).rows[0].n);const o=await pool.query('INSERT INTO orders(store_id,customer_id,order_number,customer_name,customer_phone,customer_email,shipping_address,shipping_city,shipping_wilaya,shipping_zip,subtotal,shipping_cost,discount,total,payment_method,notes,notification_preference,shipping_type) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *',[sid,customer_id||null,num,customer_name,customer_phone,customer_email||null,shipping_address,shipping_city||null,shipping_wilaya||null,shipping_zip||null,subtotal,ship,0,total,payment_method||'cod',notes||null,notification_preference||'whatsapp',sType]);for(const it of oi){await pool.query('INSERT INTO order_items(order_id,product_id,product_name,product_image,variant_info,quantity,unit_price,total_price) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[o.rows[0].id,it.product_id,it.product_name,it.product_image,it.variant_info,it.quantity,it.unit_price,it.total_price]);}// Auto-add or update customer record so every buyer shows in the customers page.
// Registered buyers already have a row; guest checkouts get one created here.
let custId = customer_id || null;
if (custId) {
  try { await pool.query('UPDATE customers SET total_orders=COALESCE(total_orders,0)+1,total_spent=COALESCE(total_spent,0)+$1,address=COALESCE($2,address),city=COALESCE($3,city),wilaya=COALESCE($4,wilaya) WHERE id=$5',[total,shipping_address,shipping_city,shipping_wilaya,custId]); } catch(e){}
} else {
  // Try to find an existing customer by phone, or create one.
  try {
    const existing = await pool.query('SELECT id FROM customers WHERE store_id=$1 AND phone=$2',[sid,customer_phone]);
    if (existing.rows.length) {
      custId = existing.rows[0].id;
      await pool.query('UPDATE customers SET total_orders=COALESCE(total_orders,0)+1,total_spent=COALESCE(total_spent,0)+$1,full_name=COALESCE($2,full_name),email=COALESCE($3,email),address=COALESCE($4,address),city=COALESCE($5,city),wilaya=COALESCE($6,wilaya) WHERE id=$7',[total,customer_name,customer_email,shipping_address,shipping_city,shipping_wilaya,custId]);
    } else {
      const nc = await pool.query('INSERT INTO customers(store_id,full_name,email,phone,address,city,wilaya,total_orders,total_spent) VALUES($1,$2,$3,$4,$5,$6,$7,1,$8) RETURNING id',[sid,customer_name,customer_email||null,customer_phone,shipping_address||null,shipping_city||null,shipping_wilaya||null,total]);
      custId = nc.rows[0]?.id;
    }
    // Link the order to the customer so it shows in their profile
    if (custId) await pool.query('UPDATE orders SET customer_id=$1 WHERE id=$2',[custId,o.rows[0].id]);
  } catch(e){}
}
// Auto-create notification for store owner (new order only)
try{await pool.query("INSERT INTO notifications(store_id,type,title,message,link) VALUES($1,'order',$2,$3,$4)",[sid,`New order #${num}`,`${customer_name} placed an order for ${total} ${store.currency||'DZD'}`,'/dashboard/orders']);}catch(e){}
// Push notification to admin's phone
try{const{sendStorePush}=require('./storeOwner');sendStorePush(sid,`New order #${num}`,`${customer_name} — ${total} ${store.currency||'DZD'}`);}catch(e){}
// Auto-decrease stock
for(const it of oi){try{await pool.query('UPDATE products SET stock_quantity=GREATEST(0,COALESCE(stock_quantity,0)-$1) WHERE id=$2',[it.quantity,it.product_id]);}catch(e){}}
// Mark any abandoned carts for this customer as recovered
try{await pool.query('UPDATE carts SET is_recovered=TRUE,updated_at=NOW() WHERE store_id=$1 AND customer_phone=$2 AND is_recovered=FALSE',[sid,customer_phone]);}catch(e){}
res.status(201).json({...o.rows[0],order_number:'ORD-'+String(num).padStart(5,'0')});}catch(e){console.error(e);res.status(500).json({error:e.message});}});

// Buyer cancel order (only if not shipped/delivered)
router.post('/:slug/orders/:oid/cancel',async(req,res)=>{try{
  const store=(await pool.query('SELECT * FROM stores WHERE slug=$1',[req.params.slug])).rows[0];
  if(!store)return res.status(404).json({error:'Not found'});
  const order=(await pool.query('SELECT * FROM orders WHERE id=$1 AND store_id=$2',[req.params.oid,store.id])).rows[0];
  if(!order)return res.status(404).json({error:'Order not found'});
  if(['shipped','delivered','cancelled'].includes(order.status))return res.status(400).json({error:`Cannot cancel — order is already ${order.status}`});
  const r=await pool.query("UPDATE orders SET status='cancelled',cancelled_at=NOW(),cancel_reason='Cancelled by customer',updated_at=NOW() WHERE id=$1 RETURNING *",[order.id]);
  // Notify store owner
  const orderNum='ORD-'+String(order.order_number).padStart(5,'0');
  try{await pool.query("INSERT INTO notifications(store_id,type,title,message,link) VALUES($1,'order',$2,$3,$4)",[store.id,`Order ${orderNum} cancelled by customer`,`${order.customer_name} cancelled their order (${order.total} DZD)`,'/dashboard/orders']);}catch(e){}
  try{const{sendStorePush}=require('./storeOwner');sendStorePush(store.id,`Order ${orderNum} cancelled`,`${order.customer_name} cancelled their order`);}catch(e){}
  res.json(r.rows[0]);
}catch(e){res.status(500).json({error:e.message});}});

// Pages
router.get('/:slug/pages',async(req,res)=>{try{const store=(await pool.query('SELECT id FROM stores WHERE slug=$1',[req.params.slug])).rows[0];if(!store)return res.json([]);res.json((await pool.query('SELECT * FROM store_pages WHERE store_id=$1 AND is_published=TRUE',[store.id])).rows);}catch(e){res.json([]);}});

// ═══ PRODUCT REVIEWS (public) ═══
// Get approved reviews for a product
router.get('/:slug/products/:pslug/reviews',async(req,res)=>{try{
  const store=(await pool.query('SELECT id FROM stores WHERE slug=$1',[req.params.slug])).rows[0];
  if(!store)return res.json({reviews:[],stats:{}});
  const product=(await pool.query('SELECT id FROM products WHERE store_id=$1 AND slug=$2',[store.id,req.params.pslug])).rows[0];
  if(!product)return res.json({reviews:[],stats:{}});
  const reviews=await pool.query('SELECT id,customer_name,rating,title,content,created_at FROM reviews WHERE product_id=$1 AND is_approved=TRUE ORDER BY created_at DESC LIMIT 50',[product.id]);
  const stats=await pool.query('SELECT COUNT(*) as total,ROUND(AVG(rating),1) as avg_rating,COUNT(*) FILTER(WHERE rating=5) as r5,COUNT(*) FILTER(WHERE rating=4) as r4,COUNT(*) FILTER(WHERE rating=3) as r3,COUNT(*) FILTER(WHERE rating=2) as r2,COUNT(*) FILTER(WHERE rating=1) as r1 FROM reviews WHERE product_id=$1 AND is_approved=TRUE',[product.id]);
  res.json({reviews:reviews.rows,stats:stats.rows[0]||{}});
}catch(e){res.json({reviews:[],stats:{}});}});

// Submit a review
router.post('/:slug/products/:pslug/reviews',async(req,res)=>{try{
  const store=(await pool.query('SELECT id,config FROM stores WHERE slug=$1',[req.params.slug])).rows[0];
  if(!store)return res.status(404).json({error:'Store not found'});
  const product=(await pool.query('SELECT id FROM products WHERE store_id=$1 AND slug=$2',[store.id,req.params.pslug])).rows[0];
  if(!product)return res.status(404).json({error:'Product not found'});
  const{customer_name,customer_phone,rating,title,content}=req.body;
  if(!customer_name||!rating)return res.status(400).json({error:'Name and rating required'});
  if(rating<1||rating>5)return res.status(400).json({error:'Rating must be 1-5'});

  // Check if customer already reviewed this product
  if(customer_phone){
    const dup=await pool.query('SELECT id FROM reviews WHERE product_id=$1 AND customer_phone=$2',[product.id,customer_phone]);
    if(dup.rows.length)return res.status(409).json({error:'You already reviewed this product'});
  }

  // AI moderation if enabled
  let aiScore=null,aiReason=null,autoApprove=false;
  const cfg=store.config||{};
  if(cfg.smart_reviews){
    try{
      const chatbot=require('../services/chatbot');
      const mod=await chatbot.moderateReview(content||'',rating);
      aiScore=mod.score;
      aiReason=mod.reason;
      autoApprove=mod.score>=70; // Auto-approve if AI score >= 70
    }catch(e){console.log('[Review AI Error]',e.message);}
  }

  const r=await pool.query(
    'INSERT INTO reviews(store_id,product_id,customer_name,customer_phone,rating,title,content,is_approved,ai_moderation_score,ai_moderation_reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
    [store.id,product.id,customer_name,customer_phone||null,rating,title||null,content||null,autoApprove,aiScore,aiReason]
  );
  res.status(201).json({...r.rows[0],auto_approved:autoApprove});
}catch(e){res.status(500).json({error:e.message});}});

// ═══ CART SYNC (for abandoned cart recovery) ═══
router.post('/:slug/save-cart',async(req,res)=>{try{
  const store=(await pool.query('SELECT id FROM stores WHERE slug=$1',[req.params.slug])).rows[0];
  if(!store)return res.status(404).json({error:'Store not found'});
  const{customer_phone,customer_name,customer_email,items}=req.body;
  if(!customer_phone||!items||!items.length)return res.status(400).json({error:'Phone and items required'});

  // Upsert cart
  const existing=await pool.query('SELECT id FROM carts WHERE store_id=$1 AND customer_phone=$2 AND is_abandoned=FALSE',[store.id,customer_phone]);
  const total=items.reduce((s,i)=>s+(parseFloat(i.price)||0)*(i.quantity||1),0);
  const itemsJson=JSON.stringify(items);

  if(existing.rows.length){
    await pool.query('UPDATE carts SET items=$1,total=$2,customer_name=$3,customer_email=$4,updated_at=NOW() WHERE id=$5',
      [itemsJson,total,customer_name||'',customer_email||'',existing.rows[0].id]);
  }else{
    await pool.query('INSERT INTO carts(store_id,customer_phone,customer_name,customer_email,items,total) VALUES($1,$2,$3,$4,$5,$6)',
      [store.id,customer_phone,customer_name||'',customer_email||'',itemsJson,total]);
  }
  res.json({ok:true});
}catch(e){res.status(500).json({error:e.message});}});

// ═══ PUBLIC ORDER TRACKING ═══
router.get('/:slug/track',async(req,res)=>{try{
  const{phone}=req.query;
  if(!phone)return res.status(400).json({error:'Phone required'});
  const store=(await pool.query('SELECT id FROM stores WHERE slug=$1',[req.params.slug])).rows[0];
  if(!store)return res.status(404).json({error:'Store not found'});
  const orders=await pool.query(
    `SELECT o.id,o.order_number,o.status,o.total,o.tracking_number,o.tracking_status,o.shipping_wilaya,o.created_at,o.shipped_at,o.delivered_at,
      dc.name as delivery_company FROM orders o LEFT JOIN delivery_companies dc ON dc.id=o.delivery_company_id
      WHERE o.store_id=$1 AND o.customer_phone LIKE $2 ORDER BY o.created_at DESC LIMIT 20`,
    [store.id,'%'+phone.replace(/\D/g,'').slice(-9)]
  );
  res.json(orders.rows.map(o=>({...o,order_number:'ORD-'+String(o.order_number).padStart(5,'0')})));
}catch(e){res.status(500).json({error:e.message});}});

// Dedicated visit tracking — called once per browser session by the Storefront page only.
router.post('/:slug/visit',async(req,res)=>{try{
  const s=(await pool.query('SELECT id FROM stores WHERE slug=$1',[req.params.slug])).rows[0];
  if(!s)return res.status(404).json({error:'Not found'});
  await pool.query('UPDATE stores SET total_visits=COALESCE(total_visits,0)+1 WHERE id=$1',[s.id]);
  res.json({ok:true});
}catch(e){res.json({ok:false});}});

module.exports=router;
