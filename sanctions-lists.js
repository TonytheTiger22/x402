// UN, EU and UK sanctions lists -> the shared `entities` / `entity_aliases`
// tables (the same ones OFAC lives in; see ingest-ofac-full.mjs).
//
// Each parser is a pure function: XML string in, array of normalised records
// out, so it can be tested against a fixture without a network or database.
// refreshSource() downloads, parses, sanity-checks and swaps the data in a
// single transaction, so a bad download can never leave a list half-loaded or
// empty — the previous data stays live.
import { XMLParser } from "fast-xml-parser";

const arr = (x) => (Array.isArray(x) ? x : x != null ? [x] : []);
const txt = (x) => (x == null ? "" : typeof x === "object" ? txt(x["#text"]) : String(x).trim());
const join = (...parts) => parts.map(txt).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();

// Every node called `key`, anywhere in the document. Used instead of a fixed
// path so a wrapper element being added or renamed doesn't silently produce
// zero records (the min-count guard below catches the rest).
function findAll(node, key, out = []) {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) { node.forEach((n) => findAll(n, key, out)); return out; }
  for (const [k, v] of Object.entries(node)) {
    if (k === key) arr(v).forEach((x) => out.push(x));
    else findAll(v, key, out);
  }
  return out;
}

const uniq = (list) => [...new Set(list.filter(Boolean))];

// ---- UN Security Council consolidated list --------------------------------
export function parseUN(xml) {
  const doc = new XMLParser({ ignoreAttributes: true, parseTagValue: false }).parse(xml);
  const out = [];
  const one = (n, type) => {
    const name = join(n.FIRST_NAME, n.SECOND_NAME, n.THIRD_NAME, n.FOURTH_NAME);
    const uid = txt(n.REFERENCE_NUMBER) || txt(n.DATAID);
    if (!name || !uid) return;
    const dobs = arr(n.INDIVIDUAL_DATE_OF_BIRTH);
    const dobNode = dobs.find((d) => txt(d.DATE)) || dobs.find((d) => txt(d.YEAR)) || null;
    const dob = dobNode ? txt(dobNode.DATE) || txt(dobNode.YEAR) : null;
    const nat = arr(n.NATIONALITY).flatMap((x) => arr(x.VALUE)).map(txt).find(Boolean) || null;
    const aliases = [...arr(n.INDIVIDUAL_ALIAS), ...arr(n.ENTITY_ALIAS)].map((a) => txt(a.ALIAS_NAME));
    out.push({ uid, name, type, dob: dob ? dob.slice(0, 10) : null, nationality: nat,
               program: txt(n.UN_LIST_TYPE) || null, aliases: uniq(aliases) });
  };
  findAll(doc, "INDIVIDUAL").forEach((n) => one(n, "Individual"));
  findAll(doc, "ENTITY").forEach((n) => one(n, "Entity"));
  return out;
}

// ---- EU consolidated financial sanctions list (FSF) ------------------------
export function parseEU(xml) {
  const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_",
                              parseAttributeValue: false, parseTagValue: false }).parse(xml);
  const out = [];
  for (const e of findAll(doc, "sanctionEntity")) {
    const names = arr(e.nameAlias)
      .map((a) => txt(a["@_wholeName"]) || join(a["@_firstName"], a["@_middleName"], a["@_lastName"]))
      .filter(Boolean);
    const uid = txt(e["@_euReferenceNumber"]) || txt(e["@_logicalId"]);
    if (!names.length || !uid) continue;
    const code = txt(arr(e.subjectType)[0]?.["@_code"]).toLowerCase();
    const births = arr(e.birthdate);
    const b = births.find((x) => txt(x["@_birthdate"])) || births.find((x) => txt(x["@_year"]));
    const dob = b ? txt(b["@_birthdate"]) || txt(b["@_year"]) : null;
    const nat = arr(e.citizen).map((c) => txt(c["@_countryDescription"])).find(Boolean) || null;
    const program = uniq(arr(e.regulation).map((r) => txt(r["@_programme"]))).join(",") || null;
    out.push({ uid, name: names[0], type: code === "person" ? "Individual" : "Entity",
               dob: dob ? dob.slice(0, 10) : null, nationality: nat, program,
               aliases: uniq(names.slice(1)) });
  }
  return out;
}

