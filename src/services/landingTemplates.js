// ═══ LANDING PAGE TEMPLATE ENGINE ═══
// GPT supplies only the COPY (structured JSON); this renders it into one of ~40
// polished templates, chosen by the product's category/mood. Reliable HTML (no
// GPT-authored markup), fast pages, real product photos shown crisp in clean
// frames — never pasted onto an AI scene. AI imagery (optional) appears as a
// separate full-width "mood band". Uses the LP_BASE_CSS classes from chatbot.js.

const ICONS = {
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2 4 5v6c0 5 3.5 8 8 11 4.5-3 8-6 8-11V5z"/></svg>',
  truck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7h13v10H3z"/><path d="M16 10h4l1 3v4h-5"/><circle cx="7" cy="18" r="2"/><circle cx="18" cy="18" r="2"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2 3 14h7l-1 8 10-12h-7z"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l3 7h7l-5.5 4 2 7L12 16l-6.5 4 2-7L2 9h7z"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1L12 21l7.7-7.5 1.1-1a5.5 5.5 0 0 0 0-7.9z"/></svg>',
  gift: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="8" width="18" height="4"/><path d="M12 8v13M5 12v9h14v-9"/><path d="M12 8C12 4 8 4 8 6s4 2 4 2zM12 8c0-4 4-4 4-2s-4 2-4 2z"/></svg>',
  spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  badge: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="9" r="6"/><path d="M9 14l-2 7 5-3 5 3-2-7"/></svg>',
  cash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/></svg>',
  sparkles: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 4l1.6 4.4L18 10l-4.4 1.6L12 16l-1.6-4.4L6 10l4.4-1.6z"/></svg>',
};
const BENEFIT_ICONS = ['bolt', 'shield', 'star', 'spark', 'heart', 'eye', 'clock', 'sparkles'];

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function money(v, cur) { return `${esc(v)} ${esc(cur)}`; }

const TXT = {
  ar: { orderNow: 'اطلب الآن', cod: 'الدفع عند الاستلام', deliver: 'توصيل لكل الولايات', fast: 'توصيل سريع', why: 'لماذا تختار هذا المنتج', features: 'المميزات', faq: 'أسئلة شائعة', howTo: 'كيف تطلب', steps: ['اختر المنتج', 'أدخل معلوماتك', 'استلم وادفع'], stepsD: ['اختر المنتج والكمية التي تناسبك', 'املأ الاسم ورقم الهاتف والولاية', 'يصلك المنتج وتدفع عند الاستلام'], q1: 'كم تستغرق مدة التوصيل؟', a1: 'عادة من 2 إلى 5 أيام حسب الولاية.', q2: 'هل الدفع عند الاستلام متاح؟', a2: 'نعم، تدفع فقط عند استلام المنتج ومعاينته.', q3: 'هل التوصيل متاح لكل الولايات؟', a3: 'نعم، نوصّل إلى كل ولايات الجزائر الـ58.', codTitle: 'الدفع عند الاستلام لكل الولايات', codDesc: 'افحص المنتج عند وصوله ثم ادفع — توصيل سريع وآمن إلى باب منزلك.', getToday: 'احصل عليه اليوم', limited: 'الكمية محدودة — اطلب الآن.', available: 'المتوفر' },
  fr: { orderNow: 'Commander', cod: 'Paiement à la livraison', deliver: 'Livraison toutes wilayas', fast: 'Livraison rapide', why: 'Pourquoi choisir ce produit', features: 'Caractéristiques', faq: 'Questions fréquentes', howTo: 'Comment commander', steps: ['Choisissez le produit', 'Vos informations', 'Recevez et payez'], stepsD: ['Choisissez le produit et la quantité', 'Nom, téléphone et wilaya', 'Payez à la réception'], q1: 'Délai de livraison ?', a1: 'En général 2 à 5 jours selon la wilaya.', q2: 'Paiement à la livraison ?', a2: 'Oui, payez à la réception après vérification.', q3: 'Livraison partout ?', a3: 'Oui, vers les 58 wilayas d’Algérie.', codTitle: 'Paiement à la livraison — toutes wilayas', codDesc: 'Vérifiez le produit à la livraison, puis payez. Rapide et sûr.', getToday: 'Commandez aujourd’hui', limited: 'Quantité limitée — commandez maintenant.', available: 'Disponible' },
  en: { orderNow: 'Order now', cod: 'Cash on delivery', deliver: 'Delivery nationwide', fast: 'Fast delivery', why: 'Why choose this product', features: 'Features', faq: 'FAQ', howTo: 'How to order', steps: ['Choose the product', 'Your details', 'Receive & pay'], stepsD: ['Pick the product and quantity', 'Name, phone and wilaya', 'Pay on delivery'], q1: 'How long is delivery?', a1: 'Usually 2–5 days depending on the wilaya.', q2: 'Is cash on delivery available?', a2: 'Yes, pay only when you receive and check it.', q3: 'Do you deliver everywhere?', a3: 'Yes, to all 58 wilayas of Algeria.', codTitle: 'Cash on delivery — nationwide', codDesc: 'Inspect the product on arrival, then pay. Fast and safe to your door.', getToday: 'Get yours today', limited: 'Limited stock — order now.', available: 'Available' },
};

