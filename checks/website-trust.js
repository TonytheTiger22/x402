// Website trust check — a "fan-out and score" composite, not a list match.
// Every signal here is deterministic code against a free, zero-signup
// source (see checks/shared.js). No LLM calls anywhere in this path.
//
// Three more signals are designed but NOT implemented here yet — Google
// Safe Browsing, VirusTotal, and AbuseIPDB all need a free API key that
// hasn't been signed up for. Those get added as a second pass once keys
// exist; see the roadmap doc. This file only runs the seven signals that
// need zero setup at all.

import { rdapLookup, getCertInfo, crtShHistory, waybackFirstSeen, dnsRecords, daysSince } from "./shared.js";

const AGE_FLAG_DAYS = 30; // domains younger than this get flagged as new/unproven

function parseUrl(input) {
  try {
    const withScheme = /^https?:\/\//i.test(input) ? input : `https://${input}`;
    return new URL(withScheme);
  } catch {
    return null;
  }
}

// One overall time budget for the whole chain, not 6s per hop — a
// malicious or slow-loris redirect chain shouldn't be able to make this
// paid check take up to 36s (6 hops x 6s) before giving up.
const REDIRECT_CHAIN_BUDGET_MS = 10000;

async function checkRedirectChain(url) {
  const hops = [];
  let current = url;
  const deadline = Date.now() + REDIRECT_CHAIN_BUDGET_MS;
  for (let i = 0; i < 6; i++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { status: "unknown", detail: "Redirect chain check timed out", hops };
    }
    let res;
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), remaining);
      res = await fetch(current, { redirect: "manual", signal: controller.signal });
      clearTimeout(t);
    } catch {
      return { status: "unknown", detail: "Could not reach the site", hops };
    }
    hops.push(current);
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current).toString();
      continue;
    }
    const finalHost = new URL(current).hostname;
    const startHost = new URL(url).hostname;
    if (hops.length > 3) {
      return { status: "flag", detail: `${hops.length} redirect hops before landing`, hops, finalHost, headers: res.headers };
    }
    if (finalHost !== startHost && !finalHost.endsWith(`.${startHost}`) && !startHost.endsWith(`.${finalHost}`)) {
      return { status: "flag", detail: `Redirects to a different domain (${finalHost})`, hops, finalHost, headers: res.headers };
    }
    return { status: "pass", detail: `${hops.length} hop(s), lands on ${finalHost}`, hops, finalHost, headers: res.headers };
  }
  return { status: "flag", detail: "Too many redirect hops (6+)", hops };
}

