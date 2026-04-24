const { Pool } = require('pg');
const fs = require('fs');

// PUT YOUR NEW NEON CONNECTION STRING HERE
const NEW_DB = 'postgresql://neondb_owner:npg_qfY2NioQzev7@ep-little-cloud-a46aw80u-pooler.us-east-1.aws.neon.tech/neondb';

const pool = new Pool({
  connectionString: NEW_DB,
  ssl: { rejectUnauthorized: false }
});

async function importDb() {
  const sql = fs.readFileSync('backup.sql', 'utf8');
  const statements = sql.split('\n').filter(l => l.startsWith('INSERT') || l.startsWith('CREATE') || l.startsWith('ALTER'));

  console.log(`Running ${statements.length} statements...`);
  let ok = 0, fail = 0;
  for (const stmt of statements) {
    try {
      await pool.query(stmt);
      ok++;
    } catch (e) {
      console.error('SKIP:', e.message.slice(0, 80));
      fail++;
    }
  }
  console.log(`Done. ${ok} ok, ${fail} skipped.`);
  await pool.end();
}

importDb().catch(e => { console.error(e.message); process.exit(1); });
