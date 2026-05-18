// ─────────────────────────────────────────────────────────────────────────────
// Carrier API client. Single entry-point used by both tracking and create-order
// flows. Per-host normalisation lives at the top of each function so we always
// hit the correct endpoint regardless of what the admin pasted into the form.
// ─────────────────────────────────────────────────────────────────────────────

const parseJson = (v) => typeof v === 'string'
  ? (() => { try { return JSON.parse(v); } catch { return {}; } })()
  : (v || {});

// Algerian wilaya name → numeric code lookup. Carriers like ZR Express,
// Procolis, NOEST and EcoTrack (incl. DHD) all want the integer wilaya id (1-58),
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
//   • use the carrier-specific content-type
//   • walk the carrier's response shape correctly
function detectCarrier(baseUrl) {
  const host = (() => { try { return new URL(baseUrl).host.toLowerCase(); } catch { return ''; } })();
  // EcoTrack family is checked FIRST so dhd.ecotrack.dz / yalidex.ecotrack.dz
  // / any-tenant.ecotrack.dz use the EcoTrack endpoint shape, not Procolis.
  if (/noest/.test(host)) return 'noest';
  if (/ecotrack/.test(host)) return 'ecotrack';
  if (/yalidine/.test(host)) return 'yalidine';
  if (/procolis|zr-?express/.test(host)) return 'procolis';
  if (/maystro/.test(host)) return 'maystro';
  if (/yassir/.test(host)) return 'yassir';
  if (/aramex/.test(host)) return 'aramex';
  if (/dhl/.test(host)) return 'dhl';
  if (/fedex/.test(host)) return 'fedex';
  if (/ups/.test(host)) return 'ups';
  return 'generic';
}

