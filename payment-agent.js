import express from "express";
import { wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { marked } from "marked";
import { readFileSync } from "fs";
import * as audit from "./audit-store.js";
import * as accounts from "./accounts-store.js";
import * as analytics from "./analytics-store.js";
import * as credits from "./credits-store.js";
import { createPublicClient, http, verifyMessage } from "viem";
import { base } from "viem/chains";

const signer = privateKeyToAccount(process.env.BUYER_KEY);
console.log("Buyer wallet address:", signer.address);
const client = new x402Client();
client.register("eip155:*", new ExactEvmScheme(signer));
const fetchWithPayment = wrapFetchWithPayment(fetch, client);
const httpClient = new x402HTTPClient(client);

const API = process.env.COMPLIANCE_API_URL || "http://localhost:4025";
const LIST_VERSION = "OFAC-2026-08-17";

const ledger = { spent: 0, lines: [] };
// What the browser sees as "ledger": the site's running spend normally; in wallet mode
// just the visitor's own call (so the site's spend isn't touched or shown).
const ledgerFor = (req, line) => (isWallet(req) || isBalance(req)) ? { spent: line.price, lines: [line] } : ledger;
const txOf = (h) => (JSON.stringify(h ?? {}).match(/0x[0-9a-fA-F]{64}/) || [])[0] || null;

// ---- Wallet mode -----------------------------------------------------------
// Normally the site pays the API from its own wallet (BUYER_KEY). In wallet
// mode (request header X-Pay-Mode: wallet) the visitor's browser does the
// x402 handshake instead: this server just relays the call to the paid API,
// forwarding the visitor's signed payment header and passing the API's 402
// challenge / settlement headers back. The site wallet is never charged.
const isWallet = (req) => String(req?.headers?.["x-pay-mode"] || "").toLowerCase() === "wallet";
// Balance mode (X-Pay-Mode: balance): the visitor prepaid a USDC balance
// (see credits-store.js). Each check is deducted from it first, then the
// site wallet pays the API exactly as in the default mode — no popup.
const isBalance = (req) => String(req?.headers?.["x-pay-mode"] || "").toLowerCase() === "balance";
const PAY_HEADERS_IN = ["payment-signature", "x-payment"];
const PAY_HEADERS_OUT = ["payment-required", "payment-response", "x-payment-response"];

class Passthrough extends Error {            // upstream said "not paid / not OK"; relay it as-is
  constructor(status, headers, body) { super(`upstream ${status}`); this.status = status; this.headers = headers; this.body = body; }
}
// Sends a Passthrough to the browser, or returns false if `err` is something else.
function relay(res, err) {
  if (err instanceof credits.InsufficientBalance) {
    res.json({ ok: false, code: err.code, error: "Not enough prepaid balance: this costs " +
      Math.round(credits.toUsd(err.needed) * 100) + "¢ and your balance is $" + credits.toUsd(err.balance).toFixed(2) + ". Top up to continue.",
      balanceUsd: credits.toUsd(err.balance) });
    return true;
  }
  if (err?.code === "NO_CREDIT_SESSION") { res.status(401).json({ ok: false, code: err.code, error: err.message }); return true; }
  if (!(err instanceof Passthrough)) return false;
  for (const [k, v] of Object.entries(err.headers)) res.set(k, v);
  res.status(err.status).send(err.body);
  return true;
}
function decodeB64Json(h) { try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; } }

async function walletBuy(req, path, params, label, price) {
  const t0 = Date.now();
  const headers = {};
  for (const h of PAY_HEADERS_IN) if (req.headers[h]) headers[h] = String(req.headers[h]);
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`${API}${path}?${qs}`, { method: "GET", headers });
  const text = await r.text();
  if (r.status !== 200) {
    const out = {};
    for (const h of PAY_HEADERS_OUT) if (r.headers.get(h)) out[h] = r.headers.get(h);
    out["content-type"] = r.headers.get("content-type") || "application/json";
    throw new Passthrough(r.status, out, text);
  }
  const settleHeader = r.headers.get("payment-response") || r.headers.get("x-payment-response");
  if (!settleHeader) throw new Error("The API returned a result without a payment receipt");
  const settled = decodeB64Json(settleHeader);
  if (settled && settled.success === false) throw new Error("Payment did not settle");
  req.res.set("PAYMENT-RESPONSE", settleHeader);
  const line = { label, price, ms: Date.now() - t0, tx: txOf(settled ?? settleHeader), payer: "visitor wallet",
                 at: new Date().toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit"}) };
  return { body: JSON.parse(text), line, settled };
}

