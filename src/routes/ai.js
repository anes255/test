const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// AI Chatbot
router.post('/:slug/chatbot', async (req, res) => {
  try {
    const store = await pool.query('SELECT * FROM stores WHERE slug=$1',[req.params.slug]);
    if (!store.rows.length) return res.status(404).json({ error:'Store not found' });
    const s = store.rows[0];
    const { message } = req.body;
    const msg = (message||'').toLowerCase();
    const currency = s.currency||'DZD';

    let response = `Thanks for reaching out! I'm here to help with products, shipping, and payments at ${s.store_name}.`;
    if (msg.includes('shipping')||msg.includes('delivery')||msg.includes('livraison')||msg.includes('توصيل'))
      response = `Shipping is available to all 58 wilayas! Standard shipping costs 400 ${currency}.`;
    else if (msg.includes('payment')||msg.includes('pay')||msg.includes('paiement')||msg.includes('دفع'))
      response = `We accept Cash on Delivery and other payment methods. Contact us for details!`;
    else if (msg.includes('hello')||msg.includes('hi')||msg.includes('bonjour')||msg.includes('سلام'))
      response = `Welcome to ${s.store_name}! How can I help you today?`;
    else if (msg.includes('product')||msg.includes('best')||msg.includes('منتج'))
      response = `Check out our product catalog to find what you need!`;

    res.json({ response, suggestedActions:[
      {label:'Shipping rates', action:'shipping_rates'},
      {label:'Best sellers', action:'best_sellers'},
      {label:'Contact info', action:'contact'},
    ]});
  } catch(e) { res.status(500).json({ error:'Chatbot error' }); }
});

// Fake detection
router.post('/detect-fake', async (req, res) => {
  try {
    const { store_id, customer_phone } = req.body;
    let fakeScore=0, flags=[];
    try {
      const cancelled = await pool.query("SELECT COUNT(*) FROM orders WHERE store_id=$1 AND customer_phone=$2 AND status='cancelled'",[store_id,customer_phone]);
      const cnt = parseInt(cancelled.rows[0].count);
      if (cnt>=3) { fakeScore+=40; flags.push('High cancellation rate'); }
      else if (cnt>=1) { fakeScore+=15; flags.push('Previous cancellations'); }
    } catch(e){}
    res.json({ fakeScore:Math.min(fakeScore,100), riskLevel:fakeScore>=60?'high':fakeScore>=30?'medium':'low', flags });
  } catch(e) { res.status(500).json({ error:'Detection failed' }); }
});

// Cart recovery
router.post('/cart-recovery/suggest', async (req, res) => {
  res.json({ messages:[
    { sequence:1, delay:'30m', channel:'whatsapp', message:'Hi! You left items in your cart. Complete your order before they sell out!' },
    { sequence:2, delay:'6h', channel:'whatsapp', message:'Still thinking about it? Your items are waiting!' },
    { sequence:3, delay:'24h', channel:'whatsapp', message:'Last chance! Use code COMEBACK10 for 10% off!' },
  ]});
});

module.exports = router;
