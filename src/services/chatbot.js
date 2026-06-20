const https = require('https');

const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
// Default to a fast, cheap model; override with OPENAI_MODEL (e.g. gpt-4o for best copy)
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
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

// Last OpenAI failure reason (status + message), so callers can surface why a
// GPT call fell through instead of silently degrading to another provider.
let lastOpenAIError = null;

// ═══ OPENAI (GPT) — proper chat format ═══
function openaiCall(systemPrompt, messages, maxTokens = 250) {
  return new Promise((resolve) => {
    if (!OPENAI_KEY) return resolve(null);

    const chatMessages = [{ role: 'system', content: systemPrompt }];
    for (const m of messages) {
      chatMessages.push({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.text || m.content || ''
      });
    }

    const body = JSON.stringify({
      model: OPENAI_MODEL,
      messages: chatMessages,
      max_tokens: maxTokens,
      temperature: 0.7,
    });

    const req = https.request({
      hostname: 'api.openai.com', path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Length': Buffer.byteLength(body) },
      // Large generations (full landing-page HTML) can take a while on gpt-4o.
      timeout: maxTokens > 2000 ? 110000 : (maxTokens > 800 ? 40000 : 12000),
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const text = JSON.parse(d).choices[0].message.content;
            console.log('[AI] OpenAI OK:', text.substring(0, 60));
            lastOpenAIError = null;
            resolve({ text, model: OPENAI_MODEL });
          } catch { resolve(null); }
        } else {
          let msg = String(res.statusCode);
          try { msg = JSON.parse(d).error?.message || msg; } catch {}
          console.log('[AI] OpenAI error:', msg);
          lastOpenAIError = { status: res.statusCode, message: msg };
          resolve(null);
        }
      });
    });
    req.on('error', (e) => { lastOpenAIError = { message: e.message }; resolve(null); });
    req.on('timeout', () => { req.destroy(); lastOpenAIError = { message: 'OpenAI request timed out' }; resolve(null); });
    req.write(body); req.end();
  });
}

// ═══ OPENAI IMAGE GENERATION ═══
// Generates a real image with OpenAI (gpt-image-1, falling back to dall-e-3) and
// returns a data URI ready to embed in <img src="...">. Used to give AI landing
// pages genuine generated visuals.
function openaiImageOnce(model, prompt, size) {
  return new Promise((resolve) => {
    // Each model supports different sizes — normalize wide/tall/square per model.
    const wide = size === '1536x1024' || size === '1792x1024';
    const tall = size === '1024x1536' || size === '1024x1792';
    const useSize = model === 'gpt-image-1'
      ? (wide ? '1536x1024' : tall ? '1024x1536' : '1024x1024')
      : (wide ? '1792x1024' : tall ? '1024x1792' : '1024x1024');
    const payload = { model, prompt: String(prompt).slice(0, 3800), n: 1, size: useSize };
    if (model === 'gpt-image-1') payload.quality = 'medium';
    else { payload.response_format = 'b64_json'; payload.quality = 'standard'; } // dall-e-3
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: 'api.openai.com', path: '/v1/images/generations', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Length': Buffer.byteLength(body) },
      timeout: 90000,
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try { const b64 = JSON.parse(d).data[0].b64_json; return resolve(b64 ? `data:image/png;base64,${b64}` : null); } catch { return resolve(null); }
        }
        let msg = String(res.statusCode); try { msg = JSON.parse(d).error?.message || msg; } catch {}
        console.log(`[AI] image ${model} error:`, msg);
        resolve({ _err: msg, _status: res.statusCode });
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body); req.end();
  });
}
async function openaiImage(prompt, size = '1024x1024') {
  if (!OPENAI_KEY) return null;
  const a = await openaiImageOnce('gpt-image-1', prompt, size);
  if (typeof a === 'string') return a;
  // gpt-image-1 may be unavailable (org not verified) — fall back to DALL·E 3.
  const b = await openaiImageOnce('dall-e-3', prompt, size);
  return typeof b === 'string' ? b : null;
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
      timeout: maxTokens > 800 ? 20000 : 8000,
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
      timeout: maxTokens > 800 ? 20000 : 10000,
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

  // Try OpenAI (GPT) first — highest quality
  if (OPENAI_KEY) {
    result = await openaiCall(systemPrompt, chatHistory, 250);
  }

  // Try Groq next (proper chat format)
  if (!result?.text && GROQ_KEY) {
    result = await groqCall(systemPrompt, chatHistory, 250);
  }

  // Try Gemini as final fallback (flat prompt)
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
  const configured = [OPENAI_KEY && 'OpenAI', GROQ_KEY && 'Groq', GEMINI_KEY && 'Gemini'].filter(Boolean);
  fb.debug = configured.length ? 'AI providers failed' : 'Set OPENAI_API_KEY (or GROQ_API_KEY, free at console.groq.com)';
  return fb;
}

