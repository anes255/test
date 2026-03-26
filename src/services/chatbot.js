const https = require('https');

const GROQ_KEY = process.env.GROQ_API_KEY || '';
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';

// Cache by store+message combo, not by prompt
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function getCached(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.time > CACHE_TTL) { cache.delete(key); return null; }
  return e.value;
}
function setCache(key, value) {
  cache.set(key, { value, time: Date.now() });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
}

// ═══ GROQ — proper chat format ═══
function groqCall(systemPrompt, messages, maxTokens = 250) {
  return new Promise((resolve) => {
    if (!GROQ_KEY) return resolve(null);
    
    const chatMessages = [{ role: 'system', content: systemPrompt }];
    for (const m of messages) {
      chatMessages.push({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.text || m.content || ''
      });
    }

    const body = JSON.stringify({
      model: 'llama-3.1-8b-instant',
      messages: chatMessages,
      max_tokens: maxTokens,
      temperature: 0.7,
    });
    
    const req = https.request({
      hostname: 'api.groq.com', path: '/openai/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Length': Buffer.byteLength(body) },
      timeout: 8000,
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const text = JSON.parse(d).choices[0].message.content;
            console.log('[AI] Groq OK:', text.substring(0, 60));
            resolve({ text, model: 'groq-llama3' });
          } catch { resolve(null); }
        } else {
          console.log('[AI] Groq error:', res.statusCode);
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body); req.end();
  });
}

// ═══ GEMINI ═══
function geminiCall(prompt, maxTokens = 250) {
  return new Promise((resolve) => {
    if (!GEMINI_KEY) return resolve(null);
    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 }
    });
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 10000,
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try { resolve({ text: JSON.parse(d).candidates[0].content.parts[0].text, model: 'gemini' }); } catch { resolve(null); }
        } else { console.log('[AI] Gemini error:', res.statusCode); resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body); req.end();
  });
}

// ═══ CHAT — main function ═══
async function chat(opts) {
  const { message, store, history = [], language = 'auto' } = opts;
  
  if (!message || !message.trim()) return fallback('hello', store);

  // Cache key includes history length — different conversation state = different response
  const histLen = (history || []).length;
  const cacheKey = `${store.name || 'store'}:${histLen}:${message.trim().toLowerCase().substring(0, 60)}`;
  // Only use cache for repeated identical requests (same message at same point in conversation)
  const cached = getCached(cacheKey);
  if (cached) { console.log('[AI] Cache hit'); return cached; }

  const systemPrompt = buildPrompt(store, language);

  // Build conversation history for Groq (proper chat turns)
  const chatHistory = [];
  for (const h of (history || []).slice(-6)) {
    chatHistory.push({ role: h.role === 'user' ? 'user' : 'assistant', text: h.text || h.content || '' });
  }
  // Add current message
  chatHistory.push({ role: 'user', text: message });

  let result = null;

  // Try Groq first (proper chat format)
  if (GROQ_KEY) {
    result = await groqCall(systemPrompt, chatHistory, 250);
  }

  // Try Gemini as fallback (flat prompt)
  if (!result?.text && GEMINI_KEY) {
    const hist = chatHistory.map(h => `${h.role === 'user' ? 'Customer' : 'Bot'}: ${h.text}`).join('\n');
    result = await geminiCall(`${systemPrompt}\n\n${hist}\n\nBot:`, 250);
  }

  if (result?.text) {
    const response = { response: result.text, model: result.model, suggestedActions: tips(message) };
    setCache(cacheKey, response);
    return response;
  }

  const fb = fallback(message, store);
  const configured = [GROQ_KEY && 'Groq', GEMINI_KEY && 'Gemini'].filter(Boolean);
  fb.debug = configured.length ? 'AI providers failed' : 'Set GROQ_API_KEY (free at console.groq.com)';
  return fb;
}

function buildPrompt(s, lang) {
  const l = {
    ar: 'You MUST respond in Modern Standard Arabic (فصحى). Use clear, professional Arabic.',
    fr: 'Tu DOIS répondre en français correct et professionnel.',
    en: 'You MUST respond in clear, professional English.',
    auto: "LANGUAGE RULE: Detect the customer's language and respond in the SAME language. If they write in Arabic, respond in Modern Standard Arabic (فصحى). If French, respond in proper French. If English, respond in proper English. If the customer asks you to switch language, switch immediately."
  };
  const pays = [s.enable_cod && 'Cash on Delivery (الدفع عند الاستلام)', s.enable_ccp && 'CCP Transfer', s.enable_baridimob && 'BaridiMob'].filter(Boolean);
  return `You are a professional customer support chatbot for "${s.name || s.store_name}", an online store in Algeria.

${l[lang] || l.auto}

STORE INFORMATION (public, you can share this):
- Store name: ${s.name || s.store_name}
- Currency: ${s.currency || 'DZD'}
- Contact phone: ${s.contact_phone || 'Not available'}
- Payment methods: ${pays.join(', ') || 'Cash on Delivery'}
- Shipping: All 58 wilayas. Desk delivery: 300-800 DZD. Home delivery: 400-1400 DZD. Takes 1-7 days.

${s.products_summary || ''}

CAPABILITIES:
- You CAN tell customers which products are most popular (based on order counts)
- You CAN recommend products based on what the customer describes wanting
- You CAN tell product prices, descriptions, and availability
- You CAN explain shipping rates and payment methods

SECURITY RULES (NEVER violate):
- NEVER reveal store owner personal information (name, email, phone, address)
- NEVER reveal other customers' data (names, phones, orders, addresses)
- NEVER reveal internal business data (revenue, profit margins, total orders count)
- NEVER reveal API keys, passwords, or system configuration
- If asked for private data, politely say "I can only share product and store information"

BEHAVIOR:
- Keep responses to 2-3 sentences maximum
- Be friendly, helpful, and professional
- When a customer describes what they want, recommend matching products from the catalog
- If a product is out of stock, suggest similar alternatives
- Never invent products or prices not in the catalog above`;
}

