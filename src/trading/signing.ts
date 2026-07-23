/**
 * Hyperliquid L1 action signing (EIP-712 "phantom agent" scheme).
 *
 * Scheme (matches the official SDK):
 *   hash = keccak256( msgpack(action) || nonce_be8 || vaultByte )
 *   phantomAgent = { source: "a"|"b", connectionId: hash }
 *   sign EIP-712 domain {name:"Exchange", version:"1", chainId:1337, verifyingContract:0x0}
 *
 * Only used by the local (stdio) trading tier. The private key is read from env
 * by the caller and never logged. Trading is dry-run-first; verify on testnet.
 */
import { keccak256, hexToBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { encode as msgpackEncode } from "@msgpack/msgpack";

export interface Signature {
  r: Hex;
  s: Hex;
  v: number;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function actionHash(action: unknown, vaultAddress: string | null, nonce: number): Hex {
  const data = msgpackEncode(action) as Uint8Array;
  const nonceBytes = new Uint8Array(8);
  new DataView(nonceBytes.buffer).setBigUint64(0, BigInt(nonce), false); // big-endian
  const vaultBytes =
    vaultAddress === null
      ? new Uint8Array([0x00])
      : concatBytes([new Uint8Array([0x01]), hexToBytes(vaultAddress as Hex)]);
  return keccak256(concatBytes([data, nonceBytes, vaultBytes]));
}

export async function signL1Action(
  privateKey: string,
  action: unknown,
  nonce: number,
  isMainnet: boolean,
  vaultAddress: string | null = null,
): Promise<Signature> {
  const pk = (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as Hex;
  const account = privateKeyToAccount(pk);
  const connectionId = actionHash(action, vaultAddress, nonce);

  const signature = await account.signTypedData({
    domain: {
      name: "Exchange",
      version: "1",
      chainId: 1337,
      verifyingContract: "0x0000000000000000000000000000000000000000",
    },
    types: {
      Agent: [
        { name: "source", type: "string" },
        { name: "connectionId", type: "bytes32" },
      ],
    },
    primaryType: "Agent",
    message: { source: isMainnet ? "a" : "b", connectionId },
  });

  return {
    r: `0x${signature.slice(2, 66)}`,
    s: `0x${signature.slice(66, 130)}`,
    v: parseInt(signature.slice(130, 132), 16),
  };
}

/** The account address for a private key (for confirmations; never logs the key). */
export function addressForKey(privateKey: string): string {
  const pk = (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as Hex;
  return privateKeyToAccount(pk).address;
}

/** Round size to szDecimals and stringify (Hyperliquid wire format). */
export function formatSize(sz: number, szDecimals: number): string {
  const f = 10 ** szDecimals;
  return trimZeros((Math.round(sz * f) / f).toFixed(szDecimals));
}

/**
 * Format price to Hyperliquid rules: integers always allowed; otherwise up to 5
 * significant figures and at most (MAX_DECIMALS - szDecimals) decimals
 * (MAX_DECIMALS = 6 perps, 8 spot).
 */
export function formatPrice(px: number, szDecimals: number, isPerp = true): string {
  if (Number.isInteger(px)) return px.toString();
  const maxDecimals = Math.max(0, (isPerp ? 6 : 8) - szDecimals);
  const sig = Number(px.toPrecision(5));
  return trimZeros(sig.toFixed(maxDecimals));
}

function trimZeros(s: string): string {
  if (!s.includes(".")) return s;
  return s.replace(/\.?0+$/, "");
}

/**
 * Builder fee (tenths of a bp) -> exact percent string for approveBuilderFee.
 * Avoids float artifacts: 7 * 0.001 === 0.007000000000000001 would produce a
 * malformed maxFeeRate. f=5 -> "0.005%", f=100 -> "0.1%", f=0 -> "0%".
 */
export function feeRateToPercentString(fTenthsBps: number): string {
  const pct = fTenthsBps / 1000;
  return `${trimZeros(pct.toFixed(6))}%`;
}
