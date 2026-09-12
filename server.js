import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";

const SELLER = process.env.SELLER_ADDRESS;
const app = express();
const facilitator = new HTTPFacilitatorClient({ url: "https://x402.org/facilitator" });

const priced = (price, description) => ({
  accepts: [{ scheme: "exact", price, network: "eip155:84532", payTo: SELLER }],
  description,
  mimeType: "application/json",
});

app.use(paymentMiddleware(
  {
    "GET /forecast":    priced("$0.001", "24-hour forecast"),
    "GET /frost-alert": priced("$0.002", "Overnight frost risk"),
    "GET /flight-risk": priced("$0.005", "Flight delay probability"),
  },
  new x402ResourceServer(facilitator).register("eip155:84532", new ExactEvmScheme()),
));

app.get("/forecast", (_, res) =>
  res.json({ high: 71, low: 54, conditions: "clear", rainChance: 0.05 }));

app.get("/frost-alert", (_, res) =>
  res.json({ minTemp: 33, frostRisk: 0.62, window: "3am–6am" }));

app.get("/flight-risk", (_, res) =>
  res.json({ delayProbability: 0.34, driver: "crosswinds at destination", medianDelayMins: 42 }));

app.listen(4021, () => console.log("Weather API on 4021 — 3 products"));