import pg from "pg";

// OFAC's own sdn.xml does not carry crypto addresses as structured data —
// they only exist in sdn_advanced.xml, buried behind a FeatureTypeID lookup
// table. Rather than build that parser ourselves, we use a maintained,
// MIT-licensed tool that already does it and republishes clean per-asset
// files, regenerated nightly straight from OFAC's data:
// https://github.com/0xB10C/ofac-sanctioned-digital-currency-addresses
//
// Known limitation, carried through honestly: these files are bare address
// lists with no linked entity name/DOB/program. See
// list-management-roadmap.md in the project for the full writeup.

const RAW_BASE =
  "https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists";

// EVM-family assets use 0x-hex addresses, which are case-insensitive —
// safe to lowercase for matching. Everything else is Base58 (or similar)
// and case-sensitive: lowercasing would corrupt matching.
const EVM_ASSETS = new Set(["ETH", "USDT", "USDC", "ARB", "BSC", "ETC"]);

const ASSETS = [
  "XBT", "ETH", "USDT", "USDC", "TRX", "SOL", "LTC", "BCH",
  "ARB", "BSC", "ETC", "DASH", "XMR", "ZEC", "XVG", "BTG", "BSV", "XRP",
];

const SOURCE = "OFAC-SDN-CRYPTO";

const normalize = (asset, address) =>
  EVM_ASSETS.has(asset) ? address.trim().toLowerCase() : address.trim();

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

await client.connect();
console.log("Clearing old crypto-address entries...");
await client.query("DELETE FROM sanctioned_addresses WHERE source = $1", [SOURCE]);

let total = 0;
for (const asset of ASSETS) {
  const url = `${RAW_BASE}/sanctioned_addresses_${asset}.txt`;
  const res = await fetch(url);
  if (!res.ok) {
    console.log(`  ${asset}: fetch failed (${res.status}), skipping`);
    continue;
  }
  const text = await res.text();
  const addresses = text.split("\n").map((l) => l.trim()).filter(Boolean);

  for (const address of addresses) {
    const addressNormalized = normalize(asset, address);
    await client.query(
      `INSERT INTO sanctioned_addresses (source, asset, address, address_normalized)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (source, asset, address_normalized) DO NOTHING`,
      [SOURCE, asset, address, addressNormalized]
    );
  }
  console.log(`  ${asset}: ${addresses.length} addresses`);
  total += addresses.length;
}

await client.query(
  `INSERT INTO list_metadata (source, list_version, refreshed_at)
   VALUES ($1, $2, now())
   ON CONFLICT (source) DO UPDATE SET list_version = $2, refreshed_at = now()`,
  [SOURCE, new Date().toISOString().slice(0, 10)]
);

console.log(`Done. ${total} addresses across ${ASSETS.length} assets.`);
await client.end();
