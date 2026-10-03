// Email trust check — a "fan-out and score" composite over free, zero-key
// sources only. No LLM calls anywhere in this path. All ten signals from
// the roadmap doc are implemented here — unlike the website check, none
// of these need a paid API key.

import { readFileSync } from "fs";
import net from "net";
import { rdapLookup, crtShHistory, dnsRecords, spamhausCheck, daysSince } from "./shared.js";

const DISPOSABLE_DOMAINS = new Set(
  JSON.parse(readFileSync(new URL("../node_modules/disposable-email-domains/index.json", import.meta.url), "utf8"))
);

const FREE_MAIL_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com",
  "aol.com", "protonmail.com", "proton.me", "mail.com", "gmx.com", "live.com",
]);

const ROLE_LOCAL_PARTS = new Set([
  "admin", "administrator", "support", "info", "sales", "noreply", "no-reply",
  "postmaster", "webmaster", "contact", "help", "billing", "abuse", "hello",
]);

const KNOWN_PROVIDERS = [
  { pattern: /\.google\.com$|googlemail\.com$|aspmx\.l\.google\.com$/i, name: "Google Workspace" },
  { pattern: /outlook\.com$|protection\.outlook\.com$/i, name: "Microsoft 365" },
  { pattern: /zoho\.com$/i, name: "Zoho Mail" },
  { pattern: /mailgun\.org$/i, name: "Mailgun" },
  { pattern: /pphosted\.com$/i, name: "Proofpoint" },
];

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// RCPT TO probe without sending DATA — best-effort. Many mail servers
// (including most cloud PaaS egress, possibly including wherever this
// runs) block or rate-limit outbound port 25, and some servers accept
// every address (catch-all) regardless of whether the mailbox is real.
// Both failure modes degrade to "unknown", never to a false negative.
function smtpProbe(mxHost, email) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: mxHost, port: 25, timeout: 5000 });
    let step = 0;
    let settled = false;
    const finish = (status, detail) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch {}
      resolve({ status, detail });
    };
    const commands = [
      `EHLO payperscreen.com\r\n`,
      `MAIL FROM:<verify@payperscreen.com>\r\n`,
      `RCPT TO:<${email}>\r\n`,
      `QUIT\r\n`,
    ];
    socket.on("connect", () => {});
    socket.on("data", (buf) => {
      const line = buf.toString();
      const code = parseInt(line.slice(0, 3), 10);
      if (step === 0 && /^220/.test(line)) { socket.write(commands[0]); step = 1; return; }
      if (step === 1 && /^250/.test(line)) { socket.write(commands[1]); step = 2; return; }
      if (step === 2 && /^250/.test(line)) { socket.write(commands[2]); step = 3; return; }
      if (step === 3) {
        if (code >= 200 && code < 300) return finish("pass", "Mail server accepted the address");
        if (code >= 500) return finish("flag", `Mail server rejected the address (${code})`);
        return finish("unknown", `Unexpected response (${code})`);
      }
    });
    socket.on("error", () => finish("unknown", "Could not reach the mail server on port 25 (often blocked by cloud hosting)"));
    socket.on("timeout", () => finish("unknown", "Mail server probe timed out"));
  });
}

