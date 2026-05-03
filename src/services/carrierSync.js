const pool = require('../config/db');
const { carrierRequest, carrierCreateOrder, extractStatus } = require('./carrierApi');

const pick = (o, ...keys) => { for (const k of keys) { if (o && o[k] != null && o[k] !== '') return o[k]; } return null; };
const mapStatus = (s) => {
  const t = String(s || '').toLowerCase();
  if (/livr[éeè]|deliver|تم التسليم/.test(t)) return 'delivered';
  if (/exp[éeè]di|ship|في الطريق/.test(t)) return 'shipped';
  if (/retour|return|مرتجع/.test(t)) return 'returned';
  if (/annul|cancel|ملغ/.test(t)) return 'cancelled';
  if (/transit|center|en cours/.test(t)) return 'shipped';
  if (/r[ée]ception|prepar/.test(t)) return 'preparing';
  return 'shipped';
};

async function ensureSyncCols() {
  for (const sql of [
    "ALTER TABLE delivery_companies ADD COLUMN IF NOT EXISTS auto_sync_enabled BOOLEAN DEFAULT FALSE",
    "ALTER TABLE delivery_companies ADD COLUMN IF NOT EXISTS auto_dispatch_enabled BOOLEAN DEFAULT FALSE",
    "ALTER TABLE delivery_companies ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ",
    "ALTER TABLE delivery_companies ADD COLUMN IF NOT EXISTS sync_interval_minutes INT DEFAULT 10",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS source VARCHAR(40)",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS external_id VARCHAR(120)",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS carrier_data JSONB",
  ]) { try { await pool.query(sql); } catch {} }
}

