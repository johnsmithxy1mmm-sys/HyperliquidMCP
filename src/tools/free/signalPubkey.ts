import { z } from "zod";
import type { ToolDef } from "../registry.js";

export const signalPubkey: ToolDef = {
  name: "hl_signal_pubkey",
  tier: "free",
  title: "Get signal verification public key",
  description:
    "Returns the server's Ed25519 public key (SPKI DER, base64) used to sign emitted signals, so anyone can " +
    "independently verify a signal's authenticity and timestamp. Canonicalization: JSON with recursively sorted " +
    "keys over {payload, ts}; signature is base64 Ed25519.",
  inputSchema: {},
  outputSchema: {
    alg: z.string(),
    publicKey: z.string(),
    ephemeral: z.boolean(),
    canonicalization: z.string(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  run: async (_args, ctx) => {
    return {
      summary: `Ed25519 public key${ctx.signer.ephemeral ? " (EPHEMERAL — rotates on restart)" : ""}.`,
      data: {
        alg: "ed25519",
        publicKey: ctx.signer.publicKey(),
        ephemeral: ctx.signer.ephemeral,
        canonicalization: "sha256 over JSON.stringify with recursively sorted keys of {payload, ts}",
      },
    };
  },
};