function buildPrompt(s, lang) {
  const l = {
    ar: 'STRICT LANGUAGE RULE: You MUST respond ONLY in Modern Standard Arabic. Every word must be Arabic. NEVER use French or English words. NEVER switch language.',
    fr: 'STRICT LANGUAGE RULE: Tu DOIS répondre UNIQUEMENT en français. Chaque mot doit être en français. Ne change JAMAIS de langue. Ne mélange JAMAIS avec l\'anglais ou l\'arabe.',
    en: 'STRICT LANGUAGE RULE: You MUST respond ONLY in English. Every word must be English. NEVER switch to French or Arabic. NEVER mix languages.',
    auto: 'STRICT LANGUAGE RULE: You MUST respond ONLY in English. Every word must be English. NEVER switch languages mid-conversation.'
  };
  const pays = [s.enable_cod && 'Cash on Delivery', s.enable_ccp && 'CCP Transfer', s.enable_baridimob && 'BaridiMob'].filter(Boolean);
  return `You are a professional customer support chatbot for "${s.name || s.store_name}", an online store in Algeria.

${l[lang] || l.en}
YOU MUST MAINTAIN THIS LANGUAGE FOR YOUR ENTIRE RESPONSE. DO NOT SWITCH MID-SENTENCE.

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
  if (OPENAI_KEY) result = await openaiCall('You are a helpful assistant. Follow instructions exactly.', [{ role: 'user', text: prompt }], maxTokens);
  if (!result?.text && GROQ_KEY) result = await groqCall('You are a helpful assistant. Follow instructions exactly.', [{ role: 'user', text: prompt }], maxTokens);
  if (!result?.text && GEMINI_KEY) result = await geminiCall(prompt, maxTokens);
  return result?.text || null;
}

async function generateProductDescription(name, cat, lang = 'en') {
  const l = {
    ar: 'in Modern Standard Arabic (فصحى). CRITICAL: Use ONLY Arabic letters and characters. Do NOT include ANY Chinese, Japanese, Korean, or other non-Arabic characters. Do NOT mix in English or French words. Every single character must be Arabic script, Arabic punctuation, or standard numbers.',
    fr: 'en français. Use ONLY French text, no other languages.',
    en: 'in English'
  };
  let result = await aiGenerate(`Write a product description (2 sentences) ${l[lang] || l.en} for: ${name} (${cat || 'General'}). Return ONLY the description text, nothing else.`);
  if (result && lang === 'ar') result = sanitizeArabic(result);
  return result;
}

// Strip non-Arabic/non-standard characters that AI sometimes injects into Arabic text
function sanitizeArabic(text) {
  if (!text) return text;
  // Remove CJK characters, random Unicode symbols, and other non-Arabic scripts
  // Keep: Arabic block (0600-06FF, 0750-077F, FB50-FDFF, FE70-FEFF), spaces, numbers, basic punctuation, emoji
  return text.replace(/[⺀-鿿　-〿豈-﫿぀-ゟ゠-ヿ가-힯]/g, '')
    .replace(/\s{2,}/g, ' ').trim();
}

async function generateCartRecoveryMessage(store, items, lang = 'ar') {
  const l = { ar: 'in Modern Standard Arabic (فصحى). Use professional, clear Arabic. Do NOT use Algerian dialect. Do NOT include any non-Arabic characters.', fr: 'en français professionnel', en: 'in professional English' };
  let result = await aiGenerate(`Write a WhatsApp cart recovery message (2-3 lines) ${l[lang] || l.ar}. Store: ${store}. Items: ${items.join(',')}. Be friendly and urgent. Return ONLY the message text, nothing else.`);
  if (result && lang === 'ar') result = sanitizeArabic(result);
  return result;
}

async function detectFakeOrder(order, hist) {
  let s = 0; const f = [];
  if ((hist.cancelled || 0) >= 5) { s += 50; f.push('Very high cancellations'); }
  else if ((hist.cancelled || 0) >= 3) { s += 30; f.push('High cancellations'); }
  else if ((hist.cancelled || 0) >= 1) { s += 10; f.push('Previous cancellations'); }
  if (order.total > 50000) { s += 15; f.push('High value'); }
  return { score: Math.min(s, 100), level: s >= 60 ? 'high' : s >= 30 ? 'medium' : 'low', flags: f };
}

async function moderateReview(content, rating) {
  if (!content || content.trim().length < 3) {
    return { score: rating >= 3 ? 80 : 40, reason: 'Very short review, rated by stars only', approved: rating >= 3 };
  }

  // Try AI moderation
  const prompt = `You are a review moderator. Analyze this product review and return ONLY a JSON object with:
- "score": 0-100 (100=definitely legitimate, 0=definitely spam/fake/inappropriate)
- "reason": short explanation
- "approved": true/false

Rules: Approve genuine reviews even if negative. Reject spam, gibberish, offensive content, or reviews with personal info (phone/email).

Review (rating: ${rating}/5): "${content.substring(0, 300)}"

Return ONLY the JSON, no other text.`;

  const result = await aiGenerate(prompt, 100);
  if (result) {
    try {
      const clean = result.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(clean);
      return { score: parseInt(parsed.score) || 50, reason: parsed.reason || '', approved: parsed.approved !== false };
    } catch (e) {}
  }

  // Fallback: basic rule-based moderation
  const lower = (content || '').toLowerCase();
  let score = 70;
  const flags = [];
  // Check for spam patterns
  if (/https?:\/\/|www\./i.test(content)) { score -= 30; flags.push('Contains URL'); }
  if (/(\d{8,})|(\w+@\w+\.\w+)/i.test(content)) { score -= 20; flags.push('Contains personal info'); }
  if (content.length < 10 && rating <= 2) { score -= 15; flags.push('Very short negative review'); }
  if (/fuck|shit|damn|ass|bitch/i.test(content)) { score -= 40; flags.push('Profanity'); }
  // Positive signals
  if (content.length > 30) score += 10;
  if (rating >= 4) score += 5;

  score = Math.max(0, Math.min(100, score));
  return { score, reason: flags.length ? flags.join(', ') : 'Basic check passed', approved: score >= 50 };
}

// ═══ AI LANDING PAGE GENERATOR ═══
// Analyzes products and generates a unique page structure, layout, copy, and theme
const LANDING_TEMPLATES = [
  { id: 'magazine', name: 'Magazine', mood: 'editorial, sophisticated', best_for: 'fashion, lifestyle, beauty, home decor' },
  { id: 'bento', name: 'Bento Grid', mood: 'modern, tech-forward', best_for: 'electronics, gadgets, tech accessories, multi-product bundles' },
  { id: 'timeline', name: 'Timeline Journey', mood: 'storytelling, narrative', best_for: 'skincare routines, collections, step-by-step products, kits' },
  { id: 'cards', name: 'Card Gallery', mood: 'clean, browsable', best_for: 'varied catalogs, general products, mixed categories' },
  { id: 'cinematic', name: 'Cinematic', mood: 'immersive, dramatic', best_for: 'luxury, premium products, watches, jewelry, perfume' },
  { id: 'minimal-zen', name: 'Minimal Zen', mood: 'serene, minimal', best_for: 'single hero products, artisan goods, handmade items' },
  { id: 'split-screen', name: 'Split Screen', mood: 'bold, high-contrast', best_for: 'comparisons, before/after, two hero products, sports gear' },
  { id: 'mosaic', name: 'Mosaic Collage', mood: 'creative, artistic', best_for: 'art, photography, prints, creative products, clothing collections' },
  { id: 'storytelling', name: 'Storytelling', mood: 'emotional, narrative', best_for: 'brand story products, heritage items, food, organic goods' },
  { id: 'alternating', name: 'Alternating', mood: 'balanced, classic', best_for: 'general products, e-commerce standard' },
  { id: 'stacked', name: 'Stacked', mood: 'content-focused', best_for: 'detailed products, products needing description space' },
  { id: 'showcase', name: 'Showcase', mood: 'dark, premium', best_for: 'high-end products, limited editions' },
  { id: 'product-hero', name: 'Product Hero', mood: 'conversion-focused, mobile-first', best_for: 'single product pages, COD offers, Landixo-style landing pages, impulse buys' },
];

async function generateLandingPage(products, store, language = 'en') {
  const productSummary = products.slice(0, 8).map((p, i) => {
    const name = p.name_en || p.name_fr || p.name_ar || p.name || 'Product';
    const price = p.price || 0;
    const cat = p.category_name || p.category || 'General';
    const desc = (p.description_en || p.description || '').substring(0, 100);
    const hasImage = !!(p.images?.[0] || p.thumbnail || p.image);
    return `${i + 1}. "${name}" — ${price} ${store.currency || 'DZD'}, category: ${cat}, ${desc ? 'desc: ' + desc : 'no description'}${hasImage ? ', has image' : ''}`;
  }).join('\n');

  const templateList = LANDING_TEMPLATES.map(t => `- ${t.id}: ${t.name} (${t.mood}) — best for: ${t.best_for}`).join('\n');

  const langInstructions = {
    ar: 'CRITICAL: Write ALL text content in clear, natural Modern Standard Arabic (فصحى). Hero title, subtitle, headlines, features, CTA — every single text field MUST be in Arabic. Use ONLY Arabic letters, Arabic punctuation, and standard numbers. Do NOT include ANY Chinese, Japanese, Korean, or other non-Arabic/non-Latin characters. Do NOT mix in English or French words. Do NOT add extra spaces between Arabic letters. Every word must be a real, complete Arabic word.',
    fr: 'Write ALL text content in French. Hero title, subtitle, headlines, features, CTA — everything in French.',
    en: 'Write ALL text content in English.',
  };

  const prompt = `You are an expert landing page designer and copywriter. Analyze these products and generate a complete, unique landing page configuration.

PRODUCTS:
${productSummary}

STORE: "${store.name || store.store_name}" (${store.currency || 'DZD'})

AVAILABLE LAYOUT TEMPLATES:
${templateList}

${langInstructions[language] || langInstructions.en}

YOUR TASK:
1. Analyze the products — what category, price range, target audience, mood
2. Pick the BEST layout template from the list above that matches these products
3. Pick a hero_style: "centered" | "split" | "minimal"
4. Pick an animation_style: "fade" | "slide-up" | "zoom"
5. Generate a color palette that matches the product mood (6 hex colors)
6. Write compelling hero copy (title + subtitle)
7. Write a unique headline, description, and 3 key features for EACH product
8. Write CTA button text
9. Decide which extra sections to show: trust_badges, social_proof, countdown, reviews

Return ONLY valid JSON (no markdown, no backticks):
{
  "layout_style": "template_id",
  "hero_style": "centered|split|minimal",
  "animation_style": "fade|slide-up|zoom",
  "hero_title": "compelling headline",
  "hero_subtitle": "supporting text, 1-2 sentences",
  "cta_text": "action button text",
  "colors": {
    "hero_bg": "#hex",
    "hero_text": "#hex",
    "cta_bg": "#hex",
    "cta_text_color": "#hex",
    "bg_color": "#hex",
    "accent_color": "#hex"
  },
  "show_trust_badges": true,
  "show_social_proof": true,
  "show_countdown": false,
  "show_reviews": true,
  "products": [
    {
      "headline": "attention-grabbing headline",
      "description": "2-3 sentence selling description",
      "features": ["feature 1", "feature 2", "feature 3"]
    }
  ],
  "page_mood": "one word describing the overall mood",
  "reasoning": "1 sentence on why you chose this template"
}`;

  // Extract the first balanced {...} JSON object from raw text
  const extractJson = (raw) => {
    if (!raw) return null;
    const s = raw.replace(/```json|```/g, '');
    const start = s.indexOf('{');
    if (start === -1) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) return s.slice(start, i + 1); }
    }
    return null;
  };

  const validLayouts = LANDING_TEMPLATES.map(t => t.id);

  // Try up to 2 times — Arabic generation sometimes returns malformed/empty JSON
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await aiGenerate(prompt, 1500);
    if (!result) continue;
    const clean = extractJson(result);
    if (!clean) { console.log('[AI] Landing: no JSON found, attempt', attempt + 1); continue; }
    try {
      const parsed = JSON.parse(clean);
      if (!validLayouts.includes(parsed.layout_style)) parsed.layout_style = 'alternating';
      // Sanitize Arabic text fields to remove stray non-Arabic characters
      if (language === 'ar') {
        const sanitizeStr = (v) => typeof v === 'string' ? sanitizeArabic(v) : v;
        if (parsed.hero_title) parsed.hero_title = sanitizeStr(parsed.hero_title);
        if (parsed.hero_subtitle) parsed.hero_subtitle = sanitizeStr(parsed.hero_subtitle);
        if (parsed.cta_text) parsed.cta_text = sanitizeStr(parsed.cta_text);
        if (Array.isArray(parsed.products)) {
          parsed.products = parsed.products.map(p => ({
            ...p,
            headline: sanitizeStr(p.headline),
            description: sanitizeStr(p.description),
            features: Array.isArray(p.features) ? p.features.map(sanitizeStr) : p.features,
          }));
        }
      }
      return parsed;
    } catch (e) {
      console.log('[AI] Landing page parse error (attempt', attempt + 1, '):', e.message);
    }
  }
  return null;
}

// ═══ PREMIUM DESIGN-SYSTEM CSS ═══
// A hand-crafted, agency-grade stylesheet injected into EVERY AI landing page.
// GPT only supplies the theme variables (colors + fonts) and semantic markup
// using these classes — this guarantees a polished, professional result every
// time instead of depending on GPT to free-hand good CSS. Everything is scoped
// under .ai-lp so it never leaks into the host app.
const LP_BASE_CSS = `
.ai-lp{--lp-primary:#4f46e5;--lp-primary-d:#3730a3;--lp-accent:#f59e0b;--lp-bg:#0b1020;--lp-surface:#ffffff;--lp-ink:#0f172a;--lp-muted:#64748b;--lp-line:#e6e8f0;--lp-radius:22px;--lp-shadow:0 10px 30px -12px rgba(15,23,42,.18),0 30px 60px -30px rgba(15,23,42,.22);--lp-font-display:'Outfit',system-ui,sans-serif;--lp-font-body:'DM Sans',system-ui,sans-serif;color:var(--lp-ink);font-family:var(--lp-font-body);line-height:1.6;-webkit-font-smoothing:antialiased;background:#f7f8fc;overflow-x:hidden}
.ai-lp *{box-sizing:border-box;margin:0;padding:0}
.ai-lp img{max-width:100%;display:block}
.ai-lp[dir=rtl]{text-align:right}
.ai-lp .lp-wrap{max-width:1080px;margin:0 auto;padding:0 20px}
.ai-lp .lp-section{position:relative;padding:64px 0}
.ai-lp .lp-bar{background:linear-gradient(90deg,var(--lp-primary),var(--lp-primary-d));color:#fff;text-align:center;font-weight:700;font-size:14px;letter-spacing:.2px;padding:11px 16px}
.ai-lp .lp-eyebrow{display:inline-block;font-family:var(--lp-font-display);font-weight:800;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:var(--lp-primary);background:color-mix(in srgb,var(--lp-primary) 12%,#fff);padding:7px 14px;border-radius:999px;margin-bottom:16px}
.ai-lp .lp-title{font-family:var(--lp-font-display);font-weight:900;font-size:clamp(30px,6vw,56px);line-height:1.05;letter-spacing:-.02em}
.ai-lp .lp-h2{font-family:var(--lp-font-display);font-weight:850;font-size:clamp(24px,4.5vw,40px);line-height:1.12;letter-spacing:-.01em;text-align:center}
.ai-lp .lp-h3{font-family:var(--lp-font-display);font-weight:800;font-size:20px;line-height:1.2}
.ai-lp .lp-lead{font-size:clamp(16px,2.2vw,20px);color:var(--lp-muted);margin-top:14px;max-width:60ch}
.ai-lp .lp-sub{font-size:16px;color:var(--lp-muted);text-align:center;max-width:56ch;margin:14px auto 0}
.ai-lp .lp-center{text-align:center}
/* HERO */
.ai-lp .lp-hero{position:relative;background:radial-gradient(120% 120% at 80% 0%,color-mix(in srgb,var(--lp-primary) 16%,#fff),#fff 60%);overflow:hidden}
.ai-lp .lp-hero-grid{display:grid;grid-template-columns:1.05fr 1fr;gap:48px;align-items:center;padding:56px 0 64px}
.ai-lp .lp-hero-img{border-radius:var(--lp-radius);box-shadow:var(--lp-shadow);width:100%;object-fit:cover;aspect-ratio:4/3;background:#eef1f8}
.ai-lp .lp-pricing{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin:22px 0}
.ai-lp .lp-price{font-family:var(--lp-font-display);font-weight:900;font-size:clamp(30px,6vw,46px);color:var(--lp-primary-d)}
.ai-lp .lp-was{font-size:20px;color:var(--lp-muted);text-decoration:line-through}
.ai-lp .lp-off{background:var(--lp-accent);color:#1a1300;font-weight:800;font-size:13px;padding:6px 12px;border-radius:999px}
/* BUTTONS */
.ai-lp .lp-btn{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:10px;font-family:var(--lp-font-display);font-weight:800;font-size:clamp(16px,2.4vw,19px);color:#fff;background:linear-gradient(135deg,var(--lp-primary),var(--lp-primary-d));border:0;cursor:pointer;padding:18px 34px;border-radius:999px;box-shadow:0 14px 30px -10px color-mix(in srgb,var(--lp-primary) 70%,transparent);transition:transform .18s,box-shadow .18s,filter .18s;overflow:hidden;text-align:center;width:auto}
.ai-lp .lp-btn:hover{transform:translateY(-2px);filter:brightness(1.06);box-shadow:0 22px 44px -12px color-mix(in srgb,var(--lp-primary) 75%,transparent)}
.ai-lp .lp-btn:active{transform:translateY(0)}
.ai-lp .lp-btn::after{content:"";position:absolute;top:0;left:-130%;width:60%;height:100%;background:linear-gradient(100deg,transparent,rgba(255,255,255,.45),transparent);transform:skewX(-18deg);animation:lp-shine 3.2s infinite}
@keyframes lp-shine{0%,60%{left:-130%}100%{left:160%}}
.ai-lp .lp-btn-xl{padding:22px 46px;font-size:clamp(18px,3vw,22px)}
.ai-lp .lp-cta-note{display:block;font-size:13px;color:var(--lp-muted);margin-top:10px;font-weight:600}
/* CHIPS */
.ai-lp .lp-chips{display:flex;flex-wrap:wrap;gap:10px;margin-top:22px}
.ai-lp .lp-chip{display:inline-flex;align-items:center;gap:7px;background:#fff;border:1px solid var(--lp-line);color:var(--lp-ink);font-weight:700;font-size:13px;padding:9px 14px;border-radius:999px;box-shadow:0 4px 12px -8px rgba(15,23,42,.25)}
.ai-lp .lp-chip svg{width:16px;height:16px;color:var(--lp-primary)}
/* GRID + CARDS */
.ai-lp .lp-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:20px}
.ai-lp .lp-grid-2{display:grid;grid-template-columns:1fr 1fr;gap:20px}
.ai-lp .lp-card{background:var(--lp-surface);border:1px solid var(--lp-line);border-radius:var(--lp-radius);padding:26px;box-shadow:0 6px 24px -16px rgba(15,23,42,.3);transition:transform .2s,box-shadow .2s;height:100%}
.ai-lp .lp-card:hover{transform:translateY(-5px);box-shadow:var(--lp-shadow)}
.ai-lp .lp-icn{width:52px;height:52px;display:grid;place-items:center;border-radius:15px;background:linear-gradient(135deg,color-mix(in srgb,var(--lp-primary) 18%,#fff),color-mix(in srgb,var(--lp-accent) 18%,#fff));color:var(--lp-primary-d);margin-bottom:16px}
.ai-lp .lp-icn svg{width:26px;height:26px}
.ai-lp .lp-card h3{font-family:var(--lp-font-display);font-weight:800;font-size:18px;margin-bottom:8px}
.ai-lp .lp-card p{color:var(--lp-muted);font-size:15px}
/* FEATURE ROWS */
.ai-lp .lp-feature{display:grid;grid-template-columns:1fr 1fr;gap:44px;align-items:center;margin-top:36px}
.ai-lp .lp-feature.rev>*:first-child{order:2}
.ai-lp .lp-feature-media{border-radius:var(--lp-radius);overflow:hidden;box-shadow:var(--lp-shadow);aspect-ratio:4/3;background:linear-gradient(135deg,color-mix(in srgb,var(--lp-primary) 14%,#fff),color-mix(in srgb,var(--lp-accent) 14%,#fff))}
.ai-lp .lp-feature-media img{width:100%;height:100%;object-fit:cover}
.ai-lp .lp-checks{list-style:none;margin-top:18px;display:grid;gap:12px}
.ai-lp .lp-checks li{display:flex;gap:12px;align-items:flex-start;font-size:16px;font-weight:600}
.ai-lp .lp-checks li::before{content:"";flex:none;width:24px;height:24px;border-radius:50%;background:var(--lp-primary) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='3.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='20 6 9 17 4 12'/%3E%3C/svg%3E") center/15px no-repeat;margin-top:1px}
/* SOCIAL PROOF */
.ai-lp .lp-stars{display:inline-flex;gap:3px;color:var(--lp-accent)}
.ai-lp .lp-stars svg{width:20px;height:20px;fill:currentColor}
.ai-lp .lp-quote{background:var(--lp-surface);border:1px solid var(--lp-line);border-radius:var(--lp-radius);padding:24px;box-shadow:0 6px 24px -16px rgba(15,23,42,.3)}
.ai-lp .lp-quote p{font-size:15px;color:var(--lp-ink);margin:12px 0 16px}
.ai-lp .lp-who{display:flex;align-items:center;gap:12px}
.ai-lp .lp-ava{width:44px;height:44px;border-radius:50%;display:grid;place-items:center;font-weight:800;color:#fff;font-family:var(--lp-font-display);background:linear-gradient(135deg,var(--lp-primary),var(--lp-accent))}
.ai-lp .lp-who b{font-family:var(--lp-font-display);font-size:15px}
.ai-lp .lp-who span{font-size:13px;color:var(--lp-muted)}
/* TRUST */
.ai-lp .lp-trust{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:16px;text-align:center}
.ai-lp .lp-trust>div{padding:22px 14px}
.ai-lp .lp-trust .lp-icn{margin:0 auto 12px}
.ai-lp .lp-trust b{font-family:var(--lp-font-display);display:block;font-size:15px;margin-bottom:4px}
.ai-lp .lp-trust span{font-size:13px;color:var(--lp-muted)}
/* FINAL CTA */
.ai-lp .lp-final{background:linear-gradient(135deg,var(--lp-primary),var(--lp-primary-d));color:#fff;text-align:center;border-radius:var(--lp-radius);padding:56px 24px;box-shadow:var(--lp-shadow);position:relative;overflow:hidden}
.ai-lp .lp-final .lp-h2,.ai-lp .lp-final p{color:#fff}
.ai-lp .lp-final .lp-btn{background:#fff;color:var(--lp-primary-d)}
.ai-lp .lp-final .lp-btn::after{background:linear-gradient(100deg,transparent,rgba(79,70,229,.18),transparent)}
/* DECOR + ANIMATION */
.ai-lp .lp-blob{position:absolute;border-radius:50%;filter:blur(60px);opacity:.5;z-index:0;pointer-events:none}
.ai-lp .lp-section>.lp-wrap{position:relative;z-index:1}
@media (prefers-reduced-motion:no-preference){
 .ai-lp .lp-section,.ai-lp .lp-card,.ai-lp .lp-feature{animation:lp-rise .7s both;animation-timeline:view();animation-range:entry 0% cover 28%}
}
@keyframes lp-rise{from{opacity:0;transform:translateY(34px)}to{opacity:1;transform:none}}
/* RESPONSIVE */
@media (max-width:860px){
 .ai-lp .lp-hero-grid{grid-template-columns:1fr;gap:30px;text-align:center}
 .ai-lp .lp-hero-grid .lp-chips,.ai-lp .lp-hero-grid .lp-pricing{justify-content:center}
 .ai-lp .lp-feature,.ai-lp .lp-grid-2{grid-template-columns:1fr;gap:26px}
 .ai-lp .lp-feature.rev>*:first-child{order:0}
 .ai-lp .lp-section{padding:48px 0}
 .ai-lp .lp-btn{width:100%}
}`.replace(/\n\s*/g, '\n').trim();

// ═══ FULL AI LANDING PAGE (HTML from scratch, no templates) ═══
// Uses GPT to design a complete, bespoke, conversion-optimized HTML marketing
// page for the given products. GPT picks the theme + writes the content/markup;
// a premium injected stylesheet (LP_BASE_CSS) guarantees the polish. Returns a
// self-contained HTML fragment the buyer renderer mounts directly. The functional
// order form, reviews and footer are still rendered by React around it.
async function generateLandingHTML(products, store, language = 'en') {
  const currency = store.currency || 'DZD';
  const productLines = products.slice(0, 8).map((p, i) => {
    const name = p.name_ar && language === 'ar' ? p.name_ar : (p.name_fr && language === 'fr' ? p.name_fr : (p.name_en || p.name || 'Product'));
    const price = p.price || 0;
    const compare = p.compare_at_price || p.compare_price || 0;
    const cat = p.category_name || p.category || 'General';
    const desc = (p.description_ar && language === 'ar' ? p.description_ar : (p.description_en || p.description || '')).substring(0, 200);
    const imgs = (Array.isArray(p.images) ? p.images : []).filter(Boolean);
    const img = imgs[0] || p.thumbnail || p.image || '';
    const pid = p.product_id || p.id || '';
    // Product images can be huge base64 blobs. Give the model a SHORT token to
    // reference instead, and inject the real image once after generation — so the
    // page never bloats with repeated multi-KB image data (which broke saves).
    return `Product ${i + 1}:
  id: ${pid}
  name: ${name}
  price: ${price} ${currency}${compare && compare > price ? ` (was ${compare} ${currency})` : ''}
  category: ${cat}
  description: ${desc || 'n/a'}
  image_token: ${img ? `{{P${i}}}` : 'none'}`;
  }).join('\n\n');
  // token -> real image url/data, for post-generation injection
  const productImages = products.slice(0, 8).map(p => {
    const imgs = (Array.isArray(p.images) ? p.images : []).filter(Boolean);
    return imgs[0] || p.thumbnail || p.image || '';
  });

  const langRule = {
    ar: 'Write ALL visible text in clear, natural Modern Standard Arabic (فصحى). Set dir="rtl" on the root wrapper. Use ONLY Arabic letters, Arabic punctuation and standard numbers — NO Chinese/Japanese/Korean characters, no random Latin words.',
    fr: 'Write ALL visible text in natural, persuasive French.',
    en: 'Write ALL visible text in natural, persuasive English.',
  }[language] || 'Write ALL visible text in English.';

  const systemPrompt = `You are an elite direct-response landing-page designer who builds the high-converting single-product "COD" (cash-on-delivery) pages advertised on Facebook/Instagram across Algeria and the MENA region — bold hero, benefit cards, feature deep-dives, social proof, urgency. You output clean, semantic HTML that hooks into a PROVIDED premium design system (a stylesheet is injected for you), so you NEVER need to write good CSS yourself — you focus on art direction (theme colors + fonts), structure, persuasive copy, hand-drawn inline-SVG icons, and rich AI-generated photography. Every page is uniquely themed around the actual product. You never use icon fonts, emoji-as-icons, or external image/icon URLs.`;

  const prompt = `Build a COMPLETE, premium, conversion-optimized PRODUCT landing page for the product(s) below. It must look like a real agency-built Facebook-ad COD landing page (think: bold hero with the product, colorful benefit cards each with an icon, alternating feature spotlights with checklists, lifestyle photography, star-rated testimonials, trust badges, strong final CTA).

STORE: "${store.name || store.store_name}" — currency ${currency}, Algeria (Cash on Delivery, delivery to all 58 wilayas).

PRODUCT(S):
${productLines}

LANGUAGE: ${langRule}

═══ A DESIGN SYSTEM IS ALREADY INJECTED FOR YOU ═══
A complete premium stylesheet is added automatically. DO NOT redefine these classes. Just USE them so the page looks professional. You MUST build the page from these building blocks (you may add EXTRA inline SVG and decorative <div class="lp-blob"> elements, and a SMALL optional <style> only for tiny per-product flourishes — never restyle the core classes):

THEME (required, first thing): set the palette + fonts by putting CSS variables in the wrapper's style attribute, and @import the Google Fonts you choose in a <style> block. Pick a palette + font pairing that MATCHES the product mood (tech=dark/electric, beauty=warm/elegant, food=fresh, kids=playful):
<div class="ai-lp" dir="${language === 'ar' ? 'rtl' : 'ltr'}" style="--lp-primary:#XXXXXX;--lp-primary-d:#XXXXXX;--lp-accent:#XXXXXX;--lp-font-display:'DisplayFont';--lp-font-body:'BodyFont'">
  <style>@import url('https://fonts.googleapis.com/css2?family=DisplayFont:wght@700;800;900&family=BodyFont:wght@400;500;700&display=swap');</style>
  ...sections...
</div>

CLASS TOOLKIT:
- Announcement bar: <div class="lp-bar">…</div>
- Section: <section class="lp-section"><div class="lp-wrap">…</div></section> (add <div class="lp-blob" style="...background;width;height;top;left"></div> inside a section for depth)
- Hero: <section class="lp-hero"><div class="lp-wrap"><div class="lp-hero-grid"><div>…copy…</div><div><img class="lp-hero-img" src="{{P0}}" alt=".."></div></div></div></section>
- Eyebrow/labels: <span class="lp-eyebrow">…</span> · Headlines: class="lp-title" (hero), "lp-h2" (section), "lp-h3" · Body: "lp-lead", "lp-sub", "lp-center"
- Price: <div class="lp-pricing"><span class="lp-price">1200 ${currency}</span><span class="lp-was">1800 ${currency}</span><span class="lp-off">-33%</span></div>
- CTA button (REQUIRED format): <button class="lp-btn lp-btn-xl" data-order data-add-product="PRODUCT_ID">اطلب الآن<span class="lp-cta-note">price • COD</span></button>
- Trust chips: <div class="lp-chips"><span class="lp-chip"><svg .../>text</span>…</div>
- Benefit cards: <div class="lp-grid"><div class="lp-card"><div class="lp-icn"><svg…/></div><h3>title</h3><p>desc</p></div>… (4–6 cards)</div>
- Feature spotlight: <div class="lp-feature"><div>…lp-h3 + <ul class="lp-checks"><li>point</li>…</ul></div><div class="lp-feature-media"><img src="{{AI_IMG:…}}"></div></div> (add class "rev" to alternate sides)
- Testimonials: <div class="lp-grid"><div class="lp-quote"><div class="lp-stars">5×star svg</div><p>review</p><div class="lp-who"><div class="lp-ava">A</div><div><b>Name</b><span>Wilaya</span></div></div></div>…</div>
- Trust row: <div class="lp-trust"><div><div class="lp-icn"><svg/></div><b>title</b><span>desc</span></div>…</div>
- Final CTA: <section class="lp-section"><div class="lp-wrap"><div class="lp-final"><h2 class="lp-h2">…</h2><p>…</p><button class="lp-btn lp-btn-xl">…</button></div></div></section>

═══ IMAGES (REQUIRED — the page must be photographic) ═══
- HERO: use the real product photo <img class="lp-hero-img" src="{{P0}}"> (if image_token is "none", use {{AI_IMG:…}} of the product instead).
- You MUST also include EXACTLY 3 AI-generated photos via <img src="{{AI_IMG: detailed English photography brief}}">: one in a feature spotlight (the product in a real-life setting), one "lifestyle/in-use" scene, and one quality/atmosphere shot. Each brief = subject + setting + lighting + mood + camera angle, matching the theme colors. NO text/logos/watermarks in the image. Do NOT request more than 3.
- Every other icon/graphic = inline SVG. No external image URLs ever.

REQUIRED SECTIONS IN ORDER: 1) announcement bar  2) hero (with product photo, name, value prop, price, CTA, trust chips)  3) benefits grid (4–6 icon cards)  4) two feature spotlights (alternating, with checklists + an AI lifestyle photo each)  5) a "why choose us"/quality section (with the 3rd AI photo)  6) social proof (overall rating + 3 testimonials, realistic Algerian names + wilayas)  7) trust row (COD, 58 wilayas delivery, warranty, secure)  8) final CTA.

HARD RULES:
1. Return ONLY raw HTML — no markdown, no \`\`\` fences, no commentary.
2. The single root element is the <div class="ai-lp" …> shown above. Do NOT redefine the toolkit classes; only set theme vars + @import fonts + tiny flourishes.
3. EVERY CTA is a <button class="lp-btn …" data-order data-add-product="EXACT_PRODUCT_ID">…</button>. No href/onclick. Show the real price; struck-through "was" price + discount badge when present.
4. Use {{P0}} for the real product photo ONCE (hero only). Use exactly 3 {{AI_IMG:…}} photos. Inline SVG for everything else.
5. Do NOT include the order form, inputs, <html>/<head>/<body>, nav, or footer — the host app renders those.

Write rich, persuasive, product-specific copy (no lorem, no placeholders). Return the HTML now.`;

  // GPT ONLY — the landing page must be generated by OpenAI's GPT, never by any
  // other provider. We do NOT fall back to Groq/Gemini here.
  if (!OPENAI_KEY) return { error: 'no_provider' };

  let raw = null, usedModel = null;
  const r = await openaiCall(systemPrompt, [{ role: 'user', text: prompt }], 12000);
  if (r?.text) { raw = r.text; usedModel = r.model; }
  // If OpenAI failed (bad key, quota, timeout), report the real reason — the
  // user explicitly wants GPT-quality pages and no other AI.
  else return { error: 'openai_failed', detail: lastOpenAIError };
  if (!raw) { console.log('[AI] LandingHTML: OpenAI returned nothing'); return { error: 'provider_failed' }; }

  // Strip markdown fences / any prose around the markup.
  let html = raw.replace(/```html|```/gi, '').trim();
  const wrap = html.indexOf('<div class="ai-lp"');
  if (wrap > 0) html = html.slice(wrap);
  // If the model ignored the wrapper instruction but still returned markup,
  // wrap it ourselves rather than failing the whole request.
  if (!/class="ai-lp"/.test(html)) {
    const firstTag = html.search(/<(section|div|main|header|style|h1|h2)/i);
    if (firstTag === -1) { console.log('[AI] LandingHTML: no HTML in output'); return { error: 'no_html' }; }
    html = `<div class="ai-lp">${html.slice(firstTag)}</div>`;
  }

  // Inject the premium design-system stylesheet as the FIRST child of the .ai-lp
  // wrapper, so the page is guaranteed to look polished regardless of how much
  // CSS the model wrote. The model's own <style> (theme vars / fonts / flourishes)
  // comes after and can fine-tune, but never replaces the core look.
  html = html.replace(/(<div\b[^>]*class="ai-lp"[^>]*>)/i, `$1<style>${LP_BASE_CSS}</style>`);

  // Inject the real product image(s) where the model used the short {{Pi}} tokens.
  // The FIRST use of each token gets the real image; any extra uses get a tiny
  // gradient placeholder — so even a big base64 product photo is embedded only
  // ONCE and the page can never bloat enough to break the save.
  const gradientPx = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='12'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%23e9e9ef'/%3E%3Cstop offset='1' stop-color='%23d7d7e0'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='16' height='12' fill='url(%23g)'/%3E%3C/svg%3E";
  productImages.forEach((img, i) => {
    const tok = `{{P${i}}}`;
    let used = false;
    while (html.includes(tok)) {
      const rep = (!used && img) ? img : gradientPx;
      used = true;
      html = html.replace(tok, () => rep); // function form: avoids $-pattern issues
    }
  });
  // {{AI_HERO}} (legacy) -> first product image or gradient.
  if (html.includes('{{AI_HERO}}')) {
    const heroImg = productImages.find(Boolean) || gradientPx;
    html = html.split('{{AI_HERO}}').join(heroImg);
  }

  // ═══ GPT-GENERATED IMAGERY ═══
  // The model places <img src="{{AI_IMG: <prompt> }}"> tokens where it wants
  // bespoke photographic visuals. Generate each one with OpenAI's image model
  // (gpt-image-1 → DALL·E 3) and inject the result. GPT ONLY — no other AI.
  let imageModel = null;
  const aiImgRe = /\{\{\s*AI_IMG\s*:\s*([\s\S]*?)\}\}/g;
  const wantedPrompts = [];
  let m;
  while ((m = aiImgRe.exec(html)) !== null) {
    const p = (m[1] || '').trim();
    if (p) wantedPrompts.push(p);
  }
  if (wantedPrompts.length && OPENAI_KEY) {
    // Cap at 3 unique prompts — image generation is slow and costly.
    const unique = [...new Set(wantedPrompts)].slice(0, 3);
    console.log(`[AI] LandingHTML: generating ${unique.length} image(s)…`);
    const style = 'high-end commercial advertising photography, photorealistic, professional studio lighting, shallow depth of field, crisp detail, vibrant, no text, no captions, no logos, no watermark';
    const results = await Promise.all(unique.map(async (p) => {
      try { return await openaiImage(`${p}. ${style}`, '1536x1024'); }
      catch (e) { console.log('[AI] image error:', e.message); return null; }
    }));
    const okCount = results.filter(Boolean).length;
    console.log(`[AI] LandingHTML: ${okCount}/${unique.length} image(s) generated`);
    const map = {};
    unique.forEach((p, i) => { map[p] = results[i]; if (results[i]) imageModel = imageModel || 'gpt-image'; });
    // Replace every token: the prompt we generated -> data URI; anything we could
    // not generate (or extra duplicates beyond the cap) -> gradient placeholder.
    html = html.replace(/\{\{\s*AI_IMG\s*:\s*([\s\S]*?)\}\}/g, (_full, raw) => {
      const key = (raw || '').trim();
      return map[key] || gradientPx;
    });
  } else if (wantedPrompts.length) {
    // No key to generate — strip tokens to a gradient so the page still renders.
    html = html.replace(/\{\{\s*AI_IMG\s*:\s*([\s\S]*?)\}\}/g, () => gradientPx);
  }

  // Final safety net: only if the page is catastrophically large (e.g. the model
  // duplicated a base64 blob many times) do we drop embedded images. Real pages
  // with the product photo + up to 3 generated images stay well under this.
  if (html.length > 32000000) html = html.replace(/<img[^>]*src="data:image\/(png|jpe?g|webp)[^>]*>/g, '');
  return { html, model: usedModel || 'ai', imageModel };
}

// Live check: does the configured OpenAI key actually work right now?
function checkOpenAI() {
  return new Promise((resolve) => {
    if (!OPENAI_KEY) return resolve({ ok: false, reason: 'no_key' });
    const body = JSON.stringify({ model: OPENAI_MODEL, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 });
    const req = https.request({
      hostname: 'api.openai.com', path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Length': Buffer.byteLength(body) },
      timeout: 15000,
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode === 200) return resolve({ ok: true, model: OPENAI_MODEL });
        let msg = String(res.statusCode); try { msg = JSON.parse(d).error?.message || msg; } catch {}
        resolve({ ok: false, status: res.statusCode, error: msg, model: OPENAI_MODEL });
      });
    });
    req.on('error', e => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.write(body); req.end();
  });
}

function isConfigured() { return !!(OPENAI_KEY || GROQ_KEY || GEMINI_KEY); }

// Which providers are live + which is the active (preferred) one
function providerStatus() {
  const providers = {
    openai: { configured: !!OPENAI_KEY, model: OPENAI_MODEL },
    groq: { configured: !!GROQ_KEY, model: 'llama-3.1-8b-instant' },
    gemini: { configured: !!GEMINI_KEY, model: 'gemini-2.0-flash' },
  };
  const active = OPENAI_KEY ? 'openai' : GROQ_KEY ? 'groq' : GEMINI_KEY ? 'gemini' : null;
  return { configured: isConfigured(), active, providers };
}

module.exports = { chat, detectFakeOrder, isConfigured, providerStatus, checkOpenAI, geminiCall: aiGenerate, generateProductDescription, generateCartRecoveryMessage, moderateReview, generateLandingPage, generateLandingHTML, generateImage: openaiImage };
