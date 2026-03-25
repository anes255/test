/**
 * AI Chatbot powered by Google Gemini
 * With detailed error logging for debugging
 */
const GEMINI_KEY = process.env.GEMINI_API_KEY || 'AIzaSyCEcpGv5gTzV4fhA6bSFfSSPNHIXTfm0MY';

async function geminiCall(prompt, maxTokens = 400) {
  if (!GEMINI_KEY) { console.log('[AI] No Gemini key'); return null; }
  
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 }
  };

  try {
    console.log('[AI] Calling Gemini...');
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    
    const text = await res.text();
    console.log('[AI] Status:', res.status, 'Body length:', text.length);
    
    if (!res.ok) {
      console.error('[AI] Gemini error:', text.substring(0, 300));
      return null;
    }
    
    const data = JSON.parse(text);
    const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!reply) {
      console.error('[AI] No reply in response:', JSON.stringify(data).substring(0, 300));
      return null;
    }
    
    console.log('[AI] Got reply:', reply.substring(0, 80));
    return reply;
  } catch (e) {
    console.error('[AI] Fetch failed:', e.message);
    return null;
  }
}

async function chat(opts) {
  const { message, store, history = [], language = 'auto' } = opts;
  const systemPrompt = buildSystemPrompt(store, language);
  const fullPrompt = `${systemPrompt}\n\nConversation so far:\n${history.slice(-6).map(h => `${h.role === 'user' ? 'Customer' : 'Bot'}: ${h.text || h.content || ''}`).join('\n')}\n\nCustomer: ${message}\n\nBot:`;
  
  const reply = await geminiCall(fullPrompt);
  if (reply) {
    return { response: reply, model: 'gemini-1.5-flash', suggestedActions: getSuggestions(message) };
  }
  return fallbackChat(message, store);
}

function buildSystemPrompt(store, language) {
  const langMap = { ar: 'أجب بالعربية الدارجة الجزائرية. كن مختصراً.', fr: 'Réponds en français. Sois concis.', en: 'Respond in English. Be concise.', auto: 'Detect the customer language and respond in the same language. For Arabic use Algerian dialect.' };
  const pays = [];
  if (store.enable_cod) pays.push('Cash on Delivery');
  if (store.enable_ccp) pays.push('CCP Transfer');
  if (store.enable_baridimob) pays.push('BaridiMob');
  if (store.enable_bank_transfer) pays.push('Bank Transfer');
  return `You are a friendly customer support chatbot for "${store.name || store.store_name}" in Algeria.
${langMap[language] || langMap.auto}
Currency: ${store.currency || 'DZD'}. Phone: ${store.contact_phone || 'N/A'}.
Payment methods: ${pays.join(', ') || 'COD'}.
Shipping: all 58 wilayas, 300-1400 DZD, 1-7 days.
${store.products_summary || ''}
RULES: Keep responses to 2-3 sentences. Be helpful and friendly. Never invent prices. Direct unknowns to store contact.`;
}

function getSuggestions(msg) {
  const m = (msg || '').toLowerCase();
  if (m.includes('ship') || m.includes('توصيل')) return [{ label: 'Products', action: 'view_products' }, { label: 'Contact', action: 'contact' }];
  if (m.includes('pay') || m.includes('دفع')) return [{ label: 'Shipping', action: 'shipping_rates' }, { label: 'Products', action: 'best_sellers' }];
  return [{ label: 'Shipping rates', action: 'shipping_rates' }, { label: 'Payment methods', action: 'payment_methods' }, { label: 'Contact', action: 'contact' }];
}

function fallbackChat(message, store) {
  const m = (message || '').toLowerCase(), name = store.name || store.store_name || 'Store', c = store.currency || 'DZD';
  let r = `مرحباً بك في ${name}! كيف يمكنني مساعدتك؟`;
  if (m.includes('shipping') || m.includes('توصيل') || m.includes('livraison')) r = `🚚 التوصيل متاح لجميع 58 ولاية! من 300 ${c} للمكتب، من 400 ${c} للبيت.`;
  else if (m.includes('payment') || m.includes('دفع') || m.includes('paiement')) r = `💳 الدفع عند الاستلام، CCP، BaridiMob، تحويل بنكي.`;
  else if (m.includes('hello') || m.includes('سلام') || m.includes('bonjour') || m.includes('مرحبا') || m.includes('hi')) r = `مرحباً! 👋 أهلاً بك في ${name}. كيف أساعدك؟`;
  else if (m.includes('contact') || m.includes('اتصال')) r = `📞 تواصل معنا: ${store.contact_phone || 'غير متاح'}`;
  else if (m.includes('track') || m.includes('تتبع')) r = `📦 لتتبع طلبك، استخدم صفحة تتبع الطلبات.`;
  return { response: r, model: 'fallback', suggestedActions: getSuggestions(message) };
}

// AI: Generate product description
async function generateProductDescription(productName, category, language = 'en') {
  const langMap = { ar: 'اكتب بالعربية الدارجة الجزائرية', fr: 'Écris en français', en: 'Write in English' };
  const reply = await geminiCall(`Generate a short compelling product description (2-3 sentences) for an e-commerce product. ${langMap[language] || langMap.en}.\nProduct: ${productName}\nCategory: ${category || 'General'}\nReturn ONLY the description text, nothing else.`, 200);
  return reply;
}

// AI: Generate cart recovery message
async function generateCartRecoveryMessage(storeName, itemNames, language = 'ar') {
  const langMap = { ar: 'اكتب بالعربية الدارجة الجزائرية', fr: 'Écris en français', en: 'Write in English' };
  const reply = await geminiCall(`Write a short WhatsApp cart recovery message (max 3 lines) for a customer who left items in their cart. ${langMap[language] || langMap.ar}.\nStore: ${storeName}\nItems: ${itemNames.join(', ')}\nBe friendly, create urgency. Return ONLY the message text.`, 150);
  return reply;
}

// AI: Fraud detection
async function detectFakeOrder(orderData, customerHistory) {
  let score = 0; const flags = [];
  const cancelled = customerHistory.cancelled || 0;
  if (cancelled >= 5) { score += 50; flags.push('Very high cancellations: ' + cancelled); }
  else if (cancelled >= 3) { score += 30; flags.push('High cancellations: ' + cancelled); }
  else if (cancelled >= 1) { score += 10; flags.push('Previous cancellations: ' + cancelled); }
  if (orderData.total > 50000) { score += 15; flags.push('High order value'); }
  
  // Try AI analysis
  const aiResult = await geminiCall(`Analyze this order for fraud. Return JSON: {"extra_score":0-20,"flags":["reason"]}\nOrder total: ${orderData.total} DZD, Phone: ${orderData.customer_phone}, Cancellations: ${cancelled}/${customerHistory.total_orders} orders`, 100);
  if (aiResult) {
    try {
      const m = aiResult.match(/\{[\s\S]*\}/);
      if (m) { const parsed = JSON.parse(m[0]); score += (parsed.extra_score || 0); if (parsed.flags) flags.push(...parsed.flags); }
    } catch {}
  }
  
  score = Math.min(score, 100);
  return { score, level: score >= 60 ? 'high' : score >= 30 ? 'medium' : 'low', flags };
}

function isConfigured() { return !!GEMINI_KEY; }

module.exports = { chat, detectFakeOrder, isConfigured, geminiCall, generateProductDescription, generateCartRecoveryMessage };
