/**
 * AI Chatbot - Google Gemini with auto model discovery
 * Tries multiple model names until one works
 */
const https = require('https');

const GEMINI_KEY = process.env.GEMINI_API_KEY || '';

// Try these models in order - first success wins and gets cached
const MODELS = [
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash-latest',
  'gemini-1.5-flash',
  'gemini-1.5-pro',
  'gemini-pro',
];
let workingModel = null; // Cache the working model

function httpsPost(hostname, path, data) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(data);
    const req = https.request({
      hostname, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
      timeout: 15000,
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', e => reject(e));
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(postData);
    req.end();
  });
}

async function geminiCall(prompt, maxTokens = 400) {
  if (!GEMINI_KEY) { console.log('[AI] No API key set in GEMINI_API_KEY env'); return { error: 'AI not configured - set GEMINI_API_KEY in environment' }; }

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 }
  };

  // If we already found a working model, use it directly
  if (workingModel) {
    console.log('[AI] Using cached model:', workingModel);
    try {
      const r = await httpsPost(
        'generativelanguage.googleapis.com',
        `/v1beta/models/${workingModel}:generateContent?key=${GEMINI_KEY}`,
        payload
      );
      if (r.status === 200) {
        const data = JSON.parse(r.body);
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) { console.log('[AI] Reply OK, length:', text.length); return { text }; }
      }
      console.log('[AI] Cached model failed, status:', r.status, '- retrying all');
      workingModel = null;
    } catch (e) {
      console.log('[AI] Cached model error:', e.message);
      workingModel = null;
    }
  }

  // Try each model
  const errors = [];
  for (const model of MODELS) {
    try {
      console.log('[AI] Trying model:', model);
      const r = await httpsPost(
        'generativelanguage.googleapis.com',
        `/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`,
        payload
      );

      console.log('[AI]', model, '→', r.status);

      if (r.status === 200) {
        const data = JSON.parse(r.body);
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          workingModel = model;
          console.log('[AI] ✅ Working model:', model);
          return { text, model };
        }
        errors.push(`${model}: 200 but empty`);
      } else if (r.status === 404) {
        errors.push(`${model}: not available`);
      } else if (r.status === 400) {
        errors.push(`${model}: bad request`);
      } else if (r.status === 403) {
        errors.push(`${model}: API key not authorized for this model`);
        // Don't break - try other models, some keys only work with certain models
      } else if (r.status === 429) {
        errors.push(`${model}: rate limited`);
        // Don't break - try other models, they have separate rate limits
      } else {
        errors.push(`${model}: status ${r.status}`);
      }
    } catch (e) {
      errors.push(`${model}: ${e.message}`);
    }
  }

  const errorMsg = errors.join(' | ');
  console.error('[AI] All models failed:', errorMsg);
  return { error: errorMsg };
}

async function chat(opts) {
  const { message, store, history = [], language = 'auto' } = opts;
  const systemPrompt = buildSystemPrompt(store, language);
  const historyText = history.slice(-6).map(h => `${h.role === 'user' ? 'Customer' : 'Bot'}: ${h.text || h.content || ''}`).join('\n');
  const fullPrompt = `${systemPrompt}\n\n${historyText ? 'Recent conversation:\n' + historyText + '\n\n' : ''}Customer: ${message}\n\nBot:`;

  const result = await geminiCall(fullPrompt);

  if (result && result.text) {
    return { response: result.text, model: result.model || workingModel || 'gemini', suggestedActions: getSuggestions(message) };
  }

  const fb = fallbackChat(message, store);
  if (result && result.error) { fb.debug = result.error; }
  return fb;
}

function buildSystemPrompt(store, language) {
  const langMap = {
    ar: 'أجب بالعربية الدارجة الجزائرية. كن مختصراً وودوداً.',
    fr: 'Réponds en français. Sois concis et amical.',
    en: 'Respond in English. Be concise and friendly.',
    auto: 'Detect the customer language and respond in the same language. For Arabic use Algerian dialect.'
  };
  const pays = [];
  if (store.enable_cod) pays.push('Cash on Delivery');
  if (store.enable_ccp) pays.push('CCP Transfer');
  if (store.enable_baridimob) pays.push('BaridiMob');
  if (store.enable_bank_transfer) pays.push('Bank Transfer');

  return `You are a friendly customer support chatbot for "${store.name || store.store_name}" in Algeria.
${langMap[language] || langMap.auto}
Currency: ${store.currency || 'DZD'}. Phone: ${store.contact_phone || 'N/A'}.
Payment: ${pays.join(', ') || 'COD'}. Shipping: all 58 wilayas, 300-1400 DZD, 1-7 days.
${store.products_summary || ''}
Rules: 2-3 sentences max, be helpful, never invent prices.`;
}