async function buyQuery(path, params, label, price, req) {
  if (req && isWallet(req)) return walletBuy(req, path, params, label, price);
  if (req && isBalance(req)) return balanceBuy(req, path, params, label, price);
  // The site's own wallet never pays for an anonymous visitor's check: only for a
  // signed-in admin testing, or (via balanceBuy) after a prepaid balance was charged.
  if (!req?.isAdmin) throw new Error("Connect a wallet, or sign in to your prepaid balance, to pay for this check.");
  return siteBuy(path, params, label, price);
}

// Pays the API from the site's own wallet (BUYER_KEY). Callers must have been
// authorised first (admin, or a prepaid balance charge) — see buyQuery/balanceBuy.
async function siteBuy(path, params, label, price) {
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

// Deduct from the visitor's prepaid balance, then pay the API from the site
// wallet. If anything after the deduction fails, the charge is refunded,
// so a failed check never costs the visitor anything.
async function balanceBuy(req, path, params, label, price) {
  const address = req.creditAddress;
  if (!address) { const e = new Error("Sign in with your wallet to use your prepaid balance."); e.code = "NO_CREDIT_SESSION"; throw e; }
  const chargeId = credits.charge(address, credits.toMicros(price), label);
  try {
    const out = await siteBuy(path, params, label, price);   // site-wallet path
    out.line = { ...out.line, payer: "prepaid balance" };
    return out;
  } catch (err) {
    credits.refund(chargeId);
    throw err;
  }
}

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
  req.creditAddress = credits.addressForSession(req.cookies.credit_session);
  next();
});

// Count real page views (no cookies, no raw IPs) — see analytics-store.js.
app.use((req, _res, next) => { if (!req.isAdmin) analytics.track(req); next(); });  // your own visits (signed in as admin) aren't counted

app.use(express.static("public"));
app.use("/examples", express.static("examples"));
// express.static ignores dotfiles/dot-directories by default, so
// /.well-known needs an explicit route.
app.get("/.well-known/agent-card.json", (_, res) =>
  res.sendFile(process.cwd() + "/public/.well-known/agent-card.json", { dotfiles: "allow" }));
app.get("/", (_, res) => res.sendFile(process.cwd() + "/public/landing.html"));
app.get("/audit", (_, res) => res.sendFile(process.cwd() + "/public/audit.html"));
app.get("/methodology", (_, res) => res.sendFile(process.cwd() + "/public/methodology.html"));
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

    const PLANNED = { OFAC: "OFAC Specially Designated Nationals (SDN) list",
      UN: "UN Security Council Consolidated List", EU: "EU Consolidated Financial Sanctions List",
      UK: "UK Sanctions List (FCDO)" };
    const loaded = new Set(lists.filter((l) => l.records > 0).map((l) => l.source));
    const missing = Object.entries(PLANNED).filter(([k]) => !loaded.has(k));
    const notYet = missing.length
      ? `<h2>Not yet included</h2>
<p class="not-yet">Planned but not loaded today. Until they appear in the table above,
   verify against these sources directly for anything high-stakes:</p>
<ul class="not-yet">${missing.map(([, v]) => `<li>${v}</li>`).join("")}</ul>`
      : "";
    res.send(template.replace("__LISTS_TABLE__", table).replace("__NOT_YET__", notYet));
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

app.get("/api/admin/visits", (req, res) => {
  if (!req.isAdmin) return res.status(401).json({ ok: false, error: "Admin login required" });
  res.json({ ok: true, ...analytics.summary(Math.min(+req.query.days || 30, 365)) });
});

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

// --- Prepaid balance ("load your wallet") ---------------------------------
// Balances live in the same sqlite file as accounts. On Railway that file is
// wiped on every redeploy unless DB_PATH points at a persistent volume — so
// top-ups are refused there until it does, rather than losing people's money.
const BALANCES_PERSISTENT = !process.env.RAILWAY_ENVIRONMENT || !!process.env.DB_PATH;
if (!BALANCES_PERSISTENT) console.warn("Prepaid top-ups are disabled: set DB_PATH to a file on a persistent Railway volume (e.g. /data/audit.db).");

