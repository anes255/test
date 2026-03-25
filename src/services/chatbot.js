const https = require('https');

// Supports: GROQ_API_KEY (free, fast, recommended) or GEMINI_API_KEY
const GROQ_KEY = process.env.GROQ_API_KEY || '';
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';

// Cache responses for 5 min — same question = no API call
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.time > CACHE_TTL) { cache.delete(key); return null; }
  return entry.value;
}
function setCache(key, value) {
  cache.set(key, { value, time: Date.now() });
  // Keep cache small
  if (cache.size > 200) { const first = cache.keys().next().value; cache.delete(first); }
}

// ═══ GROQ — Free, fast, 30 RPM, 14400 RPD ═══
function groqCall(prompt, maxTokens = 250) {
  return new Promise((resolve) => {
    if (!GROQ_KEY) return resolve(null);
    const body = JSON.stringify({
      model: 'llama-3.1-8b-instant',
      messages: [{ role: 'user', content: prompt }],
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
          try { resolve({ text: JSON.parse(d).choices[0].message.content, model: 'groq-llama3' }); } catch { resolve(null); }
        } else { console.log('[AI] Groq status:', res.statusCode); resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body); req.end();
  });
}

// ═══ GEMINI ═══
function geminiCallRaw(prompt, maxTokens = 250) {
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
        } else { console.log('[AI] Gemini status:', res.statusCode); resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body); req.end();
  });
}

// ═══ UNIFIED CALL — tries Groq first, then Gemini ═══
async function aiCall(prompt, maxTokens = 250) {
  // Check cache
  const cacheKey = prompt.substring(0, 100);
  const cached = getCached(cacheKey);
  if (cached) { console.log('[AI] Cache hit'); return cached; }

  let result = null;

  // Try Groq first (faster, higher limits)
  if (GROQ_KEY) {
    result = await groqCall(prompt, maxTokens);
    if (result?.text) { setCache(cacheKey, result); return result; }
  }

  // Try Gemini
  if (GEMINI_KEY) {
    result = await geminiCallRaw(prompt, maxTokens);
    if (result?.text) { setCache(cacheKey, result); return result; }
  }

  // Both failed or not configured
  const configured = [];
  if (GROQ_KEY) configured.push('Groq');
  if (GEMINI_KEY) configured.push('Gemini');
  return { error: configured.length ? `${configured.join(' & ')} failed - rate limited or error` : 'No AI configured. Set GROQ_API_KEY (free at console.groq.com) in Render env' };
}

// ═══ CHAT ═══
async function chat(opts) {
  const { message, store, history = [], language = 'auto' } = opts;
  const prompt = buildPrompt(store, language);
  const hist = history.slice(-4).map(h => `${h.role === 'user' ? 'Q' : 'A'}: ${h.text || h.content || ''}`).join('\n');
  const result = await aiCall(`${prompt}\n${hist ? hist + '\n' : ''}Q: ${message}\nA:`);
  if (result?.text) return { response: result.text, model: result.model, suggestedActions: tips(message) };
  const fb = fallback(message, store);
  if (result?.error) fb.debug = result.error;
  return fb;
}

function buildPrompt(s, lang) {
  const l = { ar: 'أجب بالدارجة الجزائرية.', fr: 'Réponds en français.', en: 'Reply in English.', auto: "Reply in customer's language. Use Algerian Arabic for Arabic speakers." };
  return `Support bot for "${s.name || s.store_name}" (Algeria). ${l[lang] || l.auto} ${s.currency || 'DZD'}. Payment: ${[s.enable_cod && 'COD', s.enable_ccp && 'CCP', s.enable_baridimob && 'BaridiMob'].filter(Boolean).join(',') || 'COD'}. Shipping: 58 wilayas, 300-1400 DZD. ${s.products_summary || ''} 2 sentences max, friendly.`;
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
  const r = await aiCall(`Product description (2 sentences) ${l[lang] || l.en} for: ${name}. ONLY text.`, 120);
  return r?.text || null;
}

async function generateCartRecoveryMessage(store, items, lang = 'ar') {
  const l = { ar: 'بالدارجة الجزائرية', fr: 'en français', en: 'in English' };
  const r = await aiCall(`WhatsApp cart recovery (2 lines) ${l[lang] || l.ar}. Store: ${store}. Items: ${items.join(',')}. ONLY message.`, 80);
  return r?.text || null;
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

module.exports = { chat, detectFakeOrder, isConfigured, geminiCall: aiCall, generateProductDescription, generateCartRecoveryMessage };
