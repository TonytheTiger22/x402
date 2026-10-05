// Usage: DATABASE_URL=... node ingest-sanctions.mjs [UN|EU|UK|all]
import pg from "pg";
import { SOURCES, refreshSource } from "./sanctions-lists.js";

const arg = (process.argv[2] || "all").toUpperCase();
const wanted = arg === "ALL" ? Object.keys(SOURCES) : [arg];
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
let failed = false;
for (const s of wanted) {
  try { await refreshSource(client, s); }
  catch (e) { failed = true; console.error(String(e.message || e)); }
}
await client.end();
process.exitCode = failed ? 1 : 0;
