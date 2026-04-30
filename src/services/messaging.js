/**
 * Unified Messaging Service
 * WhatsApp (Meta Cloud API) + Email (Resend)
 */

// ═══════════════════════════════════════════
// WHATSAPP — Meta Cloud API
// ═══════════════════════════════════════════
const WA_API = 'https://graph.facebook.com/v21.0';
const WA_TOKEN = process.env.META_WHATSAPP_TOKEN || '';
const WA_PHONE_ID = process.env.META_PHONE_NUMBER_ID || '';

/**
 * Send a WhatsApp text message
 * @param {string} to - Phone number with country code (e.g., '213555123456')
 * @param {string} message - Text message
 */
async function sendWhatsApp(to, message, storeId) {
  // Try Railway WhatsApp service (QR code method) first
  if (storeId && process.env.WA_SERVICE_URL) {
    try {
      const waUrl = process.env.WA_SERVICE_URL;
      const waSecret = process.env.WA_API_SECRET || 'mymarket-wa-secret-2026';
      const r = await fetch(waUrl + '/send', {
        method: 'POST',
        headers: { 'x-api-secret': waSecret, 'Content-Type': 'application/json' },
        body: JSON.stringify({ storeId, phone: to, message }),
      });
      const data = await r.json();
      if (data.success) return { ...data, method: 'railway_qr' };
      console.log('[WA-Railway] Failed:', data.reason, '— trying Cloud API');
    } catch (e) { console.log('[WA-Railway] Error:', e.message); }
  }

  // Fallback: Cloud API
  if (!WA_TOKEN || !WA_PHONE_ID) {
    return { success: false, reason: 'WhatsApp not connected. Scan QR code in Apps → WhatsApp, or set up Cloud API.' };
  }

  // Normalize Algerian phone numbers
  let phone = String(to).replace(/[\s\-\+\(\)]/g, '');
  if (phone.startsWith('00213')) phone = phone.substring(2);
  if (phone.startsWith('213')) { /* already correct */ }
  else if (phone.startsWith('0')) phone = '213' + phone.substring(1);
  else if (phone.length <= 10) phone = '213' + phone;

  console.log('[WA-Cloud] Sending to:', phone);

  try {
    const res = await fetch(`${WA_API}/${WA_PHONE_ID}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: phone, type: 'text', text: { body: message } }),
    });
    const data = await res.json();

    if (data.error) {
      console.log('[WA-Cloud] Text failed, trying template:', data.error.message);
      const res2 = await fetch(`${WA_API}/${WA_PHONE_ID}/messages`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: phone, type: 'template', template: { name: 'hello_world', language: { code: 'en_US' } } }),
      });
      const data2 = await res2.json();
      if (data2.error) {
        return { success: false, reason: data2.error.message };
      }
      return { success: true, messageId: data2.messages?.[0]?.id, method: 'cloud_template' };
    }

    console.log('[WA-Cloud] Sent to', phone);
    return { success: true, messageId: data.messages?.[0]?.id, method: 'cloud_text' };
  } catch (e) {
    console.error('[WA] Failed:', e.message);
    return { success: false, reason: e.message };
  }
}

/**
 * Send a WhatsApp template message (for first-time contacts)
 * Templates must be pre-approved by Meta
 */
async function sendWhatsAppTemplate(to, templateName, languageCode = 'ar', params = []) {
  if (!WA_TOKEN || !WA_PHONE_ID) return { success: false, reason: 'not_configured' };

  let phone = to.replace(/[\s\-\+\(\)]/g, '');
  if (phone.startsWith('00')) phone = phone.substring(2);
  if (phone.startsWith('0')) phone = '213' + phone.substring(1);
  if (phone.length <= 10) phone = '213' + phone;

  try {
    const body = {
      messaging_product: 'whatsapp',
      to: phone,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
      },
    };

    if (params.length) {
      body.template.components = [{
        type: 'body',
        parameters: params.map(p => ({ type: 'text', text: String(p) })),
      }];
    }

    const res = await fetch(`${WA_API}/${WA_PHONE_ID}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WA_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await res.json();
    if (data.error) return { success: false, reason: data.error.message };
    return { success: true, messageId: data.messages?.[0]?.id };
  } catch (e) {
    return { success: false, reason: e.message };
  }
}


// ═══════════════════════════════════════════
// EMAIL — Resend
// ═══════════════════════════════════════════
const RESEND_KEY = process.env.RESEND_API_KEY || '';
const FROM_EMAIL = process.env.FROM_EMAIL || 'onboarding@resend.dev';

/**
 * Send an email via Resend
 * @param {Object} opts
 * @param {string} opts.to - Recipient email
 * @param {string} opts.subject
 * @param {string} opts.html - HTML body
 * @param {string} opts.text - Plain text fallback
 */
async function sendEmail(opts) {
  if (!RESEND_KEY) {
    console.log('[Email] Not configured, skipping:', opts.to, opts.subject);
    return { success: false, reason: 'not_configured' };
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: opts.from || FROM_EMAIL,
        to: [opts.to],
        subject: opts.subject,
        html: opts.html || undefined,
        text: opts.text || undefined,
      }),
    });

    const data = await res.json();
    if (data.error) {
      console.error('[Email] Error:', data.error);
      return { success: false, reason: data.error.message || data.error };
    }

    console.log('[Email] Sent to', opts.to);
    return { success: true, messageId: data.id };
  } catch (e) {
    console.error('[Email] Failed:', e.message);
    return { success: false, reason: e.message };
  }
}


