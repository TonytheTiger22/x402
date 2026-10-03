import express from "express";
import { wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { marked } from "marked";
import { readFileSync } from "fs";
import * as audit from "./audit-store.js";
import * as accounts from "./accounts-store.js";

const signer = privateKeyToAccount(process.env.BUYER_KEY);
console.log("Buyer wallet address:", signer.address);
const client = new x402Client();
client.register("eip155:*", new ExactEvmScheme(signer));
const fetchWithPayment = wrapFetchWithPayment(fetch, client);
const httpClient = new x402HTTPClient(client);

const API = process.env.COMPLIANCE_API_URL || "http://localhost:4025";
const LIST_VERSION = "OFAC-2026-08-17";

const PAYMENTS = {
  clean: { ref: "INV-88213", vendor: "Maria Santos Oliveira",
           amount: "$1,250.00", purpose: "Design retainer, August" },
  hit:   { ref: "INV-88214", vendor: "Viktor Petrov",
           amount: "$1,250.00", purpose: "Logistics consulting, August" },
};

const ledger = { spent: 0, lines: [] };
const txOf = (h) => (JSON.stringify(h ?? {}).match(/0x[0-9a-fA-F]{64}/) || [])[0] || null;

async function buyQuery(path, params, label, price) {
  const t0 = Date.now();
  const qs = new URLSearchParams(params).toString();
  const r = await fetchWithPayment(`${API}${path}?${qs}`, { method: "GET" });
  const out = await httpClient.processResponse(r);
  if (out.paymentStatus !== "settled") throw new Error("Payment " + out.paymentStatus);
  ledger.spent = +(ledger.spent + price).toFixed(4);
  const line = { label, price, ms: Date.now() - t0, tx: txOf(out.header),
                 at: new Date().toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit"}) };
  ledger.lines.push(line);
  return { body: out.body, line };
}

const buy = (path, id, label, price) => buyQuery(path, { id }, label, price);

const app = express();
app.set("trust proxy", 1); // Railway terminates TLS in front of us; needed so req.secure is right
app.use(express.json());

// Minimal hand-rolled cookie parsing — one cookie, not worth a dependency.
function parseCookies(header) {
  const out = {};
  (header || "").split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    if (k) out[k] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}
app.use((req, _res, next) => {
  req.cookies = parseCookies(req.headers.cookie);
  req.account = accounts.accountForSession(req.cookies.session);
  req.isAdmin = accounts.isAdminSession(req.cookies.admin_session);
  next();
});

app.use(express.static("public"));
app.use("/examples", express.static("examples"));
// express.static ignores dotfiles/dot-directories by default, so
// /.well-known needs an explicit route.
app.get("/.well-known/agent-card.json", (_, res) =>
  res.sendFile(process.cwd() + "/public/.well-known/agent-card.json", { dotfiles: "allow" }));
app.get("/", (_, res) => res.sendFile(process.cwd() + "/public/landing.html"));
app.get("/audit", (_, res) => res.sendFile(process.cwd() + "/public/audit.html"));
app.get("/review", (_, res) => res.sendFile(process.cwd() + "/public/compliance.html"));
// Old path kept working in case anything still links to it.
app.get("/landing", (_, res) => res.sendFile(process.cwd() + "/public/landing.html"));

app.get("/docs", (_, res) => {
  const md = readFileSync(process.cwd() + "/docs/API.md", "utf8");
  const html = marked.parse(md);
  const template = readFileSync(process.cwd() + "/public/docs-template.html", "utf8");
  res.send(template.replace("__CONTENT__", html));
});

const fmtDate = (iso) => iso
  ? new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
  : "unknown";

app.get("/lists", async (_, res) => {
  const template = readFileSync(process.cwd() + "/public/lists-template.html", "utf8");
  try {
    const r = await fetch(`${API}/lists-meta`);
    if (!r.ok) throw new Error(`lists-meta ${r.status}`);
    const { lists } = await r.json();

    const rows = lists.map((l) => `
      <tr>
        <td class="label">${l.label}<br><span class="meta">${l.source}</span></td>
        <td><span class="tag">${l.kind}</span></td>
        <td><span class="tag">${l.matchType}</span></td>
        <td class="num">${l.records.toLocaleString("en-US")}</td>
        <td class="meta">${fmtDate(l.refreshedAt)}</td>
      </tr>`).join("");

    const table = `
      <table class="lists-table">
        <thead><tr><th>List</th><th>Type</th><th>Match</th><th>Records</th><th>Last refreshed</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;

    res.send(template.replace("__LISTS_TABLE__", table));
  } catch (err) {
    const fallback = `<p><strong>Live list data is temporarily unavailable</strong>
      (${String(err.message || err)}). Try again shortly, or see
      <a href="/docs">/docs</a> for what's checked in general.</p>`;
    res.send(template.replace("__LISTS_TABLE__", fallback));
  }
});
// --- Case management portal: magic-link auth + each account's open queue ---

app.get("/login", (_, res) => res.sendFile(process.cwd() + "/public/login.html"));

app.post("/api/auth/request-link", (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.json({ ok: false, error: "Enter a valid email address" });
  }
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const { link, expiresAt } = accounts.requestLink(email, baseUrl);
  console.log(`Magic link for ${email}: ${link}`); // stand-in until real email delivery is wired up
  res.json({
    ok: true, link, expiresAt,
    note: "Email delivery isn't wired up yet (needs a transactional email " +
      "provider — Resend and Brevo both have a free tier), so here's the " +
      "link directly. In production this would be emailed, not shown here.",
  });
});

app.get("/api/auth/verify", (req, res) => {
  const result = accounts.verifyLink(req.query.token);
  if (!result) {
    return res.status(400).send(
      'This login link is invalid or has expired. <a href="/login">Request a new one</a>.'
    );
  }
  res.setHeader("Set-Cookie",
    `session=${result.sessionToken}; HttpOnly; Path=/; Max-Age=${30 * 24 * 60 * 60}; ` +
    `SameSite=Lax${req.secure ? "; Secure" : ""}`);
  res.redirect("/cases");
});

app.post("/api/auth/logout", (req, res) => {
  accounts.destroySession(req.cookies.session);
  res.setHeader("Set-Cookie", `session=; HttpOnly; Path=/; Max-Age=0${req.secure ? "; Secure" : ""}`);
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => res.json({ ok: true, account: req.account }));

app.get("/cases", (req, res) => {
  if (!req.account) return res.redirect("/login");
  res.sendFile(process.cwd() + "/public/cases.html");
});

app.get("/api/cases", (req, res) => {
  if (!req.account) return res.status(401).json({ ok: false, error: "Not signed in" });
  res.json({ ok: true, email: req.account.email, alerts: audit.listOpenAlertsForAccount(req.account.id) });
});

// --- Operator admin: one shared code (ADMIN_CODE env var), sees every
// account's open alerts, and can seed test cases without a real payment. ---

app.get("/admin", (_, res) => res.sendFile(process.cwd() + "/public/admin.html"));

app.post("/api/admin/login", (req, res) => {
  if (!accounts.checkAdminCode(req.body.code)) {
    return res.json({ ok: false, error: "Incorrect code" });
  }
  const { token } = accounts.createAdminSession();
  res.setHeader("Set-Cookie",
    `admin_session=${token}; HttpOnly; Path=/; Max-Age=${7 * 24 * 60 * 60}; ` +
    `SameSite=Lax${req.secure ? "; Secure" : ""}`);
  res.json({ ok: true });
});

app.post("/api/admin/logout", (req, res) => {
  accounts.destroyAdminSession(req.cookies.admin_session);
  res.setHeader("Set-Cookie", `admin_session=; HttpOnly; Path=/; Max-Age=0${req.secure ? "; Secure" : ""}`);
  res.json({ ok: true });
});

app.get("/api/admin/me", (req, res) => res.json({ ok: true, isAdmin: !!req.isAdmin }));

app.get("/api/admin/cases", (req, res) => {
  if (!req.isAdmin) return res.status(401).json({ ok: false, error: "Admin login required" });
  const emailById = Object.fromEntries(accounts.listAccounts().map((a) => [a.id, a.email]));
  const alerts = audit.listAllOpenAlerts().map((r) => ({
    ...r,
    account_email: r.account_id ? (emailById[r.account_id] || "(deleted account)") : "(no account — anonymous)",
  }));
  res.json({ ok: true, alerts });
});

const TEST_CASE_TYPES = {
  name:    { clientRef: "LANDING",         lists: ["OFAC SDN"] },
  address: { clientRef: "LANDING-ADDRESS", lists: ["OFAC Crypto Addresses"] },
  website: { clientRef: "LANDING-WEBSITE", lists: ["Website trust signals"] },
  email:   { clientRef: "LANDING-EMAIL",   lists: ["Email trust signals"] },
  ip:      { clientRef: "LANDING-IP",      lists: ["IP risk signals (beta)"] },
};

// Seeds a fake check straight into an account's queue — no payment, no
// real screening call. For testing the case-management UI only.
app.post("/api/admin/test-case", (req, res) => {
  if (!req.isAdmin) return res.status(401).json({ ok: false, error: "Admin login required" });

  const email = (req.body.email || "").trim().toLowerCase();
  const type = req.body.type;
  const subject = (req.body.subject || "").trim();
  const severity = req.body.severity;

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.json({ ok: false, error: "Enter a valid email for the test account" });
  if (!subject) return res.json({ ok: false, error: "Enter a subject — a name, address, domain, or email" });
  if (!TEST_CASE_TYPES[type]) return res.json({ ok: false, error: "Invalid check type" });
  if (!["low", "medium", "high"].includes(severity)) return res.json({ ok: false, error: "Invalid severity" });

  const account = accounts.getOrCreateAccount(email);
  const { clientRef, lists } = TEST_CASE_TYPES[type];
  const hitCount = { low: 0, medium: 1, high: 3 }[severity];
  const topMatch = type === "name" || type === "address" ? subject : severity;

  const rec = audit.record({
    subject: { name: subject, dob: null, country: null },
    listsChecked: lists,
    listVersion: LIST_VERSION,
    hitCount,
    topScore: type === "name" ? { low: null, medium: 70, high: 95 }[severity] : null,
    topMatch,
    clientRef,
    accountId: account.id,
    pricePaid: 0.02,
    paymentTx: null,
  });

  if (hitCount === 0) audit.dispose(rec.reference, "no_match_auto", "system");

  res.json({ ok: true, record: audit.get(rec.reference), account });
});

app.get("/api/ledger", (_, res) => res.json(ledger));
app.get("/api/audit", (_, res) => res.json(audit.list(200)));
app.get("/api/verify/:ref", (req, res) => res.json(audit.verify(req.params.ref)));

app.get("/api/export", (_, res) => {
  const rows = audit.list(1000);
  const cols = ["reference","client_ref","performed_at","subject_name","subject_dob",
    "subject_country","lists_checked","list_version","hit_count","top_score","top_match",
    "disposition","disposed_at","disposed_by","price_paid","payment_tx","record_hash"];
  const esc = (v) => v === null || v === undefined ? "" : `"${String(v).replace(/"/g,'""')}"`;
  const csv = [cols.join(","), ...rows.map(r => cols.map(c => esc(r[c])).join(","))].join("\n");
  res.setHeader("Content-Type","text/csv");
  res.setHeader("Content-Disposition","attachment; filename=audit-trail.csv");
  res.send(csv);
});

app.post("/api/reset", (_, res) => { ledger.spent = 0; ledger.lines = []; res.json(ledger); });

app.post("/api/run", async (req, res) => {
  const id = req.body.id === "hit" ? "hit" : "clean";
  try {
    const screen = await buy("/screen", id, "Sanctions screening", 0.02);
    const b = screen.body;

    const rec = audit.record({
      subject: b.subject,
      listsChecked: b.listsChecked,
      listVersion: LIST_VERSION,
      hitCount: b.hitCount,
      topScore: b.hitCount ? b.hits[0].score : null,
      topMatch: b.hitCount ? b.hits[0].name : null,
      clientRef: PAYMENTS[id].ref,
      pricePaid: 0.02,
      paymentTx: screen.line.tx,
    });

    if (b.hitCount === 0) {
      audit.dispose(rec.reference, "no_match_auto", "system");
      return res.json({ ok: true, id, payment: PAYMENTS[id], outcome: "clear",
                        screen: b, record: audit.get(rec.reference), ledger });
    }

    const context = await buy("/context", id, "Alert context pack", 0.05);
    res.json({ ok: true, id, payment: PAYMENTS[id], outcome: "review",
               screen: b, context: context.body, record: rec, ledger });

  } catch (err) {
    res.json({ ok: false, error: String(err), ledger });
  }
});

app.post("/api/screen-free", async (req, res) => {
  const name = (req.body.name || "").trim();
  const dob = req.body.dob || "";
  const country = req.body.country || "";
  const type = req.body.type || "Individual";
  if (!name) return res.json({ ok: false, error: "Name is required" });

  try {
    const screen = await buyQuery("/screen", { name, dob, country, type },
                                  "Sanctions screening", 0.02);
    const b = screen.body;

    const rec = audit.record({
      subject: b.subject,
      listsChecked: b.listsChecked,
      listVersion: LIST_VERSION,
      hitCount: b.hitCount,
      topScore: b.hitCount ? b.hits[0].score : null,
      topMatch: b.hitCount ? b.hits[0].name : null,
      clientRef: "LANDING",
      accountId: req.account?.id ?? null,
      pricePaid: 0.02,
      paymentTx: screen.line.tx,
    });

    if (b.hitCount === 0) {
      audit.dispose(rec.reference, "no_match_auto", "system");
      return res.json({ ok: true, outcome: "clear", screen: b,
                        record: audit.get(rec.reference), ledger });
    }

    const context = await buyQuery("/context", { name, dob, country, type },
                                    "Field comparison", 0.05);
    res.json({ ok: true, outcome: "hit", screen: b, context: context.body,
               record: rec, ledger });

  } catch (err) {
    res.json({ ok: false, error: String(err), ledger });
  }
});

app.post("/api/screen-address", async (req, res) => {
  const address = (req.body.address || "").trim();
  if (!address) return res.json({ ok: false, error: "Address is required" });

  try {
    const screen = await buyQuery("/screen-address", { address },
                                  "Crypto address screening", 0.02);
    const b = screen.body;

    const rec = audit.record({
      subject: { name: address, dob: null, country: null },
      listsChecked: [b.source],
      listVersion: LIST_VERSION,
      hitCount: b.sanctioned ? 1 : 0,
      topScore: null,
      topMatch: b.sanctioned ? b.matches.map((m) => m.asset).join(", ") : null,
      clientRef: "LANDING-ADDRESS",
      accountId: req.account?.id ?? null,
      pricePaid: 0.02,
      paymentTx: screen.line.tx,
    });

    if (!b.sanctioned) audit.dispose(rec.reference, "no_match_auto", "system");

    res.json({ ok: true, screen: b, record: audit.get(rec.reference), ledger });

  } catch (err) {
    res.json({ ok: false, error: String(err), ledger });
  }
});

app.post("/api/check-website", async (req, res) => {
  const url = (req.body.url || "").trim();
  if (!url) return res.json({ ok: false, error: "A website address is required" });

  try {
    const check = await buyQuery("/screen-website", { url },
                                  "Website trust check", 0.02);
    const b = check.body;
    if (b.ok === false) return res.json({ ok: false, error: b.error || "Could not check that site" });

    const rec = audit.record({
      subject: { name: b.domain, dob: null, country: null },
      listsChecked: ["Website trust signals"],
      listVersion: LIST_VERSION,
      hitCount: b.flagCount,
      topScore: null,
      topMatch: b.riskLevel,
      clientRef: "LANDING-WEBSITE",
      accountId: req.account?.id ?? null,
      pricePaid: 0.02,
      paymentTx: check.line.tx,
    });

    if (b.riskLevel === "low") audit.dispose(rec.reference, "no_match_auto", "system");

    res.json({ ok: true, check: b, record: audit.get(rec.reference), ledger });
  } catch (err) {
    res.json({ ok: false, error: String(err), ledger });
  }
});

app.post("/api/check-email", async (req, res) => {
  const email = (req.body.email || "").trim();
  if (!email) return res.json({ ok: false, error: "An email address is required" });

  try {
    const check = await buyQuery("/screen-email", { email },
                                  "Email trust check", 0.02);
    const b = check.body;
    if (b.ok === false) return res.json({ ok: false, error: b.error || "Could not check that address" });

    const rec = audit.record({
      subject: { name: b.email, dob: null, country: null },
      listsChecked: ["Email trust signals"],
      listVersion: LIST_VERSION,
      hitCount: b.flagCount,
      topScore: null,
      topMatch: b.riskLevel,
      clientRef: "LANDING-EMAIL",
      accountId: req.account?.id ?? null,
      pricePaid: 0.02,
      paymentTx: check.line.tx,
    });

    if (b.riskLevel === "low") audit.dispose(rec.reference, "no_match_auto", "system");

    res.json({ ok: true, check: b, record: audit.get(rec.reference), ledger });
  } catch (err) {
    res.json({ ok: false, error: String(err), ledger });
  }
});

app.post("/api/check-ip", async (req, res) => {
  const ip = (req.body.ip || "").trim();
  if (!ip) return res.json({ ok: false, error: "An IP address is required" });

  try {
    const check = await buyQuery("/screen-ip", { ip }, "IP risk check", 0.01);
    const b = check.body;
    if (b.ok === false) return res.json({ ok: false, error: b.error || "Could not check that address" });

    const rec = audit.record({
      subject: { name: b.ip, dob: null, country: null },
      listsChecked: ["IP risk signals (beta)"],
      listVersion: LIST_VERSION,
      hitCount: b.flagCount,
      topScore: null,
      topMatch: b.riskLevel,
      clientRef: "LANDING-IP",
      accountId: req.account?.id ?? null,
      pricePaid: 0.01,
      paymentTx: check.line.tx,
    });

    if (b.riskLevel === "low") audit.dispose(rec.reference, "no_match_auto", "system");

    res.json({ ok: true, check: b, record: audit.get(rec.reference), ledger });
  } catch (err) {
    res.json({ ok: false, error: String(err), ledger });
  }
});

// --- Tier 3: AI agent opinion. Re-screens via the matching /opinion route
// on the compliance API (its own paid call, same as any other check), then
// attaches the result to the case record a prior tier-1 check already
// created — so a mom & pop looking at their case queue (tier 2) sees the
// AI's read sitting right on the alert, instead of a disconnected 3rd item.

const OPINION_ROUTES = {
  name:    { path: "/screen/opinion",         price: 0.07, label: "AI opinion: sanctions screening" },
  address: { path: "/screen-address/opinion", price: 0.07, label: "AI opinion: address screening" },
  website: { path: "/screen-website/opinion", price: 0.07, label: "AI opinion: website trust" },
  email:   { path: "/screen-email/opinion",   price: 0.07, label: "AI opinion: email trust" },
  ip:      { path: "/screen-ip/opinion",      price: 0.06, label: "AI opinion: IP risk" },
};

app.post("/api/opinion", async (req, res) => {
  const type = req.body.type;
  const route = OPINION_ROUTES[type];
  if (!route) return res.json({ ok: false, error: "Invalid check type" });

  const params = {};
  if (type === "name") {
    params.name = (req.body.name || "").trim();
    params.dob = req.body.dob || "";
    params.country = req.body.country || "";
    params.type = req.body.entityType || "Individual";
    if (!params.name) return res.json({ ok: false, error: "Name is required" });
  } else if (type === "address") {
    params.address = (req.body.address || "").trim();
    if (!params.address) return res.json({ ok: false, error: "Address is required" });
  } else if (type === "website") {
    params.url = (req.body.url || "").trim();
    if (!params.url) return res.json({ ok: false, error: "A website address is required" });
  } else if (type === "email") {
    params.email = (req.body.email || "").trim();
    if (!params.email) return res.json({ ok: false, error: "An email address is required" });
  } else if (type === "ip") {
    params.ip = (req.body.ip || "").trim();
    if (!params.ip) return res.json({ ok: false, error: "An IP address is required" });
  }

  try {
    const call = await buyQuery(route.path, params, route.label, route.price);
    const b = call.body;
    if (b.error) return res.json({ ok: false, error: b.error });
    if (!b.opinion?.ok) {
      return res.json({ ok: false, error: b.opinion?.error || "Could not get an AI opinion", ledger });
    }

    // Attach to the case record from the original check, if one was passed
    // and it actually belongs to this account (or no one's signed in, same
    // open-demo exception /api/dispose uses).
    const reference = req.body.reference;
    let record = null;
    if (reference) {
      const existing = audit.get(reference);
      if (existing && (!existing.account_id || existing.account_id === req.account?.id || req.isAdmin)) {
        record = audit.attachOpinion(reference, b.opinion);
      }
    }

    res.json({ ok: true, opinion: b.opinion, record, ledger });
  } catch (err) {
    res.json({ ok: false, error: String(err), ledger });
  }
});

app.post("/api/dispose", (req, res) => {
  const { reference, disposition } = req.body;
  if (!["cleared","escalated"].includes(disposition))
    return res.json({ ok: false, error: "Invalid disposition" });

  const existing = audit.get(reference);
  if (!existing) return res.json({ ok: false, error: "No such check" });

  // Checks run from a signed-in account's own queue can only be actioned by
  // that account, unless an admin is acting. Checks with no owner (the
  // scripted /review demo) keep the old open behavior so that flow doesn't
  // need a login.
  if (existing.account_id && !req.isAdmin && (!req.account || req.account.id !== existing.account_id)) {
    return res.status(403).json({ ok: false, error: "Not signed in to the account that owns this check" });
  }

  const by = req.isAdmin ? "admin" : (req.account?.email || "reviewer@demo");
  res.json({ ok: true, record: audit.dispose(reference, disposition, by) });
});

app.listen(4030, () => console.log("Payment agent on http://localhost:4030"));
