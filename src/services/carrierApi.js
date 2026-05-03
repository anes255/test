// ─────────────────────────────────────────────────────────────────────────────
// Carrier API client. Single entry-point used by both tracking and create-order
// flows. Per-host normalisation lives at the top of each function so we always
// hit the correct endpoint regardless of what the admin pasted into the form.
// ─────────────────────────────────────────────────────────────────────────────

const parseJson = (v) => typeof v === 'string'
  ? (() => { try { return JSON.parse(v); } catch { return {}; } })()
  : (v || {});

// Algerian wilaya name → numeric code lookup. Carriers like ZR Express,
// Procolis, NOEST and EcoTrack all want the integer wilaya id (1-58),
// not the name. We accept several spelling variants so we don't care
// which form the storefront stored.
const WILAYA_CODES = {
  'adrar':1,'chlef':2,'laghouat':3,'oum el bouaghi':4,'batna':5,'béjaïa':6,'bejaia':6,
  'biskra':7,'béchar':8,'bechar':8,'blida':9,'bouira':10,'tamanrasset':11,'tébessa':12,
  'tebessa':12,'tlemcen':13,'tiaret':14,'tizi ouzou':15,'alger':16,'algiers':16,
  'djelfa':17,'jijel':18,'sétif':19,'setif':19,'saïda':20,'saida':20,'skikda':21,
  'sidi bel abbès':22,'sidi bel abbes':22,'annaba':23,'guelma':24,'constantine':25,
  'médéa':26,'medea':26,'mostaganem':27,"m'sila":28,'msila':28,'mascara':29,
  'ouargla':30,'oran':31,'el bayadh':32,'illizi':33,'bordj bou arréridj':34,
  'bordj bou arreridj':34,'boumerdès':35,'boumerdes':35,'el tarf':36,'tindouf':37,
  'tissemsilt':38,'el oued':39,'khenchela':40,'souk ahras':41,'tipaza':42,'mila':43,
  'aïn defla':44,'ain defla':44,'naâma':45,'naama':45,'aïn témouchent':46,
  'ain temouchent':46,'ghardaïa':47,'ghardaia':47,'relizane':48,'timimoun':49,
  "el m'ghair":49,'bordj badji mokhtar':50,'ouled djellal':51,'béni abbès':52,
  'beni abbes':52,'in salah':53,'in guezzam':54,'touggourt':55,'djanet':56,
  'el mghair':57,'el meniaa':58,
};
function wilayaToCode(input) {
  if (!input) return '';
  const s = String(input).toLowerCase().trim();
  if (/^\d+$/.test(s)) return s.replace(/^0+/, '') || '0';
  // Strip leading "16-" / "16 " / "16 - "
  const stripped = s.replace(/^\s*\d+\s*[-–—.]?\s*/, '').trim();
  return String(WILAYA_CODES[stripped] || WILAYA_CODES[s] || '');
}

// Detect carrier family from base URL host. We use this to:
//   • swap in the canonical tracking/create endpoints when the admin's
//     pasted ones are wrong
//   • use the carrier-specific content-type (NOEST = form-urlencoded)
//   • walk the carrier's response shape correctly
function detectCarrier(baseUrl) {
  const host = (() => { try { return new URL(baseUrl).host.toLowerCase(); } catch { return ''; } })();
  // EcoTrack family is checked FIRST so dhd.ecotrack.dz / yalidex.ecotrack.dz
  // / any-tenant.ecotrack.dz use the EcoTrack endpoint shape, not Procolis.
  if (/ecotrack/.test(host)) return 'ecotrack';
  if (/yalidine/.test(host)) return 'yalidine';
  if (/noest|noest-dz/.test(host)) return 'noest';
  if (/procolis|zr-?express/.test(host)) return 'procolis';
  if (/maystro/.test(host)) return 'maystro';
  if (/yassir/.test(host)) return 'yassir';
  if (/aramex/.test(host)) return 'aramex';
  if (/dhl/.test(host)) return 'dhl';
  if (/fedex/.test(host)) return 'fedex';
  if (/ups/.test(host)) return 'ups';
  return 'generic';
}