function cta(p, t, big) { return `<button class="lp-btn${big ? ' lp-btn-xl' : ''}" data-order data-add-product="${esc(p.id)}">${esc(t.orderNow)}<span class="lp-cta-note">${money(p.price, p.cur)} • ${esc(t.cod)}</span></button>`; }
function chips(t) { return `<div class="lp-chips"><span class="lp-chip">${ICONS.cash}${esc(t.cod)}</span><span class="lp-chip">${ICONS.truck}${esc(t.deliver)}</span></div>`; }
function pricing(p) { const off = p.compare && p.compare > p.price ? Math.round((1 - p.price / p.compare) * 100) : 0; return `<div class="lp-pricing"><span class="lp-price">${money(p.price, p.cur)}</span>${off ? `<span class="lp-was">${money(p.compare, p.cur)}</span><span class="lp-off">-${off}%</span>` : ''}</div>`; }
function pframe(p, off) { return `<div class="lp-pframe"><div class="lp-pfblob" style="top:-10%;inset-inline-start:-10%"></div>${off ? `<span class="lp-badge">-${off}%</span>` : ''}<img src="${p.media}" alt="${esc(p.name)}"></div>`; }

// ── SECTION RENDERERS ──
function heroSplit(p, t, tpl) {
  const off = p.compare && p.compare > p.price ? Math.round((1 - p.price / p.compare) * 100) : 0;
  const media = p.vTok && p.hasVariants ? `<div class="lp-pframe">${off ? `<span class="lp-badge">-${off}%</span>` : ''}${p.vTok}</div>` : pframe(p, off);
  const copy = `<div><span class="lp-eyebrow">${esc(p.eyebrow || t.available)}</span><h1 class="lp-title">${esc(p.headline || p.name)}</h1><p class="lp-lead">${esc(p.subtitle || p.description || '')}</p>${pricing(p)}${cta(p, t, true)}${chips(t)}</div>`;
  const mediaCol = `<div>${media}</div>`;
  const blob = tpl.decor ? `<div class="lp-blob" style="background:var(--lp-primary);width:340px;height:340px;top:-80px;inset-inline-start:-60px"></div>` : '';
  return `<section class="lp-hero">${blob}<div class="lp-wrap"><div class="lp-hero-grid">${tpl.hero === 'splitL' ? mediaCol + copy : copy + mediaCol}</div></div></section>`;
}
function heroCenter(p, t, tpl) {
  const off = p.compare && p.compare > p.price ? Math.round((1 - p.price / p.compare) * 100) : 0;
  const media = p.vTok && p.hasVariants ? `<div class="lp-pframe" style="max-width:380px;margin:28px auto 0">${off ? `<span class="lp-badge">-${off}%</span>` : ''}${p.vTok}</div>` : `<div style="max-width:380px;margin:28px auto 0">${pframe(p, off)}</div>`;
  const blob = tpl.decor ? `<div class="lp-blob" style="background:var(--lp-accent);width:300px;height:300px;top:-60px;right:10%"></div>` : '';
  return `<section class="lp-hero">${blob}<div class="lp-wrap" style="text-align:center;padding:54px 0 60px"><span class="lp-eyebrow">${esc(p.eyebrow || t.available)}</span><h1 class="lp-title">${esc(p.headline || p.name)}</h1><p class="lp-lead" style="margin-inline:auto;text-align:center">${esc(p.subtitle || p.description || '')}</p><div style="display:flex;justify-content:center;margin:18px 0">${pricing(p)}</div><div style="display:flex;justify-content:center">${cta(p, t, true)}</div><div style="display:flex;justify-content:center">${chips(t)}</div>${media}</div></section>`;
}
function heroBanner(p, t, tpl) {
  // Full-width AI mood scene (no product) + headline overlay, then clean product frame below.
  const off = p.compare && p.compare > p.price ? Math.round((1 - p.price / p.compare) * 100) : 0;
  const media = p.vTok && p.hasVariants ? `<div class="lp-pframe" style="max-width:360px;margin:-70px auto 0;position:relative;z-index:3">${off ? `<span class="lp-badge">-${off}%</span>` : ''}${p.vTok}</div>` : `<div style="max-width:360px;margin:-70px auto 0;position:relative;z-index:3">${pframe(p, off)}</div>`;
  return `<section class="lp-hero" style="padding:0"><div class="lp-wrap" style="padding-top:34px"><div class="lp-band" style="min-height:360px">${p.bandTok || ''}<div class="lp-band-in"><span class="lp-eyebrow">${esc(p.eyebrow || t.available)}</span><h1 class="lp-title">${esc(p.headline || p.name)}</h1><p class="lp-lead" style="margin-inline:auto;color:#fff">${esc(p.subtitle || p.description || '')}</p></div></div>${media}<div style="text-align:center;margin-top:18px">${pricing(p).replace('lp-pricing', 'lp-pricing" style="justify-content:center')}</div><div style="display:flex;justify-content:center;margin-top:6px">${cta(p, t, true)}</div><div style="display:flex;justify-content:center">${chips(t)}</div></div></section>`;
}
function dividerChips(t) { return `<section class="lp-section" style="padding:14px 0"><div class="lp-wrap"><div class="lp-divider"><span class="lp-chip">${esc(t.cod)}</span><span class="lp-chip">${esc(t.fast)}</span></div></div></section>`; }
function benefits(p, t, tpl) {
  const items = (p.features && p.features.length ? p.features : [p.description]).slice(0, 4);
  while (items.length < 4) items.push('');
  const cards = items.filter(Boolean).map((f, i) => {
    const ic = ICONS[BENEFIT_ICONS[i % BENEFIT_ICONS.length]];
    const parts = String(f).split(/[:：]/);
    const title = parts.length > 1 ? parts[0] : f;
    const desc = parts.length > 1 ? parts.slice(1).join(':') : '';
    if (tpl.benefits === 'flat') return `<div class="lp-ben"><div class="lp-icn">${ic}</div><h3>${esc(title)}</h3><p>${esc(desc)}</p></div>`;
    return `<div class="lp-card"><div class="lp-icn">${ic}</div><h3>${esc(title)}</h3><p>${esc(desc)}</p></div>`;
  }).join('');
  const wrap = tpl.benefits === 'flat' ? 'lp-bens' : 'lp-grid';
  return `<section class="lp-section"><div class="lp-wrap"><div class="lp-head"><span class="lp-eyebrow">${esc(t.features)}</span><h2 class="lp-h2">${esc(t.why)}</h2></div><div class="${wrap}">${cards}</div></div></section>`;
}
function featureChecks(p, t) {
  const items = (p.features && p.features.length ? p.features : []).slice(0, 5);
  if (!items.length) return '';
  return `<section class="lp-section" style="background:#fff"><div class="lp-wrap"><div class="lp-feature"><div><span class="lp-eyebrow">${esc(t.features)}</span><h3 class="lp-h3">${esc(p.headline || p.name)}</h3><ul class="lp-checks">${items.map(f => `<li>${esc(f)}</li>`).join('')}</ul></div><div class="lp-feature-media">${p.bandTok2 || `<div class="lp-pframe" style="aspect-ratio:4/3;box-shadow:none;border:0">${p.vTok && p.hasVariants ? p.vTok : `<img src="${p.media}" alt="${esc(p.name)}">`}</div>`}</div></div></div></section>`;
}
function moodBand(p, t) {
  if (!p.bandTok3) return '';
  return `<section class="lp-section"><div class="lp-wrap"><div class="lp-band">${p.bandTok3}<div class="lp-band-in"><h2 class="lp-h2">${esc(p.headline || p.name)}</h2><p class="lp-lead" style="margin-inline:auto;color:#fff">${esc(p.subtitle || p.description || '')}</p></div></div></div></section>`;
}
function productShowcase(products, t) {
  const cards = products.map((p, i) => {
    const off = p.compare && p.compare > p.price ? Math.round((1 - p.price / p.compare) * 100) : 0;
    const media = p.vTok && p.hasVariants ? p.vTok : `<div class="lp-shot"><img src="${p.media}" alt="${esc(p.name)}"></div>`;
    const feats = (p.features || []).slice(0, 3).map(f => `<li>${esc(f)}</li>`).join('');
    return `<div class="lp-feature${i % 2 ? ' rev' : ''}"><div class="lp-feature-media">${media}</div><div><h3 class="lp-h3">${esc(p.name)}</h3><p style="color:var(--lp-muted);margin:8px 0 6px">${esc(p.description || '')}</p>${feats ? `<ul class="lp-checks">${feats}</ul>` : ''}${pricing(p)}${cta(p, t, false)}</div></div>`;
  }).join('');
  return `<section class="lp-section"><div class="lp-wrap"><div class="lp-head"><h2 class="lp-h2">${esc(t.available)}</h2></div>${cards}</div></section>`;
}
function codBox(t) { return `<section class="lp-section"><div class="lp-wrap"><div class="lp-cod"><div class="lp-cod-ic">${ICONS.truck}</div><div><h3>${esc(t.codTitle)}</h3><p>${esc(t.codDesc)}</p></div></div></div></section>`; }
function steps(t) { return `<section class="lp-section" style="background:#fff"><div class="lp-wrap"><div class="lp-head"><h2 class="lp-h2">${esc(t.howTo)}</h2></div><div class="lp-steps">${t.steps.map((s, i) => `<div class="lp-step"><h3>${esc(s)}</h3><p>${esc(t.stepsD[i])}</p></div>`).join('')}</div></div></section>`; }
function faq(t) { const qs = [[t.q1, t.a1], [t.q2, t.a2], [t.q3, t.a3]]; return `<section class="lp-section"><div class="lp-wrap"><div class="lp-head"><h2 class="lp-h2">${esc(t.faq)}</h2></div><div class="lp-faq">${qs.map(([q, a], i) => `<details${i === 0 ? ' open' : ''}><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}</div></div></section>`; }
function finalCta(p, t) { return `<section class="lp-section"><div class="lp-wrap"><div class="lp-final"><div class="lp-blob" style="background:#fff;width:260px;height:260px;top:-120px;right:-60px;opacity:.12"></div><h2 class="lp-h2">${esc(t.getToday)}</h2><p>${esc(t.limited)}</p>${cta(p, t, true)}</div></div></section>`; }

// ── TEMPLATE CONFIGS (generated combos → ~40 distinct looks) ──
const HEROES = ['splitR', 'splitL', 'center', 'banner'];
const HERO_MOODS = { splitR: ['tech', 'general', 'health'], splitL: ['tech', 'home', 'general'], center: ['luxury', 'beauty', 'general'], banner: ['beauty', 'fashion', 'food', 'playful', 'energetic'] };
const TEMPLATES = [];
let _tid = 0;
for (const hero of HEROES) for (const benefitsStyle of ['cards', 'flat']) for (const decor of [true, false]) for (const band of [true, false]) for (const feat of [true, false]) {
  TEMPLATES.push({ id: 't' + (_tid++), hero, benefits: benefitsStyle, decor, band, feat, moods: HERO_MOODS[hero] });
}
// → 4*2*2*2*2 = 64 configs; we expose up to 40 varied ones per selection pool.

function hashStr(s) { let h = 0; s = String(s || ''); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }

function pickTemplate(mood, seed) {
  let pool = TEMPLATES.filter(t => t.moods.includes(mood));
  if (!pool.length) pool = TEMPLATES;
  return pool[hashStr((mood || '') + '|' + (seed || '')) % pool.length];
}

// Render the full inner section list. `products` = array of normalized product
// objects { id, name, price, compare, cur, media, vTok, hasVariants, headline,
// subtitle, description, features[], eyebrow, bandTok, bandTok2, bandTok3 }.
function renderTemplate(tpl, products, t, multi) {
  const p0 = products[0];
  const out = [];
  if (tpl.hero === 'center') out.push(heroCenter(p0, t, tpl));
  else if (tpl.hero === 'banner') out.push(heroBanner(p0, t, tpl));
  else out.push(heroSplit(p0, t, tpl));
  out.push(dividerChips(t));
  if (p0.bandTok3) out.push(moodBand(p0, t)); // AI marketing scene, prominent right under the hero
  out.push(benefits(p0, t, tpl));
  if (tpl.feat) out.push(featureChecks(p0, t));
  if (multi) out.push(productShowcase(products, t));
  out.push(codBox(t));
  out.push(steps(t));
  out.push(faq(t));
  out.push(finalCta(p0, t));
  return out.join('\n');
}

module.exports = { TEMPLATES, pickTemplate, renderTemplate, TXT };
