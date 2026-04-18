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
    try{await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_type VARCHAR(20) DEFAULT 'desk'");}catch(e){}
    // Allow oversell — lets admins keep selling products even when stock is 0
    try{await pool.query("ALTER TABLE products ADD COLUMN IF NOT EXISTS allow_oversell BOOLEAN DEFAULT FALSE");}catch(e){}
    // Store staff: ensure the table exists before any ALTERs run (some older deployments
    // never created it, which made staff creation fail).
    try{await pool.query(`CREATE TABLE IF NOT EXISTS store_staff(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      store_id UUID NOT NULL,
      name VARCHAR(150) NOT NULL,
      email VARCHAR(200),
      phone VARCHAR(30),
      password_hash TEXT NOT NULL,
      role VARCHAR(100) DEFAULT 'viewer',
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);}catch(e){console.log('store_staff create:',e.message);}
    try{await pool.query("ALTER TABLE store_staff ADD COLUMN IF NOT EXISTS permissions TEXT DEFAULT '[]'");}catch(e){}
    try{await pool.query("ALTER TABLE store_staff ADD COLUMN IF NOT EXISTS role_template_id UUID");}catch(e){}

    // ═══ Super-admin-defined staff role templates ═══
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS role_templates(
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name_en VARCHAR(100) NOT NULL,
        name_fr VARCHAR(100) DEFAULT '',
        name_ar VARCHAR(100) DEFAULT '',
        description_en VARCHAR(255) DEFAULT '',
        description_fr VARCHAR(255) DEFAULT '',
        description_ar VARCHAR(255) DEFAULT '',
        permissions TEXT DEFAULT '[]',
        is_active BOOLEAN DEFAULT TRUE,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`);
      const cnt = await pool.query('SELECT COUNT(*)::int AS c FROM role_templates');
      if ((cnt.rows[0]?.c || 0) === 0) {
        await pool.query(
          `INSERT INTO role_templates(name_en,name_fr,name_ar,description_en,description_fr,description_ar,permissions,sort_order) VALUES
           ('Manager','Gérant','مدير','Full store access','Accès complet au magasin','وصول كامل للمتجر',
             '["view_dashboard","view_orders","manage_orders","view_products","manage_products","view_customers","manage_customers","view_analytics","manage_settings","manage_staff"]',1),
           ('Preparer','Préparateur','محضّر','Prepares and ships orders','Prépare et expédie les commandes','تحضير وشحن الطلبات',
             '["view_dashboard","view_orders","prepare_orders","view_products"]',2),
           ('Confirmer','Confirmateur','مؤكِّد','Confirms and validates orders','Confirme les commandes','تأكيد الطلبات',
             '["view_dashboard","view_orders","confirm_orders","view_customers"]',3),
           ('Accountant','Comptable','محاسب','Reads financials only','Accès en lecture aux finances','اطلاع على البيانات المالية',
             '["view_dashboard","view_orders","view_analytics","view_billing"]',4),
           ('Viewer','Observateur','مشاهد','Read-only access','Accès en lecture seule','اطلاع فقط',
             '["view_dashboard","view_orders","view_products","view_customers","view_analytics"]',5)
          `
        );
      }
      console.log('✅ role_templates ready');
    } catch(e){console.log('role_templates:',e.message);}

    // ═══ Super-admin-editable subscription plans ═══
    try{
      await pool.query(`CREATE TABLE IF NOT EXISTS plans(
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        slug VARCHAR(50) UNIQUE NOT NULL,
        name_en VARCHAR(100) NOT NULL,
        name_fr VARCHAR(100) DEFAULT '',
        name_ar VARCHAR(100) DEFAULT '',
        tagline_en VARCHAR(255) DEFAULT '',
        tagline_fr VARCHAR(255) DEFAULT '',
        tagline_ar VARCHAR(255) DEFAULT '',
        price_monthly DECIMAL(12,2) DEFAULT 0,
        price_yearly DECIMAL(12,2) DEFAULT 0,
        currency VARCHAR(10) DEFAULT 'DZD',
        features_en TEXT DEFAULT '[]',
        features_fr TEXT DEFAULT '[]',
        features_ar TEXT DEFAULT '[]',
        feature_keys TEXT DEFAULT '[]',
        max_products INTEGER DEFAULT 0,
        max_orders_month INTEGER DEFAULT 0,
        max_staff INTEGER DEFAULT 0,
        is_popular BOOLEAN DEFAULT FALSE,
        is_active BOOLEAN DEFAULT TRUE,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`);
      // Backfill columns on existing installs.
      try{await pool.query("ALTER TABLE plans ADD COLUMN IF NOT EXISTS feature_keys TEXT DEFAULT '[]'");}catch{}
      try{await pool.query("ALTER TABLE plans ADD COLUMN IF NOT EXISTS max_products INTEGER DEFAULT 0");}catch{}
      try{await pool.query("ALTER TABLE plans ADD COLUMN IF NOT EXISTS max_orders_month INTEGER DEFAULT 0");}catch{}
      try{await pool.query("ALTER TABLE plans ADD COLUMN IF NOT EXISTS max_staff INTEGER DEFAULT 0");}catch{}
      // Seed two defaults on empty tables so the landing page isn't blank.
      const cnt = await pool.query('SELECT COUNT(*)::int AS c FROM plans');
      if ((cnt.rows[0]?.c || 0) === 0) {
        await pool.query(
          `INSERT INTO plans(slug,name_en,name_fr,name_ar,tagline_en,tagline_fr,tagline_ar,price_monthly,price_yearly,features_en,features_fr,features_ar,feature_keys,max_products,max_orders_month,max_staff,is_popular,sort_order)
           VALUES
           ('starter','Starter','Débutant','المبتدئ','Perfect to get started','Idéal pour commencer','مثالي للبدء',0,0,
             '["1 store","Up to 50 products","Basic analytics","Email support"]',
             '["1 magasin","Jusqu''à 50 produits","Analyses de base","Support par e-mail"]',
             '["متجر واحد","حتى 50 منتج","تحليلات أساسية","دعم عبر البريد"]',
             '["basic_analytics","email_support"]',50,200,1,FALSE,1),
           ('pro','Pro','Pro','المحترف','For serious sellers','Pour les vendeurs sérieux','للبائعين الجادين',2500,25000,
             '["Unlimited stores","Unlimited products","Advanced analytics","AI features","Priority support","Custom domain"]',
             '["Magasins illimités","Produits illimités","Analyses avancées","Fonctionnalités IA","Support prioritaire","Domaine personnalisé"]',
             '["متاجر غير محدودة","منتجات غير محدودة","تحليلات متقدمة","ميزات الذكاء الاصطناعي","دعم ذو أولوية","نطاق مخصص"]',
             '["basic_analytics","advanced_analytics","ai_chatbot","ai_descriptions","ai_moderation","custom_domain","priority_support","page_builder","abandoned_cart","custom_html","unlimited_products","unlimited_orders","unlimited_staff"]',0,0,0,TRUE,2)
          `
        );
      }
      console.log('✅ plans ready');
    } catch(e){console.log('plans:',e.message);}

    try{await pool.query(`CREATE TABLE IF NOT EXISTS push_subscriptions(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),store_id UUID REFERENCES stores(id),
      endpoint TEXT NOT NULL,keys_p256dh TEXT,keys_auth TEXT,created_at TIMESTAMPTZ DEFAULT NOW()
    )`);console.log('✅ push_subscriptions ready');}catch(e){console.log('push_subscriptions:',e.message);}

    try{await pool.query("ALTER TABLE platform_settings ALTER COLUMN logo_url TYPE TEXT");}catch(e){}
    try{await pool.query("ALTER TABLE platform_settings ALTER COLUMN favicon_url TYPE TEXT");}catch(e){}
    try{await pool.query("ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS landing_blocks TEXT DEFAULT '[]'");}catch(e){}
    try{await pool.query("ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS google_client_id VARCHAR(500)");}catch(e){}

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
      customer_email VARCHAR(255),
      items JSONB DEFAULT '[]'::jsonb,
      total DECIMAL(12,2) DEFAULT 0,
      is_abandoned BOOLEAN DEFAULT FALSE,
      is_recovered BOOLEAN DEFAULT FALSE,
      recovery_sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);console.log('✅ carts ready');}catch(e){console.log('carts:',e.message);}
    // Backfill customer_email column
    try{await pool.query(`ALTER TABLE carts ADD COLUMN IF NOT EXISTS customer_email VARCHAR(255)`);}catch(e){}

    // ═══ NEW: Store domains table ═══
    try{await pool.query(`CREATE TABLE IF NOT EXISTS store_domains(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      store_id UUID REFERENCES stores(id),
      domain_name VARCHAR(255) NOT NULL UNIQUE,
      status VARCHAR(20) DEFAULT 'pending',
      ssl_status VARCHAR(20) DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);console.log('✅ store_domains ready');}catch(e){console.log('store_domains:',e.message);}

    console.log('✅ DB init complete');
  }catch(e){console.error('DB init error:',e.message);}
};

module.exports={initDb};