// OAuth2 client-credentials cache so we don't fetch a token on every request.
const _oauthCache = new Map(); // key: tokenUrl|clientId, value: { token, expiresAt }
async function getOAuthToken(cfg) {
  const oauth = parseJson(cfg.oauth2_credentials);
  if (!cfg.oauth2_token_url || !oauth.client_id || !oauth.client_secret) {
    return { err: 'OAuth2 credentials missing' };
  }
  const cacheKey = cfg.oauth2_token_url + '|' + oauth.client_id;
  const cached = _oauthCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 30_000) return { token: cached.token };
  try {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: oauth.client_id,
      client_secret: oauth.client_secret,
    });
    const r = await fetch(cfg.oauth2_token_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body,
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) {
      return { err: 'OAuth2 token request failed: ' + (j.error_description || j.error || ('HTTP ' + r.status)) };
    }
    const ttlMs = Math.max(60_000, ((j.expires_in || 3600) - 60) * 1000);
    _oauthCache.set(cacheKey, { token: j.access_token, expiresAt: Date.now() + ttlMs });
    return { token: j.access_token };
  } catch (e) {
    return { err: 'OAuth2 token fetch failed: ' + e.message };
  }
}

function buildAuthHeaders(cfg) {
  const headersIn = parseJson(cfg.api_headers);
  const headers = { 'Accept': 'application/json' };
  if (cfg.api_auth_type === 'bearer' && cfg.api_key) headers['Authorization'] = 'Bearer ' + cfg.api_key;
  else if (cfg.api_auth_type === 'token_prefix' && cfg.api_key) headers['Authorization'] = 'Token ' + cfg.api_key;
  else if (cfg.api_auth_type === 'custom_headers') Object.assign(headers, headersIn);
  return headers;
}

function applyQueryAuth(url, cfg) {
  if (cfg.api_auth_type !== 'query_params') return url;
  const queryIn = parseJson(cfg.api_query_params);
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(queryIn)) if (v) params.set(k, v);
  if (!params.toString()) return url;
  return url + (url.includes('?') ? '&' : '?') + params.toString();
}

// ─── carrierRequest ─────────────────────────────────────────────────────────
// Used for tracking lookups + list/sync probes. Honours per-carrier overrides
// so callers can rely on it producing the right call shape for known hosts.
async function carrierRequest(cfg, trackingNumber, bodyOverride) {
  const tn = trackingNumber || 'TEST00000';
  const carrier = detectCarrier(cfg.api_base_url || '');
  const headers = { 'Content-Type': 'application/json', ...buildAuthHeaders(cfg) };

  if (cfg.api_auth_type === 'oauth2') {
    const t = await getOAuthToken(cfg);
    if (t.err) return { ok: false, err: t.err };
    headers['Authorization'] = 'Bearer ' + t.token;
  }

  // Per-carrier endpoint normalisation: prefer canonical paths over
  // anything the admin may have pasted. This also fixes the common
  // pattern where the admin picked a preset that's slightly off.
  let path = cfg.api_tracking_endpoint || '';
  let method = (cfg.api_method || cfg.method || 'GET').toUpperCase();
  let body = bodyOverride || undefined;

  if (carrier === 'yalidine') {
    if (tn && tn !== 'TEST00000') path = `/parcels/${encodeURIComponent(tn)}/`;
    method = 'GET';
    body = undefined;
  } else if (carrier === 'procolis') {
    path = '/lire';
    method = 'POST';
    body = JSON.stringify({ Colis: tn ? [{ Tracking: tn }] : [] });
  } else if (carrier === 'ecotrack') {
    if (tn && tn !== 'TEST00000') path = `/get/tracking/${encodeURIComponent(tn)}`;
    else path = path || '/get/orders';
    method = 'GET';
    body = undefined;
  } else if (carrier === 'noest') {
    if (tn && tn !== 'TEST00000') {
      // NOEST returns tracking info via POST /get/trackings with form body.
      path = '/get/trackings';
      method = 'POST';
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      const form = new URLSearchParams();
      const q = parseJson(cfg.api_query_params);
      if (q.api_token) form.set('api_token', q.api_token);
      if (q.user_guid) form.set('user_guid', q.user_guid);
      form.set('trackings[]', tn);
      body = form.toString();
    } else {
      // Auth probe (no tracking number). Make sure POSTs to NOEST go out as
      // form-urlencoded — JSON gets a generic 200 {"message":""} regardless
      // of credentials, which makes auth verification impossible.
      if ((cfg.api_method || method) === 'POST') {
        method = 'POST';
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        body = '';
      }
    }
  } else if (carrier === 'maystro') {
    if (tn && tn !== 'TEST00000') path = `/orders/?display_id=${encodeURIComponent(tn)}`;
    method = 'GET';
    body = undefined;
  } else if (carrier === 'dhl') {
    path = `?trackingNumber=${encodeURIComponent(tn)}`;
    method = 'GET';
    body = undefined;
  } else if (carrier === 'ups') {
    path = `/track/v1/details/${encodeURIComponent(tn)}`;
    method = 'GET';
    body = undefined;
  } else if (carrier === 'fedex') {
    path = '/track/v1/trackingnumbers';
    method = 'POST';
    body = JSON.stringify({ trackingInfo: [{ trackingNumberInfo: { trackingNumber: tn } }], includeDetailedScans: false });
  } else {
    // Generic fallback: substitute placeholders in admin-provided endpoint.
    path = path.replace(/\{tracking_number\}/g, encodeURIComponent(tn))
               .replace(/\{number\}/g, encodeURIComponent(tn))
               .replace(/\{tn\}/g, encodeURIComponent(tn));
    if (!body && method !== 'GET' && cfg.api_body_template) {
      const headersIn = parseJson(cfg.api_headers);
      let tpl = cfg.api_body_template.replace(/\{tracking_number\}/g, tn);
      for (const [k, v] of Object.entries(headersIn)) tpl = tpl.split('{' + k + '}').join(String(v || ''));
      body = tpl;
    }
  }

  let url = (cfg.api_base_url || '').replace(/\/$/, '');
  if (path) url += (path.startsWith('/') || path.startsWith('?')) ? path : ('/' + path);
  url = applyQueryAuth(url, cfg);

  try {
    const r = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(15000) });
    const txt = await r.text();
    return { ok: r.ok, status: r.status, body: txt, url };
  } catch (e) {
    return { ok: false, err: e.message, url };
  }
}

