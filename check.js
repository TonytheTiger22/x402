import { createPublicClient, http, formatUnits } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount("0xBUYER_PRIVATE_KEY_HERE");
const usdc = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });

const balance = await publicClient.readContract({
  address: usdc,
  abi: [{
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  }],
  functionName: "balanceOf",
  args: [account.address],
});

console.log("Address from client.js key:", account.address);
console.log("USDC balance:", formatUnits(balance, 6));