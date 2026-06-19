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
      timeout: maxTokens > 800 ? 30000 : 12000,
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

// ═══ FULL AI LANDING PAGE (HTML from scratch, no templates) ═══
// Uses GPT to design a complete, bespoke, conversion-optimized HTML marketing
// page for the given products. Returns a self-contained HTML fragment (scoped
// <style> + markup) that the buyer renderer mounts directly. The functional
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
    return `Product ${i + 1}:
  id: ${pid}
  name: ${name}
  price: ${price} ${currency}${compare && compare > price ? ` (was ${compare} ${currency})` : ''}
  category: ${cat}
  description: ${desc || 'n/a'}
  image_urls: ${imgs.length ? imgs.join(' | ') : (img || 'none')}`;
  }).join('\n\n');

  const langRule = {
    ar: 'Write ALL visible text in clear, natural Modern Standard Arabic (فصحى). Set dir="rtl" on the root wrapper. Use ONLY Arabic letters, Arabic punctuation and standard numbers — NO Chinese/Japanese/Korean characters, no random Latin words.',
    fr: 'Write ALL visible text in natural, persuasive French.',
    en: 'Write ALL visible text in natural, persuasive English.',
  }[language] || 'Write ALL visible text in English.';

  const systemPrompt = `You are a world-class direct-response landing page designer and front-end developer. You produce stunning, modern, high-converting product landing pages as a single self-contained HTML fragment. You never use templates — every page is uniquely designed around the specific products.`;

  const prompt = `Design a COMPLETE, beautiful, conversion-optimized landing page for this store, from scratch.

STORE: "${store.name || store.store_name}" — currency ${currency}, Algeria (delivery to all 58 wilayas, Cash on Delivery available).

PRODUCTS:
${productLines}

LANGUAGE RULE: ${langRule}

OUTPUT REQUIREMENTS (follow EXACTLY):
1. Return ONLY raw HTML. No markdown, no \`\`\` fences, no explanation before or after.
2. Wrap EVERYTHING in a single <div class="ai-lp">...</div> root element.
3. Include ONE <style> block as the first child of .ai-lp. EVERY CSS selector MUST be prefixed with .ai-lp (e.g. ".ai-lp .hero{...}") so styles never leak. Do NOT style html/body/* globally. Use unique, descriptive class names.
4. Use modern, premium CSS: gradients, soft shadows, rounded corners, good typography scale, generous spacing, subtle CSS keyframe animations, hover states. Must be fully responsive (mobile-first) using media queries and fl/grid. Use system fonts.
5. Use the REAL product image_urls provided above in <img> tags (object-fit:cover). If a product has no image, use a tasteful colored placeholder block instead — never a broken image.
6. Structure the page with rich sections: a striking hero, product showcase(s) with images/price/benefits, a "why choose us" / features grid, trust signals (Cash on Delivery, fast 58-wilaya delivery, quality guarantee), social proof / testimonials (invent realistic Algerian first names), an urgency/limited-offer element, and a closing call-to-action. Make it feel bespoke to these products.
7. EVERY call-to-action button (hero CTA, per-product buy buttons, final CTA) MUST be a <button> with the attribute data-order. For a button that should also add a specific product to the cart, additionally add data-add-product="THE_PRODUCT_ID" using the exact id from above. These attributes let the host app open the order form and add the product — do not add href or onclick.
8. Do NOT include: the order/checkout form, input fields, <html>, <head>, <body>, navigation bars, or a footer — the host app provides those. Just the marketing content inside .ai-lp.
9. Show real prices from the data. If a product has a "was" price, display it struck-through next to the current price.

Return the HTML fragment now.`;

  if (!isConfigured()) return { error: 'no_provider' };

  let raw = null, usedModel = null;
  if (OPENAI_KEY) {
    const r = await openaiCall(systemPrompt, [{ role: 'user', text: prompt }], 5000);
    if (r?.text) { raw = r.text; usedModel = r.model; }
    // If OpenAI is configured but failed (bad key, quota, timeout), report the
    // real reason instead of silently serving a weaker fallback model — the
    // user explicitly wants GPT-quality pages.
    else return { error: 'openai_failed', detail: lastOpenAIError };
  }
  if (!raw && GROQ_KEY) {
    const r = await groqCall(systemPrompt, [{ role: 'user', text: prompt }], 5000);
    if (r?.text) { raw = r.text; usedModel = r.model; }
  }
  if (!raw && GEMINI_KEY) {
    const r = await geminiCall(`${systemPrompt}\n\n${prompt}`, 5000);
    if (r?.text) { raw = r.text; usedModel = r.model; }
  }
  if (!raw) { console.log('[AI] LandingHTML: all providers returned nothing'); return { error: 'provider_failed' }; }

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
  return { html, model: usedModel || 'ai' };
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

module.exports = { chat, detectFakeOrder, isConfigured, providerStatus, checkOpenAI, geminiCall: aiGenerate, generateProductDescription, generateCartRecoveryMessage, moderateReview, generateLandingPage, generateLandingHTML };
