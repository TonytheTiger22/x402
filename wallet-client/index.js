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

// Pick the injected wallet. EIP-6963 announcements first (handles several wallets
// installed at once), then the classic window.ethereum.
function findProvider() {
  return new Promise((resolve) => {
    const found = [];
    const onAnnounce = (e) => found.push(e.detail);
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    setTimeout(() => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      const eth = window.ethereum;
      const pick = found.find((f) => /metamask|coinbase/i.test(f.info?.name || "")) || found[0];
      resolve(eth ?? pick?.provider ?? null);
    }, 250);
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

async function connect() {
  provider = provider || (await findProvider());
  if (!provider) throw new Error("NO_WALLET");
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  address = accounts?.[0];
  if (!address) throw new Error("No account was shared by the wallet");
  await ensureBase();
  return address;
}

async function usdcBalance() {
  const pc = createPublicClient({ chain: base, transport: custom(provider) });
  const raw = await pc.readContract({ address: USDC, abi: ERC20_BALANCE, functionName: "balanceOf", args: [address] });
  return Number(formatUnits(raw, 6));
}

// fetch() that answers a 402 by signing with the connected wallet and retrying.
function payFetch() {
  if (!provider || !address) throw new Error("Connect a wallet first");
  const wc = createWalletClient({ chain: base, transport: custom(provider) });
  const signer = {
    address,
    signTypedData: async (m) => { await ensureBase(); return wc.signTypedData({ account: address, ...m }); },
  };
  const client = new x402Client();
  client.register("eip155:*", new ExactEvmScheme(signer));
  return wrapFetchWithPayment(fetch.bind(window), client);
}

window.PPSWallet = {
  hasWallet: async () => { provider = provider || (await findProvider()); return !!provider; },
  connect, usdcBalance, payFetch,
  get address() { return address; },
  onChange(cb) {
    provider?.on?.("accountsChanged", (a) => { address = a?.[0] || null; cb(); });
    provider?.on?.("chainChanged", () => cb());
  },
};