// ═══════════════════════════════════════════
// UNIFIED: Send via store's preferred channel
// ═══════════════════════════════════════════

/**
 * Send a notification using the store's configured channel
 * @param {Object} opts
 * @param {string} opts.channel - 'WHATSAPP', 'SMS', or 'EMAIL'
 * @param {string} opts.phone - Customer phone
 * @param {string} opts.email - Customer email (for email channel)
 * @param {string} opts.message - Text message
 * @param {string} opts.subject - Email subject (for email channel)
 * @param {string} opts.html - HTML body (for email channel)
 */
async function sendNotification(opts) {
  const channel = (opts.channel || 'WHATSAPP').toUpperCase();
  const results = {};

  if (channel === 'WHATSAPP' && opts.phone) {
    results.whatsapp = await sendWhatsApp(opts.phone, opts.message);
  }
  if (channel === 'EMAIL' && opts.email) {
    results.email = await sendEmail({
      to: opts.email,
      subject: opts.subject || 'Notification',
      html: opts.html || `<p>${opts.message}</p>`,
      text: opts.message,
    });
  }

  return results;
}


// ═══════════════════════════════════════════
// MULTILINGUAL DEFAULT TEMPLATES
// ═══════════════════════════════════════════

const defaultTemplates = {
  en: {
    new_order: "Hi {customer_name}! We received your order #{order_number} from {store_name}. Total: {total} {currency}. We'll process it shortly!",
    confirmed: "Hi {customer_name}! Your order #{order_number} from {store_name} has been confirmed! Total: {total} {currency}. We'll keep you updated!",
    under_preparation: "Hi {customer_name}! Your order #{order_number} is now being prepared. We'll notify you when it ships!",
    shipped: "Great news {customer_name}! Your order #{order_number} has been shipped! Tracking: {tracking_number}. Delivery company: {delivery_company}",
    delivered: "Your order #{order_number} has been delivered! Thank you for shopping at {store_name}!",
    cancelled: "Your order #{order_number} from {store_name} has been cancelled. Contact us if you have questions.",
    awaiting: "Hi {customer_name}, we're trying to reach you about order #{order_number}. Please call us back!",
    failed_call_1: "Hi {customer_name}, we tried calling about your order #{order_number} but couldn't reach you. Please call us back!",
    failed_call_2: "Hi {customer_name}, this is our second attempt to reach you about order #{order_number}. Please contact us soon!",
    failed_call_3: "Final notice: We've been unable to reach you about order #{order_number}. Please contact {store_name} within 24h or your order may be cancelled.",
    returned: "Your order #{order_number} from {store_name} has been returned. Contact us for any questions.",
    abandoned_cart: "Hi {customer_name}! You left {item_count} item(s) in your cart at {store_name}. Complete your order: {cart_url}"
  },
  fr: {
    new_order: "Bonjour {customer_name}! Nous avons recu votre commande #{order_number} de {store_name}. Total: {total} {currency}.",
    confirmed: "Bonjour {customer_name}! Votre commande #{order_number} de {store_name} est confirmee! Total: {total} {currency}.",
    under_preparation: "Bonjour {customer_name}! Votre commande #{order_number} est en cours de preparation.",
    shipped: "Bonne nouvelle {customer_name}! Votre commande #{order_number} a ete expediee! Suivi: {tracking_number}",
    delivered: "Votre commande #{order_number} a ete livree! Merci d'avoir choisi {store_name}!",
    cancelled: "Votre commande #{order_number} de {store_name} a ete annulee. Contactez-nous pour toute question.",
    awaiting: "Bonjour {customer_name}, nous essayons de vous joindre concernant la commande #{order_number}. Rappelez-nous!",
    failed_call_1: "Bonjour {customer_name}, nous avons essaye de vous appeler pour la commande #{order_number}. Veuillez nous rappeler!",
    failed_call_2: "Bonjour {customer_name}, deuxieme tentative d'appel pour la commande #{order_number}. Contactez-nous SVP!",
    failed_call_3: "Dernier avis: Impossible de vous joindre pour la commande #{order_number}. Contactez {store_name} dans les 24h.",
    returned: "Votre commande #{order_number} de {store_name} a ete retournee. Contactez-nous pour toute question.",
    abandoned_cart: "Bonjour {customer_name}! Vous avez laisse {item_count} article(s) dans votre panier chez {store_name}. Completez votre commande: {cart_url}"
  },
  ar: {
    new_order: "مرحبا {customer_name}! استلمنا طلبك #{order_number} من {store_name}. المبلغ: {total} {currency}.",
    confirmed: "مرحبا {customer_name}! تم تأكيد طلبك #{order_number} من {store_name}. المبلغ: {total} {currency}.",
    under_preparation: "مرحبا {customer_name}! طلبك #{order_number} قيد التحضير الآن. سنعلمك عند الشحن!",
    shipped: "أخبار سارة {customer_name}! تم شحن طلبك #{order_number}. رقم التتبع: {tracking_number}. شركة التوصيل: {delivery_company}",
    delivered: "تم تسليم طلبك #{order_number}! شكرا لتسوقك من {store_name}!",
    cancelled: "تم إلغاء طلبك #{order_number} من {store_name}. تواصل معنا لأي استفسار.",
    awaiting: "مرحبا {customer_name}، نحاول الاتصال بك بخصوص الطلب #{order_number}. يرجى معاودة الاتصال!",
    failed_call_1: "مرحبا {customer_name}، حاولنا الاتصال بك بخصوص الطلب #{order_number} ولم نتمكن. يرجى معاودة الاتصال!",
    failed_call_2: "مرحبا {customer_name}، هذه المحاولة الثانية للاتصال بك بخصوص الطلب #{order_number}. تواصل معنا!",
    failed_call_3: "إشعار أخير: لم نتمكن من الاتصال بك بخصوص الطلب #{order_number}. تواصل مع {store_name} خلال 24 ساعة.",
    returned: "تم إرجاع طلبك #{order_number} من {store_name}. تواصل معنا لأي استفسار.",
    abandoned_cart: "مرحبا {customer_name}! تركت {item_count} منتج(ات) في سلة التسوق في {store_name}. أكمل طلبك: {cart_url}"
  }
};


