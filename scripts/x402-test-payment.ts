/**
 * Manual end-to-end check of x402: pays for one premium call on a running server
 * with a throwaway TESTNET key. Not part of the package or CI (it needs a live
 * facilitator and testnet USDC). Run a local server on Base Sepolia first:
 *
 *   X402_ENABLED=true X402_NETWORK=base-sepolia X402_PAY_TO=0xYourAddress \
 *   X402_FACILITATOR_URL=https://x402.org/facilitator HYPERSIGNAL_DB_PATH=/tmp/x402-test.db \
 *   PORT=18082 npx tsx src/server-http.ts
 *
 *   npx tsx scripts/x402-test-payment.ts --new-key ./testnet.key     # writes a key (mode 600), prints its address
 *   # fund that address with testnet USDC (https://faucet.circle.com, Base Sepolia), then:
 *   npx tsx scripts/x402-test-payment.ts --key ./testnet.key --server http://localhost:18082/mcp
 *
 * Buying Pro (set X402_PRO_PRICE_USDC=0.05 on the test server so the faucet's USDC is enough):
 *
 *   ... --tool hl_buy_pro --save-key ./pro.key              # new Pro key, saved (mode 600), never printed
 *   ... --tool hl_buy_pro --api-key ./pro.key               # renew it
 *   ... --tool hl_funding_screener --api-key ./pro.key      # use it (no payment)
 *
 * The keys are never printed. Never point it at a mainnet key.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Hex } from "viem";

export interface PaymentRequirement {
  network: string;
  maxAmountRequired: string;
  payTo: string;
  asset: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string };
}

const CHAIN_IDS: Record<string, number> = { "base-sepolia": 84532, base: 8453 };

/** The X-PAYMENT header (base64 JSON) for one EIP-3009 `exact` payment of `req`. */
export async function buildXPayment(
  req: PaymentRequirement,
  account: PrivateKeyAccount,
  now = Date.now(),
  nonce: Hex = `0x${randomBytes(32).toString("hex")}`,
): Promise<string> {
  const chainId = CHAIN_IDS[req.network];
  if (!chainId) throw new Error(`Unsupported network "${req.network}"`);
  const authorization = {
    from: account.address,
    to: req.payTo as Hex,
    value: BigInt(req.maxAmountRequired),
    validAfter: 0n,
    validBefore: BigInt(Math.floor(now / 1000) + req.maxTimeoutSeconds),
    nonce,
  };
  const signature = await account.signTypedData({
    domain: { name: req.extra.name, version: req.extra.version, chainId, verifyingContract: req.asset as Hex },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: authorization,
  });
  const wire = {
    ...authorization,
    value: authorization.value.toString(),
    validAfter: authorization.validAfter.toString(),
    validBefore: authorization.validBefore.toString(),
  };
  const payment = { x402Version: 1, scheme: "exact", network: req.network, payload: { signature, authorization: wire } };
  return Buffer.from(JSON.stringify(payment)).toString("base64");
}

interface ToolResult {
  isError?: boolean;
  content?: Array<{ text?: string }>;
  structuredContent?: { error?: string; x402?: { accepts: PaymentRequirement[] }; apiKey?: string; expiresAt?: string; renewed?: boolean };
}

async function callTool(server: string, tool: string, xPayment?: string, apiKey?: string): Promise<ToolResult> {
  const res = await fetch(server, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(xPayment ? { "x-payment": xPayment } : {}),
      ...(apiKey ? { "x-api-key": apiKey } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: tool === "hl_buy_pro" ? {} : { limit: 2 } } }),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  return (JSON.parse(line ? line.slice(5) : text) as { result: ToolResult }).result;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const newKey = arg("--new-key");
  if (newKey) {
    if (existsSync(newKey)) throw new Error(`${newKey} exists; refusing to overwrite a key`);
    writeFileSync(newKey, generatePrivateKey());
    chmodSync(newKey, 0o600);
    console.log(`Testnet address (fund it with Base Sepolia USDC): ${privateKeyToAccount(readFileSync(newKey, "utf8").trim() as Hex).address}`);
    return;
  }
  const keyFile = arg("--key");
  if (!keyFile) throw new Error("Pass --new-key <file> to create a testnet key, or --key <file> to pay with one.");
  const server = arg("--server") ?? "http://localhost:18082/mcp";
  const tool = arg("--tool") ?? "hl_funding_screener";
  const account = privateKeyToAccount(readFileSync(keyFile, "utf8").trim() as Hex);

  const saveKey = arg("--save-key");
  if (saveKey && existsSync(saveKey)) throw new Error(`${saveKey} exists; refusing to overwrite a key (checked before paying)`);
  const apiKeyFile = arg("--api-key");
  const apiKey = apiKeyFile ? readFileSync(apiKeyFile, "utf8").trim() : undefined;

  const first = await callTool(server, tool, undefined, apiKey);
  if (!first.isError) {
    console.log(`No payment needed: ${(first.content?.[0]?.text ?? "").slice(0, 120)}`);
    return;
  }
  const requirement = first.structuredContent?.x402?.accepts?.[0];
  if (first.structuredContent?.error !== "payment_required" || !requirement) {
    throw new Error(`Expected a payment_required answer with x402 requirements, got: ${JSON.stringify(first).slice(0, 300)}`);
  }
  console.log(`Server wants ${Number(requirement.maxAmountRequired) / 1e6} USDC on ${requirement.network}, paid to ${requirement.payTo}`);

  const second = await callTool(server, tool, await buildXPayment(requirement, account), apiKey);
  if (second.isError) throw new Error(`Paid call failed: ${JSON.stringify(second.structuredContent ?? second.content).slice(0, 400)}`);
  const issued = second.structuredContent?.apiKey;
  if (issued && saveKey) {
    writeFileSync(saveKey, issued);
    chmodSync(saveKey, 0o600);
  }
  console.log(`Paid call succeeded: ${(second.content?.[0]?.text ?? "").slice(0, 120)}`);
  if (second.structuredContent?.expiresAt) console.log(`Pro runs until ${second.structuredContent.expiresAt} (renewed: ${second.structuredContent.renewed})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