async function syncCarrierOrders(storeId, dc) {
  const host = (() => { try { return new URL(dc.api_base_url).host.toLowerCase(); } catch { return ''; } })();
  let listCfg = dc;
  if (/yalidine/.test(host)) listCfg = { ...dc, api_tracking_endpoint: '/parcels/?page_size=200', _bypassCarrierOverride: true };
  else if (/noest/.test(host)) listCfg = { ...dc, api_tracking_endpoint: '/get/parcels' };
  else if (/procolis|dhd/.test(host)) listCfg = { ...dc, api_tracking_endpoint: '/lire', api_method: 'POST', api_body_template: '{"Colis":[]}' };
  else if (/ecotrack/.test(host)) listCfg = { ...dc, api_tracking_endpoint: '/get/orders?limit=200' };
  else if (/maystro/.test(host)) listCfg = { ...dc, api_tracking_endpoint: '/orders/?page_size=200' };
  else return { synced: 0, inserted: 0, updated: 0 };

  // Use empty tracking number so carrierRequest treats this as a list call
  // for known carriers; we still need to bypass per-carrier endpoint override.
  const r = await carrierRequest({ ...listCfg, api_base_url: dc.api_base_url }, '');
  if (r.err || !r.ok) return { synced: 0, error: r.err || `HTTP ${r.status}` };
  let data; try { data = JSON.parse(r.body || ''); } catch { return { synced: 0, error: 'Non-JSON response' }; }

  const flatten = (d) => {
    if (Array.isArray(d)) return d;
    if (d && typeof d === 'object') {
      for (const k of ['data', 'parcels', 'results', 'list', 'Colis', 'orders', 'rows', 'items'])
        if (Array.isArray(d[k])) return d[k];
      for (const v of Object.values(d)) if (Array.isArray(v)) return v;
    }
    return [];
  };
  const list = flatten(data);
  if (!list.length) return { synced: 0, inserted: 0, updated: 0 };

  let inserted = 0, updated = 0;
  for (const p of list) {
    const tracking = String(pick(p, 'tracking', 'tracking_number', 'code', 'Tracking', 'parcel_id', 'id', 'orderId', 'display_id') || '').trim();
    if (!tracking) continue;
    const phone = String(pick(p, 'to_commune_phone', 'contact_phone', 'customer_phone', 'phone', 'MobileA', 'client_phone') || '').replace(/[^\d+]/g, '');
    const name = String(pick(p, 'firstname', 'customer_name', 'client', 'Client', 'recipient', 'to_name') || '').trim()
      + (pick(p, 'familyname') ? ' ' + pick(p, 'familyname') : '');
    const wilaya = String(pick(p, 'to_wilaya_name', 'wilaya', 'Wilaya', 'shipping_wilaya') || '');
    const commune = String(pick(p, 'to_commune_name', 'commune', 'Commune', 'shipping_city') || '');
    const address = String(pick(p, 'address', 'adresse', 'Adresse', 'shipping_address') || '');
    const total = parseFloat(pick(p, 'price', 'total', 'montant', 'Total', 'order_total', 'product_price')) || 0;
    const stRaw = String(pick(p, 'last_status', 'Situation', 'status', 'statut', 'tracking_status', 'status_display') || '');
    const ourStatus = mapStatus(stRaw);
    const createdAt = pick(p, 'date_creation', 'created_at', 'createdAt', 'date');
    const externalId = String(pick(p, 'order_id', 'external_id', 'id', 'reference', 'Tracking', 'display_id') || tracking);

    const existing = (await pool.query(
      'SELECT id FROM orders WHERE store_id=$1 AND (tracking_number=$2 OR external_id=$3) LIMIT 1',
      [storeId, tracking, externalId]
    )).rows[0];

    if (existing) {
      await pool.query(
        'UPDATE orders SET status=$1,tracking_status=$2,delivery_company_id=$3,carrier_data=$4::jsonb,updated_at=NOW() WHERE id=$5',
        [ourStatus, stRaw || null, dc.id, JSON.stringify(p), existing.id]
      );
      updated++;
    } else {
      const num = parseInt((await pool.query('SELECT COALESCE(MAX(order_number),0)+1 as n FROM orders WHERE store_id=$1', [storeId])).rows[0].n);
      await pool.query(
        `INSERT INTO orders(store_id,order_number,customer_name,customer_phone,shipping_address,shipping_city,shipping_wilaya,total,subtotal,shipping_cost,discount,payment_method,status,tracking_status,tracking_number,delivery_company_id,source,external_id,carrier_data,created_at,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,0,0,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,NOW())`,
        [storeId, num, name || '(carrier import)', phone || null, address || null, commune || null, wilaya || null, total, total, 'cod', ourStatus, stRaw || null, tracking, dc.id, 'carrier_sync', externalId, JSON.stringify(p), createdAt || new Date()]
      );
      inserted++;
    }
  }

  await pool.query('UPDATE delivery_companies SET last_synced_at=NOW() WHERE id=$1', [dc.id]);
  return { synced: list.length, inserted, updated };
}

async function updateTracking(storeId, order, dc) {
  if (!dc.api_base_url || !dc.api_tracking_endpoint) return null;
  const tn = order.tracking_number || order.external_id || String(order.order_number || order.id);
  const cr = await carrierRequest(dc, tn);
  if (!cr.ok) return null;

  let data; try { data = JSON.parse(cr.body || ''); } catch { return null; }
  if (!data) return null;

  let extractedStatus = extractStatus(dc, data);
  let history = [];
  if (!extractedStatus) {
    const d = data.data || data.results || data;
    const item = Array.isArray(d) ? d[0] : d;
    if (item) {
      extractedStatus = item.last_status || item.status || item.current_status || item.state || item.status_display || null;
      history = item.historique || item.history || item.tracking_history || item.events || [];
    }
  } else {
    const d = data.data || data.results || data;
    const item = Array.isArray(d) ? d[0] : d;
    if (item) history = item.historique || item.history || item.tracking_history || item.events || [];
  }

  if (extractedStatus) {
    const normalized = extractedStatus.toLowerCase().replace(/\s+/g, '_');
    const ourStatus = mapStatus(extractedStatus);
    await pool.query(
      'UPDATE orders SET tracking_status=$1,status=$2,carrier_data=$3::jsonb,tracking_updated_at=NOW(),updated_at=NOW() WHERE id=$4',
      [normalized, ourStatus, JSON.stringify(data), order.id]
    );
    return { status: normalized, raw: extractedStatus, history };
  }
  return null;
}

