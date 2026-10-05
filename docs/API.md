# PayPerScreen API

A sanctions and crypto-wallet screening API, paid per call over
[x402](https://x402.org) — no account, no API key, no subscription. Each
request pays for itself in USDC on Base mainnet at the moment it's made.

This document is for anyone integrating programmatically, agent or human.
If you're a person using the web UI instead, see
[payperscreen.com](https://payperscreen.com). For a plain-English,
signal-by-signal breakdown of what each check actually does — including
what we don't check yet — see
[payperscreen.com/methodology](https://payperscreen.com/methodology).
Everything in that page is also reflected in the response shapes
documented below; neither should ever say more than the other.

## Who this is for

This API is built around the assumption that most real callers will be
**agents, not people clicking a button** — a backend process or an
autonomous agent that holds its own wallet and can sign a payment without
a human in the loop. That's the native use case x402 was designed for, and
it's the integration this document covers. See
[`examples/agent-client.mjs`](/examples/agent-client.mjs) for a working,
copy-pasteable reference client.

## Base URL

```
https://keen-solace-production-b976.up.railway.app
```

(Provisional — this is the Railway-assigned hostname for the API service.
A dedicated subdomain may replace it later; this document will be updated
if so.)

## How payment works

No API key, no signup. Authentication *is* payment: every request is
authorized by a signed payment, checked per-call.

1. You call an endpoint with no payment attached.
2. The server responds `402 Payment Required` with the exact payment it
   needs: scheme (`exact`), network (`eip155:8453`, Base mainnet), asset
   (USDC), amount, and the address to pay.
3. Your client signs an EIP-3009 `transferWithAuthorization` — a gasless,
   off-chain signature. You never pay gas; the facilitator that settles
   the payment does.
4. Your client retries the same request with the signed authorization
   attached in an `X-PAYMENT` header.
5. The server verifies and settles the payment, then returns your result.

If you're using an x402-aware HTTP client (the `@x402/fetch` package used
in the reference client, or any other x402 client library), steps 2–4
happen automatically — you just call the URL and the library pays for you.

**Wallet requirements:** real USDC on Base mainnet. No ETH needed — you
only sign, you never submit a transaction yourself.

## Endpoints

### `GET /screen` — $0.02

Fuzzy name match against the sanctions lists we currently carry — OFAC SDN,
UN, EU and UK where loaded (see "What we check" below; `listsChecked` in every
response names exactly what was checked).

**Query parameters**

| Param     | Required | Notes                                   |
|-----------|----------|------------------------------------------|
| `name`    | yes      | Full name to screen                      |
| `dob`     | no       | `YYYY-MM-DD` if known                    |
| `country` | no       | Nationality, free text                   |
| `type`    | no       | `Individual` or `Entity` (default: `Individual`) |

**Response**

```json
{
  "subject": { "name": "...", "dob": null, "country": null, "type": "Individual" },
  "listsChecked": ["OFAC SDN"],
  "screenedAt": "2026-10-03T12:40:00.000Z",
  "hitCount": 1,
  "hits": [{ "list": "OFAC SDN", "score": 0.87, "name": "..." }]
}
```

`hits` has at most one entry **per list** — the best match on that list above an
internal similarity threshold, strongest first. `hitCount` is the number of
lists with a hit. If it is above `0`, call `/context` for the field-by-field
comparison against the strongest match.

### `GET /context` — $0.05

Field-by-field comparison between what you submitted and the matched
listed party. Only meaningful right after a `/screen` call that returned
`hitCount: 1` — same query parameters, same values.

**Response**

```json
{
  "fields": [
    { "field": "Name", "subject": "...", "listed": "...",
      "status": "match", "note": "matched on primary name" },
    { "field": "Date of birth", "subject": "...", "listed": "...",
      "status": "differs", "note": "differs" },
    { "field": "Nationality", "subject": "not provided", "listed": "...",
      "status": "unknown", "note": "insufficient data to compare" },
    { "field": "Entity type", "subject": "Individual", "listed": "Individual",
      "status": "match", "note": "exact match" }
  ],
  "meta": {
    "list": "OFAC SDN", "listVersion": "live", "program": "...",
    "uid": "...", "score": 0.87, "matchedOn": "primary name"
  }
}
```

`status` is one of four values — this is deliberate, not a boolean:

| `status`  | Meaning                                                  |
|-----------|-----------------------------------------------------------|
| `match`   | Fields agree                                               |
| `differs` | Fields disagree                                            |
| `partial` | Partial agreement (e.g. year-only DOB matches the year)    |
| `unknown` | Not enough data on one side to compare — **not** a match or a non-match |

Returns `{ "error": "No alert to contextualise" }` if there's nothing to
compare (no prior hit for these parameters).

### `GET /screen-address` — $0.02

Exact-match lookup against OFAC's sanctioned digital-currency address
list. This is a **different kind of check** from `/screen` — exact
string match, not fuzzy, and the underlying source carries no linked
entity name, DOB, or program per address (see "What we check" below).

**Query parameters**

| Param     | Required | Notes                                      |
|-----------|----------|----------------------------------------------|
| `address` | yes      | Any supported chain's wallet address         |

**Response**

```json
{
  "address": "...",
  "screenedAt": "2026-10-03T12:40:00.000Z",
  "sanctioned": true,
  "matches": [{ "asset": "XBT", "source": "OFAC-SDN-CRYPTO" }],
  "source": "OFAC SDN digital currency addresses",
  "note": "Exact address match only — this source has no linked entity name, DOB, or program per address. \"Not sanctioned\" reflects this list only, not a guarantee the address is clean."
}
```

Supported assets: `XBT` (Bitcoin), `ETH`, `USDT`, `USDC`, `TRX`, `SOL`,
`LTC`, `BCH`, `ARB`, `BSC`, `ETC`, `DASH`, `XMR`, `ZEC`, `XVG`, `BTG`,
`BSV`, `XRP`.

### `GET /screen-email` — $0.02

A deterministic "fan-out and score" composite — not a list match. Ten signals, all zero-key: syntax/MX validity, disposable-domain check,
free-mail classification, domain age, certificate transparency, an SMTP
mailbox probe (best-effort — some mail servers block it or accept every
address), DNSBL (Spamhaus), MX provider fingerprinting, typo-squat
detection, and role-account detection.

**Query parameters**

| Param   | Required | Notes                  |
|---------|----------|--------------------------|
| `email` | yes      | Email address to check  |

**Response**

```json
{
  "ok": true,
  "email": "someone@example.com",
  "riskLevel": "low",
  "redFlag": false,
  "redFlagSignals": [],
  "flagCount": 0,
  "unknownCount": 0,
  "signalsChecked": 10,
  "signals": [ { "id": "disposable_domain", "label": "Disposable email provider", "severity": "critical", "status": "pass", "detail": "..." } ],
  "note": "..."
}
```

`riskLevel` is `low`, `medium`, or `high`. A flagged **critical** signal
(disposable provider, no mail server, look-alike domain, etc.) sets
`redFlag: true` and `riskLevel: "high"` on its own, regardless of how many
minor signals also flagged — see `redFlagSignals` for which ones fired.
Signals that couldn't be evaluated are `unknown`, never counted as a pass.

### `GET /screen-ip` — $0.01 (beta)

Checks a public IPv4 address against two known-high-risk-IP lists, both
free and keyless: the Spamhaus ZEN blocklist (spam sources, botnets,
hijacked netblocks) and the Tor Project's own exit-node list. A third
signal (network allocation, via RDAP) is informational only — plenty of
legitimate traffic comes from datacenter IPs, so it's not scored.

**Query parameters**

| Param | Required | Notes                       |
|-------|----------|-------------------------------|
| `ip`  | yes      | A public IPv4 address to check |

**Response** shape matches `/screen-email` (`riskLevel`, `redFlag`,
`redFlagSignals`, `signals`), with `ip` in place of `email`. Private/
reserved addresses (RFC 1918, loopback, etc.) and anything that isn't a
valid IPv4 address return `{ "ok": false, "error": "..." }` instead — no
reputation exists to check for a non-routable address. IPv6 isn't
supported yet. VPN/hosting classification and community abuse reports
(AbuseIPDB) aren't live yet — they need a paid key.

## What we check (current, honest state)

- **Name screening**: OFAC SDN, UN Security Council Consolidated List, EU
  Consolidated Financial Sanctions List and UK Sanctions List (FCDO). A list
  counts only once it is loaded — `listsChecked` in every response, and
  [/lists](https://payperscreen.com/lists), tell you exactly what was checked,
  so don't assume broader coverage than they state.
- **Crypto address screening**: OFAC's sanctioned digital-currency
  addresses only, sourced via a third-party extraction tool (see
  `ingest-crypto-addresses.mjs` in this repo for provenance). No linked
  identity data — a hit tells you the address is listed, not whose it is.
- All are snapshots. OFAC and crypto addresses are refreshed manually; UN/EU/UK can refresh daily. If
  you need a guarantee of same-day freshness, verify against OFAC's own
  published list directly for anything high-stakes.

This is deliberate: we'd rather you know the real boundaries of what's
checked than have the response imply more confidence than the data
supports. If this changes (more lists, scheduled refresh), this document
and the API's own response fields will reflect it.

## This is a data service, not a compliance service

A result from this API is a match (or non-match) and a field comparison —
nothing more. What you do with it — clear it, escalate it, hold a
payment, file a report — is entirely your own process and your own
regulatory responsibility. We don't make a disposition decision for you.

## Quickstart

```bash
git clone https://github.com/TonytheTiger22/x402
cd x402
npm install
PRIVATE_KEY=0xYourKey node examples/agent-client.mjs screen "Jane Doe"
PRIVATE_KEY=0xYourKey node examples/agent-client.mjs address 123WBUDmSJv4GctdVEz6Qq6z8nXSKrJ4KX
```
