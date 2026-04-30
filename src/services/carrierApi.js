async function carrierRequest(cfg, trackingNumber, bodyOverride) {
  const tn = trackingNumber || 'TEST00000';
  const parse = (v) => typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch { return {}; } })() : (v || {});
  const headersIn = parse(cfg.api_headers);
  const queryIn = parse(cfg.api_query_params);
  const oauth = parse(cfg.oauth2_credentials);
  const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };

  if (cfg.api_auth_type === 'bearer' && cfg.api_key) headers['Authorization'] = 'Bearer ' + cfg.api_key;
  else if (cfg.api_auth_type === 'token_prefix' && cfg.api_key) headers['Authorization'] = 'Token ' + cfg.api_key;
  else if (cfg.api_auth_type === 'custom_headers') Object.assign(headers, headersIn);
  else if (cfg.api_auth_type === 'oauth2') {
    if (!cfg.oauth2_token_url) return { ok:false, err:'OAuth2 token URL missing' };
    if (!oauth.client_id || !oauth.client_secret) return { ok:false, err:'OAuth2 client_id/client_secret missing' };
    try {
      const tokenBody = new URLSearchParams({ grant_type:'client_credentials', client_id:oauth.client_id, client_secret:oauth.client_secret });
      const tr = await fetch(cfg.oauth2_token_url, { method:'POST', headers:{ 'Content-Type':'application/x-www-form-urlencoded' }, body:tokenBody, signal:AbortSignal.timeout(15000) });
      const tj = await tr.json().catch(() => ({}));
      if (!tr.ok || !tj.access_token) return { ok:false, status:tr.status, err:'OAuth2 token request failed: ' + (tj.error_description || tj.error || ('HTTP '+tr.status)) };
      headers['Authorization'] = 'Bearer ' + tj.access_token;
    } catch (e) { return { ok:false, err:'OAuth2 token fetch failed: ' + e.message }; }
  }

  let path = (cfg.api_tracking_endpoint || '').replace(/\{tracking_number\}/g, encodeURIComponent(tn))
                                                .replace(/\{number\}/g, encodeURIComponent(tn))
                                                .replace(/\{tn\}/g, encodeURIComponent(tn));
  let url = (cfg.api_base_url || '').replace(/\/$/, '');
  if (path) url += (path.startsWith('/') || path.startsWith('?')) ? path : ('/' + path);
  if (cfg.api_auth_type === 'query_params') {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(queryIn)) if (v) params.set(k, v);
    if (params.toString()) url += (url.includes('?') ? '&' : '?') + params.toString();
  }

  const method = (cfg.api_method || cfg.method || 'GET').toUpperCase();
  let body = bodyOverride || undefined;
  if (!body && method !== 'GET' && cfg.api_body_template) {
    let tpl = cfg.api_body_template.replace(/\{tracking_number\}/g, tn);
    for (const [k, v] of Object.entries(headersIn)) tpl = tpl.split('{' + k + '}').join(String(v || ''));
    body = tpl;
  }

  try {
    const r = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(15000) });
    const txt = await r.text();
    return { ok: r.ok, status: r.status, body: txt, url };
  } catch (e) {
    return { ok:false, err:e.message, url };
  }
}

