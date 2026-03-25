
const https = require('https');

const GEMINI_KEY = process.env.GEMINI_API_KEY || 'AIzaSyCEcpGv5gTzV4fhA6bSFfSSPNHIXTfm0MY';

function geminiCall(prompt, maxTokens = 400) {
  return new Promise((resolve) => {
    if (!GEMINI_KEY) { console.log('[AI] No key'); return resolve(null); }

    const postData = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 }
    });

    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 15000
    };

    console.log('[AI] Calling Gemini via https...');

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        console.log('[AI] Status:', res.statusCode, 'Length:', body.length);
        if (res.statusCode !== 200) {
          console.error('[AI] Error response:', body.substring(0, 300));
          return resolve({ error: `Gemini returned ${res.statusCode}`, details: body.substring(0, 200) });
        }
        try {
          const data = JSON.parse(body);
          const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!text) {
            console.error('[AI] No text in response:', body.substring(0, 200));
            return resolve({ error: 'No text in Gemini response' });
          }
          console.log('[AI] Reply:', text.substring(0, 80));
          return resolve({ text });
        } catch (e) {
          console.error('[AI] Parse error:', e.message);
          return resolve({ error: 'Failed to parse Gemini response' });
        }
      });
    });

    req.on('error', (e) => {
      console.error('[AI] Request error:', e.message);
      resolve({ error: e.message });
    });

    req.on('timeout', () => {
      console.error('[AI] Request timeout');
      req.destroy();
      resolve({ error: 'Gemini request timed out' });
    });

    req.write(postData);
    req.end();
  });
}

async function chat(opts) {
  const { message, store, history = [], language = 'auto' } = opts;
  const systemPrompt = buildSystemPrompt(store, language);
  const historyText = history.slice(-6).map(h => `${h.role === 'user' ? 'Customer' : 'Bot'}: ${h.text || h.content || ''}`).join('\n');
  const fullPrompt = `${systemPrompt}\n\n${historyText ? 'Conversation:\n' + historyText + '\n\n' : ''}Customer: ${message}\n\nBot (respond naturally):`;

  const result = await geminiCall(fullPrompt);

  if (result && result.text) {
    return { response: result.text, model: 'gemini-1.5-flash', suggestedActions: getSuggestions(message) };
  }

  // Return fallback WITH the error so admin can debug
  const fb = fallbackChat(message, store);
  if (result && result.error) {
    fb.debug = result.error;
    fb.details = result.details;
  }
  return fb;
}

function buildSystemPrompt(store, language) {
  const langMap = {
    ar: 'أجب بالعربية الدارجة الجزائرية. كن مختصراً وودوداً.',
    fr: 'Réponds en français. Sois concis et amical.',
    en: 'Respond in English. Be concise and friendly.',
    auto: 'Detect the customer language and respond in the same language. For Arabic use Algerian dialect (الدارجة).'
  };
  const pays = [];
  if (store.enable_cod) pays.push('Cash on Delivery (الدفع عند الاستلام)');
  if (store.enable_ccp) pays.push('CCP Transfer');
  if (store.enable_baridimob) pays.push('BaridiMob');
  if (store.enable_bank_transfer) pays.push('Bank Transfer');

  return `You are a friendly customer support chatbot for "${store.name || store.store_name}" - an online store in Algeria.
${langMap[language] || langMap.auto}
Store currency: ${store.currency || 'DZD'}.
Store phone: ${store.contact_phone || 'N/A'}.
Payment methods: ${pays.join(', ') || 'Cash on Delivery'}.
Shipping: Available to all 58 wilayas in Algeria. Desk delivery: 300-800 DZD. Home delivery: 400-1400 DZD. Delivery time: 1-7 days.
${store.products_summary || ''}
Important rules:
- Keep responses SHORT (2-3 sentences maximum)
- Be helpful, warm, and professional
- Never make up prices or product details you don't have
- If unsure, direct customer to contact the store`;
}

function getSuggestions(msg) {
  const m = (msg || '').toLowerCase();
  if (m.includes('ship') || m.includes('توصيل') || m.includes('livraison')) return [{ label: 'Products', action: 'view_products' }, { label: 'Contact', action: 'contact' }];
  if (m.includes('pay') || m.includes('دفع') || m.includes('paiement')) return [{ label: 'Shipping', action: 'shipping_rates' }, { label: 'Products', action: 'best_sellers' }];
  return [{ label: 'Shipping rates', action: 'shipping_rates' }, { label: 'Payment methods', action: 'payment_methods' }, { label: 'Contact', action: 'contact' }];
}