// Verifies plain-EOA signatures locally, and smart-contract wallets
// (ERC-1271 / ERC-6492, e.g. Coinbase Smart Wallet) via a Base RPC call.
const basePublic = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL) });
async function signatureValid(address, message, signature) {
  try { if (await verifyMessage({ address, message, signature })) return true; } catch {}
  try { return await basePublic.verifyMessage({ address, message, signature }); } catch { return false; }
}

const creditCookie = (req, token, maxAge) =>
  `credit_session=${token}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Lax${req.secure ? "; Secure" : ""}`;

app.get("/api/credits", async (req, res) => {
  let limits = { min: 1.25, max: 250 };
  try { const r = await fetch(`${API}/topup-limits`); if (r.ok) limits = await r.json(); } catch {}
  const address = req.creditAddress;
  res.json({
    ok: true, signedIn: !!address, address, topupsEnabled: BALANCES_PERSISTENT, limits,
    balanceUsd: address ? credits.toUsd(credits.balanceMicros(address)) : 0,
    history: address ? credits.history(address).map((h) => ({ ...h, delta: credits.toUsd(h.delta) })) : [],
  });
});

app.get("/api/credits/nonce", (req, res) => res.json({ ok: true, ...credits.newSignInMessage(req.get("host")) }));

app.post("/api/credits/login", async (req, res) => {
  const { address, message, signature } = req.body || {};
  if (!/^0x[0-9a-fA-F]{40}$/.test(address || "") || typeof message !== "string" || typeof signature !== "string")
    return res.json({ ok: false, error: "Missing address, message or signature" });
  const nonce = (message.match(/Nonce: ([0-9a-f]{32})/) || [])[1];
  const host = req.get("host");
  if (!nonce || !message.startsWith(`Sign in to ${host} `) || !credits.consumeNonce(nonce))
    return res.json({ ok: false, error: "This sign-in request has expired. Try again." });
  if (!(await signatureValid(address, message, signature)))
    return res.json({ ok: false, error: "The signature didn't match that wallet." });
  const { token, maxAgeSec } = credits.createSession(address);
  res.setHeader("Set-Cookie", creditCookie(req, token, maxAgeSec));
  res.json({ ok: true, address: address.toLowerCase(), balanceUsd: credits.toUsd(credits.balanceMicros(address)) });
});

app.post("/api/credits/logout", (req, res) => {
  credits.destroySession(req.cookies.credit_session);
  res.setHeader("Set-Cookie", creditCookie(req, "", 0));
  res.json({ ok: true });
});

// Top-up: the visitor's wallet signs one x402 payment for the chosen amount
// (relayed to the API's GET /topup, which sets the price), and the settled
// amount is credited to the wallet that paid. Idempotent per settlement tx.
app.post("/api/topup", async (req, res) => {
  if (!isWallet(req)) return res.status(400).json({ ok: false, error: "Top-ups are paid from your wallet" });
  if (!BALANCES_PERSISTENT) return res.json({ ok: false, error: "Top-ups are temporarily unavailable." });
  if (!req.creditAddress) return res.status(401).json({ ok: false, code: "NO_CREDIT_SESSION", error: "Sign in with your wallet first." });
  const amount = Math.round(Number(req.body?.amount) * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0) return res.json({ ok: false, error: "Choose an amount" });
  try {
    const paid = await walletBuy(req, "/topup", { amount: amount.toFixed(2) }, "Balance top-up", amount);
    const credited = Number(paid.body?.credited);
    const payer = String(paid.settled?.payer || req.creditAddress).toLowerCase();
    const tx = paid.line.tx || paid.settled?.transaction;
    if (!(credited > 0) || !tx) throw new Error("Top-up settled without an amount or transaction");
    credits.creditTopup(payer, credits.toMicros(credited), tx);
    res.json({
      ok: true, credited, tx, creditedTo: payer,
      note: payer !== req.creditAddress ? "Credited to the wallet that paid, which isn't the one you're signed in with." : undefined,
      balanceUsd: credits.toUsd(credits.balanceMicros(req.creditAddress)),
      ledger: ledgerFor(req, paid.line),
    });
  } catch (err) {
    if (relay(res, err)) return;
    console.error("Top-up failed:", err);
    res.json({ ok: false, error: String(err.message || err) });
  }
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

app.post("/api/screen-free", async (req, res) => {
  const name = (req.body.name || "").trim();
  const dob = req.body.dob || "";
  const country = req.body.country || "";
  const type = req.body.type || "Individual";
  if (!name) return res.json({ ok: false, error: "Name is required" });

  try {
    const screen = await buyQuery("/screen", { name, dob, country, type },
                                  "Sanctions screening", 0.02, req);
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
                        record: audit.get(rec.reference), ledger: ledgerFor(req, screen.line) });
    }

    // Wallet/balance mode: the field comparison is a second, separate 5¢ charge
    // the visitor asks for themselves (POST /api/wallet-context), so stop here.
    if (isWallet(req) || isBalance(req)) {
      return res.json({ ok: true, outcome: "hit", screen: b, context: null,
                        record: audit.get(rec.reference), ledger: ledgerFor(req, screen.line) });
    }

    const context = await buyQuery("/context", { name, dob, country, type },
                                    "Field comparison", 0.05);
    res.json({ ok: true, outcome: "hit", screen: b, context: context.body,
               record: rec, ledger });

  } catch (err) {
    if (relay(res, err)) return;
    res.json({ ok: false, error: String(err), ledger });
  }
});