// ─── carrierCreateOrder ─────────────────────────────────────────────────────
// Pushes one of OUR orders into the carrier's system. Returns the carrier's
// tracking number on success so we can persist it and start polling status.
async function carrierCreateOrder(cfg, order, items) {
  const carrier = detectCarrier(cfg.api_base_url || '');
  const headers = { 'Content-Type': 'application/json', ...buildAuthHeaders(cfg) };

  if (cfg.api_auth_type === 'oauth2') {
    const t = await getOAuthToken(cfg);
    if (t.err) return { ok: false, err: t.err };
    headers['Authorization'] = 'Bearer ' + t.token;
  }

  // Per-carrier canonical endpoint + method.
  let path = cfg.api_create_endpoint || '';
  let method = (cfg.api_create_method || 'POST').toUpperCase();
  if (carrier === 'yalidine') path = '/parcels/';
  else if (carrier === 'procolis') path = '/add_colis';
  else if (carrier === 'ecotrack') path = '/create/order';
  else if (carrier === 'noest') path = '/create/order';
  else if (carrier === 'maystro') path = '/orders/';

  if (!path) return { ok: false, err: 'No create-order endpoint configured' };

  let url = (cfg.api_base_url || '').replace(/\/$/, '');
  url += (path.startsWith('/') || path.startsWith('?')) ? path : ('/' + path);
  url = applyQueryAuth(url, cfg);

  const productList = (items || []).map(i => `${i.product_name || i.name || 'Item'} ×${i.quantity || 1}`).join(', ');
  const fullName = (order.customer_name || '').trim();
  const nameParts = fullName.split(/\s+/);
  const totalNum = parseFloat(order.total || 0) || 0;
  const itemCount = (items || []).reduce((s, i) => s + (parseInt(i.quantity) || 1), 0) || 1;
  const weightNum = (items || []).reduce((s, i) => s + (parseFloat(i.weight) || 0), 0) || 1;
  const isStopdesk = order.shipping_type === 'desk';
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
    wilaya_code: String(order.shipping_wilaya_code || wilayaToCode(order.shipping_wilaya) || (order.shipping_zip ? order.shipping_zip.slice(0, 2).replace(/^0+/, '') : '') || ''),
    total: String(totalNum),
    subtotal: String(parseFloat(order.subtotal || 0) || 0),
    shipping_cost: String(parseFloat(order.shipping_cost || 0) || 0),
    discount: String(parseFloat(order.discount || 0) || 0),
    currency: order.currency || 'DZD',
    is_stopdesk: isStopdesk ? 'true' : 'false',
    is_stopdesk_int: isStopdesk ? '1' : '0',
    payment_method: order.payment_method || 'cod',
    notes: order.notes || '',
    item_count: String(itemCount),
    product_list: productList,
    weight: String(weightNum),
  };

  // Build the request body. NOEST uses form-encoded; others use JSON.
  let body;
  if (carrier === 'noest') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const f = new URLSearchParams();
    f.set('reference', subs.order_id);
    f.set('client', subs.customer_name);
    f.set('phone', subs.customer_phone);
    f.set('adresse', subs.shipping_address);
    f.set('wilaya_id', subs.wilaya_code);
    f.set('commune', subs.shipping_city);
    f.set('montant', subs.total);
    f.set('remarque', subs.notes);
    f.set('produit', subs.product_list);
    f.set('type_id', '1');
    f.set('poids', subs.weight);
    f.set('stop_desk', subs.is_stopdesk_int);
    f.set('stock', '0');
    f.set('quantite', subs.item_count);
    f.set('can_open', '1');
    body = f.toString();
  } else {
    let tpl = (cfg.api_create_body_template || '').trim();
    // Fallback bodies for known carriers when the admin didn't fill a template.
    if (!tpl) {
      if (carrier === 'yalidine') {
        tpl = '[{"order_id":"{order_id}","firstname":"{customer_firstname}","familyname":"{customer_lastname}","contact_phone":"{customer_phone}","address":"{shipping_address}","to_commune_name":"{shipping_city}","to_wilaya_name":"{shipping_wilaya}","product_list":"{product_list}","price":{total},"do_insurance":false,"declared_value":{total},"freeshipping":false,"is_stopdesk":{is_stopdesk},"has_exchange":0,"product_to_collect":null}]';
      } else if (carrier === 'procolis') {
        tpl = '{"Colis":[{"Tracking":"{order_id}","TypeLivraison":"{is_stopdesk_int}","TypeColis":"0","Confrimee":"","Client":"{customer_name}","MobileA":"{customer_phone}","MobileB":"","Adresse":"{shipping_address}","IDWilaya":"{wilaya_code}","Commune":"{shipping_city}","Total":"{total}","Note":"{notes}","TProduit":"{product_list}","id_Externe":"{order_id}","Source":""}]}';
      } else if (carrier === 'ecotrack') {
        tpl = '{"reference":"{order_id}","nom_client":"{customer_name}","telephone":"{customer_phone}","adresse":"{shipping_address}","code_wilaya":"{wilaya_code}","commune":"{shipping_city}","montant":"{total}","remarque":"{notes}","produit":"{product_list}","type":1,"stop_desk":{is_stopdesk_int},"quantite":{item_count}}';
      } else if (carrier === 'maystro') {
        tpl = '{"customer_name":"{customer_name}","customer_phone":"{customer_phone}","destination_text":"{shipping_address}","commune":"{shipping_city}","wilaya":"{shipping_wilaya}","product_price":{total},"products":[{"product_name":"{product_list}","quantity":{item_count},"product_id":""}],"display_id":"{order_id}","note_to_driver":"{notes}","express":false,"source":"api"}';
      }
    }
    if (tpl) {
      let filled = tpl;
      for (const [k, v] of Object.entries(subs)) {
        const safe = JSON.stringify(String(v ?? '')).slice(1, -1);
        filled = filled.split('{' + k + '}').join(safe);
      }
      const headersIn = parseJson(cfg.api_headers);
      for (const [k, v] of Object.entries(headersIn)) {
        const safe = JSON.stringify(String(v ?? '')).slice(1, -1);
        filled = filled.split('{' + k + '}').join(safe);
      }
      body = filled;
    } else {
      body = JSON.stringify(subs);
    }
  }

  try {
    const r = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(20000) });
    const txt = await r.text();
    let data; try { data = JSON.parse(txt); } catch { data = null; }

    const flatten = (obj, depth = 0) => {
      if (depth > 4 || obj == null) return '';
      if (typeof obj === 'string') return obj + ' ';
      if (typeof obj !== 'object') return '';
      let out = '';
      for (const v of Array.isArray(obj) ? obj : Object.values(obj)) out += flatten(v, depth + 1);
      return out;
    };
    const blob = (typeof txt === 'string' ? txt : '').toLowerCase() + ' ' + flatten(data).toLowerCase();
    const authFailKeywords = [
      'invalid token', 'invalid api', 'invalid key', 'invalid credentials', 'invalid auth',
      'unauthor', 'authentication failed', 'auth failed', 'access denied', 'forbidden',
      'wrong token', 'wrong key', 'token invalid', 'token expir', 'token incorrect',
      'clé invalide', 'jeton invalide', 'erreur de token', 'erreur token',
      'token invalide', 'utilisateur introuvable', 'non autorisé', 'non autorise',
      'permission denied', 'not allowed', 'please login', 'login required',
      'jwt expired', 'jwt malformed', 'bad token',
    ];
    const matched = authFailKeywords.find(k => blob.includes(k));
    if (matched) return { ok: false, err: `Carrier rejected credentials ("${matched}")`, status: r.status, carrier_response: data || txt };
    if (data && typeof data === 'object' && data.success === false) return { ok: false, err: data.message || 'Carrier returned success:false', status: r.status, carrier_response: data };
    if (!r.ok) return { ok: false, err: `Carrier rejected (HTTP ${r.status}): ${String(txt).slice(0, 160)}`, status: r.status, carrier_response: data || txt };

    // Pull the tracking number out of the carrier's response.
    let tracking = '';
    if (data && cfg.api_create_tracking_path) {
      let val = data;
      for (const p of cfg.api_create_tracking_path.split('.')) { if (val == null) break; val = !isNaN(p) ? val[parseInt(p)] : val[p]; }
      if (val != null && typeof val !== 'object') tracking = String(val);
    }
    if (!tracking && data) {
      // Carrier-specific extraction so we don't depend on the admin filling
      // create_tracking_path correctly.
      if (carrier === 'yalidine') {
        // Yalidine returns an OBJECT keyed by order_id:
        //   {"REF123":{success:true,tracking:"yal-XXX",order_id:"REF123",...}}
        // Sometimes wrapped in an array if the request was an array of one.
        const root = Array.isArray(data) ? data[0] : data;
        if (root && typeof root === 'object') {
          const first = Object.values(root)[0];
          if (first && typeof first === 'object') {
            if (first.success === false) {
              return { ok: false, err: first.message || 'Yalidine rejected the parcel', status: r.status, carrier_response: data };
            }
            tracking = first.tracking || first.tracking_number || '';
          }
        }
      } else if (carrier === 'procolis') {
        const arr = data.Colis || data;
        if (Array.isArray(arr) && arr[0]) tracking = arr[0].Tracking || arr[0].tracking || '';
      } else if (carrier === 'noest') {
        tracking = data.tracking || data.tracking_number || data.reference || '';
      } else if (carrier === 'ecotrack') {
        tracking = data.tracking || data.tracking_number || (data.data && data.data.tracking) || '';
      } else if (carrier === 'maystro') {
        tracking = data.display_id || data.id || data.tracking_id || '';
      }
      if (!tracking) {
        const pickFrom = (obj) => obj && (obj.tracking || obj.tracking_number || obj.tracking_id || obj.parcel_id || obj.shipment_id || obj.id || '');
        tracking = pickFrom(data) || pickFrom(Array.isArray(data) ? data[0] : null) || pickFrom(data?.data) || pickFrom(data?.result) || '';
      }
    }
    if (!tracking) return { ok: false, err: 'Carrier returned no tracking number. Response: ' + String(txt).slice(0, 160), status: r.status, carrier_response: data || txt };
    return { ok: true, tracking_number: String(tracking), carrier_response: data || txt, status: r.status };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}

