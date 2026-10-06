// Browser-side wallet payment for payperscreen.com. Bundled to public/wallet.js
// (npm run build:wallet) and loaded only when a visitor chooses "Pay with my wallet".
// The visitor's own wallet signs a gasless USDC authorization on Base; the site
// relays it to the paid API (see walletBuy in payment-agent.js). We never see a key.
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { createWalletClient, createPublicClient, custom, formatUnits } from "viem";
import { base } from "viem/chains";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // native USDC on Base
const ERC20_BALANCE = [{ name: "balanceOf", type: "function", stateMutability: "view",
  inputs: [{ name: "a", type: "address" }], outputs: [{ name: "", type: "uint256" }] }];
const BASE_HEX = "0x" + base.id.toString(16); // 0x2105

let provider = null, address = null;

// Wallet discovery (EIP-6963): every installed wallet announces itself with a name
// and icon, so MetaMask, Coinbase Wallet, Rabby etc. can coexist and be chosen.
// Falls back to the classic window.ethereum for wallets that don't announce.
const announced = new Map();
window.addEventListener("eip6963:announceProvider", (e) => {
  const d = e.detail; if (d?.provider) announced.set(d.info?.uuid || d.info?.rdns || d.info?.name, d);
});
function listWallets() {
  return new Promise((resolve) => {
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    setTimeout(() => {
      let list = [...announced.values()].map((d) => ({ id: d.info?.rdns || d.info?.name, name: d.info?.name || "Wallet", icon: d.info?.icon || "", provider: d.provider }));
      if (!list.length && window.ethereum) {
        const e = window.ethereum;
        list = [{ id: "injected", icon: "", provider: e,
          name: e.isMetaMask ? "MetaMask" : e.isCoinbaseWallet ? "Coinbase Wallet" : "Browser wallet" }];
      }
      resolve(list);
    }, 300);
  });
}

async function ensureBase() {
  const chain = await provider.request({ method: "eth_chainId" });
  if (chain?.toLowerCase() === BASE_HEX) return;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: BASE_HEX }] });
  } catch (e) {
    if (e?.code === 4902 || /unrecognized chain|not added/i.test(e?.message || "")) {
      await provider.request({ method: "wallet_addEthereumChain", params: [{
        chainId: BASE_HEX, chainName: "Base", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: ["https://mainnet.base.org"], blockExplorerUrls: ["https://basescan.org"] }] });
    } else throw e;
  }
}

async function connect(id) {
  const wallets = await listWallets();
  const w = (id && wallets.find((x) => x.id === id)) || wallets[0];
  if (!w) throw new Error("NO_WALLET");
  provider = w.provider;
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  address = accounts?.[0];
  if (!address) throw new Error("No account was shared by the wallet");
  await ensureBase();
  return { address, name: w.name };
}
function disconnect() { provider = null; address = null; }

async function usdcBalance() {
  const pc = createPublicClient({ chain: base, transport: custom(provider) });
  const raw = await pc.readContract({ address: USDC, abi: ERC20_BALANCE, functionName: "balanceOf", args: [address] });
  return Number(formatUnits(raw, 6));
}

// fetch() that answers a 402 by signing with the connected wallet and retrying.
// maxUsd caps what this fetch may authorise (the x402 client's own default cap
// is $1, which a top-up can exceed); per-check calls keep the default.
function payFetch(maxUsd) {
  if (!provider || !address) throw new Error("Connect a wallet first");
  const wc = createWalletClient({ chain: base, transport: custom(provider) });
  const signer = {
    address,
    signTypedData: async (m) => { await ensureBase(); return wc.signTypedData({ account: address, ...m }); },
  };
  const client = new x402Client();
  client.register("eip155:*", new ExactEvmScheme(signer));
  if (maxUsd) client.setSpendControls({ maxAmountPerPayment: "$" + Number(maxUsd).toFixed(2) });
  return wrapFetchWithPayment(fetch.bind(window), client);
}

// Plain personal_sign of a text message (used to sign in to a prepaid balance).
// Moves nothing and approves nothing.
async function signMessage(message) {
  if (!provider || !address) throw new Error("Connect a wallet first");
  const wc = createWalletClient({ chain: base, transport: custom(provider) });
  return wc.signMessage({ account: address, message });
}

window.PPSWallet = {
  listWallets, connect, disconnect, usdcBalance, payFetch, signMessage,
  get address() { return address; },
  onChange(cb) {
    provider?.on?.("accountsChanged", (a) => { address = a?.[0] || null; cb(); });
    provider?.on?.("chainChanged", () => cb());
  },
};
