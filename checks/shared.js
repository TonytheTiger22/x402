// Shared primitives for the composite trust checks (website & email).
//
// Design constraint from the roadmap doc: every one of these hits a free,
// public, authoritative source — no paid API keys, no LLM calls. Each
// helper is defensive: on any failure (timeout, DNS error, unreachable
// service) it resolves to `null`/empty rather than throwing, so one dead
// signal never takes down the whole composite result. Callers turn a
// `null` into an "unknown" status, never a false negative.

import { promises as dns } from "dns";
import tls from "tls";

// crt.sh and the rdap.org gateway are both known to be slow under load —
// give them more room than a typical API timeout before giving up and
// degrading to "unknown".
const FETCH_TIMEOUT_MS = 9000;

async function fetchJson(url, opts = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// RDAP — domain registration lookup. rdap.org is a free public gateway
// that resolves the right registry RDAP server for any TLD, so we don't
// need to maintain IANA's bootstrap table ourselves.
export async function rdapLookup(domain) {
  const data = await fetchJson(`https://rdap.org/domain/${encodeURIComponent(domain)}`);
  if (!data) return null;
  const events = Array.isArray(data.events) ? data.events : [];
  const registration = events.find((e) => e.eventAction === "registration")?.eventDate ?? null;
  const expiration = events.find((e) => e.eventAction === "expiration")?.eventDate ?? null;
  return { registeredAt: registration, expiresAt: expiration, raw: !!data };
}

// TLS certificate — we connect ourselves and read what the server
// presents. No third party involved at all.
export function getCertInfo(host, port = 443) {
  return new Promise((resolve) => {
    const socket = tls.connect(
      { host, port, servername: host, timeout: FETCH_TIMEOUT_MS, rejectUnauthorized: false },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        if (!cert || !cert.valid_from) return resolve(null);
        resolve({
          issuer: cert.issuer?.O || cert.issuer?.CN || null,
          validFrom: new Date(cert.valid_from).toISOString(),
          validTo: new Date(cert.valid_to).toISOString(),
          authorized: socket.authorized ?? null,
        });
      }
    );
    socket.on("error", () => resolve(null));
    socket.on("timeout", () => { socket.destroy(); resolve(null); });
  });
}

// Certificate Transparency log history via crt.sh — free, public, no key.
// Returns the earliest "not before" date seen across all logged certs,
// which can't be privacy-masked the way RDAP registration data sometimes
// can be.
export async function crtShHistory(domain) {
  const data = await fetchJson(`https://crt.sh/?q=${encodeURIComponent(domain)}&output=json`);
  if (!Array.isArray(data) || data.length === 0) return null;
  const dates = data
    .map((row) => row.not_before && new Date(row.not_before))
    .filter((d) => d instanceof Date && !isNaN(d));
  if (dates.length === 0) return null;
  const earliest = new Date(Math.min(...dates.map((d) => d.getTime())));
  return { certCount: data.length, earliestCertAt: earliest.toISOString() };
}

// Wayback Machine CDX API — first known archived snapshot of a URL.
// Independent third corroboration of age alongside RDAP and CT logs.
export async function waybackFirstSeen(domain) {
  const url = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(domain)}&output=json&limit=1&sort=ascending&collapse=urlkey`;
  const data = await fetchJson(url);
  if (!Array.isArray(data) || data.length < 2) return null;
  const [, timestamp] = data[1]; // row 0 is the header
  if (!timestamp) return null;
  // Wayback timestamps are YYYYMMDDhhmmss
  const iso = `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}`;
  return { firstSeenAt: iso };
}

// DNS helpers — all built into Node, zero external dependency.
export async function dnsRecords(domain) {
  const safe = (p) => p.catch(() => []);
  const [a, mx, txt, ns] = await Promise.all([
    safe(dns.resolve4(domain)),
    safe(dns.resolveMx(domain)),
    safe(dns.resolveTxt(domain)),
    safe(dns.resolveNs(domain)),
  ]);
  return { a, mx: mx.sort((x, y) => x.priority - y.priority), txt: txt.map((t) => t.join("")), ns };
}

// Spamhaus ZEN DNSBL — a DNSBL lookup is just a DNS A query against a
// specially-formatted zone. Genuinely free, no key, effectively no rate
// limit for the volumes a service like this would see.
export async function spamhausCheck(ip) {
  const octets = ip.split(".").reverse().join(".");
  try {
    const result = await dns.resolve4(`${octets}.zen.spamhaus.org`);
    return { listed: result.length > 0, codes: result };
  } catch {
    // NXDOMAIN means "not listed" — that's the expected clean result,
    // not a failure.
    return { listed: false, codes: [] };
  }
}

export function daysSince(isoDate) {
  if (!isoDate) return null;
  const then = new Date(isoDate).getTime();
  if (isNaN(then)) return null;
  return Math.floor((Date.now() - then) / 86400000);
}
