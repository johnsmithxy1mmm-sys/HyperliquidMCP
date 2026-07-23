/**
 * Signed signals: every emitted premium signal can be cryptographically signed
 * so subscribers can prove it was issued by this server at a given time (an
 * anti-cherry-picking, verifiable track record primitive). Uses Ed25519 from
 * node:crypto — no extra dependency.
 *
 * Key source (in priority order):
 *   1. SIGNAL_SIGNING_KEY — base64 of a 32-byte Ed25519 seed (private key).
 *   2. otherwise an EPHEMERAL key generated at boot (logged as such; the public
 *      key changes on restart, so persist a seed for a stable identity).
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, type KeyObject } from "node:crypto";
import { log } from "../logger.js";

export interface SignedSignal {
  ts: number;
  alg: "ed25519";
  payloadHash: string; // sha256 hex of canonical payload
  signature: string; // base64
  publicKey: string; // base64 raw (SPKI DER base64)
}

/** Deterministic JSON: object keys sorted recursively, so the hash is stable. */
export function canonicalize(value: unknown): string {
  const seen = new WeakSet();
  const norm = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v as object)) return null;
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(norm);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = norm((v as Record<string, unknown>)[k]);
    }
    return out;
  };
  return JSON.stringify(norm(value));
}

export class SignalSigner {
  private readonly privateKey: KeyObject;
  private readonly publicKeyB64: string;
  readonly ephemeral: boolean;

  constructor(seedB64?: string) {
    if (seedB64) {
      const seed = Buffer.from(seedB64, "base64");
      if (seed.length !== 32) {
        throw new Error("SIGNAL_SIGNING_KEY must be base64 of a 32-byte Ed25519 seed.");
      }
      // PKCS8 wrapper for a raw Ed25519 seed.
      const pkcs8 = Buffer.concat([
        Buffer.from("302e020100300506032b657004220420", "hex"),
        seed,
      ]);
      this.privateKey = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
      this.ephemeral = false;
    } else {
      const { privateKey } = generateKeyPairSync("ed25519");
      this.privateKey = privateKey;
      this.ephemeral = true;
      log.warn("SIGNAL_SIGNING_KEY not set: using an EPHEMERAL signing key (public key changes on restart)");
    }
    const pub: KeyObject = createPublicKey(this.privateKey);
    this.publicKeyB64 = pub.export({ format: "der", type: "spki" }).toString("base64");
  }

  publicKey(): string {
    return this.publicKeyB64;
  }

  sign(payload: unknown, ts = Date.now()): SignedSignal {
    const canonical = canonicalize({ payload, ts });
    const payloadHash = createHash("sha256").update(canonical).digest("hex");
    const signature = edSign(null, Buffer.from(canonical), this.privateKey).toString("base64");
    return { ts, alg: "ed25519", payloadHash, signature, publicKey: this.publicKeyB64 };
  }
}
