// First-party, privacy-friendly page-view counting. No cookies, no third
// party, no raw IPs stored: a "visitor" is a SHA-256 of ip + user-agent +
// the current UTC date + a server secret, so the same person is counted
// once per day but can't be tracked across days or reversed to an address.
import { createHash } from "crypto";
import { db } from "./db.js";

db.exec(`
CREATE TABLE IF NOT EXISTS visits (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       TEXT NOT NULL,
  day      TEXT NOT NULL,
  path     TEXT NOT NULL,
  referrer TEXT,
  visitor  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_visits_day ON visits(day);
`);

const SALT = process.env.ANALYTICS_SALT || process.env.ADMIN_CODE || "payperscreen";
const BOT_RE = /bot|crawl|spider|slurp|curl|wget|python|node-fetch|axios|go-http|headless|preview|monitor|uptime|facebookexternalhit/i;
// Only real pages — not assets, APIs, or machine-readable files.
const PAGES = new Set(["/", "/landing", "/docs", "/lists", "/methodology", "/login", "/cases", "/audit"]);

const insert = db.prepare("INSERT INTO visits (ts, day, path, referrer, visitor) VALUES (?,?,?,?,?)");

export function track(req) {
  try {
    if (req.method !== "GET" || !PAGES.has(req.path)) return;
    const ua = req.headers["user-agent"] || "";
    if (!ua || BOT_RE.test(ua)) return;
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const visitor = createHash("sha256").update(`${req.ip}|${ua}|${day}|${SALT}`).digest("hex").slice(0, 16);
    let ref = null;
    try {
      const h = new URL(req.headers.referer || "").hostname;
      if (h && h !== req.hostname) ref = h;
    } catch {}
    insert.run(now.toISOString(), day, req.path, ref, visitor);
  } catch {} // analytics must never break a page load
}

export function summary(days = 30) {
  const since = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
  const perDay = db.prepare(`SELECT day, COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitors
    FROM visits WHERE day >= ? GROUP BY day ORDER BY day DESC`).all(since);
  const totals = db.prepare(`SELECT COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitor_days
    FROM visits WHERE day >= ?`).get(since);
  const pages = db.prepare(`SELECT path, COUNT(*) AS views FROM visits WHERE day >= ?
    GROUP BY path ORDER BY views DESC LIMIT 10`).all(since);
  const referrers = db.prepare(`SELECT referrer, COUNT(*) AS views FROM visits
    WHERE day >= ? AND referrer IS NOT NULL GROUP BY referrer ORDER BY views DESC LIMIT 10`).all(since);
  return { days, totals, perDay, pages, referrers };
}
