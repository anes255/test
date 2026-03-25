const https = require('https');
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';

// Use flash-lite: highest free RPM (30/min vs 15 for regular flash)
const MODEL = 'gemini-2.0-flash-lite';

function post(path, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com', path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 8000,
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', e => reject(e));
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body); req.end();
  });
}

async function geminiCall(prompt, maxTokens = 300) {
  if (!GEMINI_KEY) return { error: 'GEMINI_API_KEY not set' };
  try {
    console.log('[AI] Calling', MODEL);
    const r = await post(`/v1beta/models/${MODEL}:generateContent?key=${GEMINI_KEY}`, {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 }
    });
    console.log('[AI] Status:', r.status);
    if (r.status === 200) {
      const text = JSON.parse(r.body)?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) return { text };
      return { error: 'Empty response' };
    }
    if (r.status === 429) return { error: 'Rate limited - wait a few seconds' };
    if (r.status === 403) return { error: 'API key not authorized' };
    if (r.status === 404) return { error: 'Model not available - check API key at aistudio.google.com' };
    return { error: `Error ${r.status}` };
  } catch (e) {
    return { error: e.message === 'timeout' ? 'AI took too long' : e.message };
  }
}

async function chat(opts) {
  const { message, store, history = [], language = 'auto' } = opts;
  const sys = buildPrompt(store, language);
  const hist = history.slice(-4).map(h => `${h.role === 'user' ? 'Customer' : 'Bot'}: ${h.text || h.content || ''}`).join('\n');
  const result = await geminiCall(`${sys}\n\n${hist ? hist + '\n\n' : ''}Customer: ${message}\nBot:`);
  if (result?.text) return { response: result.text, model: MODEL, suggestedActions: tips(message) };
  const fb = fallback(message, store);
  if (result?.error) fb.debug = result.error;
  return fb;
}

function buildPrompt(s, lang) {
  const l = { ar: 'أجب بالدارجة الجزائرية.', fr: 'Réponds en français.', en: 'Reply in English.', auto: 'Reply in customer\'s language. Arabic = Algerian dialect.' };
  const p = [];
  if (s.enable_cod) p.push('COD'); if (s.enable_ccp) p.push('CCP'); if (s.enable_baridimob) p.push('BaridiMob');
  return `Support bot for "${s.name||s.store_name}" (Algeria). ${l[lang]||l.auto} Currency: ${s.currency||'DZD'}. Payment: ${p.join(',')||'COD'}. Shipping: 58 wilayas, 300-1400 DZD. ${s.products_summary||''} Rules: 2 sentences max, friendly, no invented prices.`;
}

function tips(m) {
  const s = (m||'').toLowerCase();
  if (s.includes('ship')||s.includes('توصيل')) return [{label:'Products',action:'view_products'},{label:'Contact',action:'contact'}];
  if (s.includes('pay')||s.includes('دفع')) return [{label:'Shipping',action:'shipping_rates'},{label:'Products',action:'best_sellers'}];
  return [{label:'Shipping',action:'shipping_rates'},{label:'Payment',action:'payment_methods'},{label:'Contact',action:'contact'}];
}

function fallback(msg, store) {
  const m=(msg||'').toLowerCase(), n=store.name||store.store_name||'Store', c=store.currency||'DZD';
  let r=`مرحباً بك في ${n}! كيف يمكنني مساعدتك؟`;
  if(m.includes('ship')||m.includes('توصيل')||m.includes('livraison')) r=`🚚 التوصيل لجميع 58 ولاية! من 300 ${c} للمكتب.`;
  else if(m.includes('pay')||m.includes('دفع')||m.includes('paiement')) r=`💳 الدفع عند الاستلام، CCP، BaridiMob.`;
  else if(m.includes('hello')||m.includes('hi')||m.includes('سلام')||m.includes('مرحبا')||m.includes('bonjour')||m.includes('واش')) r=`مرحباً! 👋 كيف أساعدك في ${n}؟`;
  else if(m.includes('contact')||m.includes('اتصال')) r=`📞 ${store.contact_phone||'غير متاح'}`;
  else if(m.includes('track')||m.includes('تتبع')) r=`📦 استخدم صفحة تتبع الطلبات.`;
  else if(m.includes('price')||m.includes('سعر')||m.includes('شحال')) r=`💰 تصفح منتجاتنا لمعرفة الأسعار.`;
  return {response:r, model:'fallback', suggestedActions:tips(msg)};
}

async function generateProductDescription(name, cat, lang='en') {
  const l={ar:'بالدارجة الجزائرية',fr:'en français',en:'in English'};
  const r=await geminiCall(`Product description (2 sentences) ${l[lang]||l.en} for: ${name}. ONLY the text.`, 150);
  return r?.text||null;
}

async function generateCartRecoveryMessage(store, items, lang='ar') {
  const l={ar:'بالدارجة الجزائرية',fr:'en français',en:'in English'};
  const r=await geminiCall(`WhatsApp cart recovery (3 lines) ${l[lang]||l.ar}. Store: ${store}. Items: ${items.join(',')}. Friendly+urgent. ONLY message.`, 100);
  return r?.text||null;
}

async function detectFakeOrder(order, hist) {
  let s=0; const f=[];
  const c=hist.cancelled||0;
  if(c>=5){s+=50;f.push('Very high cancellations');}
  else if(c>=3){s+=30;f.push('High cancellations');}
  else if(c>=1){s+=10;f.push('Previous cancellations');}
  if(order.total>50000){s+=15;f.push('High value');}
  return {score:Math.min(s,100), level:s>=60?'high':s>=30?'medium':'low', flags:f};
}

function isConfigured() { return !!GEMINI_KEY; }

module.exports = {chat, detectFakeOrder, isConfigured, geminiCall, generateProductDescription, generateCartRecoveryMessage};