// ═══════════════════════════════════════════
// GENERATE ORDER MESSAGE FROM TEMPLATES
// ═══════════════════════════════════════════

/**
 * Generate a formatted order message using store config templates or defaults
 * @param {Object} storeConfig - The store's configuration object
 * @param {string} status - Order status key (e.g., 'confirmed', 'shipped', 'abandoned_cart')
 * @param {Object} orderData - Data to substitute into the template
 * @param {string} [language='ar'] - Language code: 'en', 'fr', or 'ar'
 * @returns {string} The formatted message string
 */
// ─── Localized variable aliases ──────────────────────────────────────────────
// Admins can insert variables in the language they're authoring in (e.g.
// {اسم_العميل}, {Nom_du_client}). We rewrite them to the canonical English
// tokens (e.g. {customer_name}) before substitution so the message renders
// with real customer data regardless of which language was used to author it.
// ─────────────────────────────────────────────────────────────────────────────
const VAR_LOCALIZED_LABELS = {
  '{store_name}': { fr: 'Nom du magasin', ar: 'اسم المتجر' },
  '{order_number}': { fr: 'N° de commande', ar: 'رقم الطلب' },
  '{customer_name}': { fr: 'Nom du client', ar: 'اسم العميل' },
  '{customer_phone}': { fr: 'Téléphone client', ar: 'هاتف العميل' },
  '{total}': { fr: 'Montant total', ar: 'المبلغ الإجمالي' },
  '{total_price}': { fr: 'Prix total', ar: 'السعر الإجمالي' },
  '{subtotal}': { fr: 'Sous-total', ar: 'المجموع الفرعي' },
  '{shipping_cost}': { fr: 'Frais de livraison', ar: 'تكلفة التوصيل' },
  '{shipping_price}': { fr: 'Prix de livraison', ar: 'سعر التوصيل' },
  '{shipping_method}': { fr: 'Mode de livraison', ar: 'طريقة التوصيل' },
  '{discount}': { fr: 'Remise', ar: 'الخصم' },
  '{currency}': { fr: 'Devise', ar: 'العملة' },
  '{shipping_address}': { fr: 'Adresse', ar: 'العنوان' },
  '{shipping_city}': { fr: 'Ville', ar: 'المدينة' },
  '{shipping_wilaya}': { fr: 'Wilaya', ar: 'الولاية' },
  '{shipping_zip}': { fr: 'Code postal', ar: 'الرمز البريدي' },
  '{payment_method}': { fr: 'Mode de paiement', ar: 'طريقة الدفع' },
  '{tracking_number}': { fr: 'N° de suivi', ar: 'رقم التتبع' },
  '{tracking_link}': { fr: 'Lien de suivi', ar: 'رابط التتبع' },
  '{delivery_company}': { fr: 'Transporteur', ar: 'شركة التوصيل' },
  '{order_date}': { fr: 'Date de commande', ar: 'تاريخ الطلب' },
  '{order_time}': { fr: 'Heure de commande', ar: 'وقت الطلب' },
  '{item_count}': { fr: "Nombre d'articles", ar: 'عدد القطع' },
  '{product_list}': { fr: 'Liste des produits', ar: 'قائمة المنتجات' },
  '{products_list}': { fr: 'Liste des produits', ar: 'قائمة المنتجات' },
  '{product_name}': { fr: 'Nom du produit', ar: 'اسم المنتج' },
  '{product_price}': { fr: 'Prix du produit', ar: 'سعر المنتج' },
  '{store_phone}': { fr: 'Téléphone du magasin', ar: 'هاتف المتجر' },
  '{store_email}': { fr: 'Email du magasin', ar: 'بريد المتجر' },
  '{cart_url}': { fr: 'Lien du panier', ar: 'رابط السلة' },
};
const VAR_ALIAS_TO_ENGLISH = (() => {
  const m = {};
  for (const [eng, labels] of Object.entries(VAR_LOCALIZED_LABELS)) {
    for (const lg of ['fr', 'ar']) {
      const lbl = labels[lg];
      if (!lbl) continue;
      const alias = '{' + lbl.replace(/\s+/g, '_') + '}';
      if (alias !== eng) m[alias] = eng;
    }
  }
  return m;
})();
function resolveVarAliases(template) {
  if (!template) return template;
  for (const [alias, eng] of Object.entries(VAR_ALIAS_TO_ENGLISH)) {
    if (template.includes(alias)) template = template.split(alias).join(eng);
  }
  return template;
}

