const pool = require('./db');
require('dotenv').config();

const initDb = async () => {
  try {
    // Just verify database connection and check tables exist
    const result = await pool.query(`
      SELECT table_name FROM information_schema.tables 
      WHERE table_schema = 'public' ORDER BY table_name
    `);
    const tables = result.rows.map(r => r.table_name);
    console.log(`📋 Found ${tables.length} tables:`, tables.join(', '));
    
    if (tables.includes('store_owners') && tables.includes('stores') && tables.includes('platform_settings')) {
      console.log('✅ Core tables exist — database is ready');
    } else {
      console.warn('⚠️ Some core tables missing. Expected: store_owners, stores, platform_settings');
      console.warn('   Found:', tables.join(', '));
    }
  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
    throw error;
  }
};

module.exports = { initDb };

if (require.main === module) {
  initDb().then(() => process.exit(0)).catch(() => process.exit(1));
}
