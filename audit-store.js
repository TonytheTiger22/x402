import Database from "better-sqlite3";
import { createHash, randomUUID } from "crypto";

const db = new Database("audit.db");
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS checks (
  reference     TEXT PRIMARY KEY,
  client_ref    TEXT,
  performed_at  TEXT NOT NULL,
  subject_name  TEXT NOT NULL,
  subject_dob   TEXT,
  subject_country TEXT,
  lists_checked TEXT NOT NULL,
  list_version  TEXT NOT NULL,
  hit_count     INTEGER NOT NULL,
  top_score     REAL,
  top_match     TEXT,
  disposition   TEXT,
  disposed_at   TEXT,
  disposed_by   TEXT,
  price_paid    REAL,
  payment_tx    TEXT,
  record_hash   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_perf ON checks(performed_at);
`);

// Canonical serialisation: stable key order, no floats left to chance.
// Same shape a future on-chain commitment would hash.
export function canonical(o) {
  return JSON.stringify(o, Object.keys(o).sort());
}

export function hashRecord(o) {
  return "0x" + createHash("sha256").update(canonical(o)).digest("hex");
}

export function newReference() {
  const d = new Date();
  const stamp = d.toISOString().slice(0, 10).replace(/-/g, "");
  return `CHK-${stamp}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

export function record(input) {
  const reference = newReference();
  const performed_at = new Date().toISOString();

  const core = {
    reference, performed_at,
    subject_name: input.subject.name,
    subject_dob: input.subject.dob ?? null,
    subject_country: input.subject.country ?? null,
    lists_checked: input.listsChecked.join(","),
    list_version: input.listVersion,
    hit_count: input.hitCount,
    top_score: input.topScore ?? null,
    top_match: input.topMatch ?? null,
  };

  const row = {
    ...core,
    client_ref: input.clientRef ?? null,
    disposition: null, disposed_at: null, disposed_by: null,
    price_paid: input.pricePaid ?? null,
    payment_tx: input.paymentTx ?? null,
    record_hash: hashRecord(core),
  };

  db.prepare(`INSERT INTO checks
    (reference, client_ref, performed_at, subject_name, subject_dob, subject_country,
     lists_checked, list_version, hit_count, top_score, top_match,
     disposition, disposed_at, disposed_by, price_paid, payment_tx, record_hash)
    VALUES
    (@reference, @client_ref, @performed_at, @subject_name, @subject_dob, @subject_country,
     @lists_checked, @list_version, @hit_count, @top_score, @top_match,
     @disposition, @disposed_at, @disposed_by, @price_paid, @payment_tx, @record_hash)`).run(row);

  return row;
}

export function dispose(reference, disposition, by) {
  db.prepare(`UPDATE checks SET disposition=?, disposed_at=?, disposed_by=?
              WHERE reference=? AND disposition IS NULL`)
    .run(disposition, new Date().toISOString(), by, reference);
  return get(reference);
}

export const get  = (r) => db.prepare("SELECT * FROM checks WHERE reference=?").get(r);
export const list = (n = 100) =>
  db.prepare("SELECT * FROM checks ORDER BY performed_at DESC LIMIT ?").all(n);

export function verify(reference) {
  const r = get(reference);
  if (!r) return { found: false };
  const core = {
    reference: r.reference, performed_at: r.performed_at,
    subject_name: r.subject_name, subject_dob: r.subject_dob,
    subject_country: r.subject_country, lists_checked: r.lists_checked,
    list_version: r.list_version, hit_count: r.hit_count,
    top_score: r.top_score, top_match: r.top_match,
  };
  const recomputed = hashRecord(core);
  return { found: true, stored: r.record_hash, recomputed,
           intact: recomputed === r.record_hash, canonical: canonical(core) };
}