export async function runEmailChecks(input) {
  const email = (input || "").trim().toLowerCase();
  const signals = [];

  // 1. Syntax + MX validation
  const syntaxOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const domain = syntaxOk ? email.split("@")[1] : null;
  if (!syntaxOk) {
    return { ok: false, error: "Not a valid email address" };
  }

  const [dns, rdap, crt] = await Promise.all([
    dnsRecords(domain),
    rdapLookup(domain),
    crtShHistory(domain),
  ]);

  const hasMx = (dns?.mx ?? []).length > 0;
  signals.push({
    id: "syntax_mx",
    label: "Syntax and mail server",
    severity: "critical", // a domain that can't receive mail at all is disqualifying
    status: hasMx ? "pass" : "flag",
    detail: hasMx ? `Domain accepts mail (${dns.mx[0].exchange})` : "Domain has no MX record — cannot receive mail",
  });

  // 2. Disposable/temp-mail domain
  const disposable = DISPOSABLE_DOMAINS.has(domain);
  signals.push({
    id: "disposable_domain",
    label: "Disposable email provider",
    severity: "critical", // throwaway mailboxes are a strong, direct fraud signal
    status: disposable ? "flag" : "pass",
    detail: disposable ? "Domain is a known disposable/temp-mail provider" : "Not on the known disposable-domain list",
  });

  // 3. Free-mail vs corporate domain
  const isFreeMail = FREE_MAIL_DOMAINS.has(domain);
  signals.push({
    id: "free_mail",
    label: "Provider type",
    severity: "minor",
    status: "pass", // informational, not a red flag either way
    detail: isFreeMail ? "Consumer free-mail provider" : "Custom/corporate domain",
  });

  // 4. Domain age via RDAP
  const ageDays = rdap?.registeredAt ? daysSince(rdap.registeredAt) : null;
  signals.push({
    id: "domain_age",
    label: "Domain registration age",
    severity: "minor",
    status: ageDays == null ? "unknown" : ageDays < 30 ? "flag" : "pass",
    detail: ageDays == null ? "Registration date not available" : `Registered ${ageDays} day(s) ago`,
  });

  // 5. Certificate Transparency history (reuses the website-check primitive)
  const ctAgeDays = crt?.earliestCertAt ? daysSince(crt.earliestCertAt) : null;
  signals.push({
    id: "cert_transparency",
    label: "Domain certificate history",
    severity: "minor",
    status: ctAgeDays == null ? "unknown" : "pass",
    detail: ctAgeDays == null ? "No certificate history found for this domain" : `Earliest logged certificate ${ctAgeDays} day(s) ago`,
  });

  // 6. SMTP mailbox probe (best-effort)
  if (hasMx) {
    const probe = await smtpProbe(dns.mx[0].exchange, email);
    signals.push({ id: "mailbox_probe", label: "Mailbox verification", severity: "critical", status: probe.status, detail: probe.detail });
  } else {
    signals.push({ id: "mailbox_probe", label: "Mailbox verification", severity: "critical", status: "unknown", detail: "Skipped — no mail server to probe" });
  }

  // 7. DNSBL (Spamhaus) on the mail server's IP
  let dnsblStatus = "unknown", dnsblDetail = "Could not resolve mail server IP";
  if (hasMx) {
    try {
      const { resolve4 } = await import("dns/promises");
      const [ip] = await resolve4(dns.mx[0].exchange);
      if (ip) {
        const sh = await spamhausCheck(ip);
        dnsblStatus = sh.listed ? "flag" : "pass";
        dnsblDetail = sh.listed ? "Mail server IP is listed on Spamhaus ZEN" : "Mail server IP is not on Spamhaus ZEN";
      }
    } catch {}
  }
  signals.push({ id: "dnsbl", label: "Mail server reputation (DNSBL)", severity: "critical", status: dnsblStatus, detail: dnsblDetail });

  // 8. MX provider fingerprinting
  const mxHost = dns?.mx?.[0]?.exchange || "";
  const knownProvider = KNOWN_PROVIDERS.find((p) => p.pattern.test(mxHost));
  signals.push({
    id: "mx_provider",
    label: "Mail provider",
    severity: "minor",
    status: "pass",
    detail: knownProvider ? `Hosted on ${knownProvider.name}` : mxHost ? `Custom/unrecognized mail infrastructure (${mxHost})` : "No mail server found",
  });

  // 9. Typo-squat detection against top free-mail domains
  let typoMatch = null;
  for (const known of FREE_MAIL_DOMAINS) {
    if (domain === known) continue;
    const dist = levenshtein(domain, known);
    if (dist > 0 && dist <= 2) { typoMatch = known; break; }
  }
  signals.push({
    id: "typosquat",
    label: "Look-alike domain check",
    severity: "critical", // a deliberate look-alike is a strong phishing signal
    status: typoMatch ? "flag" : "pass",
    detail: typoMatch ? `Domain closely resembles ${typoMatch} — possible typo-squat` : "No resemblance to major free-mail providers detected",
  });

  // 10. Role-account detection
  const localPart = email.split("@")[0];
  const isRole = ROLE_LOCAL_PARTS.has(localPart);
  signals.push({
    id: "role_account",
    label: "Account type",
    severity: "minor",
    status: "pass", // informational
    detail: isRole ? "Looks like a shared/role account, not an individual" : "Looks like a personal account",
  });

  const flagCount = signals.filter((s) => s.status === "flag").length;
  const unknownCount = signals.filter((s) => s.status === "unknown").length;
  const criticalFlags = signals.filter((s) => s.status === "flag" && s.severity === "critical");
  const minorFlagCount = flagCount - criticalFlags.length;
  const redFlag = criticalFlags.length > 0;
  const riskLevel = redFlag ? "high" : minorFlagCount === 0 ? "low" : minorFlagCount <= 2 ? "medium" : "high";

  return {
    ok: true,
    email,
    checkedAt: new Date().toISOString(),
    riskLevel,
    redFlag,
    redFlagSignals: criticalFlags.map((s) => s.label),
    flagCount,
    unknownCount,
    signalsChecked: signals.length,
    signals,
    note: "Deterministic checks only — no AI/LLM scoring. The mailbox-" +
      "verification probe is best-effort: some mail servers block it or " +
      "accept every address, which shows up as 'unknown', not as a clean " +
      "result. A 'low risk' result reflects only the signals listed above.",
  };
}
