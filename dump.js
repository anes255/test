const { Pool } = require('pg');
const fs = require('fs');

const pool = new Pool({
  host: 'ep-morning-moon-advnrn0x-pooler.c-2.us-east-1.aws.neon.tech',
  database: 'neondb',
  user: 'neondb_owner',
  password: 'npg_pAog21JIZiDc',
  port: 5432,
  ssl: { rejectUnauthorized: false }
});

async function dump() {
  const out = [];
  const { rows: tables } = await pool.query(`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
  `);

  console.log('Tables found:', tables.map(t => t.tablename).join(', '));

  for (const { tablename } of tables) {
    // Get column info
    const { rows: cols } = await pool.query(`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position
    `, [tablename]);

    // Get all rows
    const { rows } = await pool.query(`SELECT * FROM "${tablename}"`);
    console.log(`  ${tablename}: ${rows.length} rows`);

    if (rows.length === 0) continue;

    const colNames = cols.map(c => `"${c.column_name}"`).join(', ');
    out.push(`-- TABLE: ${tablename}`);

    for (const row of rows) {
      const vals = cols.map(c => {
        const v = row[c.column_name];
        if (v === null || v === undefined) return 'NULL';
        if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
        if (typeof v === 'number') return v;
        if (v instanceof Date) return `'${v.toISOString()}'`;
        if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
        return `'${String(v).replace(/'/g, "''")}'`;
      }).join(', ');
      out.push(`INSERT INTO "${tablename}" (${colNames}) VALUES (${vals}) ON CONFLICT DO NOTHING;`);
    }
    out.push('');
  }

  fs.writeFileSync('backup.sql', out.join('\n'), 'utf8');
  console.log('\nDone! backup.sql created.');
  await pool.end();
}

dump().catch(e => { console.error(e.message); process.exit(1); });
