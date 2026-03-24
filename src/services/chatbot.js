/**
 * AI Chatbot powered by Google Gemini
 */
const GEMINI_KEY = process.env.GEMINI_API_KEY || 'AIzaSyCEcpGv5gTzV4fhA6bSFfSSPNHIXTfm0MY';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent';

async function chat(opts) {
  if (!GEMINI_KEY) return fallbackChat(opts.message, opts.store);
  const { message, store, history = [], language = 'auto' } = opts;
  const systemPrompt = buildSystemPrompt(store, language);
  const contents = [];
  // System instruction as first user turn
  contents.push({ role: 'user', parts: [{ text: systemPrompt }] });
  contents.push({ role: 'model', parts: [{ text: 'Understood. I am ready to help customers.' }] });
  // History
  for (const h of history.slice(-10)) {
    contents.push({ role: h.role === 'user' ? 'user' : 'model', parts: [{ text: h.content || h.text || '' }] });
  }
  contents.push({ role: 'user', parts: [{ text: message }] });

  try {
    const res = await fetch(`${GEMINI_URL}?key=${GEMINI_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents, generationConfig: { maxOutputTokens: 400, temperature: 0.7 } }),
    });
    if (!res.ok) { console.error('[AI] Gemini error:', await res.text()); return fallbackChat(message, store); }
    const data = await res.json();
    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return { response: reply, model: 'gemini-2.0-flash', suggestedActions: generateSuggestions(message) };
  } catch (e) { console.error('[AI]', e.message); return fallbackChat(message, store); }
}

function buildSystemPrompt(store, language) {
  const langMap = { ar: 'أجب بالعربية الدارجة الجزائرية.', fr: 'Réponds en français.', en: 'Respond in English.', auto: 'Detect language and respond in same language. For Arabic use Algerian dialect.' };
  const pays = [];
  if (store.enable_cod) pays.push('Cash on Delivery');
  if (store.enable_ccp) pays.push('CCP Transfer');
  if (store.enable_baridimob) pays.push('BaridiMob');
  if (store.enable_bank_transfer) pays.push('Bank Transfer');
  if (store.chargily_enabled) pays.push('Online Card (Edahabia/CIB)');
  return `You are customer support for "${store.name||store.store_name}". ${langMap[language]||langMap.auto}
Currency: ${store.currency||'DZD'}. Phone: ${store.contact_phone||'N/A'}. Location: Algeria.
Payment: ${pays.join(', ')||'COD'}. Shipping: all 58 wilayas, 300-1400 DZD, 1-7 days.
${store.products_summary||''}
Rules: max 2-3 sentences, be helpful, never invent prices, direct unknowns to store contact.`;
}

function generateSuggestions(msg) {
  const m = (msg || '').toLowerCase();
  if (m.includes('ship') || m.includes('توصيل')) return [{ label: 'View products', action: 'view_products' }, { label: 'Contact us', action: 'contact' }];
  if (m.includes('pay') || m.includes('دفع')) return [{ label: 'Shipping info', action: 'shipping_rates' }, { label: 'Best sellers', action: 'best_sellers' }];
  return [{ label: 'Shipping rates', action: 'shipping_rates' }, { label: 'Payment methods', action: 'payment_methods' }, { label: 'Contact info', action: 'contact' }];
}

function fallbackChat(message, store) {
  const m = (message || '').toLowerCase(), name = store.name || store.store_name || 'Store', c = store.currency || 'DZD';
  let r = `مرحباً بك في ${name}! كيف يمكنني مساعدتك؟`;
  if (m.includes('shipping') || m.includes('توصيل') || m.includes('livraison')) r = `🚚 التوصيل متاح لجميع 58 ولاية! من 300 ${c} للمكتب، من 400 ${c} للبيت.`;
  else if (m.includes('payment') || m.includes('دفع') || m.includes('paiement')) r = `💳 الدفع عند الاستلام، CCP، BaridiMob، تحويل بنكي.`;
  else if (m.includes('hello') || m.includes('سلام') || m.includes('bonjour')) r = `مرحباً! 👋 أهلاً بك في ${name}. كيف أساعدك؟`;
  else if (m.includes('contact') || m.includes('اتصال')) r = `📞 تواصل معنا: ${store.contact_phone || 'غير متاح'}`;
  else if (m.includes('track') || m.includes('تتبع')) r = `📦 لتتبع طلبك، استخدم صفحة تتبع الطلبات أو تواصل معنا.`;
  return { response: r, model: 'fallback', suggestedActions: generateSuggestions(message) };
}

// Generic AI prompt — used by admin features
async function aiGenerate(prompt, maxTokens = 500) {
  if (!GEMINI_KEY) return null;
  try {
    const res = await fetch(`${GEMINI_URL}?key=${GEMINI_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 } }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch { return null; }
}

// AI: Generate product description
async function generateProductDescription(productName, category, language = 'ar') {
  const langMap = { ar: 'اكتب بالعربية الدارجة الجزائرية', fr: 'Écris en français', en: 'Write in English' };
  const prompt = `Generate a short compelling product description (2-3 sentences max) for an e-commerce product. ${langMap[language] || langMap.ar}.\nProduct: ${productName}\nCategory: ${category || 'General'}\nReturn ONLY the description, no quotes or labels.`;
  return await aiGenerate(prompt, 200);
}

// AI: Generate cart recovery message
async function generateCartRecoveryMessage(storeName, itemNames, language = 'ar') {
  const langMap = { ar: 'اكتب بالعربية الدارجة الجزائرية', fr: 'Écris en français', en: 'Write in English' };
  const prompt = `Write a short WhatsApp cart recovery message (max 3 lines) for a customer who abandoned their cart. ${langMap[language] || langMap.ar}.\nStore: ${storeName}\nItems: ${itemNames.join(', ')}\nBe friendly, create urgency. Return ONLY the message.`;
  return await aiGenerate(prompt, 150);
}

// AI: Analyze order for fraud
async function analyzeOrderFraud(orderData, customerHistory) {
  const prompt = `Analyze this e-commerce order for fraud risk. Return JSON only: {"score":0-100,"level":"low|medium|high","flags":["reason1"],"recommendation":"action"}
Order: name=${orderData.customer_name}, phone=${orderData.customer_phone}, total=${orderData.total} DZD, method=${orderData.payment_method}
History: ${customerHistory.total_orders} orders, ${customerHistory.cancelled} cancelled, ${customerHistory.total_spent} DZD spent
Consider: cancellation rate, order value anomalies, suspicious patterns.`;
  const result = await aiGenerate(prompt, 200);
  if (result) { try { const m = result.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]); } catch {} }
  return rulBasedDetection(orderData, customerHistory);
}

function rulBasedDetection(orderData, history) {
  let score = 0; const flags = [];
  if ((history.cancelled || 0) >= 5) { score += 50; flags.push('Very high cancellations'); }
  else if ((history.cancelled || 0) >= 3) { score += 30; flags.push('High cancellations'); }
  else if ((history.cancelled || 0) >= 1) { score += 10; flags.push('Previous cancellations'); }
  if (orderData.total > 50000) { score += 15; flags.push('High order value'); }
  return { score: Math.min(score, 100), level: score >= 60 ? 'high' : score >= 30 ? 'medium' : 'low', flags };
}

function isConfigured() { return !!GEMINI_KEY; }

module.exports = { chat, detectFakeOrder: analyzeOrderFraud, isConfigured, aiGenerate, generateProductDescription, generateCartRecoveryMessage };
