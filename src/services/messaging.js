/**
 * Unified Messaging Service
 * WhatsApp (Meta Cloud API) + SMS (Twilio) + Email (Resend)
 */

// ═══════════════════════════════════════════
// WHATSAPP — Meta Cloud API
// ═══════════════════════════════════════════
const WA_API = 'https://graph.facebook.com/v19.0';
const WA_TOKEN = process.env.META_WHATSAPP_TOKEN || '';
const WA_PHONE_ID = process.env.META_PHONE_NUMBER_ID || '';

/**
 * Send a WhatsApp text message
 * @param {string} to - Phone number with country code (e.g., '213555123456')
 * @param {string} message - Text message
 */
async function sendWhatsApp(to, message) {
  if (!WA_TOKEN || !WA_PHONE_ID) {
    console.log('[WA] Not configured, skipping:', to, message.substring(0, 50));
    return { success: false, reason: 'not_configured' };
  }

  // Normalize Algerian numbers: 0555... -> 213555...
  let phone = to.replace(/\s+/g, '').replace(/^0/, '213');
  if (!phone.startsWith('+')) phone = '+' + phone;

  try {
    const res = await fetch(`${WA_API}/${WA_PHONE_ID}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WA_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone,
        type: 'text',
        text: { body: message },
      }),
    });

    const data = await res.json();
    if (data.error) {
      console.error('[WA] Error:', data.error.message);
      return { success: false, reason: data.error.message };
    }

    console.log('[WA] Sent to', phone);
    return { success: true, messageId: data.messages?.[0]?.id };
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

  let phone = to.replace(/\s+/g, '').replace(/^0/, '213');
  if (!phone.startsWith('+')) phone = '+' + phone;

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
// SMS — Twilio
// ═══════════════════════════════════════════
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_FROM = process.env.TWILIO_PHONE_NUMBER || '';

/**
 * Send an SMS via Twilio
 * @param {string} to - Phone number
 * @param {string} message - SMS body (max ~160 chars for 1 segment)
 */
async function sendSMS(to, message) {
  if (!TWILIO_SID || !TWILIO_AUTH || !TWILIO_FROM) {
    console.log('[SMS] Not configured, skipping:', to, message.substring(0, 50));
    return { success: false, reason: 'not_configured' };
  }

  let phone = to.replace(/\s+/g, '').replace(/^0/, '+213');
  if (!phone.startsWith('+')) phone = '+' + phone;

  try {
    const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_AUTH}`).toString('base64');
    const params = new URLSearchParams({
      To: phone,
      From: TWILIO_FROM,
      Body: message,
    });

    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    const data = await res.json();
    if (data.error_code) {
      console.error('[SMS] Error:', data.message);
      return { success: false, reason: data.message };
    }

    console.log('[SMS] Sent to', phone);
    return { success: true, messageId: data.sid };
  } catch (e) {
    console.error('[SMS] Failed:', e.message);
    return { success: false, reason: e.message };
  }
}


// ═══════════════════════════════════════════
// EMAIL — Resend
// ═══════════════════════════════════════════
const RESEND_KEY = process.env.RESEND_API_KEY || '';
const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@mymarket.store';

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
  if (channel === 'SMS' && opts.phone) {
    results.sms = await sendSMS(opts.phone, opts.message);
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
// ORDER NOTIFICATION TEMPLATES
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

function orderConfirmationHTML(storeName, orderNumber, total, currency, items) {
  return `
<!DOCTYPE html>
<html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
<div style="background:linear-gradient(135deg,#7C3AED,#6366F1);color:white;padding:30px;border-radius:16px;text-align:center;">
<h1 style="margin:0;font-size:24px;">${storeName}</h1>
<p style="margin:5px 0 0;opacity:0.8;">Order Confirmation</p>
</div>
<div style="padding:20px;background:#f9fafb;border-radius:12px;margin-top:16px;">
<h2 style="color:#1f2937;margin-top:0;">Order #${orderNumber}</h2>
<p style="color:#6b7280;">Thank you for your order! Here's your summary:</p>
${items ? items.map(it => `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #e5e7eb;"><span>${it.product_name} x${it.quantity}</span><strong>${it.total_price} ${currency}</strong></div>`).join('') : ''}
<div style="display:flex;justify-content:space-between;padding:12px 0;margin-top:8px;font-size:18px;"><strong>Total</strong><strong style="color:#7C3AED;">${total} ${currency}</strong></div>
</div>
<p style="text-align:center;color:#9ca3af;font-size:12px;margin-top:20px;">© ${new Date().getFullYear()} ${storeName}. All rights reserved.</p>
</body></html>`;
}

// Check what's configured
function getConfiguredChannels() {
  return {
    whatsapp: !!(WA_TOKEN && WA_PHONE_ID),
    sms: !!(TWILIO_SID && TWILIO_AUTH && TWILIO_FROM),
    email: !!RESEND_KEY,
  };
}

module.exports = {
  sendWhatsApp, sendWhatsAppTemplate,
  sendSMS,
  sendEmail,
  sendNotification,
  getConfiguredChannels,
  // Templates
  orderConfirmationMessage, orderShippedMessage, orderDeliveredMessage,
  cartRecoveryMessage, orderConfirmationHTML,
};
