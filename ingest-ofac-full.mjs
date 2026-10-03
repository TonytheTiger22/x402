import pg from "pg";
import { XMLParser } from "fast-xml-parser";

const URL = "https://sanctionslistservice.ofac.treas.gov/api/download/sdn.xml";
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const arr = (x) => (Array.isArray(x) ? x : x != null ? [x] : []);
const fullName = (e) => [e.firstName, e.lastName].filter(Boolean).join(" ").trim();

console.log("Downloading sdn.xml (~29MB, may take a minute)...");
const res = await fetch(URL);
const xml = await res.text();
console.log(`Downloaded ${(xml.length / 1e6).toFixed(1)} MB`);

const parser = new XMLParser({ ignoreAttributes: true });
const doc = parser.parse(xml);
const entries = arr(doc.sdnList?.sdnEntry);
if (entries.length < 5000) throw new Error(`Only ${entries.length} entries parsed — schema may have changed`);
console.log(`Parsed ${entries.length} entries`);

await client.connect();

// Wrapped in a transaction: the live API queries this same table on every
// /screen call, so a crash partway through (bad row, network blip, OOM)
// must not leave the table deleted-but-not-refilled. Either the whole
// refresh lands, or none of it does and the previous data stays live.
try {
  await client.query("BEGIN");
  console.log("Clearing old OFAC entries...");
  await client.query("DELETE FROM entities WHERE source = 'OFAC'");

  let count = 0;
  for (const e of entries) {
    const name = fullName(e) || e.lastName || "";
    if (!name) continue;

    const programs = arr(e.programList?.program).join(",");

    const dobItems = arr(e.dateOfBirthList?.dateOfBirthItem);
    const dob = dobItems[0]?.dateOfBirth || null;

    const natItems = arr(e.nationalityList?.nationality);
    const citItems = arr(e.citizenshipList?.citizenship);
    const nationality = natItems[0]?.country || citItems[0]?.country || null;

    const { rows } = await client.query(
      `INSERT INTO entities (source, uid, canonical_name, entity_type, dob, nationality, program)
       VALUES ('OFAC', $1, $2, $3, $4, $5, $6) RETURNING id`,
      [e.uid, name, e.sdnType || "Individual", dob, nationality, programs]
    );
    const entityId = rows[0].id;

    for (const aka of arr(e.akaList?.aka)) {
      const aliasName = fullName(aka) || aka.lastName;
      if (aliasName) {
        await client.query(
          `INSERT INTO entity_aliases (entity_id, alias_name) VALUES ($1, $2)`,
          [entityId, aliasName]
        );
      }
    }

    count++;
    if (count % 2000 === 0) console.log(`  ${count} done...`);
  }

  await client.query(
    `INSERT INTO list_metadata (source, list_version, refreshed_at)
     VALUES ('OFAC', $1, now())
     ON CONFLICT (source) DO UPDATE SET list_version = $1, refreshed_at = now()`,
    [new Date().toISOString().slice(0, 10)]
  );

  await client.query("COMMIT");

  const withDob = await client.query("SELECT count(*) FROM entities WHERE source='OFAC' AND dob IS NOT NULL");
  const withNat = await client.query("SELECT count(*) FROM entities WHERE source='OFAC' AND nationality IS NOT NULL");
  console.log(`Done. ${count} entities. ${withDob.rows[0].count} have DOB. ${withNat.rows[0].count} have nationality.`);
} catch (err) {
  await client.query("ROLLBACK");
  console.error("Ingest failed — rolled back, previous OFAC data is untouched.", err);
  process.exitCode = 1;
} finally {
  await client.end();
}
