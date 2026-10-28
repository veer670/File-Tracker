// One-time: copy your local data/db.json into Neon.
//   $env:DATABASE_URL="postgresql://..."; node migrate.js
const fs = require('fs'), path = require('path');
const { Pool } = require('pg');
const url = process.env.DATABASE_URL;
if (!url) { console.error('Set DATABASE_URL first.'); process.exit(1); }
const file = path.join(__dirname, 'data', 'db.json');
if (!fs.existsSync(file)) { console.error('data/db.json not found.'); process.exit(1); }
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
(async () => {
  const p = new Pool({ connectionString: url, max: 1, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false } });
  await p.query('CREATE TABLE IF NOT EXISTS kv (id int PRIMARY KEY, data jsonb NOT NULL, ver int NOT NULL DEFAULT 0)');
  await p.query('INSERT INTO kv (id, data, ver) VALUES (1, $1, 0) ON CONFLICT (id) DO UPDATE SET data = $1, ver = kv.ver + 1', [JSON.stringify(data)]);
  console.log('Done. Files:', data.files.length, ' Movements:', data.movements.length, ' Users:', (data.users || []).length);
  await p.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
