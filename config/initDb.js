const pool = require('./db');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const initDb = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ==================== PLATFORM LEVEL TABLES ====================
    
    // Platform settings (super admin controls)
    await client.query(`
      CREATE TABLE IF NOT EXISTS platform_settings (
        id SERIAL PRIMARY KEY,
        site_name VARCHAR(255) DEFAULT 'MultiStore Platform',
        primary_color VARCHAR(7) DEFAULT '#7C3AED',
        secondary_color VARCHAR(7) DEFAULT '#10B981',
        accent_color VARCHAR(7) DEFAULT '#F59E0B',
        subscription_monthly_price DECIMAL(10,2) DEFAULT 2900.00,
        subscription_yearly_price DECIMAL(10,2) DEFAULT 29000.00,
        subscription_trial_days INT DEFAULT 14,
        currency VARCHAR(10) DEFAULT 'DZD',
        logo_url TEXT,
        favicon_url TEXT,
        meta_description TEXT,
        maintenance_mode BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Store owners (register on main platform)
    await client.query(`
      CREATE TABLE IF NOT EXISTS store_owners (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        full_name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        phone VARCHAR(20) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        address TEXT,
        city VARCHAR(100),
        wilaya VARCHAR(100),
        is_active BOOLEAN DEFAULT TRUE,
        is_verified BOOLEAN DEFAULT FALSE,
        subscription_plan VARCHAR(20) DEFAULT 'trial',
        subscription_start TIMESTAMP DEFAULT NOW(),
        subscription_end TIMESTAMP DEFAULT (NOW() + INTERVAL '14 days'),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // ==================== STORE LEVEL TABLES ====================

    // Stores
    await client.query(`
      CREATE TABLE IF NOT EXISTS stores (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id UUID REFERENCES store_owners(id) ON DELETE CASCADE,
        store_name VARCHAR(255) NOT NULL,
        slug VARCHAR(255) UNIQUE NOT NULL,
        description TEXT,
        logo_url TEXT,
        favicon_url TEXT,
        primary_color VARCHAR(7) DEFAULT '#7C3AED',
        secondary_color VARCHAR(7) DEFAULT '#10B981',
        accent_color VARCHAR(7) DEFAULT '#F59E0B',
        bg_color VARCHAR(7) DEFAULT '#F9FAFB',
        currency VARCHAR(10) DEFAULT 'DZD',
        is_active BOOLEAN DEFAULT TRUE,
        is_published BOOLEAN DEFAULT FALSE,
        meta_title VARCHAR(255),
        meta_description TEXT,
        hero_title TEXT,
        hero_subtitle TEXT,
        contact_email VARCHAR(255),
        contact_phone VARCHAR(20),
        contact_address TEXT,
        social_facebook TEXT,
        social_instagram TEXT,
        social_tiktok TEXT,
        total_visits INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Store staff accounts (multi-user with roles)
    await client.query(`
      CREATE TABLE IF NOT EXISTS store_staff (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        store_id UUID REFERENCES stores(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255),
        phone VARCHAR(20),
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(20) NOT NULL DEFAULT 'viewer',
        is_active BOOLEAN DEFAULT TRUE,
        last_login TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        CONSTRAINT valid_role CHECK (role IN ('admin', 'preparer', 'confirmer', 'accountant', 'viewer'))
      )
    `);

    // Product categories
    await client.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        store_id UUID REFERENCES stores(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        slug VARCHAR(255) NOT NULL,
        description TEXT,
        image_url TEXT,
        parent_id UUID REFERENCES categories(id) ON DELETE SET NULL,
        sort_order INT DEFAULT 0,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Products
    await client.query(`
      CREATE TABLE IF NOT EXISTS products (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        store_id UUID REFERENCES stores(id) ON DELETE CASCADE,
        category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
        name VARCHAR(255) NOT NULL,
        slug VARCHAR(255) NOT NULL,
        description TEXT,
        price DECIMAL(10,2) NOT NULL,
        compare_price DECIMAL(10,2),
        cost_price DECIMAL(10,2),
        sku VARCHAR(100),
        barcode VARCHAR(100),
        stock_quantity INT DEFAULT 0,
        track_inventory BOOLEAN DEFAULT TRUE,
        weight DECIMAL(10,2),
        is_active BOOLEAN DEFAULT TRUE,
        is_featured BOOLEAN DEFAULT FALSE,
        images JSONB DEFAULT '[]',
        variants JSONB DEFAULT '[]',
        tags TEXT[],
        seo_title VARCHAR(255),
        seo_description TEXT,
        total_sold INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Store customers (buyers - per store)
    await client.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        store_id UUID REFERENCES stores(id) ON DELETE CASCADE,
        full_name VARCHAR(255) NOT NULL,
        email VARCHAR(255),
        phone VARCHAR(20) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        address TEXT,
        city VARCHAR(100),
        wilaya VARCHAR(100),
        zip_code VARCHAR(20),
        is_active BOOLEAN DEFAULT TRUE,
        total_orders INT DEFAULT 0,
        total_spent DECIMAL(10,2) DEFAULT 0,
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(store_id, phone)
      )
    `);

    // Orders
    await client.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        store_id UUID REFERENCES stores(id) ON DELETE CASCADE,
        customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
        order_number SERIAL,
        status VARCHAR(30) DEFAULT 'pending',
        customer_name VARCHAR(255) NOT NULL,
        customer_phone VARCHAR(20) NOT NULL,
        customer_email VARCHAR(255),
        shipping_address TEXT NOT NULL,
        shipping_city VARCHAR(100),
        shipping_wilaya VARCHAR(100),
        shipping_zip VARCHAR(20),
        subtotal DECIMAL(10,2) NOT NULL,
        shipping_cost DECIMAL(10,2) DEFAULT 0,
        discount DECIMAL(10,2) DEFAULT 0,
        total DECIMAL(10,2) NOT NULL,
        payment_method VARCHAR(30) DEFAULT 'cod',
        payment_status VARCHAR(20) DEFAULT 'pending',
        payment_proof_url TEXT,
        notes TEXT,
        confirmed_by UUID,
        prepared_by UUID,
        shipped_at TIMESTAMP,
        delivered_at TIMESTAMP,
        cancelled_at TIMESTAMP,
        cancel_reason TEXT,
        is_abandoned BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        CONSTRAINT valid_status CHECK (status IN ('pending','confirmed','preparing','shipped','delivered','cancelled','returned')),
        CONSTRAINT valid_payment CHECK (payment_method IN ('cod','ccp','baridimob','bank_transfer')),
        CONSTRAINT valid_payment_status CHECK (payment_status IN ('pending','paid','failed','refunded'))
      )
    `);

    // Order items
    await client.query(`
      CREATE TABLE IF NOT EXISTS order_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
        product_id UUID REFERENCES products(id) ON DELETE SET NULL,
        product_name VARCHAR(255) NOT NULL,
        product_image TEXT,
        variant_info JSONB,
        quantity INT NOT NULL,
        unit_price DECIMAL(10,2) NOT NULL,
        total_price DECIMAL(10,2) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Shipping / Delivery companies
    await client.query(`
      CREATE TABLE IF NOT EXISTS delivery_companies (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        store_id UUID REFERENCES stores(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        api_key TEXT,
        is_active BOOLEAN DEFAULT TRUE,
        base_rate DECIMAL(10,2) DEFAULT 0,
        wilayas_rates JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Shipping wilayas configuration
    await client.query(`
      CREATE TABLE IF NOT EXISTS shipping_wilayas (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        store_id UUID REFERENCES stores(id) ON DELETE CASCADE,
        wilaya_name VARCHAR(100) NOT NULL,
        wilaya_code VARCHAR(10) NOT NULL,
        home_delivery_price DECIMAL(10,2) DEFAULT 0,
        desk_delivery_price DECIMAL(10,2) DEFAULT 0,
        is_active BOOLEAN DEFAULT TRUE,
        delivery_days INT DEFAULT 3,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Store pages (custom pages)
    await client.query(`
      CREATE TABLE IF NOT EXISTS store_pages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        store_id UUID REFERENCES stores(id) ON DELETE CASCADE,
        title VARCHAR(255) NOT NULL,
        slug VARCHAR(255) NOT NULL,
        content TEXT,
        is_published BOOLEAN DEFAULT TRUE,
        sort_order INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Payment settings per store
    await client.query(`
      CREATE TABLE IF NOT EXISTS payment_settings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        store_id UUID REFERENCES stores(id) ON DELETE CASCADE,
        cod_enabled BOOLEAN DEFAULT TRUE,
        ccp_enabled BOOLEAN DEFAULT FALSE,
        ccp_account VARCHAR(100),
        ccp_name VARCHAR(255),
        baridimob_enabled BOOLEAN DEFAULT FALSE,
        baridimob_rip VARCHAR(100),
        bank_transfer_enabled BOOLEAN DEFAULT FALSE,
        bank_name VARCHAR(255),
        bank_account VARCHAR(100),
        bank_rib VARCHAR(100),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Apps/Integrations installed per store
    await client.query(`
      CREATE TABLE IF NOT EXISTS store_apps (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        store_id UUID REFERENCES stores(id) ON DELETE CASCADE,
        app_name VARCHAR(100) NOT NULL,
        app_slug VARCHAR(100) NOT NULL,
        is_active BOOLEAN DEFAULT FALSE,
        config JSONB DEFAULT '{}',
        installed_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Analytics events
    await client.query(`
      CREATE TABLE IF NOT EXISTS analytics_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        store_id UUID REFERENCES stores(id) ON DELETE CASCADE,
        event_type VARCHAR(50) NOT NULL,
        event_data JSONB DEFAULT '{}',
        ip_address VARCHAR(50),
        user_agent TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Cart (for abandoned cart tracking)
    await client.query(`
      CREATE TABLE IF NOT EXISTS carts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        store_id UUID REFERENCES stores(id) ON DELETE CASCADE,
        customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
        customer_phone VARCHAR(20),
        customer_name VARCHAR(255),
        items JSONB DEFAULT '[]',
        total DECIMAL(10,2) DEFAULT 0,
        is_abandoned BOOLEAN DEFAULT FALSE,
        is_recovered BOOLEAN DEFAULT FALSE,
        recovery_sent_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // AI Chatbot messages
    await client.query(`
      CREATE TABLE IF NOT EXISTS chatbot_messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        store_id UUID REFERENCES stores(id) ON DELETE CASCADE,
        session_id VARCHAR(255),
        role VARCHAR(20) NOT NULL,
        message TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Insert default platform settings
    await client.query(`
      INSERT INTO platform_settings (id, site_name) 
      VALUES (1, 'MultiStore Platform')
      ON CONFLICT (id) DO NOTHING
    `);

    // Insert default super admin as store owner for login purposes
    const adminHash = await bcrypt.hash('admin123', 10);
    await client.query(`
      INSERT INTO store_owners (id, full_name, email, phone, password_hash, is_active, is_verified, subscription_plan)
      VALUES (
        '00000000-0000-0000-0000-000000000001',
        'Super Admin',
        'admin@multistore.com',
        '0661573805',
        $1,
        true,
        true,
        'admin'
      )
      ON CONFLICT (phone) DO NOTHING
    `, [adminHash]);

    await client.query('COMMIT');
    console.log('✅ Database initialized successfully!');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Database initialization failed:', error);
  } finally {
    client.release();
  }
};

initDb().then(() => process.exit(0)).catch(() => process.exit(1));