function getSuggestions(msg) {
  const m = (msg || '').toLowerCase();
  if (m.includes('ship') || m.includes('توصيل')) return [{ label: 'Products', action: 'view_products' }, { label: 'Contact', action: 'contact' }];
  if (m.includes('pay') || m.includes('دفع')) return [{ label: 'Shipping', action: 'shipping_rates' }, { label: 'Products', action: 'best_sellers' }];
  return [{ label: 'Shipping rates', action: 'shipping_rates' }, { label: 'Payment methods', action: 'payment_methods' }, { label: 'Contact', action: 'contact' }];
}

function fallbackChat(message, store) {
  const m = (message || '').toLowerCase();
  const name = store.name || store.store_name || 'Store';
  const c = store.currency || 'DZD';
  let r = `مرحباً بك في ${name}! كيف يمكنني مساعدتك؟`;
  if (m.includes('shipping') || m.includes('delivery') || m.includes('توصيل') || m.includes('livraison')) r = `🚚 التوصيل متاح لجميع 58 ولاية! من 300 ${c} للمكتب، من 400 ${c} للبيت.`;
  else if (m.includes('payment') || m.includes('pay') || m.includes('دفع') || m.includes('paiement')) r = `💳 الدفع عند الاستلام، CCP، BaridiMob، تحويل بنكي.`;
  else if (m.includes('hello') || m.includes('hi') || m.includes('سلام') || m.includes('مرحبا') || m.includes('bonjour') || m.includes('واش')) r = `مرحباً! 👋 أهلاً بك في ${name}. كيف أساعدك؟`;
  else if (m.includes('contact') || m.includes('اتصال') || m.includes('هاتف')) r = `📞 تواصل معنا: ${store.contact_phone || 'غير متاح'}`;
  else if (m.includes('track') || m.includes('تتبع')) r = `📦 لتتبع طلبك، استخدم صفحة تتبع الطلبات.`;
  else if (m.includes('price') || m.includes('سعر') || m.includes('شحال')) r = `💰 تصفح منتجاتنا لمعرفة الأسعار بال${c}.`;
  return { response: r, model: 'fallback', suggestedActions: getSuggestions(message) };
}

async function generateProductDescription(productName, category, language = 'en') {
  const langMap = { ar: 'بالعربية الدارجة الجزائرية', fr: 'en français', en: 'in English' };
  const result = await geminiCall(`Write a short product description (2-3 sentences) ${langMap[language] || langMap.en} for: ${productName} (${category || 'General'}). Return ONLY the description.`, 200);
  return result?.text || null;
}

async function generateCartRecoveryMessage(storeName, itemNames, language = 'ar') {
  const langMap = { ar: 'بالعربية الدارجة الجزائرية', fr: 'en français', en: 'in English' };
  const result = await geminiCall(`Write a short WhatsApp message ${langMap[language] || langMap.ar} to recover an abandoned cart. Store: ${storeName}. Items: ${itemNames.join(', ')}. Be friendly, create urgency. 3 lines max. Return ONLY the message.`, 150);
  return result?.text || null;
}

async function detectFakeOrder(orderData, customerHistory) {
  let score = 0; const flags = [];
  const cancelled = customerHistory.cancelled || 0;
  if (cancelled >= 5) { score += 50; flags.push('Very high cancellations'); }
  else if (cancelled >= 3) { score += 30; flags.push('High cancellations'); }
  else if (cancelled >= 1) { score += 10; flags.push('Previous cancellations'); }
  if (orderData.total > 50000) { score += 15; flags.push('High order value'); }
  score = Math.min(score, 100);
  return { score, level: score >= 60 ? 'high' : score >= 30 ? 'medium' : 'low', flags };
}

function isConfigured() { return !!GEMINI_KEY; }

module.exports = { chat, detectFakeOrder, isConfigured, geminiCall, generateProductDescription, generateCartRecoveryMessage };
