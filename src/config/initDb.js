const pool = require('./db');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const initDb = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ============ PLATFORM LEVEL TABLES ============
    await client.query(`
      CREATE TABLE IF NOT EXISTS platform_settings (
        id SERIAL PRIMARY KEY,
        site_name VARCHAR(255) DEFAULT 'KyoMarket',
        site_logo TEXT,
        primary_color VARCHAR(20) DEFAULT '#7C3AED',
        secondary_color VARCHAR(20) DEFAULT '#06B6D4',
        accent_color VARCHAR(20) DEFAULT '#F59E0B',
        subscription_monthly_price DECIMAL(10,2) DEFAULT 2900.00,
        subscription_yearly_price DECIMAL(10,2) DEFAULT 29000.00,
        trial_days INTEGER DEFAULT 14,
        default_language VARCHAR(5) DEFAULT 'en',
        custom_css TEXT,
        meta_description TEXT,
        favicon TEXT,
        maintenance_mode BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS platform_admins (
        id SERIAL PRIMARY KEY,
        phone VARCHAR(20) UNIQUE NOT NULL,
        email VARCHAR(255),
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(255) DEFAULT 'Platform Admin',
        role VARCHAR(50) DEFAULT 'super_admin',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // ============ STORE OWNER TABLES ============
    await client.query(`
      CREATE TABLE IF NOT EXISTS store_owners (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        phone VARCHAR(20),
        password_hash VARCHAR(255) NOT NULL,
        address TEXT,
        city VARCHAR(100),
        wilaya VARCHAR(100),
        is_verified BOOLEAN DEFAULT FALSE,
        is_active BOOLEAN DEFAULT TRUE,
        subscription_plan VARCHAR(50) DEFAULT 'trial',
        subscription_start TIMESTAMP DEFAULT NOW(),
        subscription_end TIMESTAMP,
        avatar TEXT,
        language VARCHAR(5) DEFAULT 'en',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS stores (
        id SERIAL PRIMARY KEY,
        owner_id INTEGER REFERENCES store_owners(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        slug VARCHAR(255) UNIQUE NOT NULL,
        custom_domain VARCHAR(255),
        domain_verified BOOLEAN DEFAULT FALSE,
        logo TEXT,
        favicon TEXT,
        description TEXT,
        meta_description TEXT,
        primary_color VARCHAR(20) DEFAULT '#7C3AED',
        secondary_color VARCHAR(20) DEFAULT '#10B981',
        accent_color VARCHAR(20) DEFAULT '#F59E0B',
        bg_color VARCHAR(20) DEFAULT '#FAFAFA',
        text_color VARCHAR(20) DEFAULT '#1F2937',
        font_family VARCHAR(100) DEFAULT 'Plus Jakarta Sans',
        header_style VARCHAR(50) DEFAULT 'modern',
        footer_text TEXT,
        social_facebook VARCHAR(255),
        social_instagram VARCHAR(255),
        social_tiktok VARCHAR(255),
        whatsapp_number VARCHAR(20),
        currency VARCHAR(10) DEFAULT 'DZD',
        default_language VARCHAR(5) DEFAULT 'en',
        supported_languages TEXT DEFAULT 'en,fr,ar',
        is_live BOOLEAN DEFAULT FALSE,
        enable_cod BOOLEAN DEFAULT TRUE,
        enable_ccp BOOLEAN DEFAULT FALSE,
        ccp_account VARCHAR(100),
        ccp_name VARCHAR(255),
        enable_baridimob BOOLEAN DEFAULT FALSE,
        baridimob_rip VARCHAR(100),
        enable_bank_transfer BOOLEAN DEFAULT FALSE,
        bank_name VARCHAR(255),
        bank_account VARCHAR(100),
        bank_rib VARCHAR(100),
        shipping_default_price DECIMAL(10,2) DEFAULT 400.00,
        free_shipping_threshold DECIMAL(10,2),
        cod_all_wilayas BOOLEAN DEFAULT TRUE,
        ai_chatbot_enabled BOOLEAN DEFAULT FALSE,
        ai_chatbot_name VARCHAR(100) DEFAULT 'Support Bot',
        ai_chatbot_greeting TEXT DEFAULT 'Hello! How can I help you today?',
        ai_chatbot_personality TEXT DEFAULT 'friendly and helpful',
        ai_fake_detection BOOLEAN DEFAULT FALSE,
        ai_cart_recovery BOOLEAN DEFAULT FALSE,
        store_visits INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Store staff / multi-user system
    await client.query(`
      CREATE TABLE IF NOT EXISTS store_staff (
        id SERIAL PRIMARY KEY,
        store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255),
        phone VARCHAR(20),
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(50) NOT NULL DEFAULT 'viewer',
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    // roles: admin, preparer, confirmer, accountant, viewer

    await client.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id SERIAL PRIMARY KEY,
        store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
        name_en VARCHAR(255),
        name_fr VARCHAR(255),
        name_ar VARCHAR(255),
        slug VARCHAR(255),
        image TEXT,
        parent_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
        sort_order INTEGER DEFAULT 0,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
        category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
        name_en VARCHAR(255),
        name_fr VARCHAR(255),
        name_ar VARCHAR(255),
        slug VARCHAR(255),
        description_en TEXT,
        description_fr TEXT,
        description_ar TEXT,
        price DECIMAL(10,2) NOT NULL,
        compare_at_price DECIMAL(10,2),
        cost_price DECIMAL(10,2),
        sku VARCHAR(100),
        barcode VARCHAR(100),
        stock_quantity INTEGER DEFAULT 0,
        track_inventory BOOLEAN DEFAULT TRUE,
        weight DECIMAL(8,2),
        images TEXT[], -- array of image URLs
        thumbnail TEXT,
        is_active BOOLEAN DEFAULT TRUE,
        is_featured BOOLEAN DEFAULT FALSE,
        tags TEXT[],
        variants JSONB,
        seo_title VARCHAR(255),
        seo_description TEXT,
        views INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // ============ BUYER / CUSTOMER TABLES ============
    await client.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id SERIAL PRIMARY KEY,
        store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255),
        phone VARCHAR(20) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        address TEXT,
        city VARCHAR(100),
        wilaya VARCHAR(100),
        zip_code VARCHAR(20),
        notes TEXT,
        total_orders INTEGER DEFAULT 0,
        total_spent DECIMAL(12,2) DEFAULT 0,
        language VARCHAR(5) DEFAULT 'en',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(store_id, phone)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
        customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
        order_number VARCHAR(50) NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        payment_method VARCHAR(50) NOT NULL,
        payment_status VARCHAR(50) DEFAULT 'pending',
        payment_proof TEXT,
        subtotal DECIMAL(10,2) NOT NULL,
        shipping_cost DECIMAL(10,2) DEFAULT 0,
        discount_amount DECIMAL(10,2) DEFAULT 0,
        total DECIMAL(10,2) NOT NULL,
        customer_name VARCHAR(255),
        customer_phone VARCHAR(20),
        customer_email VARCHAR(255),
        shipping_address TEXT,
        shipping_city VARCHAR(100),
        shipping_wilaya VARCHAR(100),
        shipping_zip VARCHAR(20),
        notes TEXT,
        tracking_number VARCHAR(100),
        delivery_company VARCHAR(100),
        confirmed_by INTEGER,
        prepared_by INTEGER,
        shipped_at TIMESTAMP,
        delivered_at TIMESTAMP,
        cancelled_at TIMESTAMP,
        cancel_reason TEXT,
        is_fake_flagged BOOLEAN DEFAULT FALSE,
        fake_score DECIMAL(5,2),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS order_items (
        id SERIAL PRIMARY KEY,
        order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
        product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
        product_name VARCHAR(255),
        product_image TEXT,
        variant JSONB,
        quantity INTEGER NOT NULL,
        unit_price DECIMAL(10,2) NOT NULL,
        total_price DECIMAL(10,2) NOT NULL
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS abandoned_carts (
        id SERIAL PRIMARY KEY,
        store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
        customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
        customer_phone VARCHAR(20),
        customer_name VARCHAR(255),
        items JSONB NOT NULL,
        total DECIMAL(10,2),
        recovery_status VARCHAR(50) DEFAULT 'abandoned',
        recovery_attempts INTEGER DEFAULT 0,
        last_reminder_at TIMESTAMP,
        recovered_at TIMESTAMP,
        discount_code VARCHAR(50),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS shipping_wilayas (
        id SERIAL PRIMARY KEY,
        store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
        wilaya_name VARCHAR(100) NOT NULL,
        wilaya_code VARCHAR(10),
        desk_price DECIMAL(10,2),
        home_price DECIMAL(10,2),
        delivery_days INTEGER DEFAULT 3,
        is_active BOOLEAN DEFAULT TRUE
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS shipping_partners (
        id SERIAL PRIMARY KEY,
        store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        api_key VARCHAR(255),
        api_url VARCHAR(255),
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS coupons (
        id SERIAL PRIMARY KEY,
        store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
        code VARCHAR(50) NOT NULL,
        type VARCHAR(20) DEFAULT 'percentage',
        value DECIMAL(10,2) NOT NULL,
        min_order DECIMAL(10,2),
        max_uses INTEGER,
        used_count INTEGER DEFAULT 0,
        starts_at TIMESTAMP,
        expires_at TIMESTAMP,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS store_pages (
        id SERIAL PRIMARY KEY,
        store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
        title_en VARCHAR(255),
        title_fr VARCHAR(255),
        title_ar VARCHAR(255),
        slug VARCHAR(255),
        content_en TEXT,
        content_fr TEXT,
        content_ar TEXT,
        is_published BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS reviews (
        id SERIAL PRIMARY KEY,
        store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
        product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
        customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
        rating INTEGER CHECK (rating >= 1 AND rating <= 5),
        comment TEXT,
        is_approved BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS analytics_events (
        id SERIAL PRIMARY KEY,
        store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
        event_type VARCHAR(50),
        data JSONB,
        ip_address VARCHAR(45),
        user_agent TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS domain_requests (
        id SERIAL PRIMARY KEY,
        store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
        domain_name VARCHAR(255) NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        price DECIMAL(10,2),
        payment_status VARCHAR(50) DEFAULT 'unpaid',
        dns_records JSONB,
        ssl_status VARCHAR(50) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
        user_type VARCHAR(50),
        user_id INTEGER,
        title VARCHAR(255),
        message TEXT,
        type VARCHAR(50),
        is_read BOOLEAN DEFAULT FALSE,
        data JSONB,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Insert default platform settings
    const settingsExist = await client.query('SELECT id FROM platform_settings LIMIT 1');
    if (settingsExist.rows.length === 0) {
      await client.query(`
        INSERT INTO platform_settings (site_name, primary_color, secondary_color, accent_color)
        VALUES ('KyoMarket', '#7C3AED', '#06B6D4', '#F59E0B')
      `);
    }

    // Insert platform admin
    const adminExists = await client.query('SELECT id FROM platform_admins WHERE phone = $1', [process.env.PLATFORM_ADMIN_PHONE]);
    if (adminExists.rows.length === 0) {
      const hash = await bcrypt.hash(process.env.PLATFORM_ADMIN_PASSWORD, 12);
      await client.query(`
        INSERT INTO platform_admins (phone, password_hash, name, role)
        VALUES ($1, $2, 'Super Admin', 'super_admin')
      `, [process.env.PLATFORM_ADMIN_PHONE, hash]);
    }

    await client.query('COMMIT');
    console.log('✅ Database initialized successfully!');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Database initialization failed:', error);
    throw error;
  } finally {
    client.release();
  }
};

initDb().then(() => process.exit(0)).catch(() => process.exit(1));
