/**
 * AI Chatbot powered by OpenAI GPT
 * Reads store data and answers customers intelligently in AR/FR/EN
 */

const OPENAI_KEY = process.env.OPENAI_API_KEY || '';

/**
 * Chat with the AI bot
 * @param {Object} opts
 * @param {string} opts.message - Customer message
 * @param {Object} opts.store - Store data (name, products, shipping, payment, etc.)
 * @param {Array} opts.history - Previous messages [{role,content}]
 * @param {string} opts.language - 'ar', 'fr', or 'en'
 */
async function chat(opts) {
  if (!OPENAI_KEY) {
    // Fallback to keyword matching if no API key
    return fallbackChat(opts.message, opts.store);
  }

  const { message, store, history = [], language = 'auto' } = opts;

  const systemPrompt = buildSystemPrompt(store, language);
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-10), // Keep last 10 messages for context
    { role: 'user', content: message },
  ];

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages,
        max_tokens: 500,
        temperature: 0.7,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('[AI] OpenAI error:', err);
      return fallbackChat(message, store);
    }

    const data = await res.json();
    const reply = data.choices?.[0]?.message?.content || '';

    return {
      response: reply,
      model: 'gpt-4o-mini',
      suggestedActions: generateSuggestions(message, store),
    };
  } catch (e) {
    console.error('[AI] Failed:', e.message);
    return fallbackChat(message, store);
  }
}

/**
 * Build the system prompt with store context
 */
function buildSystemPrompt(store, language) {
  const langInstructions = {
    ar: 'أجب دائماً بالعربية الدارجة الجزائرية. كن ودوداً ومختصراً.',
    fr: 'Réponds toujours en français. Sois amical et concis.',
    en: 'Always respond in English. Be friendly and concise.',
    auto: 'Detect the language of the customer message and respond in the same language. For Arabic, use Algerian dialect (الدارجة).',
  };

  const paymentMethods = [];
  if (store.enable_cod) paymentMethods.push('Cash on Delivery (الدفع عند الاستلام)');
  if (store.enable_ccp) paymentMethods.push(`CCP Transfer (${store.ccp_account || 'available'})`);
  if (store.enable_baridimob) paymentMethods.push('BaridiMob');
  if (store.enable_bank_transfer) paymentMethods.push(`Bank Transfer (${store.bank_name || 'available'})`);
  if (store.chargily_enabled) paymentMethods.push('Online Card Payment (Edahabia / CIB)');

  return `You are a customer support chatbot for "${store.name || store.store_name}".
${langInstructions[language] || langInstructions.auto}

STORE INFO:
- Store: ${store.name || store.store_name}
- Currency: ${store.currency || 'DZD'}
- Phone: ${store.contact_phone || 'Not provided'}
- Location: Algeria

PAYMENT METHODS:
${paymentMethods.length ? paymentMethods.map(p => `- ${p}`).join('\n') : '- Cash on Delivery'}

SHIPPING:
- Available to all 58 wilayas in Algeria
- Standard desk delivery: 300-800 DZD depending on wilaya
- Home delivery: 400-1400 DZD depending on wilaya
- Delivery time: 1-7 days depending on location

${store.products_summary || ''}

RULES:
- Keep responses short (2-3 sentences max)
- Be helpful, friendly, and professional
- If you don't know something specific, direct them to contact the store
- Never make up prices or product details you don't have
- For order tracking, tell them to use the order tracking page or contact the store directly
- You can handle: product questions, shipping info, payment methods, store hours, return policy`;
}

/**
 * Generate suggested quick-reply actions
 */
function generateSuggestions(message, store) {
  const m = (message || '').toLowerCase();
  const suggestions = [];

  if (m.includes('ship') || m.includes('توصيل') || m.includes('livraison')) {
    suggestions.push({ label: 'View products', action: 'view_products' });
    suggestions.push({ label: 'Contact us', action: 'contact' });
  } else if (m.includes('pay') || m.includes('دفع') || m.includes('paiement')) {
    suggestions.push({ label: 'Shipping info', action: 'shipping_rates' });
    suggestions.push({ label: 'Best sellers', action: 'best_sellers' });
  } else {
    suggestions.push({ label: 'Shipping rates', action: 'shipping_rates' });
    suggestions.push({ label: 'Payment methods', action: 'payment_methods' });
    suggestions.push({ label: 'Contact info', action: 'contact' });
  }

  return suggestions;
}