function generateOrderMessage(storeConfig, status, orderData, language = 'ar') {
  // Determine the template: store custom templates take priority, then defaults
  let template = null;

  // Check store's custom wa_templates first
  if (storeConfig && storeConfig.wa_templates) {
    const storeTemplates = storeConfig.wa_templates;
    if (storeTemplates[language] && storeTemplates[language][status]) {
      template = storeTemplates[language][status];
    } else if (storeTemplates[status]) {
      // Flat structure fallback (status key directly without language nesting)
      template = storeTemplates[status];
    }
  }

  // Fall back to default templates
  if (!template) {
    const lang = defaultTemplates[language] ? language : 'ar';
    template = defaultTemplates[lang][status] || '';
  }

  if (!template) return '';

  // Rewrite localized variable aliases (Arabic / French) to canonical English
  // tokens so the substitution table below catches them.
  template = resolveVarAliases(template);

  // Replace all variables in the template. Every token the WA / Email modal
  // exposes must have a substitution here — otherwise the literal {token}
  // text leaks into the customer's message. Numbers are formatted with
  // toLocaleString for readability.
  const fmtNum = (v) => (v == null || v === '' ? '' : (Number(v) || 0).toLocaleString());
  const wilayaName = String(orderData.shipping_wilaya || '');
  const communeName = String(orderData.shipping_city || '');
  const productList = (() => {
    if (orderData.product_list) return String(orderData.product_list);
    if (Array.isArray(orderData.items)) {
      return orderData.items.map(i => `• ${i.product_name || i.name || 'Item'} ×${i.quantity || 1}`).join('\n');
    }
    return '';
  })();
  const productName = (() => {
    if (orderData.product_name) return String(orderData.product_name);
    if (Array.isArray(orderData.items) && orderData.items[0]) return orderData.items[0].product_name || orderData.items[0].name || '';
    return '';
  })();
  const productPrice = (() => {
    if (orderData.product_price != null) return fmtNum(orderData.product_price);
    if (Array.isArray(orderData.items) && orderData.items[0]) return fmtNum(orderData.items[0].unit_price ?? orderData.items[0].price);
    return '';
  })();
  const variantStr = (() => {
    if (orderData.variant) return String(orderData.variant);
    if (Array.isArray(orderData.items) && orderData.items[0]) {
      const v = orderData.items[0].variant_info || orderData.items[0].variant;
      if (!v) return '';
      if (typeof v === 'string') return v;
      if (Array.isArray(v?.selections)) return v.selections.map(s => s.name || s.value).filter(Boolean).join(' / ');
      return v.name || v.value || '';
    }
    return '';
  })();
  const totalQty = (() => {
    if (orderData.quantity != null) return String(orderData.quantity);
    if (Array.isArray(orderData.items)) return String(orderData.items.reduce((s, i) => s + (parseInt(i.quantity) || 1), 0));
    return '';
  })();
  const itemCount = orderData.item_count != null
    ? String(orderData.item_count)
    : Array.isArray(orderData.items) ? String(orderData.items.length) : '';
  const orderDate = (() => {
    const d = orderData.order_date || orderData.created_at;
    if (!d) return '';
    try { return new Date(d).toLocaleDateString(language === 'ar' ? 'ar-DZ' : language === 'fr' ? 'fr-DZ' : 'en-GB'); } catch { return String(d); }
  })();
  const orderTime = (() => {
    const d = orderData.order_time || orderData.created_at;
    if (!d) return '';
    try { return new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return String(d); }
  })();

  const variables = {
    '{store_name}':              orderData.store_name || '',
    '{store_phone}':             orderData.store_phone || '',
    '{store_email}':             orderData.store_email || '',
    '{order_number}':            orderData.order_number || '',
    '{order_date}':              orderDate,
    '{order_time}':              orderTime,
    '{customer_name}':           orderData.customer_name || '',
    '{customer_phone}':          orderData.customer_phone || '',
    '{customer_email}':          orderData.customer_email || '',
    '{total}':                   fmtNum(orderData.total),
    '{total_price}':             fmtNum(orderData.total),
    '{subtotal}':                fmtNum(orderData.subtotal),
    '{shipping_cost}':           fmtNum(orderData.shipping_cost),
    '{shipping_price}':          fmtNum(orderData.shipping_cost),
    '{shipping_method}':         orderData.shipping_method || (orderData.shipping_type === 'desk' ? 'Desk' : orderData.shipping_type === 'home' ? 'Home' : ''),
    '{discount}':                fmtNum(orderData.discount),
    '{currency}':                orderData.currency || '',
    '{shipping_address}':        orderData.shipping_address || '',
    '{shipping_city}':           communeName,
    '{shipping_wilaya}':         wilayaName,
    '{shipping_zip}':            orderData.shipping_zip || '',
    '{wilaya_fr}':               orderData.wilaya_fr || wilayaName,
    '{wilaya_ar}':               orderData.wilaya_ar || wilayaName,
    '{commune_fr}':              orderData.commune_fr || communeName,
    '{commune_ar}':              orderData.commune_ar || communeName,
    '{payment_method}':          orderData.payment_method || '',
    '{tracking_number}':         orderData.tracking_number || '',
    '{tracking_link}':           orderData.tracking_link || orderData.tracking_url || '',
    '{tracking_URL}':            orderData.tracking_url || orderData.tracking_link || '',
    '{delivery_company}':        orderData.delivery_company || orderData.delivery_company_name || '',
    '{shipping_company}':        orderData.shipping_company || orderData.delivery_company || orderData.delivery_company_name || '',
    '{delivery_office_name}':    orderData.delivery_office_name || '',
    '{delivery_office_map}':     orderData.delivery_office_map || '',
    '{delivery_office_address}': orderData.delivery_office_address || '',
    '{item_count}':              itemCount,
    '{quantity}':                totalQty,
    '{product_name}':            productName,
    '{product_price}':           productPrice,
    '{product_list}':            productList,
    '{products_list}':           productList,
    '{variant}':                 variantStr,
    '{cart_url}':                orderData.cart_url || '',
  };

  let message = template;
  for (const [key, value] of Object.entries(variables)) {
    if (message.includes(key)) message = message.split(key).join(value);
  }

  return message;
}