// Carrier-specific status path resolver. Used by tracking poller so the admin
// doesn't have to know each carrier's exact JSON tree.
function extractStatus(cfg, data) {
  const carrier = detectCarrier(cfg.api_base_url || '');
  const walk = (obj, path) => {
    let v = obj;
    for (const p of String(path).split('.')) { if (v == null) break; v = !isNaN(p) ? v[parseInt(p)] : v[p]; }
    return v;
  };
  const tryPaths = (obj, paths) => {
    for (const p of paths) {
      const v = walk(obj, p);
      if (v != null && typeof v !== 'object') return String(v);
    }
    return null;
  };
  const carrierPaths = {
    yalidine: ['last_status', 'data.0.last_status'],
    procolis: ['0.Situation', 'Colis.0.Situation'],
    ecotrack: ['data.activity.0.event', 'data.0.activity.0.event', 'data.last_situation', 'data.status'],
    noest: ['0.last_situation', 'data.last_situation', '0.situation', 'data.0.situation'],
    maystro: ['list.0.status_display', 'list.0.status', 'data.status_display'],
    dhl: ['shipments.0.status.description', 'shipments.0.status.statusCode'],
    fedex: ['output.completeTrackResults.0.trackResults.0.latestStatusDetail.description'],
    ups: ['trackResponse.shipment.0.package.0.activity.0.status.description'],
    aramex: ['TrackingResults.0.Value.0.UpdateDescription'],
  };
  const fromCarrier = carrierPaths[carrier] ? tryPaths(data, carrierPaths[carrier]) : null;
  if (fromCarrier) return fromCarrier;
  if (cfg.api_status_path) {
    const v = walk(data, cfg.api_status_path);
    if (v != null && typeof v !== 'object') return String(v);
  }
  // Last-resort: any top-level "status" / "last_status" string.
  if (data && typeof data === 'object') {
    if (typeof data.last_status === 'string') return data.last_status;
    if (typeof data.status === 'string') return data.status;
    if (Array.isArray(data) && data[0] && typeof data[0] === 'object') {
      return data[0].last_status || data[0].Situation || data[0].status_display || data[0].status || null;
    }
  }
  return null;
}

