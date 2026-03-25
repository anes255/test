const https = require('https');
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';

// Hardcoded - no discovery, no wasted calls
const MODEL = 'gemini-2.0-flash-lite';

// Simple rate limiter - space calls 2.5s apart (max 24/min, under 30 RPM limit)
let lastCallTime = 0;

function post(path, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com', path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 10000,
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', e => reject(e));
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body); req.end();
  });
}

async function geminiCall(prompt, maxTokens = 250) {
  if (!GEMINI_KEY) return { error: 'Set GEMINI_API_KEY in Render environment' };

  // Enforce minimum 2.5s between calls
  const now = Date.now();
  const elapsed = now - lastCallTime;
  if (elapsed < 2500) {
    await new Promise(r => setTimeout(r, 2500 - elapsed));
  }
  lastCallTime = Date.now();

  try {
    const r = await post(
      `/v1beta/models/${MODEL}:generateContent?key=${GEMINI_KEY}`,
      { contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 } }
    );

    if (r.status === 200) {
      const text = JSON.parse(r.body)?.candidates?.[0]?.content?.parts?.[0]?.text;
      return text ? { text } : { error: 'Empty response' };
    }
    if (r.status === 429) return { error: 'AI busy - try again in 10 seconds' };
    if (r.status === 403) return { error: 'API key issue - regenerate at aistudio.google.com' };
    return { error: `Error ${r.status}` };
  } catch (e) {
    return { error: e.message === 'timeout' ? 'AI slow - try again' : e.message };
  }
}

async function chat(opts) {
  const { message, store, history = [], language = 'auto' } = opts;
  const prompt = buildPrompt(store, language);
  const hist = history.slice(-4).map(h => `${h.role === 'user' ? 'Q' : 'A'}: ${h.text || h.content || ''}`).join('\n');
  const result = await geminiCall(`${prompt}\n${hist ? hist + '\n' : ''}Q: ${message}\nA:`);
  if (result?.text) return { response: result.text, model: MODEL, suggestedActions: tips(message) };
  const fb = fallback(message, store);
  if (result?.error) fb.debug = result.error;
  return fb;
}

function buildPrompt(s, lang) {
  const l = { ar: 'أجب بالدارجة الجزائرية.', fr: 'Réponds en français.', en: 'Reply in English.', auto: "Reply in customer's language." };
  return `Support bot for "${s.name || s.store_name}" (Algeria). ${l[lang] || l.auto} ${s.currency || 'DZD'}. Payment: ${[s.enable_cod && 'COD', s.enable_ccp && 'CCP', s.enable_baridimob && 'BaridiMob'].filter(Boolean).join(',') || 'COD'}. Shipping: 58 wilayas. ${s.products_summary || ''} 2 sentences max.`;
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
  return { response: r, model: 'fallback', suggestedActions: tips(msg) };
}

async function generateProductDescription(name, cat, lang = 'en') {
  const l = { ar: 'بالدارجة الجزائرية', fr: 'en français', en: 'in English' };
  const r = await geminiCall(`Product description (2 sentences) ${l[lang] || l.en} for: ${name}. ONLY the text.`, 120);
  return r?.text || null;
}

async function generateCartRecoveryMessage(store, items, lang = 'ar') {
  const l = { ar: 'بالدارجة الجزائرية', fr: 'en français', en: 'in English' };
  const r = await geminiCall(`WhatsApp cart recovery (2 lines) ${l[lang] || l.ar}. Store: ${store}. Items: ${items.join(',')}. Urgent+friendly. ONLY message.`, 80);
  return r?.text || null;
}

async function detectFakeOrder(order, hist) {
  let s = 0; const f = [];
  const c = hist.cancelled || 0;
  if (c >= 5) { s += 50; f.push('Very high cancellations'); }
  else if (c >= 3) { s += 30; f.push('High cancellations'); }
  else if (c >= 1) { s += 10; f.push('Previous cancellations'); }
  if (order.total > 50000) { s += 15; f.push('High value'); }
  return { score: Math.min(s, 100), level: s >= 60 ? 'high' : s >= 30 ? 'medium' : 'low', flags: f };
}

function isConfigured() { return !!GEMINI_KEY; }

module.exports = { chat, detectFakeOrder, isConfigured, geminiCall, generateProductDescription, generateCartRecoveryMessage };
