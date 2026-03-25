const https = require('https');
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const MODEL = 'gemini-2.0-flash';

function httpsPost(path, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 20000,
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', e => reject(e));
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function geminiCall(prompt, maxTokens = 400) {
  if (!GEMINI_KEY) return { error: 'GEMINI_API_KEY not set' };

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 }
  };
  const path = `/v1beta/models/${MODEL}:generateContent?key=${GEMINI_KEY}`;

  // Try up to 3 times with increasing delay for rate limits
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt > 0) {
        const delay = attempt * 3000; // 3s, 6s
        console.log(`[AI] Retry ${attempt + 1} after ${delay}ms...`);
        await sleep(delay);
      }

      console.log(`[AI] Calling ${MODEL} (attempt ${attempt + 1})...`);
      const r = await httpsPost(path, payload);
      console.log('[AI] Status:', r.status);

      if (r.status === 200) {
        try {
          const data = JSON.parse(r.body);
          const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) {
            console.log('[AI] OK, length:', text.length);
            return { text };
          }
          return { error: 'Empty response from Gemini' };
        } catch (e) {
          return { error: 'Failed to parse response' };
        }
      }

      if (r.status === 429) {
        console.log('[AI] Rate limited, will retry...');
        if (attempt === 2) return { error: 'Rate limited - too many requests. Wait 60 seconds.' };
        continue; // retry
      }

      if (r.status === 403) return { error: 'API key not authorized. Create a new key at aistudio.google.com/apikey' };
      if (r.status === 404) return { error: 'Model not found. Check API key permissions.' };
      return { error: `Gemini error ${r.status}` };

    } catch (e) {
      console.error('[AI] Error:', e.message);
      if (attempt === 2) return { error: e.message };
    }
  }
  return { error: 'All retries failed' };
}

async function chat(opts) {
  const { message, store, history = [], language = 'auto' } = opts;
  const sys = buildPrompt(store, language);
  const hist = history.slice(-6).map(h => `${h.role === 'user' ? 'Customer' : 'Bot'}: ${h.text || h.content || ''}`).join('\n');
  const full = `${sys}\n\n${hist ? 'Chat:\n' + hist + '\n\n' : ''}Customer: ${message}\n\nBot:`;

  const result = await geminiCall(full);
  if (result?.text) return { response: result.text, model: MODEL, suggestedActions: tips(message) };

  const fb = fallback(message, store);
  if (result?.error) fb.debug = result.error;
  return fb;
}

function buildPrompt(store, lang) {
  const l = { ar: 'أجب بالدارجة الجزائرية.', fr: 'Réponds en français.', en: 'Reply in English.', auto: 'Reply in the same language as the customer. Use Algerian Arabic for Arabic.' };
  const p = [];
  if (store.enable_cod) p.push('COD');
  if (store.enable_ccp) p.push('CCP');
  if (store.enable_baridimob) p.push('BaridiMob');
  if (store.enable_bank_transfer) p.push('Bank');
  return `Customer support bot for "${store.name || store.store_name}" in Algeria. ${l[lang] || l.auto}
Currency: ${store.currency || 'DZD'}. Phone: ${store.contact_phone || 'N/A'}.
Payment: ${p.join(', ') || 'COD'}. Shipping: all 58 wilayas, 300-1400 DZD, 1-7 days.
${store.products_summary || ''}
Keep answers to 2-3 sentences. Be friendly. Never invent prices.`;
}

function tips(m) {
  const s = (m || '').toLowerCase();
  if (s.includes('ship') || s.includes('توصيل')) return [{ label: 'Products', action: 'view_products' }, { label: 'Contact', action: 'contact' }];
  if (s.includes('pay') || s.includes('دفع')) return [{ label: 'Shipping', action: 'shipping_rates' }, { label: 'Products', action: 'best_sellers' }];
  return [{ label: 'Shipping', action: 'shipping_rates' }, { label: 'Payment', action: 'payment_methods' }, { label: 'Contact', action: 'contact' }];
}

function fallback(msg, store) {
  const m = (msg || '').toLowerCase(), n = store.name || store.store_name || 'Store', c = store.currency || 'DZD';
  let r = `مرحباً بك في ${n}! كيف يمكنني مساعدتك؟`;
  if (m.includes('ship') || m.includes('توصيل') || m.includes('livraison')) r = `🚚 التوصيل لجميع 58 ولاية! من 300 ${c} للمكتب، من 400 ${c} للبيت.`;
  else if (m.includes('pay') || m.includes('دفع') || m.includes('paiement')) r = `💳 الدفع عند الاستلام، CCP، BaridiMob، تحويل بنكي.`;
  else if (m.includes('hello') || m.includes('hi') || m.includes('سلام') || m.includes('مرحبا') || m.includes('bonjour') || m.includes('واش')) r = `مرحباً! 👋 أهلاً بك في ${n}. كيف أساعدك؟`;
  else if (m.includes('contact') || m.includes('اتصال') || m.includes('هاتف')) r = `📞 ${store.contact_phone || 'غير متاح'}`;
  else if (m.includes('track') || m.includes('تتبع')) r = `📦 استخدم صفحة تتبع الطلبات.`;
  else if (m.includes('price') || m.includes('سعر') || m.includes('شحال')) r = `💰 تصفح منتجاتنا لمعرفة الأسعار.`;
  return { response: r, model: 'fallback', suggestedActions: tips(msg) };
}

async function generateProductDescription(name, cat, lang = 'en') {
  const l = { ar: 'بالدارجة الجزائرية', fr: 'en français', en: 'in English' };
  const r = await geminiCall(`Write a 2-3 sentence product description ${l[lang] || l.en} for: ${name} (${cat || 'General'}). Return ONLY the text.`, 200);
  return r?.text || null;
}

async function generateCartRecoveryMessage(store, items, lang = 'ar') {
  const l = { ar: 'بالدارجة الجزائرية', fr: 'en français', en: 'in English' };
  const r = await geminiCall(`Write a 3-line WhatsApp cart recovery message ${l[lang] || l.ar}. Store: ${store}. Items: ${items.join(', ')}. Be friendly, urgent. ONLY the message.`, 150);
  return r?.text || null;
}

async function detectFakeOrder(order, hist) {
  let s = 0; const f = [];
  const c = hist.cancelled || 0;
  if (c >= 5) { s += 50; f.push('Very high cancellations'); }
  else if (c >= 3) { s += 30; f.push('High cancellations'); }
  else if (c >= 1) { s += 10; f.push('Previous cancellations'); }
  if (order.total > 50000) { s += 15; f.push('High value order'); }
  s = Math.min(s, 100);
  return { score: s, level: s >= 60 ? 'high' : s >= 30 ? 'medium' : 'low', flags: f };
}

function isConfigured() { return !!GEMINI_KEY; }

module.exports = { chat, detectFakeOrder, isConfigured, geminiCall, generateProductDescription, generateCartRecoveryMessage };