// ─── carrierDeleteOrder ─────────────────────────────────────────────────────
// Best-effort cleanup of a test parcel created by the dispatch probe so the
// admin's real carrier account doesn't accumulate fake orders. Each carrier
// has its own delete/cancel endpoint shape; failure here is non-fatal.
async function carrierDeleteOrder(cfg, trackingNumber) {
  if (!trackingNumber) return { ok: false, err: 'No tracking number' };
  const carrier = detectCarrier(cfg.api_base_url || '');
  const headers = { 'Content-Type': 'application/json', ...buildAuthHeaders(cfg) };
  if (cfg.api_auth_type === 'oauth2') {
    const t = await getOAuthToken(cfg);
    if (t.err) return { ok: false, err: t.err };
    headers['Authorization'] = 'Bearer ' + t.token;
  }
  let url = (cfg.api_base_url || '').replace(/\/$/, '');
  let method = 'DELETE';
  let body;
  if (carrier === 'yalidine') {
    url += `/parcels/${encodeURIComponent(trackingNumber)}/`;
  } else if (carrier === 'noest') {
    url += `/delete/order/${encodeURIComponent(trackingNumber)}`;
    method = 'POST';
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const q = parseJson(cfg.api_query_params);
    const f = new URLSearchParams();
    if (q.api_token) f.set('api_token', q.api_token);
    if (q.user_guid) f.set('user_guid', q.user_guid);
    body = f.toString();
  } else if (carrier === 'ecotrack') {
    url += `/cancel/order/${encodeURIComponent(trackingNumber)}`;
    method = 'POST';
  } else if (carrier === 'procolis') {
    url += '/supprimer';
    method = 'POST';
    body = JSON.stringify({ Colis: [{ Tracking: trackingNumber }] });
  } else if (carrier === 'maystro') {
    url += `/orders/${encodeURIComponent(trackingNumber)}/`;
    method = 'DELETE';
  } else {
    return { ok: false, err: 'No delete endpoint for this carrier' };
  }
  url = applyQueryAuth(url, cfg);
  try {
    const r = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(10000) });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}

module.exports = { carrierRequest, carrierCreateOrder, carrierDeleteOrder, detectCarrier, extractStatus, wilayaToCode };
