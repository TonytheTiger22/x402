import express from "express";
import { wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import * as audit from "./audit-store.js";

const signer = privateKeyToAccount(process.env.BUYER_KEY);
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
app.use(express.json());
app.use(express.static("public"));
app.get("/", (_, res) => res.sendFile(process.cwd() + "/public/compliance.html"));
app.get("/audit", (_, res) => res.sendFile(process.cwd() + "/public/audit.html"));
app.get("/landing", (_, res) => res.sendFile(process.cwd() + "/public/landing.html"));
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

app.post("/api/dispose", (req, res) => {
  const { reference, disposition } = req.body;
  if (!["cleared","escalated"].includes(disposition))
    return res.json({ ok: false, error: "Invalid disposition" });
  res.json({ ok: true, record: audit.dispose(reference, disposition, "reviewer@demo") });
});

app.listen(4030, () => console.log("Payment agent on http://localhost:4030"));