async function autoDispatchOrder(storeId, orderId, dcId) {
  try {
    const dc = (await pool.query('SELECT * FROM delivery_companies WHERE id=$1 AND store_id=$2', [dcId, storeId])).rows[0];
    if (!dc || !dc.api_base_url || !dc.api_create_endpoint) return null;
    const order = (await pool.query('SELECT * FROM orders WHERE id=$1 AND store_id=$2', [orderId, storeId])).rows[0];
    if (!order || order.tracking_number) return null;
    const items = (await pool.query('SELECT * FROM order_items WHERE order_id=$1', [orderId])).rows;
    const result = await carrierCreateOrder(dc, order, items);
    if (result.ok && result.tracking_number) {
      await pool.query('UPDATE orders SET tracking_number=$1,delivery_company_id=$2,status=$3,carrier_data=$4::jsonb,updated_at=NOW() WHERE id=$5',
        [result.tracking_number, dcId, 'shipped', JSON.stringify(result.carrier_response), orderId]);
      console.log(`[AutoDispatch] Order ${orderId} → ${dc.name} TN: ${result.tracking_number}`);
    }
    return result;
  } catch (e) {
    console.error('[AutoDispatch]', e.message);
    return null;
  }
}

async function runFullSync() {
  try {
    await ensureSyncCols();
    const carriers = (await pool.query(
      "SELECT dc.*, dc.store_id FROM delivery_companies dc WHERE dc.api_base_url IS NOT NULL AND dc.api_base_url != '' AND dc.auto_sync_enabled = TRUE AND dc.is_active = TRUE"
    )).rows;
    if (!carriers.length) return;
    console.log(`[CarrierSync] Syncing ${carriers.length} carriers...`);

    for (const dc of carriers) {
      try {
        const result = await syncCarrierOrders(dc.store_id, dc);
        if (result.inserted || result.updated) {
          console.log(`[CarrierSync] ${dc.name}: ${result.inserted} new, ${result.updated} updated`);
        }
      } catch (e) {
        console.error(`[CarrierSync] ${dc.name} error:`, e.message);
      }
    }

    const orders = (await pool.query(`
      SELECT o.id,o.store_id,o.tracking_number,o.external_id,o.order_number,
        dc.api_base_url,dc.api_auth_type,dc.api_key,dc.api_headers,dc.api_query_params,
        dc.oauth2_token_url,dc.oauth2_credentials,dc.api_method,dc.api_body_template,
        dc.api_tracking_endpoint,dc.api_status_path
      FROM orders o
      JOIN delivery_companies dc ON dc.id=o.delivery_company_id
      WHERE o.tracking_number IS NOT NULL
        AND dc.api_base_url IS NOT NULL AND dc.api_base_url != ''
        AND dc.api_tracking_endpoint IS NOT NULL
        AND o.status NOT IN ('delivered','cancelled','returned')
        AND (o.tracking_updated_at IS NULL OR o.tracking_updated_at < NOW() - INTERVAL '5 minutes')
      ORDER BY o.tracking_updated_at ASC NULLS FIRST
      LIMIT 50
    `)).rows;

    for (const o of orders) {
      try { await updateTracking(o.store_id, o, o); } catch {}
    }

    console.log(`[CarrierSync] Done. Updated tracking for ${orders.length} orders.`);
  } catch (e) {
    console.error('[CarrierSync] Fatal:', e.message);
  }
}

module.exports = { runFullSync, syncCarrierOrders, updateTracking, autoDispatchOrder, ensureSyncCols };