// Wallet mode only: the 5¢ field comparison for a hit, paid by the visitor's wallet.
app.post("/api/wallet-context", async (req, res) => {
  if (!isWallet(req) && !isBalance(req)) return res.status(400).json({ ok: false, error: "Wallet or balance mode only" });
  const name = (req.body.name || "").trim();
  if (!name) return res.json({ ok: false, error: "Name is required" });
  try {
    const context = await buyQuery("/context",
      { name, dob: req.body.dob || "", country: req.body.country || "", type: req.body.type || "Individual" },
      "Field comparison", 0.05, req);
    res.json({ ok: true, context: context.body, ledger: ledgerFor(req, context.line) });
  } catch (err) {
    if (relay(res, err)) return;
    res.json({ ok: false, error: String(err) });
  }
});

app.post("/api/screen-address", async (req, res) => {
  const address = (req.body.address || "").trim();
  if (!address) return res.json({ ok: false, error: "Address is required" });

  try {
    const screen = await buyQuery("/screen-address", { address },
                                  "Crypto address screening", 0.02, req);
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

    res.json({ ok: true, screen: b, record: audit.get(rec.reference), ledger: ledgerFor(req, screen.line) });

  } catch (err) {
    if (relay(res, err)) return;
    res.json({ ok: false, error: String(err), ledger });
  }
});

app.post("/api/check-email", async (req, res) => {
  const email = (req.body.email || "").trim();
  if (!email) return res.json({ ok: false, error: "An email address is required" });

  try {
    const check = await buyQuery("/screen-email", { email },
                                  "Email trust check", 0.02, req);
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

    res.json({ ok: true, check: b, record: audit.get(rec.reference), ledger: ledgerFor(req, check.line) });
  } catch (err) {
    if (relay(res, err)) return;
    res.json({ ok: false, error: String(err), ledger });
  }
});

app.post("/api/check-ip", async (req, res) => {
  const ip = (req.body.ip || "").trim();
  if (!ip) return res.json({ ok: false, error: "An IP address is required" });

  try {
    const check = await buyQuery("/screen-ip", { ip }, "IP risk check", 0.01, req);
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

    res.json({ ok: true, check: b, record: audit.get(rec.reference), ledger: ledgerFor(req, check.line) });
  } catch (err) {
    if (relay(res, err)) return;
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
  // scripted demo) keep the old open behavior so that flow doesn't
  // need a login.
  if (existing.account_id && !req.isAdmin && (!req.account || req.account.id !== existing.account_id)) {
    return res.status(403).json({ ok: false, error: "Not signed in to the account that owns this check" });
  }

  const by = req.isAdmin ? "admin" : (req.account?.email || "reviewer@demo");
  res.json({ ok: true, record: audit.dispose(reference, disposition, by) });
});

app.listen(4030, () => console.log("Payment agent on http://localhost:4030"));
