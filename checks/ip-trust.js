// IP risk check — beta. A "fan-out and score" composite like the email
// and email checks, built around known-high-risk-IP lists rather than a
// paid reputation API. Zero signups: Spamhaus ZEN is a DNSBL (a DNS query
// against a public blocklist zone) and the Tor Project publishes its own
// exit-node list, both free and keyless. No LLM calls anywhere in this
// path.
//
// Explicitly out of scope for this beta (would need a paid key — see the
// roadmap doc): VPN/hosting-provider classification beyond what RDAP's
// network name implies, and AbuseIPDB-style community abuse reports.
// Those stay "planned" until that signup happens; this ships the two
// real, free, keyless blocklists now rather than waiting on them.

import { spamhausCheck, rdapLookupIp, torExitNodeCheck } from "./shared.js";

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function parseIpv4(input) {
  const m = IPV4_RE.exec((input || "").trim());
  if (!m) return null;
  const octets = m.slice(1, 5).map(Number);
  if (octets.some((o) => o < 0 || o > 255)) return null;
  return octets;
}

// RFC 1918 private ranges, loopback, link-local, and a few other
// non-routable blocks. There is no public reputation to check for these —
// they're not addresses that appear on the public internet at all.
function isPrivateOrReserved([a, b]) {
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 0) return true;
  if (a >= 224) return true; // multicast/reserved
  return false;
}

export async function runIpChecks(input) {
  const octets = parseIpv4(input);
  if (!octets) {
    return { ok: false, error: "Not a valid IPv4 address (IPv6 isn't supported in this beta yet)" };
  }
  const ip = octets.join(".");

  if (isPrivateOrReserved(octets)) {
    return {
      ok: false,
      error: "That's a private or reserved IP address, not a public one — there's no reputation " +
        "to check for an address that doesn't appear on the public internet.",
    };
  }

  const [spamhaus, tor, rdap] = await Promise.all([
    spamhausCheck(ip),
    torExitNodeCheck(ip),
    rdapLookupIp(ip),
  ]);

  const signals = [];

  // 1. Spamhaus ZEN — spam sources, botnets, and hijacked/compromised
  // netblocks. A real, maintained, widely-trusted blocklist, not a
  // heuristic.
  signals.push({
    id: "dnsbl",
    label: "Blocklist status (Spamhaus ZEN)",
    severity: "critical",
    status: spamhaus.listed ? "flag" : "pass",
    detail: spamhaus.listed
      ? "Listed on Spamhaus ZEN — known spam source, botnet member, or hijacked netblock"
      : "Not listed on Spamhaus ZEN",
  });

  // 2. Tor exit node — not inherently malicious, but a strong signal for
  // fraud/abuse screening specifically: it means the true origin of the
  // traffic is deliberately hidden.
  signals.push({
    id: "tor_exit_node",
    label: "Tor exit node",
    severity: "critical",
    status: tor == null ? "unknown" : tor.isExitNode ? "flag" : "pass",
    detail: tor == null
      ? "Could not fetch the current Tor exit-node list"
      : tor.isExitNode
      ? "This address is a known Tor exit node — traffic origin is anonymized"
      : "Not a known Tor exit node",
  });

  // 3. Network allocation — informational only. Plenty of legitimate
  // traffic comes from datacenter/cloud ranges, so this is context, not a
  // flag either way.
  signals.push({
    id: "network_info",
    label: "Network allocation",
    severity: "minor",
    status: "pass",
    detail: rdap?.name
      ? `Allocated to ${rdap.name}${rdap.country ? ` (${rdap.country})` : ""}`
      : "Allocation details not available",
  });

  const flagCount = signals.filter((s) => s.status === "flag").length;
  const unknownCount = signals.filter((s) => s.status === "unknown").length;
  const criticalFlags = signals.filter((s) => s.status === "flag" && s.severity === "critical");
  const minorFlagCount = flagCount - criticalFlags.length;
  const redFlag = criticalFlags.length > 0;
  const riskLevel = redFlag ? "high" : minorFlagCount === 0 ? "low" : minorFlagCount <= 2 ? "medium" : "high";

  return {
    ok: true,
    ip,
    checkedAt: new Date().toISOString(),
    riskLevel,
    redFlag,
    redFlagSignals: criticalFlags.map((s) => s.label),
    flagCount,
    unknownCount,
    signalsChecked: signals.length,
    signals,
    note: "Beta — two known-high-risk-IP lists (Spamhaus ZEN, Tor exit nodes), both free and " +
      "keyless. VPN/hosting classification and community abuse reports (AbuseIPDB) aren't live " +
      "yet; they need a paid key. IPv6 isn't supported yet. A 'low risk' result reflects only the " +
      "signals listed above.",
  };
}