function fallbackChat(message, store) {
  const m = (message || '').toLowerCase();
  const name = store.name || store.store_name || 'Store';
  const c = store.currency || 'DZD';
  let r = `مرحباً بك في ${name}! كيف يمكنني مساعدتك؟`;
  if (m.includes('shipping') || m.includes('delivery') || m.includes('توصيل') || m.includes('livraison')) r = `🚚 التوصيل متاح لجميع 58 ولاية! من 300 ${c} للمكتب، من 400 ${c} للبيت. المدة: 1-7 أيام.`;
  else if (m.includes('payment') || m.includes('pay') || m.includes('دفع') || m.includes('paiement')) r = `💳 طرق الدفع: الدفع عند الاستلام، CCP، BaridiMob، تحويل بنكي.`;
  else if (m.includes('hello') || m.includes('hi') || m.includes('سلام') || m.includes('مرحبا') || m.includes('bonjour') || m.includes('صباح') || m.includes('واش')) r = `مرحباً! 👋 أهلاً بك في ${name}. كيف أساعدك اليوم؟`;
  else if (m.includes('contact') || m.includes('اتصال') || m.includes('phone') || m.includes('هاتف')) r = `📞 تواصل معنا: ${store.contact_phone || 'غير متاح'}`;
  else if (m.includes('track') || m.includes('تتبع') || m.includes('suivi') || m.includes('وين')) r = `📦 لتتبع طلبك، استخدم صفحة تتبع الطلبات أو تواصل معنا برقم الطلب.`;
  else if (m.includes('return') || m.includes('إرجاع') || m.includes('retour')) r = `🔄 للإرجاع أو الاستبدال، تواصل معنا خلال 7 أيام من الاستلام.`;
  else if (m.includes('price') || m.includes('سعر') || m.includes('prix') || m.includes('شحال')) r = `💰 تصفح منتجاتنا لمعرفة الأسعار. الأسعار بالدينار الجزائري (${c}).`;
  return { response: r, model: 'fallback', suggestedActions: getSuggestions(message) };
}

// AI: Generate product description
async function generateProductDescription(productName, category, language = 'en') {
  const langMap = { ar: 'اكتب بالعربية الدارجة الجزائرية', fr: 'Écris en français', en: 'Write in English' };
  const result = await geminiCall(`Generate a short compelling product description (2-3 sentences) for an e-commerce product. ${langMap[language] || langMap.en}.\nProduct: ${productName}\nCategory: ${category || 'General'}\nReturn ONLY the description text, nothing else.`, 200);
  return result?.text || null;
}

// AI: Generate cart recovery message
async function generateCartRecoveryMessage(storeName, itemNames, language = 'ar') {
  const langMap = { ar: 'اكتب بالعربية الدارجة الجزائرية', fr: 'Écris en français', en: 'Write in English' };
  const result = await geminiCall(`Write a short WhatsApp cart recovery message (max 3 lines) for a customer who left items in their cart. ${langMap[language] || langMap.ar}.\nStore: ${storeName}\nItems: ${itemNames.join(', ')}\nBe friendly and create urgency. Return ONLY the message text, no quotes.`, 150);
  return result?.text || null;
}

// AI: Fraud detection
async function detectFakeOrder(orderData, customerHistory) {
  let score = 0;
  const flags = [];
  const cancelled = customerHistory.cancelled || 0;
  if (cancelled >= 5) { score += 50; flags.push('Very high cancellations: ' + cancelled); }
  else if (cancelled >= 3) { score += 30; flags.push('High cancellations: ' + cancelled); }
  else if (cancelled >= 1) { score += 10; flags.push('Previous cancellations: ' + cancelled); }
  if (orderData.total > 50000) { score += 15; flags.push('High order value'); }

  // Try AI enhancement
  const result = await geminiCall(`Analyze this order for fraud risk. Return ONLY a JSON object: {"extra_score":0-20,"flags":["reason"]}\nOrder: ${orderData.total} DZD, Phone: ${orderData.customer_phone}, Past cancellations: ${cancelled}/${customerHistory.total_orders} orders`, 100);
  if (result?.text) {
    try {
      const match = result.text.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        score += (parsed.extra_score || 0);
        if (parsed.flags) flags.push(...parsed.flags);
      }
    } catch {}
  }

  score = Math.min(score, 100);
  return { score, level: score >= 60 ? 'high' : score >= 30 ? 'medium' : 'low', flags };
}

function isConfigured() { return !!GEMINI_KEY; }

module.exports = { chat, detectFakeOrder, isConfigured, geminiCall, generateProductDescription, generateCartRecoveryMessage };
