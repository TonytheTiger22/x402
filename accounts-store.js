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

import { randomUUID, timingSafeEqual } from "crypto";
import { db } from "./db.js";

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
CREATE TABLE IF NOT EXISTS admin_sessions (
  token      TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
`);

const LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function getOrCreateAccount(email) {
  const existing = db.prepare("SELECT * FROM accounts WHERE email = ?").get(email);
  if (existing) return existing;
  const row = { id: randomUUID(), email, created_at: new Date().toISOString() };
  db.prepare("INSERT INTO accounts (id, email, created_at) VALUES (@id, @email, @created_at)").run(row);
  return row;
}

export const listAccounts = () => db.prepare("SELECT * FROM accounts ORDER BY created_at DESC").all();

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

// --- Operator admin access: one shared secret code (ADMIN_CODE env var),
// not a per-person account. For the site operator, not for customers. ---

const ADMIN_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — shorter than a customer session on purpose

// Constant-time comparison so a wrong guess can't be timed to learn how
// many leading characters it got right.
export function checkAdminCode(code) {
  const expected = process.env.ADMIN_CODE;
  if (!expected) return false; // no code configured = admin login disabled entirely
  const a = Buffer.from(String(code || ""));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function createAdminSession() {
  const token = randomUUID();
  const now = new Date();
  const expires = new Date(now.getTime() + ADMIN_SESSION_TTL_MS);
  db.prepare(`INSERT INTO admin_sessions (token, created_at, expires_at) VALUES (?, ?, ?)`)
    .run(token, now.toISOString(), expires.toISOString());
  return { token, expiresAt: expires.toISOString() };
}

export function isAdminSession(token) {
  if (!token) return false;
  const row = db.prepare("SELECT * FROM admin_sessions WHERE token = ?").get(token);
  if (!row) return false;
  return new Date(row.expires_at).getTime() >= Date.now();
}

export function destroyAdminSession(token) {
  if (!token) return;
  db.prepare("DELETE FROM admin_sessions WHERE token = ?").run(token);
}
