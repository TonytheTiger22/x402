// Reference client for agent/developer integrators.
//
// This is what you'd actually run — a standalone script with no UI, no
// audit database, no Express server. It just calls the paid API with your
// own wallet. No account, no API key: x402 payment on every request IS
// the authentication.
//
// Usage:
//   PRIVATE_KEY=0x... node examples/agent-client.mjs screen "Jane Doe"
//   PRIVATE_KEY=0x... node examples/agent-client.mjs address 0x1234...
//   PRIVATE_KEY=0x... node examples/agent-client.mjs email someone@example.com
//   PRIVATE_KEY=0x... node examples/agent-client.mjs ip 1.2.3.4
//
// Requirements on your wallet:
//   - Real USDC on Base mainnet (this hits production, not a testnet).
//   - No ETH needed — the facilitator pays gas, you only sign.
//
// See docs/API.md for the full endpoint/pricing/response reference.

import { wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const API_BASE = process.env.API_BASE_URL
  || "https://keen-solace-production-b976.up.railway.app";

if (!process.env.PRIVATE_KEY) {
  console.error("Set PRIVATE_KEY to a funded Base-mainnet wallet's private key.");
  process.exit(1);
}

const signer = privateKeyToAccount(process.env.PRIVATE_KEY);
const client = new x402Client();
client.register("eip155:*", new ExactEvmScheme(signer));
const fetchWithPayment = wrapFetchWithPayment(fetch, client);
const httpClient = new x402HTTPClient(client);

// Calls a paid GET endpoint, paying automatically on the 402, and returns
// the parsed JSON body. Throws if the payment didn't settle.
async function callPaid(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetchWithPayment(`${API_BASE}${path}${qs ? "?" + qs : ""}`, {
    method: "GET",
  });
  const out = await httpClient.processResponse(res);
  if (out.paymentStatus !== "settled") {
    throw new Error(`Payment ${out.paymentStatus} for ${path}`);
  }
  return out.body;
}

async function screenName(name, { dob, country, type } = {}) {
  console.log(`Screening "${name}" ($0.02)...`);
  const screen = await callPaid("/screen", {
    name, dob: dob || "", country: country || "", type: type || "Individual",
  });
  console.log(JSON.stringify(screen, null, 2));

  if (screen.hitCount > 0) {
    console.log(`\nPossible match found. Pulling field comparison ($0.05)...`);
    const context = await callPaid("/context", {
      name, dob: dob || "", country: country || "", type: type || "Individual",
    });
    console.log(JSON.stringify(context, null, 2));
  }
}

async function screenAddress(address) {
  console.log(`Screening address "${address}" ($0.02)...`);
  const result = await callPaid("/screen-address", { address });
  console.log(JSON.stringify(result, null, 2));
}

async function screenEmail(email) {
  console.log(`Checking email "${email}" ($0.02)...`);
  const result = await callPaid("/screen-email", { email });
  console.log(JSON.stringify(result, null, 2));
}

async function screenIp(ip) {
  console.log(`Checking IP "${ip}" ($0.01)...`);
  const result = await callPaid("/screen-ip", { ip });
  console.log(JSON.stringify(result, null, 2));
}

const [, , cmd, ...args] = process.argv;

if (cmd === "screen" && args[0]) {
  await screenName(args[0]);
} else if (cmd === "address" && args[0]) {
  await screenAddress(args[0]);
} else if (cmd === "email" && args[0]) {
  await screenEmail(args[0]);
} else if (cmd === "ip" && args[0]) {
  await screenIp(args[0]);
} else {
  console.log("Usage:");
  console.log('  PRIVATE_KEY=0x... node examples/agent-client.mjs screen "Jane Doe"');
  console.log("  PRIVATE_KEY=0x... node examples/agent-client.mjs address 0x1234...");
  console.log("  PRIVATE_KEY=0x... node examples/agent-client.mjs email someone@example.com");
  console.log("  PRIVATE_KEY=0x... node examples/agent-client.mjs ip 1.2.3.4");
  process.exit(1);
}