async function carrierCreateOrder(cfg, order, items) {
  const parse = (v) => typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch { return {}; } })() : (v || {});
  const headersIn = parse(cfg.api_headers);
  const queryIn = parse(cfg.api_query_params);
  const oauth = parse(cfg.oauth2_credentials);
  const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };

  if (cfg.api_auth_type === 'bearer' && cfg.api_key) headers['Authorization'] = 'Bearer ' + cfg.api_key;
  else if (cfg.api_auth_type === 'token_prefix' && cfg.api_key) headers['Authorization'] = 'Token ' + cfg.api_key;
  else if (cfg.api_auth_type === 'custom_headers') Object.assign(headers, headersIn);
  else if (cfg.api_auth_type === 'oauth2') {
    if (!cfg.oauth2_token_url || !oauth.client_id || !oauth.client_secret) return { ok:false, err:'OAuth2 credentials missing' };
    try {
      const tokenBody = new URLSearchParams({ grant_type:'client_credentials', client_id:oauth.client_id, client_secret:oauth.client_secret });
      const tr = await fetch(cfg.oauth2_token_url, { method:'POST', headers:{ 'Content-Type':'application/x-www-form-urlencoded' }, body:tokenBody, signal:AbortSignal.timeout(15000) });
      const tj = await tr.json().catch(() => ({}));
      if (!tj.access_token) return { ok:false, err:'OAuth2 token request failed' };
      headers['Authorization'] = 'Bearer ' + tj.access_token;
    } catch (e) { return { ok:false, err:'OAuth2 token fetch failed: ' + e.message }; }
  }

  const path = (cfg.api_create_endpoint || '').trim();
  if (!path) return { ok:false, err:'No create-order endpoint configured' };
  let url = (cfg.api_base_url || '').replace(/\/$/, '');
  url += (path.startsWith('/') || path.startsWith('?')) ? path : ('/' + path);
  if (cfg.api_auth_type === 'query_params') {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(queryIn)) if (v) params.set(k, v);
    if (params.toString()) url += (url.includes('?') ? '&' : '?') + params.toString();
  }

  const productList = (items || []).map(i => `${i.product_name || i.name || 'Item'} ×${i.quantity || 1}`).join(', ');
  const fullName = order.customer_name || '';
  const nameParts = fullName.trim().split(/\s+/);
  const subs = {
    tracking_number: order.tracking_number || '',
    order_id: order.order_number || order.id || '',
    customer_name: fullName,
    customer_firstname: nameParts[0] || fullName,
    customer_lastname: nameParts.slice(1).join(' ') || '',
    customer_phone: (order.customer_phone || '').replace(/[^\d+]/g, ''),
    customer_email: order.customer_email || '',
    shipping_address: order.shipping_address || '',
    shipping_city: order.shipping_city || '',
    shipping_wilaya: order.shipping_wilaya || '',
    shipping_zip: order.shipping_zip || '',
    wilaya_code: order.shipping_wilaya_code || '',
    total: String(parseFloat(order.total || 0) || 0),
    subtotal: String(parseFloat(order.subtotal || 0) || 0),
    shipping_cost: String(parseFloat(order.shipping_cost || 0) || 0),
    discount: String(parseFloat(order.discount || 0) || 0),
    currency: order.currency || 'DZD',
    is_stopdesk: order.shipping_type === 'desk' ? 'true' : 'false',
    is_stopdesk_int: order.shipping_type === 'desk' ? '1' : '0',
    payment_method: order.payment_method || 'cod',
    notes: order.notes || '',
    item_count: String((items || []).reduce((s, i) => s + (parseInt(i.quantity) || 1), 0)),
    product_list: productList,
    weight: String((items || []).reduce((s, i) => s + (parseFloat(i.weight) || 0), 0) || 1),
  };

  const tpl = (cfg.api_create_body_template || '').trim();
  let body;
  if (tpl) {
    let filled = tpl;
    for (const [k, v] of Object.entries(subs)) {
      const safe = JSON.stringify(String(v ?? '')).slice(1, -1);
      filled = filled.split('{' + k + '}').join(safe);
    }
    for (const [k, v] of Object.entries(headersIn)) {
      const safe = JSON.stringify(String(v ?? '')).slice(1, -1);
      filled = filled.split('{' + k + '}').join(safe);
    }
    body = filled;
  } else {
    body = JSON.stringify(subs);
  }

  const method = (cfg.api_create_method || 'POST').toUpperCase();
  try {
    const r = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(20000) });
    const txt = await r.text();
    let data; try { data = JSON.parse(txt); } catch { data = null; }

    const flatten = (obj, depth=0) => {
      if (depth > 4 || obj == null) return '';
      if (typeof obj === 'string') return obj + ' ';
      if (typeof obj !== 'object') return '';
      let out = '';
      for (const v of Array.isArray(obj) ? obj : Object.values(obj)) out += flatten(v, depth+1);
      return out;
    };
    const blob = (typeof txt === 'string' ? txt : '').toLowerCase() + ' ' + flatten(data).toLowerCase();
    const authFailKeywords = [
      'invalid token','invalid api','invalid key','invalid credentials','invalid auth',
      'unauthor','authentication failed','auth failed','access denied','forbidden',
      'wrong token','wrong key','token invalid','token expir','token incorrect',
      'clé invalide','jeton invalide','erreur de token','erreur token',
      'token invalide','user_guid','utilisateur introuvable','non autorisé','non autorise',
      'permission denied','not allowed','please login','login required',
      'jwt expired','jwt malformed','bad token',
    ];
    const matched = authFailKeywords.find(k => blob.includes(k));
    if (matched) return { ok:false, err:`Carrier rejected credentials ("${matched}")`, status:r.status, carrier_response:data || txt };
    if (data && typeof data === 'object' && data.success === false) return { ok:false, err:data.message || 'Carrier returned success:false', status:r.status, carrier_response:data };
    if (!r.ok) return { ok:false, err:`Carrier rejected (HTTP ${r.status})`, status:r.status, carrier_response:data || txt };

    let tracking = '';
    if (data && cfg.api_create_tracking_path) {
      let val = data;
      for (const p of cfg.api_create_tracking_path.split('.')) { if (val == null) break; val = !isNaN(p) ? val[parseInt(p)] : val[p]; }
      if (val != null && typeof val !== 'object') tracking = String(val);
    }
    if (!tracking && data) {
      const pickFrom = (obj) => obj && (obj.tracking || obj.tracking_number || obj.tracking_id || obj.parcel_id || obj.shipment_id || obj.id || '');
      tracking = pickFrom(data) || pickFrom(Array.isArray(data) ? data[0] : null) || pickFrom(data?.data) || pickFrom(data?.result) || '';
    }
    if (!tracking) {
      return { ok:false, err:'Carrier returned no tracking number', status:r.status, carrier_response:data || txt };
    }
    return { ok:true, tracking_number:String(tracking), carrier_response:data || txt, status:r.status };
  } catch (e) {
    return { ok:false, err:e.message };
  }
}

module.exports = { carrierRequest, carrierCreateOrder };