function tips(m) {
  const s = (m || '').toLowerCase();
  if (s.includes('ship') || s.includes('توصيل')) return [{ label: 'Products', action: 'view_products' }, { label: 'Contact', action: 'contact' }];
  if (s.includes('pay') || s.includes('دفع')) return [{ label: 'Shipping', action: 'shipping_rates' }];
  return [{ label: 'Shipping', action: 'shipping_rates' }, { label: 'Payment', action: 'payment_methods' }, { label: 'Contact', action: 'contact' }];
}

function fallback(msg, store) {
  const m = (msg || '').toLowerCase(), n = store.name || store.store_name || 'Store', c = store.currency || 'DZD';
  let r = `مرحباً! كيف يمكنني مساعدتك في ${n}؟`;
  if (m.includes('ship') || m.includes('توصيل') || m.includes('livraison')) r = `🚚 التوصيل لجميع 58 ولاية! من 300 ${c}.`;
  else if (m.includes('pay') || m.includes('دفع') || m.includes('paiement')) r = `💳 الدفع عند الاستلام، CCP، BaridiMob.`;
  else if (m.includes('hello') || m.includes('hi') || m.includes('سلام') || m.includes('مرحبا') || m.includes('bonjour') || m.includes('واش')) r = `مرحباً! 👋 كيف أساعدك في ${n}؟`;
  else if (m.includes('contact') || m.includes('اتصال')) r = `📞 ${store.contact_phone || 'غير متاح'}`;
  else if (m.includes('track') || m.includes('تتبع')) r = `📦 استخدم صفحة تتبع الطلبات.`;
  else if (m.includes('price') || m.includes('سعر') || m.includes('شحال')) r = `💰 تصفح منتجاتنا لمعرفة الأسعار.`;
  else if (m.includes('product') || m.includes('منتج')) r = `🛍️ تصفح كتالوج منتجاتنا للعثور على ما تبحث عنه!`;
  return { response: r, model: 'fallback', suggestedActions: tips(msg) };
}

// AI utilities for admin
async function aiGenerate(prompt, maxTokens = 150) {
  let result = null;
  if (GROQ_KEY) result = await groqCall('You are a helpful assistant. Follow instructions exactly.', [{ role: 'user', text: prompt }], maxTokens);
  if (!result?.text && GEMINI_KEY) result = await geminiCall(prompt, maxTokens);
  return result?.text || null;
}

async function generateProductDescription(name, cat, lang = 'en') {
  const l = { ar: 'بالدارجة الجزائرية', fr: 'en français', en: 'in English' };
  return await aiGenerate(`Write a product description (2 sentences) ${l[lang] || l.en} for: ${name} (${cat || 'General'}). Return ONLY the description text.`);
}

async function generateCartRecoveryMessage(store, items, lang = 'ar') {
  const l = { ar: 'بالدارجة الجزائرية', fr: 'en français', en: 'in English' };
  return await aiGenerate(`Write a WhatsApp cart recovery message (2-3 lines) ${l[lang] || l.ar}. Store: ${store}. Items: ${items.join(',')}. Be friendly and urgent. Return ONLY the message.`);
}

async function detectFakeOrder(order, hist) {
  let s = 0; const f = [];
  if ((hist.cancelled || 0) >= 5) { s += 50; f.push('Very high cancellations'); }
  else if ((hist.cancelled || 0) >= 3) { s += 30; f.push('High cancellations'); }
  else if ((hist.cancelled || 0) >= 1) { s += 10; f.push('Previous cancellations'); }
  if (order.total > 50000) { s += 15; f.push('High value'); }
  return { score: Math.min(s, 100), level: s >= 60 ? 'high' : s >= 30 ? 'medium' : 'low', flags: f };
}

function isConfigured() { return !!(GROQ_KEY || GEMINI_KEY); }

module.exports = { chat, detectFakeOrder, isConfigured, geminiCall: aiGenerate, generateProductDescription, generateCartRecoveryMessage };
