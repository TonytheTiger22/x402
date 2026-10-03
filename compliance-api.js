import express from "express";
import pg from "pg";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { createCdpFacilitatorClient } from "@coinbase/cdp-sdk/x402";

// Base mainnet (CAIP-2). Was "eip155:84532" (Base Sepolia testnet).
const NETWORK = "eip155:8453";

const SELLER = process.env.SELLER_ADDRESS;
const app = express();

// Real CDP facilitator — reads CDP_API_KEY_ID / CDP_API_KEY_SECRET from env.
// Was the free testnet facilitator at https://x402.org/facilitator.
const facilitator = createCdpFacilitatorClient();

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const priced = (price, description) => ({
  accepts: [{ scheme: "exact", price, network: NETWORK, payTo: SELLER }],
  description, mimeType: "application/json",
});

app.use(paymentMiddleware(
  {
    "GET /screen":  priced("$0.02", "Sanctions screening"),
    "GET /context": priced("$0.05", "Field comparison"),
  },
  new x402ResourceServer(facilitator).register(NETWORK, new ExactEvmScheme()),
));

const SUBJECTS = {
  clean: { name: "Maria Santos Oliveira", dob: "1981-04-12",
           country: "Portugal", type: "Individual", hits: [] },
  hit: {
    name: "Viktor Petrov", dob: "1978-09-03",
    country: "Bulgaria", type: "Individual",
    hits: [{
      list: "OFAC SDN", listVersion: "2026-08-17", score: 0.87,
      matchedOn: "Primary name, exact token match",
      listed: { name: "Viktor PETROV", dob: "1965-01-22",
                country: "Russian Federation", type: "Individual",
                program: "UKRAINE-EO14024", uid: "SDN-41287" },
    }],
  },
};

const LISTS_CHECKED = ["OFAC SDN"];
const HIT_THRESHOLD = 0.4;

const titleCase = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;

function compareDob(subjectDob, listedDob) {
  if (!subjectDob || !listedDob)
    return { status: "unknown", note: "insufficient data to compare" };

  if (/^\d{4}$/.test(listedDob)) {
    const subjectYear = String(subjectDob).slice(0, 4);
    return subjectYear === listedDob
      ? { status: "partial", note: "year matches — OFAC record has year only" }
      : { status: "differs", note: "year differs — OFAC record has year only" };
  }

  const listedParsed = new Date(listedDob);
  const subjectParsed = new Date(subjectDob);
  if (isNaN(listedParsed) || isNaN(subjectParsed))
    return { status: "unknown", note: "unparseable date format" };

  const same = listedParsed.toISOString().slice(0, 10) === subjectParsed.toISOString().slice(0, 10);
  return same
    ? { status: "match", note: "exact match" }
    : { status: "differs", note: "differs" };
}

function compareField(subjectVal, listedVal) {
  if (!subjectVal || !listedVal)
    return { status: "unknown", note: "insufficient data to compare" };
  const same = String(subjectVal).trim().toLowerCase() === String(listedVal).trim().toLowerCase();
  return same
    ? { status: "match", note: "exact match" }
    : { status: "differs", note: "differs" };
}

async function bestMatch(name) {
  const { rows } = await pool.query(
    `WITH candidates AS (
       SELECT e.id, e.canonical_name AS name, e.entity_type, e.dob, e.nationality,
              e.program, e.uid, similarity(e.canonical_name, $1) AS score, 'primary name' AS basis
       FROM entities e
       WHERE e.source = 'OFAC' AND e.canonical_name % $1
       UNION ALL
       SELECT e.id, e.canonical_name AS name, e.entity_type, e.dob, e.nationality,
              e.program, e.uid, similarity(a.alias_name, $1) AS score, 'alias match' AS basis
       FROM entity_aliases a JOIN entities e ON e.id = a.entity_id
       WHERE e.source = 'OFAC' AND a.alias_name % $1
     )
     SELECT * FROM candidates ORDER BY score DESC LIMIT 1`,
    [name]
  );
  return rows[0] || null;
}

app.get("/screen", async (req, res) => {
  if (req.query.id) {
    const s = SUBJECTS[req.query.id] || SUBJECTS.clean;
    return res.json({
      subject: { name: s.name, dob: s.dob, country: s.country, type: s.type },
      listsChecked: LISTS_CHECKED,
      screenedAt: new Date().toISOString(),
      hitCount: s.hits.length,
      hits: s.hits.map((h) => ({ list: h.list, score: h.score, name: h.listed.name })),
    });
  }

  const subject = {
    name: (req.query.name || "").trim(),
    dob: req.query.dob || null,
    country: req.query.country || null,
    type: req.query.type || "Individual",
  };

  const top = subject.name ? await bestMatch(subject.name) : null;
  const score = top ? Math.round(top.score * 100) / 100 : 0;
  const hitCount = top && score >= HIT_THRESHOLD ? 1 : 0;

  res.json({
    subject,
    listsChecked: LISTS_CHECKED,
    screenedAt: new Date().toISOString(),
    hitCount,
    hits: hitCount ? [{ list: "OFAC SDN", score, name: top.name }] : [],
  });
});

app.get("/context", async (req, res) => {
  if (req.query.id) {
    const s = SUBJECTS[req.query.id];
    if (!s || !s.hits.length) return res.json({ error: "No alert to contextualise" });
    const h = s.hits[0];
    return res.json({
      fields: [
        { field: "Name",          subject: s.name,   listed: h.listed.name,
          status: "match",  note: "exact match" },
        { field: "Date of birth", subject: s.dob,     listed: h.listed.dob,
          status: "differs", note: "differs" },
        { field: "Nationality",   subject: s.country, listed: h.listed.country,
          status: "differs", note: "differs" },
        { field: "Entity type",   subject: s.type,    listed: h.listed.type,
          status: "match",  note: "exact match" },
      ],
      meta: { list: h.list, listVersion: h.listVersion, program: h.listed.program,
              uid: h.listed.uid, score: h.score, matchedOn: h.matchedOn },
    });
  }

  const subject = {
    name: (req.query.name || "").trim(),
    dob: req.query.dob || null,
    country: req.query.country || null,
    type: req.query.type || "Individual",
  };

  const top = subject.name ? await bestMatch(subject.name) : null;
  const score = top ? Math.round(top.score * 100) / 100 : 0;
  if (!top || score < HIT_THRESHOLD) return res.json({ error: "No alert to contextualise" });

  const listedType = titleCase(top.entity_type);
  const dobCmp = compareDob(subject.dob, top.dob);
  const natCmp = compareField(subject.country, top.nationality);
  const typeCmp = compareField(subject.type, listedType);

  res.json({
    fields: [
      { field: "Name", subject: subject.name, listed: top.name,
        status: "match", note: "matched on " + top.basis },
      { field: "Date of birth",
        subject: subject.dob || "not provided",
        listed: top.dob || "not in source data",
        status: dobCmp.status, note: dobCmp.note },
      { field: "Nationality",
        subject: subject.country || "not provided",
        listed: top.nationality || "not in source data",
        status: natCmp.status, note: natCmp.note },
      { field: "Entity type",
        subject: subject.type, listed: listedType || "unknown",
        status: typeCmp.status, note: typeCmp.note },
    ],
    meta: {
      list: "OFAC SDN", listVersion: "live", program: top.program,
      uid: top.uid, score, matchedOn: top.basis,
    },
  });
});

app.listen(4025, () => console.log("Compliance API on 4025 (live OFAC data, staged comparison)"));