// ─── normalizeConfig ────────────────────────────────────────────────────────
// Auto-migrate legacy NOEST configs. Old presets had /api/public/v1 base and
// query_params auth. Real API uses /api/public paths, Bearer header + user_guid
// in body. We fix the base URL and migrate credentials.
function normalizeConfig(cfg) {
  const host = (() => { try { return new URL(cfg.api_base_url || '').host.toLowerCase(); } catch { return ''; } })();
  if (/noest/.test(host)) {
    let patched = { ...cfg };
    // Migrate api_token from query_params → api_key (Bearer)
    if (!patched.api_key || patched.api_auth_type === 'query_params') {
      const q = parseJson(patched.api_query_params);
      if (q.api_token && !patched.api_key) patched.api_key = q.api_token;
      patched.api_auth_type = 'bearer';
    }
    // Fix base URL to origin (all NOEST paths start with /api/public/...)
    try { patched.api_base_url = new URL(patched.api_base_url).origin; } catch {}
    return patched;
  }
  return cfg;
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
async function carrierRequest(rawCfg, trackingNumber, bodyOverride) {
  const cfg = normalizeConfig(rawCfg);
  const tn = trackingNumber || 'TEST00000';
  const carrier = detectCarrier(cfg.api_base_url || '');
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Accept-Language': 'fr,en;q=0.9,ar;q=0.8',
    'User-Agent': 'MakretDZ/1.0 (+https://makretdz.com)',
    ...buildAuthHeaders(cfg),
  };

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
  } else if (carrier === 'noest') {
    // NOEST Public API v2.3: POST /api/public/get/trackings/info with JSON body
    const q = parseJson(cfg.api_query_params);
    const userGuid = q.user_guid || '';
    if (tn && tn !== 'TEST00000') {
      path = '/api/public/get/trackings/info';
      method = 'POST';
      body = JSON.stringify({ trackings: [tn] });
    } else {
      // No list-all endpoint — use /api/public/get/wilayas as connectivity test
      path = '/api/public/get/wilayas';
      method = 'GET';
      body = undefined;
    }
  } else if (carrier === 'ecotrack') {
    if (tn && tn !== 'TEST00000') path = `/get/tracking/info?tracking=${encodeURIComponent(tn)}`;
    else path = path || '/get/orders?page=1';
    method = 'GET';
    body = undefined;
    if (/validate\/token/.test(path) && cfg.api_key) {
      path += (path.includes('?') ? '&' : '?') + 'api_token=' + encodeURIComponent(cfg.api_key);
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
  // EcoTrack (non-NOEST) expects api_token as query param
  const host = (() => { try { return new URL(url).host.toLowerCase(); } catch { return ''; } })();
  if (carrier === 'ecotrack' && !/noest/.test(host) && cfg.api_key && !url.includes('api_token'))
    url += (url.includes('?') ? '&' : '?') + 'api_token=' + encodeURIComponent(cfg.api_key);

  try {
    console.log(`[carrierRequest] ${carrier} ${method} ${url}`);
    let r = await fetch(url, { method, headers, body, redirect: method === 'POST' ? 'manual' : 'follow', signal: AbortSignal.timeout(15000) });
    if (method === 'POST' && [301,302,303,307,308].includes(r.status)) {
      const loc = r.headers.get('location');
      if (loc) {
        const redir = loc.startsWith('http') ? loc : new URL(loc, url).href;
        console.log(`[carrierRequest] ${carrier} redirect ${r.status} → ${redir} (re-POSTing)`);
        r = await fetch(redir, { method: 'POST', headers, body, redirect: 'follow', signal: AbortSignal.timeout(15000) });
      }
    }
    const txt = await r.text();
    console.log(`[carrierRequest] ${carrier} ← HTTP ${r.status} | ${txt.slice(0, 200)}`);
    return { ok: r.ok, status: r.status, body: txt, url };
  } catch (e) {
    console.error(`[carrierRequest] ${carrier} ERROR: ${e.message}`);
    return { ok: false, err: e.message, url };
  }
}

// ─── resolveCommuneAndStation ───────────────────────────────────────────────
// Pre-flight call for EcoTrack & NOEST: fetch communes for a wilaya, pick the
// active commune that best matches the input name, and if desk delivery is
// requested return a station_code too. Prevents the "Commune mal écrite, ou
// désactivée" / "stop_desk required" errors that would otherwise force the
// fallback path to silently downgrade desk orders to home delivery.
async function resolveCommuneAndStation(baseUrl, headers, wilayaCode, communeName, cfg, carrier, isStopdesk) {
  const out = { commune: communeName, station_code: '', resolved: false };
  try {
    const communesUrl = carrier === 'ecotrack'
      ? baseUrl + '/get/communes/' + wilayaCode + (cfg.api_key ? '?api_token=' + encodeURIComponent(cfg.api_key) : '')
      : baseUrl + '/api/public/get/communes/' + wilayaCode;
    const r = await fetch(communesUrl, { method: 'GET', headers, signal: AbortSignal.timeout(10000) });
    if (!r.ok) {
      console.log(`[resolveCommune] ${carrier} GET ${communesUrl} → HTTP ${r.status}`);
      return out;
    }
    const txt = await r.text();
    let data; try { data = JSON.parse(txt); } catch { return out; }
    const arr = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : (Array.isArray(data?.communes) ? data.communes : []));
    if (!arr.length) {
      console.log(`[resolveCommune] ${carrier} no communes returned for wilaya ${wilayaCode}`);
      return out;
    }
    const isActive = (c) => {
      if (c.is_active === 0 || c.is_active === false) return false;
      if (c.is_deliverable === 0 || c.is_deliverable === false) return false;
      return true;
    };
    const hasDesk = (c) => c.has_stop_desk === 1 || c.has_stop_desk === true || c.stop_desk === 1 || c.stop_desk === true;
    const getName = (c) => c.commune || c.name || c.nom || '';
    const getStation = (c) => c.station_code || c.code_station || c.code || c.station_id || '';
    const normalize = (s) => String(s || '').toLowerCase().trim()
      .replace(/é|è|ê|ë/g, 'e').replace(/à|â|ä/g, 'a').replace(/ù|û|ü/g, 'u')
      .replace(/ô|ö/g, 'o').replace(/î|ï/g, 'i').replace(/ç/g, 'c')
      .replace(/[''`\-_\s]+/g, '');
    const inputNorm = normalize(communeName);
    if (!inputNorm) return out;
    // Build candidate pool. If desk requested, only consider communes that
    // support desk delivery. Otherwise prefer active communes.
    let pool = isStopdesk ? arr.filter(c => isActive(c) && hasDesk(c)) : arr.filter(isActive);
    if (!pool.length) pool = arr; // fall back to full list rather than nothing
    // Exact (normalized) match first
    let pick = pool.find(c => normalize(getName(c)) === inputNorm);
    if (!pick) {
      // Fuzzy: prefix / contains / shared-char similarity
      let bestScore = 0;
      for (const c of pool) {
        const cn = normalize(getName(c));
        if (!cn) continue;
        let score = 0;
        if (cn === inputNorm) score = 100;
        else if (cn.startsWith(inputNorm) || inputNorm.startsWith(cn)) score = 85 - Math.abs(cn.length - inputNorm.length);
        else if (cn.includes(inputNorm) || inputNorm.includes(cn)) score = 70 - Math.abs(cn.length - inputNorm.length);
        else {
          const shorter = inputNorm.length < cn.length ? inputNorm : cn;
          const longer  = inputNorm.length < cn.length ? cn : inputNorm;
          let matching = 0;
          for (let i = 0; i < shorter.length; i++) if (longer.includes(shorter[i])) matching++;
          score = (matching / Math.max(longer.length, 1)) * 60;
        }
        if (score > bestScore) { bestScore = score; pick = c; }
      }
      if (bestScore < 30) pick = null;
    }
    if (pick) {
      out.commune = getName(pick) || communeName;
      out.resolved = true;
      if (isStopdesk) out.station_code = String(getStation(pick) || '');
      console.log(`[resolveCommune] ${carrier} "${communeName}" → "${out.commune}" station="${out.station_code}"`);
    } else {
      console.log(`[resolveCommune] ${carrier} no match for "${communeName}" in wilaya ${wilayaCode} (${arr.length} candidates)`);
    }
  } catch (e) {
    console.log(`[resolveCommune] ${carrier} error: ${e.message}`);
  }
  return out;
}

// ─── carrierCreateOrder ─────────────────────────────────────────────────────
// Pushes one of OUR orders into the carrier's system. Returns the carrier's
// tracking number on success so we can persist it and start polling status.
async function carrierCreateOrder(rawCfg, order, items) {
  const cfg = normalizeConfig(rawCfg);
  const carrier = detectCarrier(cfg.api_base_url || '');
  const baseUrl = (cfg.api_base_url || '').replace(/\/$/, '');

  // ── Auth headers ──
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Accept-Language': 'fr,en;q=0.9,ar;q=0.8',
    'User-Agent': 'MakretDZ/1.0 (+https://makretdz.com)',
    ...buildAuthHeaders(cfg),
  };
  if (cfg.api_auth_type === 'oauth2') {
    const t = await getOAuthToken(cfg);
    if (t.err) return { ok: false, err: t.err };
    headers['Authorization'] = 'Bearer ' + t.token;
  }

  // ── Endpoint resolution ──
  // For known carriers, always use the canonical endpoint (ignore stale DB values).
  let path;
  if (carrier === 'yalidine') path = '/parcels/';
  else if (carrier === 'noest') path = '/api/public/create/order';
  else if (carrier === 'procolis') path = '/add_colis';
  else if (carrier === 'ecotrack') path = '/create/order';
  else if (carrier === 'maystro') path = '/orders/';
  else {
    path = (cfg.api_create_endpoint || '').trim();
    if (!path) return { ok: false, err: 'No create-order endpoint configured for this carrier' };
  }

  // ── Build substitution variables ──
  const productList = (items || []).map(i => `${i.product_name || i.name || 'Item'} ×${i.quantity || 1}`).join(', ');
  const fullName = (order.customer_name || '').trim();
  const nameParts = fullName.split(/\s+/);
  const totalNum = parseFloat(order.total || 0) || 0;
  const itemCount = (items || []).reduce((s, i) => s + (parseInt(i.quantity) || 1), 0) || 1;
  const weightNum = (items || []).reduce((s, i) => s + (parseFloat(i.weight) || 0), 0) || 1;
  const isStopdesk = order.shipping_type === 'desk';
  const subs = {
    tracking_number: order.tracking_number || '',
    order_id: String(order.order_number || order.id || ''),
    customer_name: fullName,
    customer_firstname: nameParts[0] || fullName,
    customer_lastname: nameParts.slice(1).join(' ') || fullName,
    customer_phone: (order.customer_phone || '').replace(/[^\d+]/g, ''),
    customer_email: order.customer_email || '',
    shipping_address: order.shipping_address || '',
    shipping_city: order.shipping_city || order.shipping_wilaya || '',
    shipping_wilaya: order.shipping_wilaya || '',
    shipping_zip: order.shipping_zip || '',
    wilaya_code: String(order.shipping_wilaya_code || wilayaToCode(order.shipping_wilaya) || (order.shipping_zip ? order.shipping_zip.slice(0, 2).replace(/^0+/, '') : '') || '0'),
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

  // ── Build request body per carrier ──
  // For known carriers, ALWAYS use the canonical body format regardless of
  // what may be stored in the DB (stale presets had wrong field types).
  let body;
  if (carrier === 'noest') {
    // NOEST Public API v2.3 — JSON body with user_guid
    const q = parseJson(cfg.api_query_params);
    const userGuid = q.user_guid || '';
    const noestBody = {
      user_guid: userGuid,
      reference: subs.order_id.padStart(5, '0'),
      client: subs.customer_name,
      phone: subs.customer_phone,
      phone_2: '',
      adresse: subs.shipping_address,
      montant: (subs.payment_method && subs.payment_method !== 'cod')
        ? (parseFloat(subs.shipping_cost) || 0)
        : (parseFloat(subs.total) || parseFloat(subs.subtotal) || 0),
      remarque: subs.notes || '',
      produit: subs.product_list || 'Commande',
      type_id: 1, // 1=Delivery (home or stop_desk). 2=Exchange. 3=Pick-up (forces amount=0, never use for delivery)
      poids: parseFloat(subs.weight) || 0,
      stop_desk: isStopdesk ? 1 : 0,
      stock: 0,
      quantite: String(subs.item_count),
      can_open: 1,
    };
    // Always send wilaya_id + commune (zip_code unreliable on NOEST)
    noestBody.wilaya_id = parseInt(subs.wilaya_code) || 16;
    // Pre-flight: resolve commune name (fix misspellings) and station_code for desk
    const resolvedN = await resolveCommuneAndStation(baseUrl, headers, noestBody.wilaya_id, subs.shipping_city, cfg, 'noest', isStopdesk);
    noestBody.commune = resolvedN.commune || subs.shipping_city;
    if (isStopdesk && resolvedN.station_code) noestBody.station_code = resolvedN.station_code;
    body = JSON.stringify(noestBody);
  } else if (carrier === 'ecotrack') {
    const ecoWilaya = parseInt(subs.wilaya_code) || 16;
    // Pre-flight: resolve commune name (fix misspellings) and station_code for desk
    const resolvedE = await resolveCommuneAndStation(baseUrl, headers, ecoWilaya, subs.shipping_city, cfg, 'ecotrack', isStopdesk);
    const ecoBody = {
      reference: subs.order_id,
      nom_client: subs.customer_name,
      telephone: subs.customer_phone,
      telephone_2: '',
      adresse: subs.shipping_address,
      code_wilaya: ecoWilaya,
      commune: resolvedE.commune || subs.shipping_city,
      montant: (subs.payment_method && subs.payment_method !== 'cod')
        ? (parseFloat(subs.shipping_cost) || 0)
        : (parseFloat(subs.total) || parseFloat(subs.subtotal) || 0),
      remarque: subs.notes || subs.product_list,
      produit: subs.product_list || 'Commande',
      stock: 0,
      quantite: String(subs.item_count),
      type: 1, // 1=Delivery, 2=Exchange, 3=Pickup — desk vs home is controlled by stop_desk
      stop_desk: isStopdesk ? 1 : 0,
      weight: subs.weight,
      fragile: 0,
    };
    if (isStopdesk && resolvedE.station_code) ecoBody.station_code = resolvedE.station_code;
    body = JSON.stringify(ecoBody);
  } else {
    let tpl = (cfg.api_create_body_template || '').trim();
    if (!tpl) {
      if (carrier === 'yalidine') {
        tpl = '[{"order_id":"{order_id}","firstname":"{customer_firstname}","familyname":"{customer_lastname}","contact_phone":"{customer_phone}","address":"{shipping_address}","to_commune_name":"{shipping_city}","to_wilaya_name":"{shipping_wilaya}","product_list":"{product_list}","price":{total},"do_insurance":false,"declared_value":{total},"freeshipping":false,"is_stopdesk":{is_stopdesk},"has_exchange":0,"product_to_collect":null}]';
      } else if (carrier === 'procolis') {
        tpl = '{"Colis":[{"Tracking":"{order_id}","TypeLivraison":"{is_stopdesk_int}","TypeColis":"0","Confrimee":"","Client":"{customer_name}","MobileA":"{customer_phone}","MobileB":"","Adresse":"{shipping_address}","IDWilaya":"{wilaya_code}","Commune":"{shipping_city}","Total":"{total}","Note":"{notes}","TProduit":"{product_list}","id_Externe":"{order_id}","Source":""}]}';
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

  // ── Build candidate URLs (primary + fallbacks) ──
  const buildUrl = (p) => {
    let u = baseUrl;
    if (p.startsWith('/api/')) { try { u = new URL(baseUrl).origin; } catch {} }
    u += p.startsWith('/') || p.startsWith('?') ? p : ('/' + p);
    u = applyQueryAuth(u, cfg);
    // EcoTrack (non-NOEST) expects api_token as query param
    const bHost = (() => { try { return new URL(u).host.toLowerCase(); } catch { return ''; } })();
    if (carrier === 'ecotrack' && !/noest/.test(bHost) && cfg.api_key && !u.includes('api_token'))
      u += (u.includes('?') ? '&' : '?') + 'api_token=' + encodeURIComponent(cfg.api_key);
    return u;
  };

  const fallbacks = {
    noest: ['/api/public/create/order'],
    ecotrack: ['/create/order'],
    yalidine: ['/parcels/'],
    procolis: ['/add_colis'],
    maystro: ['/orders/'],
  };
  const allPaths = [path, ...(fallbacks[carrier] || []).filter(p => p !== path)];

  // ── Execute request with fallback ──
  const doPost = async (postBody) => {
    let r, txt = '', tried = [], finalUrl = '';
    for (const pp of allPaths) {
      const candidateUrl = buildUrl(pp);
      finalUrl = candidateUrl;
      console.log(`[carrierCreateOrder] ${carrier} → POST ${candidateUrl}`);
      r = await fetch(candidateUrl, { method: 'POST', headers, body: postBody, redirect: 'manual', signal: AbortSignal.timeout(25000) });
      if ([301,302,303,307,308].includes(r.status)) {
        const loc = r.headers.get('location');
        if (loc) {
          const redir = loc.startsWith('http') ? loc : new URL(loc, candidateUrl).href;
          console.log(`[carrierCreateOrder] ${carrier} redirect ${r.status} → ${redir} (re-POSTing)`);
          r = await fetch(redir, { method: 'POST', headers, body: postBody, redirect: 'follow', signal: AbortSignal.timeout(25000) });
        }
      }
      txt = await r.text();
      tried.push({ url: candidateUrl, status: r.status, snippet: String(txt).slice(0, 200) });
      console.log(`[carrierCreateOrder] ${carrier} ← HTTP ${r.status} | ${String(txt).slice(0, 200)}`);
      if (r.status === 404 && (!txt.trim() || /^\s*\{\s*"message"\s*:\s*""\s*\}/.test(txt) || /not.?found|no.?route/i.test(txt))) continue;
      break;
    }
    return { r, txt, tried, finalUrl };
  };

  let r, txt = '', tried = [];
  let finalUrl = '';
  try {
    ({ r, txt, tried, finalUrl } = await doPost(body));

    // Auto-retry with corrected commune if carrier rejects it
    if (r && (r.status === 422 || r.status === 400) && /commune/i.test(txt)) {
      try {
        const wilayaCode = parseInt(subs.wilaya_code) || 0;
        if (wilayaCode > 0 && (carrier === 'ecotrack' || carrier === 'noest')) {
          // Fetch communes from carrier API
          let communesUrl = '';
          if (carrier === 'ecotrack') communesUrl = baseUrl + '/get/communes/' + wilayaCode + (cfg.api_key ? '?api_token=' + encodeURIComponent(cfg.api_key) : '');
          else if (carrier === 'noest') communesUrl = baseUrl + '/api/public/get/communes/' + wilayaCode;
          const communeHeaders = { ...headers };
          const cr = await fetch(communesUrl, { method: 'GET', headers: communeHeaders, signal: AbortSignal.timeout(10000) }).catch(() => null);
          if (cr && cr.ok) {
            const cData = await cr.json().catch(() => null);
            // EcoTrack returns [{id, commune, wilaya_id, ...}], NOEST returns [{id, commune, ...}]
            let communeNames = [];
            if (Array.isArray(cData)) communeNames = cData.map(c => c.commune || c.name || '').filter(Boolean);
            else if (cData?.data && Array.isArray(cData.data)) communeNames = cData.data.map(c => c.commune || c.name || '').filter(Boolean);
            if (communeNames.length > 0) {
              const inputCommune = subs.shipping_city.toLowerCase().trim().replace(/[''`\-\s]+/g, '');
              // Find best match by normalized comparison
              const normalize = s => s.toLowerCase().trim().replace(/[''`\-\s]+/g, '').replace(/é|è|ê/g, 'e').replace(/à|â/g, 'a').replace(/ù|û/g, 'u').replace(/ô/g, 'o').replace(/ç/g, 'c').replace(/ï|î/g, 'i');
              const inputNorm = normalize(subs.shipping_city);
              let bestMatch = '';
              let bestScore = 0;
              for (const cn of communeNames) {
                const cnNorm = normalize(cn);
                // Exact match
                if (cnNorm === inputNorm) { bestMatch = cn; bestScore = 100; break; }
                // Starts with / contains
                if (cnNorm.startsWith(inputNorm) || inputNorm.startsWith(cnNorm)) {
                  const score = 80;
                  if (score > bestScore) { bestScore = score; bestMatch = cn; }
                }
                // Levenshtein-like: count matching chars
                let matching = 0;
                const shorter = inputNorm.length < cnNorm.length ? inputNorm : cnNorm;
                const longer = inputNorm.length < cnNorm.length ? cnNorm : inputNorm;
                for (let ci = 0; ci < shorter.length; ci++) { if (longer.includes(shorter[ci])) matching++; }
                const similarity = matching / Math.max(longer.length, 1) * 60;
                if (similarity > bestScore) { bestScore = similarity; bestMatch = cn; }
              }
              if (bestMatch && bestMatch !== subs.shipping_city && bestScore >= 40) {
                console.log(`[carrierCreateOrder] ${carrier} commune "${subs.shipping_city}" → "${bestMatch}" (score: ${bestScore.toFixed(0)})`);
                const parsed = JSON.parse(body);
                parsed.commune = bestMatch;
                const retryBody = JSON.stringify(parsed);
                ({ r, txt, tried, finalUrl } = await doPost(retryBody));
                body = retryBody;
              }
            }
          }
        }
      } catch (e) { console.log(`[carrierCreateOrder] commune auto-correct failed:`, e.message); }
    }

    // Auto-retry with home delivery ONLY if carrier explicitly says desk is
    // unavailable for this commune/wilaya. We do NOT downgrade on every
    // validation error that merely mentions stop_desk — otherwise desk orders
    // get silently converted to home delivery on minor field issues.
    if (r && (r.status === 422 || r.status === 400) && /desk.*indisponible|desk.*disponible|desk.*not.?available|stop.?desk.*not.?available|stop.?desk.*invalid|aucun.*bureau|no.*stop.?desk|stop.?desk.*unavailable|bureau.*indispo|bureau.*ferm/i.test(txt)) {
      try {
        {
          const parsed = JSON.parse(body);
          let changed = false;
          if (parsed.stop_desk === 1) { parsed.stop_desk = 0; changed = true; }
          if (parsed.is_stopdesk === true || parsed.is_stopdesk === 'true') { parsed.is_stopdesk = false; changed = true; }
          if (Array.isArray(parsed) && parsed[0]?.is_stopdesk) { parsed[0].is_stopdesk = false; changed = true; }
          if (parsed.Colis?.[0]?.TypeLivraison === '1') { parsed.Colis[0].TypeLivraison = '0'; changed = true; }
          if (changed) {
            const retryBody = JSON.stringify(parsed);
            console.log(`[carrierCreateOrder] ${carrier} desk delivery rejected, retrying with home delivery`);
            ({ r, txt, tried, finalUrl } = await doPost(retryBody));
            body = retryBody;
          }
        }
      } catch {}
    }

    if (!r) return { ok: false, err: 'No endpoint responded', tried };

    let data; try { data = JSON.parse(txt); } catch { data = null; }
    const sentBody = typeof body === 'string' ? body.slice(0, 300) : '';

    // ── Check for auth failures ──
    const blob = (txt || '').toLowerCase();
    const authFail = [
      'invalid token','invalid api','invalid key','invalid credentials',
      'unauthor','authentication failed','access denied','forbidden',
      'wrong token','token invalid','token expir',
      'clé invalide','jeton invalide','token invalide','non autorisé',
      'permission denied','not allowed','login required','jwt expired','bad token',
    ].find(k => blob.includes(k));
    if (authFail) return { ok: false, err: `Credentials rejected: "${authFail}"`, status: r.status, carrier_response: data || txt, request_url: finalUrl, request_body: sentBody, tried };

    // ── Friendly translation for the common "commune deactivated" case ──
    // EcoTrack/NOEST return "Commune mal écrite, ou désactivée" when the
    // commune name is wrong OR (more commonly) when the merchant hasn't
    // enabled that commune in their carrier dashboard. The pre-flight
    // resolver already tried to fix misspellings, so this almost certainly
    // means the commune is disabled in the carrier account.
    const friendlyCommune = (() => {
      if (!/désactiv|deactivat|disabled|inactive/i.test(txt)) return null;
      if (!/commune/i.test(txt)) return null;
      try {
        const parsedB = JSON.parse(body);
        const cn = parsedB.commune || parsedB.Colis?.[0]?.Commune || subs.shipping_city;
        const wn = subs.shipping_wilaya || ('wilaya ' + (parsedB.wilaya_id || parsedB.code_wilaya || subs.wilaya_code));
        return `Commune "${cn}" is not enabled for delivery in your ${carrier === 'noest' ? 'NOEST' : 'EcoTrack/DHD'} account for ${wn}. Open your carrier dashboard → Settings → Communes / Zones de livraison and enable "${cn}", or choose a different commune for this order.`;
      } catch {
        return `This commune is not enabled in your carrier account. Enable it in your carrier dashboard or pick a different commune.`;
      }
    })();
    if (friendlyCommune) return { ok: false, err: friendlyCommune, status: r.status, carrier_response: data || txt, request_url: finalUrl, request_body: sentBody, tried };

    // ── Check for explicit failure responses ──
    if (data && data.success === false && data.message) return { ok: false, err: data.message, status: r.status, carrier_response: data, request_url: finalUrl, request_body: sentBody, tried };
    if (data && data.error && typeof data.error === 'string') return { ok: false, err: data.error, status: r.status, carrier_response: data, request_url: finalUrl, request_body: sentBody, tried };
    if (data && data.errors && typeof data.errors === 'object') return { ok: false, err: JSON.stringify(data.errors).slice(0, 300), status: r.status, carrier_response: data, request_url: finalUrl, request_body: sentBody, tried };
    if (data && data.success === false) return { ok: false, err: data.msg || data.detail || `Carrier rejected (HTTP ${r.status})`, status: r.status, carrier_response: data, request_url: finalUrl, request_body: sentBody, tried };
    if (!r.ok && r.status >= 400) return { ok: false, err: `HTTP ${r.status}: ${String(txt).slice(0, 200)}`, status: r.status, carrier_response: data || txt, request_url: finalUrl, request_body: sentBody, tried };

    // ── Extract tracking number ──
    let tracking = '';

    // 1. Admin-configured path
    if (data && cfg.api_create_tracking_path) {
      let val = data;
      for (const p of cfg.api_create_tracking_path.split('.')) { if (val == null) break; val = !isNaN(p) ? val[parseInt(p)] : val[p]; }
      if (val != null && typeof val !== 'object') tracking = String(val);
    }

    // 2. Carrier-specific extraction
    if (!tracking && data) {
      if (carrier === 'yalidine') {
        const root = Array.isArray(data) ? data[0] : data;
        if (root && typeof root === 'object') {
          const first = Object.values(root)[0];
          if (first && typeof first === 'object') {
            if (first.success === false) return { ok: false, err: first.message || 'Yalidine rejected the parcel', status: r.status, carrier_response: data, request_url: finalUrl, tried };
            tracking = first.tracking || first.tracking_number || first.label || '';
          }
        }
      } else if (carrier === 'procolis') {
        const arr = data.Colis || data.colis || data;
        if (Array.isArray(arr) && arr[0]) tracking = arr[0].Tracking || arr[0].tracking || arr[0].code || '';
        if (!tracking && data.Tracking) tracking = data.Tracking;
      } else if (carrier === 'noest') {
        // NOEST returns {success:true, tracking:"ECS...", reference:"..."}
        tracking = data.tracking || data.tracking_number || '';
      } else if (carrier === 'ecotrack') {
        tracking = data.tracking || data.tracking_number || '';
        if (!tracking && data.data) tracking = data.data.tracking || data.data.tracking_number || data.data.code || '';
        if (!tracking && data.order) tracking = data.order.tracking || data.order.tracking_number || '';
      } else if (carrier === 'maystro') {
        tracking = data.display_id || data.tracking_id || data.id || '';
      }

      // 3. Generic fallback
      if (!tracking) {
        const pick = (obj) => obj && (obj.tracking || obj.tracking_number || obj.tracking_id || obj.code || obj.parcel_id || obj.shipment_id || '');
        tracking = pick(data) || pick(data?.data) || pick(data?.result) || pick(Array.isArray(data) ? data[0] : null) || '';
      }
    }

    if (tracking) {
      console.log(`[carrierCreateOrder] ${carrier} ✓ TN: ${tracking}`);
      return { ok: true, tracking_number: String(tracking), carrier_response: data || txt, status: r.status, request_url: finalUrl, request_body: sentBody, tried };
    }

    console.log(`[carrierCreateOrder] ${carrier} ✓ accepted (HTTP ${r.status}) — no tracking number in response, will resolve via sync`);
    return { ok: true, tracking_number: '', carrier_response: data || txt, status: r.status, request_url: finalUrl, request_body: sentBody, tried };
  } catch (e) {
    console.error(`[carrierCreateOrder] ${carrier} EXCEPTION:`, e.message);
    return { ok: false, err: e.message, request_url: finalUrl, tried };
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
    noest: ['activity.0.event', 'data.activity.0.event', 'OrderInfo.status', 'data.last_situation'],
    procolis: ['0.Situation', 'Colis.0.Situation'],
    ecotrack: ['data.activity.0.event', 'data.0.activity.0.event', 'data.last_situation', 'data.status', 'status', 'data.0.status'],
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
async function carrierDeleteOrder(rawCfg, trackingNumber) {
  const cfg = normalizeConfig(rawCfg);
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
    // NOEST: POST /api/public/delete/order with {user_guid, tracking}
    const q = parseJson(cfg.api_query_params);
    url += '/api/public/delete/order';
    method = 'POST';
    body = JSON.stringify({ user_guid: q.user_guid || '', tracking: trackingNumber });
  } else if (carrier === 'ecotrack') {
    url += `/delete/order?tracking=${encodeURIComponent(trackingNumber)}`;
    if (cfg.api_key) url += '&api_token=' + encodeURIComponent(cfg.api_key);
    method = 'DELETE';
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
    let r = await fetch(url, { method, headers, body, redirect: (method === 'POST' || method === 'DELETE') ? 'manual' : 'follow', signal: AbortSignal.timeout(10000) });
    if ([301,302,303,307,308].includes(r.status)) {
      const loc = r.headers.get('location');
      if (loc) {
        const redir = loc.startsWith('http') ? loc : new URL(loc, url).href;
        r = await fetch(redir, { method, headers, body, redirect: 'follow', signal: AbortSignal.timeout(10000) });
      }
    }
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}

module.exports = { carrierRequest, carrierCreateOrder, carrierDeleteOrder, detectCarrier, normalizeConfig, extractStatus, wilayaToCode };