// ═══════════════════════════════════════════
// MESSAGE TIMING / DELAY
// ═══════════════════════════════════════════

/**
 * Get the configured message delay for a given order status
 * Reads from the store's wa_timing config
 * @param {Object} storeConfig - The store's configuration object
 * @param {string} status - Order status key
 * @returns {number} Delay in milliseconds (0 = immediate)
 */
function getMessageDelay(storeConfig, status) {
  if (!storeConfig || !storeConfig.wa_timing) return 0;

  const timing = storeConfig.wa_timing;

  // Check for status-specific timing
  if (timing[status] != null) {
    const delay = Number(timing[status]);
    return isNaN(delay) ? 0 : delay;
  }

  // Check for a default delay
  if (timing.default != null) {
    const delay = Number(timing.default);
    return isNaN(delay) ? 0 : delay;
  }

  return 0;
}


// ═══════════════════════════════════════════
// ORDER NOTIFICATION TEMPLATES (legacy)
// ═══════════════════════════════════════════

function orderConfirmationMessage(storeName, orderNumber, total, currency) {
  return `✅ طلبك مؤكد!\n\n🏪 ${storeName}\n📦 رقم الطلب: ${orderNumber}\n💰 المبلغ: ${total} ${currency}\n\nسيتم التواصل معك قريباً. شكراً لك!`;
}

