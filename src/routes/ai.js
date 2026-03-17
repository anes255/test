const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// AI Chatbot endpoint (public, per-store)
router.post('/:slug/chatbot', async (req, res) => {
  try {
    const store = await pool.query(`
      SELECT s.*, 
        (SELECT json_agg(json_build_object('name', name_en, 'price', price, 'slug', slug)) 
         FROM products WHERE store_id = s.id AND is_active = TRUE LIMIT 10) as products
      FROM stores s WHERE s.slug = $1 AND s.ai_chatbot_enabled = TRUE
    `, [req.params.slug]);

    if (store.rows.length === 0) return res.status(404).json({ error: 'Chatbot not available' });
    const s = store.rows[0];

    const { message, history = [] } = req.body;

    // Build context for AI
    const systemPrompt = `You are "${s.ai_chatbot_name}", an AI assistant for the store "${s.name}".
Your personality: ${s.ai_chatbot_personality}.
Store currency: ${s.currency || 'DZD'}.
Available payment methods: ${[s.enable_cod && 'Cash on Delivery', s.enable_ccp && 'CCP Transfer', s.enable_baridimob && 'BaridiMob', s.enable_bank_transfer && 'Bank Transfer'].filter(Boolean).join(', ')}.
Shipping: Default ${s.shipping_default_price} ${s.currency || 'DZD'}, available across all 58 wilayas.
${s.whatsapp_number ? `WhatsApp: ${s.whatsapp_number}` : ''}
Available products: ${JSON.stringify(s.products || [])}.
Answer in the customer's language. Be helpful, concise, and guide them to products.`;

    // For now, use a simple rule-based response if no OpenAI key
    // In production, this would call OpenAI API
    const response = generateSmartResponse(message, s, systemPrompt);

    res.json({ 
      response,
      suggestedActions: getSuggestedActions(message, s)
    });
  } catch (error) {
    console.error('Chatbot error:', error);
    res.status(500).json({ error: 'Chatbot error' });
  }
});

// AI Fake Order Detection
router.post('/detect-fake', async (req, res) => {
  try {
    const { store_id, customer_phone, customer_name, ip_address, order_total, items_count } = req.body;

    // Check patterns
    let fakeScore = 0;
    const flags = [];

    // Check phone repetition
    const phoneOrders = await pool.query(
      "SELECT COUNT(*) FROM orders WHERE store_id = $1 AND customer_phone = $2 AND status = 'cancelled' AND created_at > NOW() - INTERVAL '30 days'",
      [store_id, customer_phone]
    );
    const cancelledCount = parseInt(phoneOrders.rows[0].count);
    if (cancelledCount >= 3) { fakeScore += 40; flags.push('High cancellation rate'); }
    else if (cancelledCount >= 1) { fakeScore += 15; flags.push('Previous cancellations'); }

    // Check IP duplication
    if (ip_address) {
      const ipOrders = await pool.query(
        "SELECT COUNT(DISTINCT customer_phone) FROM orders WHERE store_id = $1 AND notes LIKE $2 AND created_at > NOW() - INTERVAL '24 hours'",
        [store_id, `%${ip_address}%`]
      );
      if (parseInt(ipOrders.rows[0].count) >= 3) { fakeScore += 30; flags.push('Multiple orders from same IP'); }
    }

    // Check unusual quantities
    if (items_count > 10) { fakeScore += 20; flags.push('Unusual item quantity'); }

    // Check if phone is in known fake list
    const prevFakes = await pool.query(
      'SELECT COUNT(*) FROM orders WHERE store_id = $1 AND customer_phone = $2 AND is_fake_flagged = TRUE',
      [store_id, customer_phone]
    );
    if (parseInt(prevFakes.rows[0].count) > 0) { fakeScore += 35; flags.push('Previously flagged phone'); }

    const riskLevel = fakeScore >= 60 ? 'high' : fakeScore >= 30 ? 'medium' : 'low';

    res.json({ fakeScore: Math.min(fakeScore, 100), riskLevel, flags });
  } catch (error) {
    res.status(500).json({ error: 'Detection failed' });
  }
});

// Cart Recovery AI - get recovery suggestions
router.post('/cart-recovery/suggest', async (req, res) => {
  try {
    const { store_id, cart_items, customer_name } = req.body;

    const store = await pool.query('SELECT name, currency FROM stores WHERE id = $1', [store_id]);
    if (store.rows.length === 0) return res.status(404).json({ error: 'Store not found' });

    const messages = [
      {
        sequence: 1,
        delay: '30m',
        channel: 'whatsapp',
        message: `Hi ${customer_name || 'there'}! 👋 You left some items in your cart at ${store.rows[0].name}. Complete your order before they sell out!`
      },
      {
        sequence: 2,
        delay: '6h',
        channel: 'whatsapp',
        message: `Still thinking about it? Your items at ${store.rows[0].name} are waiting for you. Order now and we'll reserve them for you! ⏰`
      },
      {
        sequence: 3,
        delay: '24h',
        channel: 'whatsapp',
        message: `Last chance! 🎁 Here's a special discount just for you. Use code COMEBACK10 for 10% off your cart at ${store.rows[0].name}. Valid for 24 hours only!`
      }
    ];

    res.json({ messages });
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate recovery messages' });
  }
});

function generateSmartResponse(message, store, systemPrompt) {
  const msg = message.toLowerCase();
  const products = store.products || [];
  const currency = store.currency || 'DZD';

  if (msg.includes('shipping') || msg.includes('delivery') || msg.includes('livraison') || msg.includes('توصيل')) {
    return `Shipping is available to all 58 wilayas! Standard shipping costs ${store.shipping_default_price} ${currency}. ${store.free_shipping_threshold ? `Free shipping on orders above ${store.free_shipping_threshold} ${currency}!` : ''}`;
  }
  if (msg.includes('payment') || msg.includes('pay') || msg.includes('paiement') || msg.includes('دفع')) {
    const methods = [store.enable_cod && 'Cash on Delivery', store.enable_ccp && 'CCP Transfer', store.enable_baridimob && 'BaridiMob QR', store.enable_bank_transfer && 'Bank Transfer'].filter(Boolean);
    return `We accept: ${methods.join(', ')}. Which method works best for you?`;
  }
  if (msg.includes('product') || msg.includes('best') || msg.includes('popular') || msg.includes('منتج')) {
    if (products.length > 0) {
      const list = products.slice(0, 5).map(p => `• ${p.name} - ${p.price} ${currency}`).join('\n');
      return `Here are our top products:\n${list}\n\nWould you like to know more about any of these?`;
    }
    return 'We have amazing products! Check out our catalog to find what you need.';
  }
  if (msg.includes('contact') || msg.includes('help') || msg.includes('مساعدة')) {
    return `You can reach us ${store.whatsapp_number ? `on WhatsApp at ${store.whatsapp_number}` : 'through this chat'}. How can I assist you?`;
  }
  if (msg.includes('hello') || msg.includes('hi') || msg.includes('bonjour') || msg.includes('سلام') || msg.includes('مرحبا')) {
    return store.ai_chatbot_greeting || `Welcome to ${store.name}! How can I help you today?`;
  }

  return `Thank you for reaching out! I'm here to help with products, shipping, payment, or any other questions about ${store.name}. What would you like to know?`;
}

function getSuggestedActions(message, store) {
  return [
    { label: 'Shipping rates', action: 'shipping_rates' },
    { label: 'Best sellers', action: 'best_sellers' },
    { label: 'Contact info', action: 'contact' },
  ];
}

module.exports = router;
