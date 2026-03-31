const pool=require('./db');
const initDb=async()=>{
  try{
    const r=await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");
    console.log('DB:',r.rows.length,'tables');

    // Auto-add config column if missing
    try{await pool.query("ALTER TABLE stores ADD COLUMN IF NOT EXISTS config JSONB DEFAULT '{}'::jsonb");console.log('✅ config column ready');}catch(e){console.log('config col:',e.message);}

    // Payment receipts table (for manual CCP/BaridiMob/Bank verification)
    try{await pool.query(`CREATE TABLE IF NOT EXISTS payment_receipts(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      store_id UUID REFERENCES stores(id),
      order_id UUID REFERENCES orders(id),
      payment_method VARCHAR(50),
      reference_number VARCHAR(100),
      receipt_image TEXT,
      status VARCHAR(20) DEFAULT 'pending',
      reviewed_by UUID,
      reviewed_at TIMESTAMPTZ,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);console.log('✅ payment_receipts ready');}catch(e){console.log('payment_receipts:',e.message);}

    // Blacklist table
    try{await pool.query(`CREATE TABLE IF NOT EXISTS blacklist(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      store_id UUID REFERENCES stores(id),
      phone VARCHAR(50) NOT NULL,
      name VARCHAR(255),
      reason VARCHAR(255),
      cancelled_count INT DEFAULT 0,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);console.log('✅ blacklist ready');}catch(e){console.log('blacklist:',e.message);}

    // Message log table (track all sent messages)
    try{await pool.query(`CREATE TABLE IF NOT EXISTS message_log(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      store_id UUID REFERENCES stores(id),
      order_id UUID,
      channel VARCHAR(20),
      recipient VARCHAR(255),
      message_type VARCHAR(50),
      content TEXT,
      status VARCHAR(20) DEFAULT 'sent',
      external_id VARCHAR(255),
      error_message TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);console.log('✅ message_log ready');}catch(e){console.log('message_log:',e.message);}

    // Expenses table (for Costs page)
    try{await pool.query(`CREATE TABLE IF NOT EXISTS expenses(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      store_id UUID REFERENCES stores(id),
      description VARCHAR(500) NOT NULL,
      category VARCHAR(100) DEFAULT 'Other',
      amount DECIMAL(12,2) DEFAULT 0,
      date DATE DEFAULT CURRENT_DATE,
      status VARCHAR(20) DEFAULT 'Paid',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);console.log('✅ expenses ready');}catch(e){console.log('expenses:',e.message);}

    try{await pool.query(`CREATE TABLE IF NOT EXISTS store_pages(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      store_id UUID REFERENCES stores(id),
      page_type VARCHAR(50) DEFAULT 'faq',
      title TEXT DEFAULT '',
      content TEXT DEFAULT '',
      is_published BOOLEAN DEFAULT TRUE,
      sort_order INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);console.log('✅ store_pages ready');}catch(e){console.log('store_pages:',e.message);}

    try{await pool.query(`CREATE TABLE IF NOT EXISTS notifications(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      store_id UUID REFERENCES stores(id),
      type VARCHAR(50) DEFAULT 'info',
      title VARCHAR(255) NOT NULL,
      message TEXT DEFAULT '',
      is_read BOOLEAN DEFAULT FALSE,
      link VARCHAR(255),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);console.log('✅ notifications ready');}catch(e){console.log('notifications:',e.message);}

    try{await pool.query(`CREATE TABLE IF NOT EXISTS subscription_payments(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_id UUID REFERENCES store_owners(id),
      plan VARCHAR(50) DEFAULT 'basic',
      period VARCHAR(20) DEFAULT 'monthly',
      amount DECIMAL(12,2) DEFAULT 0,
      payment_method VARCHAR(50) DEFAULT 'ccp',
      receipt_image TEXT,
      status VARCHAR(20) DEFAULT 'pending',
      reviewed_by VARCHAR(255),
      reviewed_at TIMESTAMPTZ,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);console.log('✅ subscription_payments ready');}catch(e){console.log('subscription_payments:',e.message);}

    // Add subscription columns to store_owners if missing
    try{await pool.query("ALTER TABLE store_owners ADD COLUMN IF NOT EXISTS subscription_plan VARCHAR(50) DEFAULT 'free'");}catch(e){}
    try{await pool.query("ALTER TABLE store_owners ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(20) DEFAULT 'active'");}catch(e){}
    try{await pool.query("ALTER TABLE store_owners ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMPTZ");}catch(e){}
    try{await pool.query("ALTER TABLE store_owners ADD COLUMN IF NOT EXISTS subscription_paid_until TIMESTAMPTZ");}catch(e){}

    // Add username and two_fa columns to store_owners
    try{await pool.query("ALTER TABLE store_owners ADD COLUMN IF NOT EXISTS username VARCHAR(100) UNIQUE");}catch(e){}
    try{await pool.query("ALTER TABLE store_owners ADD COLUMN IF NOT EXISTS two_fa_enabled BOOLEAN DEFAULT FALSE");}catch(e){}

    // Add payment_reference column to orders
    try{await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_reference VARCHAR(255)");}catch(e){}
    try{await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS notification_preference VARCHAR(20) DEFAULT 'whatsapp'");}catch(e){}

    // Ensure platform_settings columns are TEXT for base64 images
    try{await pool.query("ALTER TABLE platform_settings ALTER COLUMN logo_url TYPE TEXT");}catch(e){}
    try{await pool.query("ALTER TABLE platform_settings ALTER COLUMN favicon_url TYPE TEXT");}catch(e){}
    try{await pool.query("ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS landing_blocks TEXT DEFAULT '[]'");}catch(e){}

    console.log('✅ DB init complete');
  }catch(e){console.error('DB init error:',e.message);}
};

module.exports={initDb};