// ---- UK Sanctions List (FCDO; replaced the OFSI consolidated list) ---------
// NOTE: written from the published schema description, not yet run against the
// live file — see the min-count guard and the verification step in the notes.
export function parseUK(xml) {
  const doc = new XMLParser({ ignoreAttributes: true, parseTagValue: false }).parse(xml);
  const out = [];
  for (const d of findAll(doc, "Designation")) {
    const names = findAll(d.Names ?? d, "Name").map((n) => ({
      full: txt(n.Name6) && !txt(n.Name1) ? txt(n.Name6)
            : join(n.Name1, n.Name2, n.Name3, n.Name4, n.Name5, n.Name6),
      primary: /primary/i.test(txt(n.NameType)),
    })).filter((n) => n.full);
    const uid = txt(d.UniqueID) || txt(d.OFSIGroupID);
    if (!names.length || !uid) continue;
    const main = names.find((n) => n.primary) || names[0];
    const kind = txt(d.IndividualEntityShip).toLowerCase();
    const rawDob = findAll(d, "DOB").map(txt).find(Boolean) || null;
    const m = rawDob && rawDob.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);     // dd/mm/yyyy -> ISO
    const dob = m ? `${m[3]}-${m[2]}-${m[1]}` : rawDob;
    const nat = findAll(d, "Nationality").map(txt).find(Boolean) || null;
    out.push({ uid, name: main.full, type: kind.startsWith("individual") ? "Individual" : "Entity",
               dob: dob ? dob.slice(0, 10) : null, nationality: nat,
               program: txt(d.RegimeName) || null,
               aliases: uniq(names.filter((n) => n !== main).map((n) => n.full)) });
  }
  return out;
}

export const SOURCES = {
  UN: {
    label: "UN Security Council Consolidated List",
    url: "https://scsanctions.un.org/resources/xml/en/consolidated.xml",
    parse: parseUN, minRecords: 300,
  },
  EU: {
    label: "EU Consolidated Financial Sanctions List",
    url: "https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw",
    parse: parseEU, minRecords: 1000,
  },
  UK: {
    label: "UK Sanctions List (FCDO)",
    url: "https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.xml",
    parse: parseUK, minRecords: 1000,
  },
};

// Replace one source's rows with `records`, atomically. `client` is a pg Client.
export async function storeRecords(client, source, records) {
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM entities WHERE source = $1", [source]);
    const seen = new Set();
    for (const r of records) {
      if (seen.has(r.uid)) continue;           // (source, uid) is unique
      seen.add(r.uid);
      const { rows } = await client.query(
        `INSERT INTO entities (source, uid, canonical_name, entity_type, dob, nationality, program)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [source, r.uid, r.name, r.type, r.dob, r.nationality, r.program]);
      const aliases = r.aliases.filter((a) => a !== r.name);
      if (aliases.length)
        await client.query(
          `INSERT INTO entity_aliases (entity_id, alias_name) SELECT $1, unnest($2::text[])`,
          [rows[0].id, aliases]);
    }
    await client.query(
      `INSERT INTO list_metadata (source, list_version, refreshed_at) VALUES ($1,$2,now())
       ON CONFLICT (source) DO UPDATE SET list_version=$2, refreshed_at=now()`,
      [source, new Date().toISOString().slice(0, 10)]);
    await client.query("COMMIT");
    return seen.size;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

export async function refreshSource(client, source, log = console.log) {
  const s = SOURCES[source];
  if (!s) throw new Error(`Unknown source ${source}`);
  log(`[${source}] downloading ${s.label}...`);
  const res = await fetch(s.url, { redirect: "follow", signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`${source}: download failed, HTTP ${res.status}`);
  const xml = await res.text();
  const records = s.parse(xml);
  if (records.length < s.minRecords)
    throw new Error(`${source}: only ${records.length} records parsed (expected at least ` +
                    `${s.minRecords}) — the file format may have changed; previous data left untouched`);
  const n = await storeRecords(client, source, records);
  log(`[${source}] loaded ${n} records`);
  return n;
}
