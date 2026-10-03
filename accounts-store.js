// Minimal multi-tenant accounts for the case management portal.
//
// Auth model: magic link by email, no passwords. A business owner enters
// their email, we mint a short-lived token, and (today) hand them the link
// directly rather than emailing it — no transactional email provider is
// wired up yet (see the note on requestLink below). Clicking the link
// starts a 30-day session, stored server-side and referenced by an
// httpOnly cookie.
//
// Sessions and accounts live in the same sqlite file as the audit trail —
// one small file, no new infrastructure.

import Database from "better-sqlite3";
import { randomUUID } from "crypto";

const db = new Database("audit.db");
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS accounts (
  id         TEXT PRIMARY KEY,
  email      TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS login_tokens (
  token      TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
`);

const LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function getOrCreateAccount(email) {
  const existing = db.prepare("SELECT * FROM accounts WHERE email = ?").get(email);
  if (existing) return existing;
  const row = { id: randomUUID(), email, created_at: new Date().toISOString() };
  db.prepare("INSERT INTO accounts (id, email, created_at) VALUES (@id, @email, @created_at)").run(row);
  return row;
}

// Issues a login token for an email address, creating the account on first
// use. Returns the token and the link to send — today the caller shows
// this directly on the page rather than emailing it. Wiring real delivery
// is a signup-and-swap, not a redesign: drop in a transactional provider
// (Resend and Brevo both have workable free tiers) and send `link`
// instead of displaying it.
export function requestLink(email, baseUrl) {
  const token = randomUUID();
  const now = new Date();
  const expires = new Date(now.getTime() + LOGIN_TOKEN_TTL_MS);
  db.prepare(`INSERT INTO login_tokens (token, email, created_at, expires_at)
              VALUES (?, ?, ?, ?)`)
    .run(token, email, now.toISOString(), expires.toISOString());
  return { token, link: `${baseUrl}/api/auth/verify?token=${token}`, expiresAt: expires.toISOString() };
}

// Redeems a login token: marks it used, creates (or reuses) the account,
// and starts a session. Returns null if the token is missing, expired, or
// already used — a used token can't be replayed.
export function verifyLink(token) {
  const row = db.prepare("SELECT * FROM login_tokens WHERE token = ?").get(token);
  if (!row || row.used_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;

  db.prepare("UPDATE login_tokens SET used_at = ? WHERE token = ?").run(new Date().toISOString(), token);
  const account = getOrCreateAccount(row.email);

  const sessionToken = randomUUID();
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_TTL_MS);
  db.prepare(`INSERT INTO sessions (token, account_id, created_at, expires_at)
              VALUES (?, ?, ?, ?)`)
    .run(sessionToken, account.id, now.toISOString(), expires.toISOString());

  return { sessionToken, account, expiresAt: expires.toISOString() };
}

// Resolves a session cookie value to the account it belongs to, or null
// if the session is missing/expired. Does not renew expiry on access —
// a session is good for 30 days from login, not 30 days from last use.
export function accountForSession(sessionToken) {
  if (!sessionToken) return null;
  const row = db.prepare(`SELECT s.*, a.email FROM sessions s
                           JOIN accounts a ON a.id = s.account_id
                           WHERE s.token = ?`).get(sessionToken);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return { id: row.account_id, email: row.email };
}

export function destroySession(sessionToken) {
  if (!sessionToken) return;
  db.prepare("DELETE FROM sessions WHERE token = ?").run(sessionToken);
}