/**
 * Fallback keyword-based chat when OpenAI is not configured
 */
function fallbackChat(message, store) {
  const m = (message || '').toLowerCase();
  const name = store.name || store.store_name || 'Store';
  const c = store.currency || 'DZD';
  let r = `مرحباً بك في ${name}! كيف يمكنني مساعدتك؟`;

  if (m.includes('shipping') || m.includes('delivery') || m.includes('livraison') || m.includes('توصيل'))
    r = `🚚 التوصيل متاح لجميع 58 ولاية! التوصيل للمكتب: من 300 ${c}. التوصيل للبيت: من 400 ${c}.`;
  else if (m.includes('payment') || m.includes('pay') || m.includes('paiement') || m.includes('دفع'))
    r = `💳 طرق الدفع المتاحة: الدفع عند الاستلام، CCP، BaridiMob، و التحويل البنكي.`;
  else if (m.includes('product') || m.includes('best') || m.includes('منتج'))
    r = `🛍️ تصفح كتالوج منتجاتنا للعثور على أفضل المنتجات!`;
  else if (m.includes('hello') || m.includes('hi') || m.includes('bonjour') || m.includes('سلام') || m.includes('مرحبا'))
    r = `مرحباً! 👋 أهلاً بك في ${name}. كيف يمكنني مساعدتك اليوم؟`;
  else if (m.includes('contact') || m.includes('اتصال') || m.includes('phone'))
    r = `📞 تواصل معنا على: ${store.contact_phone || 'الهاتف غير متاح'}`;
  else if (m.includes('return') || m.includes('refund') || m.includes('إرجاع'))
    r = `🔄 للإرجاع أو الاستبدال، تواصل معنا خلال 7 أيام من الاستلام.`;
  else if (m.includes('track') || m.includes('تتبع') || m.includes('suivi'))
    r = `📦 لتتبع طلبك، استخدم صفحة تتبع الطلبات أو تواصل معنا برقم الطلب.`;

  return {
    response: r,
    model: 'fallback',
    suggestedActions: [
      { label: 'Shipping rates', action: 'shipping_rates' },
      { label: 'Best sellers', action: 'best_sellers' },
      { label: 'Contact info', action: 'contact' },
    ],
  };
}

/**
 * AI-powered fake order detection
 */
async function detectFakeOrder(orderData, customerHistory) {
  if (!OPENAI_KEY) {
    // Simple rule-based scoring
    return rulBasedDetection(orderData, customerHistory);
  }

  try {
    const prompt = `Analyze this order for fraud risk. Return JSON only: {"score": 0-100, "level": "low|medium|high", "flags": ["reason1","reason2"]}

Order: ${JSON.stringify(orderData)}
Customer History: ${JSON.stringify(customerHistory)}

Consider: cancellation history, order value, address patterns, phone patterns.`;

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 200,
        temperature: 0,
      }),
    });

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '';
    // Parse JSON from response
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    return rulBasedDetection(orderData, customerHistory);
  } catch (e) {
    return rulBasedDetection(orderData, customerHistory);
  }
}

function rulBasedDetection(orderData, history) {
  let score = 0;
  const flags = [];

  const cancellations = history.cancelled || 0;
  if (cancellations >= 5) { score += 50; flags.push('Very high cancellation rate'); }
  else if (cancellations >= 3) { score += 30; flags.push('High cancellation rate'); }
  else if (cancellations >= 1) { score += 10; flags.push('Previous cancellations'); }

  if (orderData.total > 50000) { score += 15; flags.push('High order value'); }
  if (!orderData.customer_email) { score += 5; flags.push('No email provided'); }

  return {
    score: Math.min(score, 100),
    level: score >= 60 ? 'high' : score >= 30 ? 'medium' : 'low',
    flags,
  };
}

function isConfigured() {
  return !!OPENAI_KEY;
}

module.exports = { chat, detectFakeOrder, isConfigured };
