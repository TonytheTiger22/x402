import pg from "pg";

const URL = "https://raw.githubusercontent.com/kindrat86/ofac-sdn-json/main/data/ofac-sdn.json";
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

console.log("Downloading OFAC SDN list...");
const res = await fetch(URL);
const data = await res.json();
console.log(`Published: ${data.published} — ${data.counts.entries} entries`);

await client.connect();

console.log("Clearing old OFAC entries...");
await client.query("DELETE FROM entities WHERE source = 'OFAC'");

console.log("Inserting fresh entries...");
let count = 0;
for (const e of data.entries) {
  const { rows } = await client.query(
    `INSERT INTO entities (source, uid, canonical_name, entity_type, program)
     VALUES ('OFAC', $1, $2, $3, $4) RETURNING id`,
    [e.uid, e.name, e.type, (e.programs || []).join(",")]
  );
  const entityId = rows[0].id;
  for (const alias of e.alternateNames || []) {
    await client.query(
      `INSERT INTO entity_aliases (entity_id, alias_name) VALUES ($1, $2)`,
      [entityId, alias]
    );
  }
  count++;
  if (count % 2000 === 0) console.log(`  ${count} done...`);
}

await client.query(
  `INSERT INTO list_metadata (source, list_version, refreshed_at)
   VALUES ('OFAC', $1, now())
   ON CONFLICT (source) DO UPDATE SET list_version = $1, refreshed_at = now()`,
  [data.published]
);

console.log(`Done. ${count} entities loaded.`);
await client.end();
