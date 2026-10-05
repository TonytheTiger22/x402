// Prepaid balances ("load your wallet"): a visitor tops up once in USDC on
// Base, then each check is deducted from that balance — no wallet popup
// per check.
//
// Identity is the visitor's wallet address, not an email account: email
// login links are shown on-page today (no email delivery yet), so anyone
// could sign in as any email — fine for a case queue, not for money.
// Spending a balance instead requires a signed sign-in message from the
// address that holds it (a plain personal_sign, not a token approval).
//
// Money is stored as integer micro-USDC (6 decimals, same as the token),
// never floats. The balance is the sum of an append-only ledger, so every
// top-up, charge and refund stays auditable.

import { randomUUID, randomBytes } from "crypto";
import { db } from "./db.js";

db.exec(`
CREATE TABLE IF NOT EXISTS credit_ledger (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  address     TEXT NOT NULL,              -- lowercase 0x address
  delta       INTEGER NOT NULL,           -- micro-USDC; + top-up/refund, - charge
  kind        TEXT NOT NULL,              -- 'topup' | 'charge' | 'refund'
  label       TEXT,
  ref         TEXT,                       -- charge id this refund reverses, etc.
  tx          TEXT UNIQUE,                -- top-up settlement tx: one credit per tx
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credit_addr ON credit_ledger(address, id);
CREATE TABLE IF NOT EXISTS credit_nonces (
  nonce       TEXT PRIMARY KEY,
  expires_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS credit_sessions (
  token       TEXT PRIMARY KEY,
  address     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
`);

export const MICROS = 1_000_000;
export const toMicros = (usd) => Math.round(Number(usd) * MICROS);
export const toUsd = (micros) => micros / MICROS;
const norm = (a) => String(a || "").toLowerCase();
const isAddr = (a) => /^0x[0-9a-f]{40}$/.test(norm(a));

const NONCE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function balanceMicros(address) {
  return db.prepare("SELECT COALESCE(SUM(delta), 0) AS b FROM credit_ledger WHERE address = ?")
    .get(norm(address)).b;
}

export const history = (address, n = 20) =>
  db.prepare(`SELECT id, delta, kind, label, tx, created_at FROM credit_ledger
              WHERE address = ? ORDER BY id DESC LIMIT ?`).all(norm(address), n);

// Credits a settled top-up. Idempotent per transaction hash: replaying the
// same settlement can never credit twice. Returns false if already credited.
export function creditTopup(address, micros, tx) {
  if (!isAddr(address)) throw new Error("Invalid address for top-up");
  if (!Number.isInteger(micros) || micros <= 0) throw new Error("Invalid top-up amount");
  if (!tx) throw new Error("A top-up needs a settlement transaction");
  const r = db.prepare(`INSERT OR IGNORE INTO credit_ledger (address, delta, kind, label, tx, created_at)
                        VALUES (?, ?, 'topup', 'Top-up', ?, ?)`)
    .run(norm(address), micros, tx.toLowerCase(), new Date().toISOString());
  return r.changes === 1;
}

export class InsufficientBalance extends Error {
  constructor(balance, needed) {
    super("Not enough prepaid balance");
    this.code = "INSUFFICIENT_BALANCE"; this.balance = balance; this.needed = needed;
  }
}

// Check-and-deduct in one transaction (better-sqlite3 transactions are
// synchronous, so two concurrent requests can't both spend the last cent).
// Returns the ledger id, used to refund this exact charge if the check fails.
export const charge = db.transaction((address, micros, label) => {
  const bal = balanceMicros(address);
  if (bal < micros) throw new InsufficientBalance(bal, micros);
  return db.prepare(`INSERT INTO credit_ledger (address, delta, kind, label, created_at)
                     VALUES (?, ?, 'charge', ?, ?)`)
    .run(norm(address), -micros, label, new Date().toISOString()).lastInsertRowid;
});

export function refund(chargeId) {
  const c = db.prepare("SELECT * FROM credit_ledger WHERE id = ? AND kind = 'charge'").get(chargeId);
  if (!c) return;
  db.prepare(`INSERT INTO credit_ledger (address, delta, kind, label, ref, created_at)
              VALUES (?, ?, 'refund', ?, ?, ?)`)
    .run(c.address, -c.delta, "Refund: " + (c.label || "check"), String(chargeId), new Date().toISOString());
}

// --- Sign-in with the wallet that holds the balance ---

export function newSignInMessage(host) {
  const nonce = randomBytes(16).toString("hex");
  db.prepare("DELETE FROM credit_nonces WHERE expires_at < ?").run(new Date().toISOString());
  db.prepare("INSERT INTO credit_nonces (nonce, expires_at) VALUES (?, ?)")
    .run(nonce, new Date(Date.now() + NONCE_TTL_MS).toISOString());
  return {
    nonce,
    message: `Sign in to ${host} to use your prepaid screening balance.\n\n` +
      `This only proves you own this wallet. It does not move funds or approve any spending.\n\n` +
      `Nonce: ${nonce}\nIssued: ${new Date().toISOString()}`,
  };
}

// Single-use: a nonce is deleted when consumed, so a signature can't be replayed.
export function consumeNonce(nonce) {
  const row = db.prepare("SELECT * FROM credit_nonces WHERE nonce = ?").get(nonce);
  if (!row) return false;
  db.prepare("DELETE FROM credit_nonces WHERE nonce = ?").run(nonce);
  return new Date(row.expires_at).getTime() >= Date.now();
}

export function createSession(address) {
  const token = randomUUID();
  const now = Date.now();
  db.prepare("INSERT INTO credit_sessions (token, address, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .run(token, norm(address), new Date(now).toISOString(), new Date(now + SESSION_TTL_MS).toISOString());
  return { token, maxAgeSec: SESSION_TTL_MS / 1000 };
}

export function addressForSession(token) {
  if (!token) return null;
  const row = db.prepare("SELECT * FROM credit_sessions WHERE token = ?").get(token);
  if (!row || new Date(row.expires_at).getTime() < Date.now()) return null;
  return row.address;
}

export function destroySession(token) {
  if (token) db.prepare("DELETE FROM credit_sessions WHERE token = ?").run(token);
}