export async function runWebsiteChecks(input) {
  const parsed = parseUrl(input);
  if (!parsed) {
    return { ok: false, error: "Not a valid URL or domain" };
  }
  const domain = parsed.hostname;

  const [rdap, cert, crt, wayback, dns, redirectResult] = await Promise.all([
    rdapLookup(domain),
    getCertInfo(domain),
    crtShHistory(domain),
    waybackFirstSeen(domain),
    dnsRecords(domain),
    checkRedirectChain(parsed.toString()),
  ]);

  const signals = [];

  // 1. Domain age via RDAP
  const rdapAgeDays = rdap?.registeredAt ? daysSince(rdap.registeredAt) : null;
  signals.push({
    id: "domain_age",
    label: "Domain registration age",
    severity: "minor", // young domains are common for legitimate new projects too
    status: rdapAgeDays == null ? "unknown" : rdapAgeDays < AGE_FLAG_DAYS ? "flag" : "pass",
    detail: rdapAgeDays == null
      ? "Registration date not available (RDAP lookup failed or privacy-protected)"
      : `Registered ${rdapAgeDays} day(s) ago`,
  });

  // 2. SSL certificate validity
  let certStatus = "unknown", certDetail = "Could not retrieve a certificate";
  if (cert) {
    const now = Date.now();
    const validTo = new Date(cert.validTo).getTime();
    const expired = validTo < now;
    certStatus = expired || cert.authorized === false ? "flag" : "pass";
    certDetail = expired
      ? `Certificate expired ${cert.validTo.slice(0, 10)}`
      : cert.authorized === false
      ? "Certificate did not validate against trusted roots"
      : `Valid, issued by ${cert.issuer || "unknown issuer"}, expires ${cert.validTo.slice(0, 10)}`;
  }
  signals.push({
    id: "ssl_certificate", label: "SSL certificate",
    severity: "critical", // an expired/untrusted cert is a direct, unambiguous problem
    status: certStatus, detail: certDetail,
  });

  // 3. Certificate Transparency history
  const ctAgeDays = crt?.earliestCertAt ? daysSince(crt.earliestCertAt) : null;
  signals.push({
    id: "cert_transparency",
    label: "Certificate history (crt.sh)",
    severity: "minor",
    status: ctAgeDays == null ? "unknown" : ctAgeDays < AGE_FLAG_DAYS ? "flag" : "pass",
    detail: ctAgeDays == null
      ? "No certificate history found"
      : `Earliest logged certificate ${ctAgeDays} day(s) ago (${crt.certCount} total)`,
  });

  // 4. SPF / DKIM / DMARC presence
  const txt = dns?.txt ?? [];
  const hasSpf = txt.some((t) => /^v=spf1/i.test(t));
  const hasDmarc = txt.some((t) => /^v=dmarc1/i.test(t)); // not authoritative (lives at _dmarc.<domain>) but a cheap signal
  signals.push({
    id: "email_auth",
    label: "Email authentication (SPF)",
    severity: "minor", // common for small/static sites that send no mail at all
    status: hasSpf ? "pass" : "flag",
    detail: hasSpf ? "SPF record present" : "No SPF record found on the apex domain",
  });

  // 5. Redirect chain
  signals.push({
    id: "redirect_chain",
    label: "Redirect behavior",
    severity: "critical", // landing on an unrelated domain is a strong phishing/hijack signal
    status: redirectResult.status,
    detail: redirectResult.detail,
  });

  // 6. Security headers (read off the same response the redirect check already made)
  const h = redirectResult.headers;
  if (h) {
    const hasHsts = !!h.get("strict-transport-security");
    const hasCsp = !!h.get("content-security-policy");
    signals.push({
      id: "security_headers",
      label: "Security headers",
      severity: "minor",
      status: hasHsts || hasCsp ? "pass" : "flag",
      detail: [hasHsts && "HSTS", hasCsp && "CSP"].filter(Boolean).join(", ") || "Neither HSTS nor CSP present",
    });
  } else {
    signals.push({ id: "security_headers", label: "Security headers", severity: "minor", status: "unknown", detail: "Site was unreachable" });
  }

  // 7. Wayback Machine presence
  const waybackAgeDays = wayback?.firstSeenAt ? daysSince(wayback.firstSeenAt) : null;
  signals.push({
    id: "wayback_history",
    label: "Web archive history",
    severity: "minor",
    status: waybackAgeDays == null ? "unknown" : "pass",
    detail: waybackAgeDays == null
      ? "No archived snapshots found"
      : `First archived ${waybackAgeDays} day(s) ago`,
  });

  const flagCount = signals.filter((s) => s.status === "flag").length;
  const unknownCount = signals.filter((s) => s.status === "unknown").length;
  const criticalFlags = signals.filter((s) => s.status === "flag" && s.severity === "critical");
  const minorFlagCount = flagCount - criticalFlags.length;
  const redFlag = criticalFlags.length > 0;
  // A critical signal (bad cert, hijacked redirect) overrides everything else —
  // that's the whole point of calling it critical. Otherwise risk scales with
  // how many minor signals flagged.
  const riskLevel = redFlag ? "high" : minorFlagCount === 0 ? "low" : minorFlagCount <= 2 ? "medium" : "high";

  return {
    ok: true,
    domain,
    checkedAt: new Date().toISOString(),
    riskLevel,
    redFlag,
    redFlagSignals: criticalFlags.map((s) => s.label),
    flagCount,
    unknownCount,
    signalsChecked: signals.length,
    signals,
    note: "Deterministic checks only — no AI/LLM scoring. Three further signals " +
      "(malware/phishing blocklist, URL reputation aggregator, hosting " +
      "reputation) are designed but not yet live — they need a free API key " +
      "that hasn't been provisioned. A 'low risk' result reflects only the " +
      "signals listed above, not a guarantee the site is safe.",
  };
}
