import express from "express";
import { wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const signer = privateKeyToAccount(process.env.BUYER_KEY);
const client = new x402Client();
client.register("eip155:*", new ExactEvmScheme(signer));
const fetchWithPayment = wrapFetchWithPayment(fetch, client);
const httpClient = new x402HTTPClient(client);

const API = "http://localhost:4021";

const CATALOG = [
  { id: "frost", path: "/frost-alert", price: 0.002,
    label: "Overnight frost risk for your area",
    words: ["frost", "garden", "tomato", "plant", "freeze", "cover"],
    say: (d) => `Yes — cover them. There's a ${Math.round(d.frostRisk * 100)}% chance of frost tonight, `
              + `dipping to ${d.minTemp}°F between ${d.window}.` },
  { id: "flight", path: "/flight-risk", price: 0.005,
    label: "Delay risk for your flight",
    words: ["flight", "fly", "airport", "plane", "delay", "travel"],
    say: (d) => `About a ${Math.round(d.delayProbability * 100)}% chance of delay, `
              + `typically around ${d.medianDelayMins} minutes. Cause: ${d.driver}.` },
  { id: "forecast", path: "/forecast", price: 0.001,
    label: "Tomorrow's forecast",
    words: ["tomorrow", "forecast", "weather", "rain", "outside", "walk"],
    say: (d) => `${d.conditions}, high of ${d.high}°F and low of ${d.low}°F, `
              + `with a ${Math.round(d.rainChance * 100)}% chance of rain.` },
];

const session = { limit: 0.05, spent: 0, receipts: [] };
const find = (id) => CATALOG.find((c) => c.id === id);
const state = () => ({ ...session, remaining: +(session.limit - session.spent).toFixed(4) });

const app = express();
app.use(express.json());
app.use(express.static("public"));
app.get("/", (_, res) => res.sendFile(process.cwd() + "/public/shop.html"));

app.get("/api/state", (_, res) => res.json(state()));
app.post("/api/reset", (_, res) => {
  session.spent = 0;
  session.receipts = [];
  res.json(state());
});

app.post("/api/ask", (req, res) => {
  const q = String(req.body.question || "").toLowerCase();
  const hit = CATALOG.find((c) => c.words.some((w) => q.includes(w))) || find("forecast");
  res.json({ id: hit.id, label: hit.label, price: hit.price, ...state() });
});

app.post("/api/buy", async (req, res) => {
  const item = find(req.body.id);
  if (!item) return res.json({ ok: false, error: "Unknown product" });

  if (session.spent + item.price > session.limit)
    return res.json({ ok: false, error: "That would exceed your spending limit.", ...state() });

  try {
    const started = Date.now();
    const r = await fetchWithPayment(API + item.path, { method: "GET" });
    const out = await httpClient.processResponse(r);

    if (out.paymentStatus !== "settled")
      return res.json({ ok: false, error: `Payment ${out.paymentStatus}`, ...state() });

    const tx = (JSON.stringify(out.header ?? {}).match(/0x[0-9a-fA-F]{64}/) || [])[0] || null;
    session.spent = +(session.spent + item.price).toFixed(4);
    const receipt = {
      label: item.label, price: item.price, tx,
      at: new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
      ms: Date.now() - started,
    };
    session.receipts.unshift(receipt);

    res.json({ ok: true, answer: item.say(out.body), raw: out.body, receipt, ...state() });
  } catch (err) {
    res.json({ ok: false, error: String(err), ...state() });
  }
});

app.listen(4023, () => console.log("Storefront on http://localhost:4023"));