function orderShippedMessage(storeName, orderNumber) {
  return `🚚 تم شحن طلبك!\n\n🏪 ${storeName}\n📦 رقم الطلب: ${orderNumber}\n\nطلبك في الطريق إليك. سيتصل بك عامل التوصيل قريباً.`;
}

function orderDeliveredMessage(storeName, orderNumber) {
  return `✅ تم تسليم طلبك!\n\n🏪 ${storeName}\n📦 رقم الطلب: ${orderNumber}\n\nشكراً لتسوقك معنا! نتمنى أن تكون راضياً.`;
}

function cartRecoveryMessage(storeName, itemCount, cartUrl) {
  return `👋 مرحباً!\n\nتركت ${itemCount} منتج(ات) في سلة التسوق في ${storeName}.\n\nأكمل طلبك الآن: ${cartUrl}\n\nنحن هنا إذا كنت بحاجة للمساعدة!`;
}

function orderConfirmationHTML(storeName, orderNumber, total, currency, items, status) {
  const statusLabels={pending:'Order Received',confirmed:'Order Confirmed',preparing:'Being Prepared',shipped:'Order Shipped',delivered:'Order Delivered',cancelled:'Order Cancelled'};
  const statusColors={pending:'#f59e0b',confirmed:'#3b82f6',preparing:'#8b5cf6',shipped:'#06b6d4',delivered:'#10b981',cancelled:'#ef4444'};
  const label=statusLabels[status]||'Order Update';
  const color=statusColors[status]||'#7C3AED';
  return `
<!DOCTYPE html>
<html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
<div style="background:${color};color:white;padding:30px;border-radius:16px;text-align:center;">
<h1 style="margin:0;font-size:24px;">${storeName}</h1>
<p style="margin:5px 0 0;opacity:0.8;">${label}</p>
</div>
<div style="padding:20px;background:#f9fafb;border-radius:12px;margin-top:16px;">
<h2 style="color:#1f2937;margin-top:0;">Order #${orderNumber}</h2>
<div style="background:${color}20;border-left:4px solid ${color};padding:12px 16px;border-radius:8px;margin-bottom:16px;">
<p style="margin:0;color:${color};font-weight:bold;font-size:16px;">${label}</p>
</div>
${items ? items.map(it => `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #e5e7eb;"><span>${it.product_name} x${it.quantity}</span><strong>${it.total_price} ${currency}</strong></div>`).join('') : ''}
<div style="display:flex;justify-content:space-between;padding:12px 0;margin-top:8px;font-size:18px;"><strong>Total</strong><strong style="color:${color};">${total} ${currency}</strong></div>
</div>
<p style="text-align:center;color:#9ca3af;font-size:12px;margin-top:20px;">© ${new Date().getFullYear()} ${storeName}. All rights reserved.</p>
</body></html>`;
}

// Check what's configured
function getConfiguredChannels() {
  return {
    whatsapp: !!(WA_TOKEN && WA_PHONE_ID),
    email: !!RESEND_KEY,
  };
}

module.exports = {
  sendWhatsApp, sendWhatsAppTemplate,
  sendEmail,
  sendNotification,
  getConfiguredChannels,
  // Legacy templates
  orderConfirmationMessage, orderShippedMessage, orderDeliveredMessage,
  cartRecoveryMessage, orderConfirmationHTML,
  // Multilingual templates & helpers
  defaultTemplates,
  generateOrderMessage,
  getMessageDelay,
};
