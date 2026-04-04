const pool=require('./db');
const initDb=async()=>{
  try{
    const r=await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");
    console.log('DB:',r.rows.length,'tables');

    try{await pool.query("ALTER TABLE stores ADD COLUMN IF NOT EXISTS config JSONB DEFAULT '{}'::jsonb");console.log('✅ config column ready');}catch(e){console.log('config col:',e.message);}

    try{await pool.query(`CREATE TABLE IF NOT EXISTS payment_receipts(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),store_id UUID REFERENCES stores(id),order_id UUID REFERENCES orders(id),
      payment_method VARCHAR(50),reference_number VARCHAR(100),receipt_image TEXT,
      status VARCHAR(20) DEFAULT 'pending',reviewed_by UUID,reviewed_at TIMESTAMPTZ,notes TEXT,created_at TIMESTAMPTZ DEFAULT NOW()
    )`);console.log('✅ payment_receipts ready');}catch(e){console.log('payment_receipts:',e.message);}

    try{await pool.query(`CREATE TABLE IF NOT EXISTS blacklist(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),store_id UUID REFERENCES stores(id),
      phone VARCHAR(50) NOT NULL,name VARCHAR(255),reason VARCHAR(255),cancelled_count INT DEFAULT 0,
      is_active BOOLEAN DEFAULT TRUE,created_at TIMESTAMPTZ DEFAULT NOW()
    )`);console.log('✅ blacklist ready');}catch(e){console.log('blacklist:',e.message);}

    try{await pool.query(`CREATE TABLE IF NOT EXISTS message_log(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),store_id UUID REFERENCES stores(id),order_id UUID,
      channel VARCHAR(20),recipient VARCHAR(255),message_type VARCHAR(50),content TEXT,
      status VARCHAR(20) DEFAULT 'sent',external_id VARCHAR(255),error_message TEXT,created_at TIMESTAMPTZ DEFAULT NOW()
    )`);console.log('✅ message_log ready');}catch(e){console.log('message_log:',e.message);}

    try{await pool.query(`CREATE TABLE IF NOT EXISTS expenses(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),store_id UUID REFERENCES stores(id),
      description VARCHAR(500) NOT NULL,category VARCHAR(100) DEFAULT 'Other',amount DECIMAL(12,2) DEFAULT 0,
      date DATE DEFAULT CURRENT_DATE,status VARCHAR(20) DEFAULT 'Paid',created_at TIMESTAMPTZ DEFAULT NOW()
    )`);console.log('✅ expenses ready');}catch(e){console.log('expenses:',e.message);}

    try{await pool.query(`CREATE TABLE IF NOT EXISTS store_pages(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),store_id UUID REFERENCES stores(id),
      page_type VARCHAR(50) DEFAULT 'faq',title TEXT DEFAULT '',content TEXT DEFAULT '',
      is_published BOOLEAN DEFAULT TRUE,sort_order INT DEFAULT 0,created_at TIMESTAMPTZ DEFAULT NOW()
    )`);console.log('✅ store_pages ready');}catch(e){console.log('store_pages:',e.message);}

    try{await pool.query(`CREATE TABLE IF NOT EXISTS notifications(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),store_id UUID REFERENCES stores(id),
      type VARCHAR(50) DEFAULT 'info',title VARCHAR(255) NOT NULL,message TEXT DEFAULT '',
      is_read BOOLEAN DEFAULT FALSE,link VARCHAR(255),created_at TIMESTAMPTZ DEFAULT NOW()
    )`);console.log('✅ notifications ready');}catch(e){console.log('notifications:',e.message);}

    try{await pool.query(`CREATE TABLE IF NOT EXISTS subscription_payments(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),owner_id UUID REFERENCES store_owners(id),
      plan VARCHAR(50) DEFAULT 'basic',period VARCHAR(20) DEFAULT 'monthly',amount DECIMAL(12,2) DEFAULT 0,
      payment_method VARCHAR(50) DEFAULT 'ccp',receipt_image TEXT,status VARCHAR(20) DEFAULT 'pending',
      reviewed_by VARCHAR(255),reviewed_at TIMESTAMPTZ,notes TEXT,created_at TIMESTAMPTZ DEFAULT NOW()
    )`);console.log('✅ subscription_payments ready');}catch(e){console.log('subscription_payments:',e.message);}

    try{await pool.query("ALTER TABLE store_owners ADD COLUMN IF NOT EXISTS subscription_plan VARCHAR(50) DEFAULT 'free'");}catch(e){}
    try{await pool.query("ALTER TABLE store_owners ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(20) DEFAULT 'active'");}catch(e){}
    try{await pool.query("ALTER TABLE store_owners ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMPTZ");}catch(e){}
    try{await pool.query("ALTER TABLE store_owners ADD COLUMN IF NOT EXISTS subscription_paid_until TIMESTAMPTZ");}catch(e){}
    try{await pool.query("ALTER TABLE store_owners ADD COLUMN IF NOT EXISTS username VARCHAR(100) UNIQUE");}catch(e){}
    try{await pool.query("ALTER TABLE store_owners ADD COLUMN IF NOT EXISTS two_fa_enabled BOOLEAN DEFAULT FALSE");}catch(e){}
    try{await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_reference VARCHAR(255)");}catch(e){}
    try{await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS notification_preference VARCHAR(20) DEFAULT 'whatsapp'");}catch(e){}

    try{await pool.query(`CREATE TABLE IF NOT EXISTS push_subscriptions(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),store_id UUID REFERENCES stores(id),
      endpoint TEXT NOT NULL,keys_p256dh TEXT,keys_auth TEXT,created_at TIMESTAMPTZ DEFAULT NOW()
    )`);console.log('✅ push_subscriptions ready');}catch(e){console.log('push_subscriptions:',e.message);}

    try{await pool.query("ALTER TABLE platform_settings ALTER COLUMN logo_url TYPE TEXT");}catch(e){}
    try{await pool.query("ALTER TABLE platform_settings ALTER COLUMN favicon_url TYPE TEXT");}catch(e){}
    try{await pool.query("ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS landing_blocks TEXT DEFAULT '[]'");}catch(e){}

    // ═══ NEW: Order tracking columns ═══
    try{await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_number VARCHAR(255)");}catch(e){}
    try{await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_company_id UUID");}catch(e){}
    try{await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_status VARCHAR(50)");}catch(e){}
    try{await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_updated_at TIMESTAMPTZ");}catch(e){}
    console.log('✅ order tracking columns ready');

    // ═══ NEW: Delivery companies — flexible API config ═══
    try{await pool.query("ALTER TABLE delivery_companies ADD COLUMN IF NOT EXISTS provider_type VARCHAR(50) DEFAULT 'manual'");}catch(e){}
    try{await pool.query("ALTER TABLE delivery_companies ADD COLUMN IF NOT EXISTS tracking_url VARCHAR(500)");}catch(e){}
    try{await pool.query("ALTER TABLE delivery_companies ADD COLUMN IF NOT EXISTS phone VARCHAR(50)");}catch(e){}
    try{await pool.query("ALTER TABLE delivery_companies ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE");}catch(e){}
    try{await pool.query("ALTER TABLE delivery_companies ADD COLUMN IF NOT EXISTS api_base_url VARCHAR(500)");}catch(e){}
    try{await pool.query("ALTER TABLE delivery_companies ADD COLUMN IF NOT EXISTS api_auth_type VARCHAR(50) DEFAULT 'none'");}catch(e){}
    try{await pool.query("ALTER TABLE delivery_companies ADD COLUMN IF NOT EXISTS api_headers JSONB DEFAULT '{}'::jsonb");}catch(e){}
    try{await pool.query("ALTER TABLE delivery_companies ADD COLUMN IF NOT EXISTS api_tracking_endpoint VARCHAR(500)");}catch(e){}
    try{await pool.query("ALTER TABLE delivery_companies ADD COLUMN IF NOT EXISTS api_status_path VARCHAR(255)");}catch(e){}
    console.log('✅ delivery_companies columns ready');

    // ═══ NEW: Product reviews table ═══
    try{await pool.query(`CREATE TABLE IF NOT EXISTS reviews(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      store_id UUID REFERENCES stores(id),
      product_id UUID REFERENCES products(id) ON DELETE CASCADE,
      customer_id UUID,
      customer_name VARCHAR(255) NOT NULL,
      customer_phone VARCHAR(50),
      rating INT NOT NULL CHECK (rating >= 1 AND rating <= 5),
      title VARCHAR(255),
      content TEXT,
      is_approved BOOLEAN DEFAULT FALSE,
      is_rejected BOOLEAN DEFAULT FALSE,
      ai_moderation_score INT,
      ai_moderation_reason TEXT,
      admin_notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);console.log('✅ reviews ready');}catch(e){console.log('reviews:',e.message);}

    // ═══ NEW: Carts table for abandoned cart recovery ═══
    try{await pool.query(`CREATE TABLE IF NOT EXISTS carts(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      store_id UUID REFERENCES stores(id),
      customer_phone VARCHAR(50),
      customer_name VARCHAR(255),
      items JSONB DEFAULT '[]'::jsonb,
      total DECIMAL(12,2) DEFAULT 0,
      is_abandoned BOOLEAN DEFAULT FALSE,
      is_recovered BOOLEAN DEFAULT FALSE,
      recovery_sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);console.log('✅ carts ready');}catch(e){console.log('carts:',e.message);}

    console.log('✅ DB init complete');
  }catch(e){console.error('DB init error:',e.message);}
};

module.exports={initDb};
