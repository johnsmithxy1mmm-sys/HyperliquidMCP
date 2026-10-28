/**
 * Public, key-free evidence for the product's two checkable claims: the signed
 * track record of the server's own (house) signals, and the out-of-sample
 * calibration of the smart-money score. Served at /track-record(.json).
 */
import type { Warehouse } from "../store/warehouse.js";
import type { SignalSigner } from "../signals/signer.js";
import type { TrackRecord } from "../store/signalStore.js";
import { calibrate, type CalibrationReport } from "../smartmoney/calibration.js";

export interface PublicProof {
  server: string;
  version: string;
  generatedAt: number;
  signing: { alg: "ed25519"; publicKey: string; persistent: boolean };
  calibration: CalibrationReport & { observations: { total: number; resolved: number; pending: number; abandoned: number } };
  houseSignals: TrackRecord[];
}

export function buildPublicProof(store: Warehouse, signer: SignalSigner, version: string, now = Date.now()): PublicProof {
  return {
    server: "hypersignal-mcp",
    version,
    generatedAt: now,
    signing: { alg: "ed25519", publicKey: signer.publicKey(), persistent: !signer.ephemeral },
    calibration: {
      ...calibrate(store.scores.outcomes()),
      observations: { ...store.scores.counts(), abandoned: store.scores.abandoned() },
    },
    // House only: a customer's alerts could be tuned to flatter the record.
    houseSignals: store.signals.trackRecord(undefined, "house"),
  };
}

const escapeHtml = (value: unknown): string =>
  String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

export function renderProofHtml(p: PublicProof): string {
  const rows = p.houseSignals.length
    ? p.houseSignals
        .map(
          (r) =>
            `<tr><td>${escapeHtml(r.type)}</td><td>${escapeHtml(r.total)}</td><td>${escapeHtml(r.scored)}</td>` +
            `<td>${escapeHtml(r.hitRatePct)}%</td><td>${escapeHtml(r.avgReturnPct)}%</td><td>${escapeHtml(r.medianReturnPct)}%</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="6">No house signals scored yet. Signals are scored 24h after they fire.</td></tr>`;
  const quartiles = p.calibration.quartiles
    .map((q) => `<li>Q${escapeHtml(q.quartile)} (n=${escapeHtml(q.n)}): mean forward return ${escapeHtml(q.meanForwardReturn)}</li>`)
    .join("");
  const c = p.calibration;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>HyperSignal track record</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:820px;margin:2rem auto;padding:0 1rem;color:#111}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:.4rem;text-align:left}
code{word-break:break-all;background:#f4f4f4;padding:.1rem .3rem}</style></head><body>
<h1>HyperSignal track record</h1>
<p>Server ${escapeHtml(p.server)} v${escapeHtml(p.version)} · generated ${escapeHtml(new Date(p.generatedAt).toISOString())} ·
<a href="/track-record.json">JSON</a></p>
<h2>House signals</h2>
<p>Signals from the server's own standing alerts (funding extremes on the top perps, whale-cohort flips on BTC/ETH),
scored against the price 24h later, direction-adjusted. Customer alerts are not included.</p>
<table><tr><th>Type</th><th>Signals</th><th>Scored</th><th>Hit rate</th><th>Avg return</th><th>Median return</th></tr>${rows}</table>
<h2>Smart-money score calibration</h2>
<p>Verdict: <strong>${escapeHtml(c.verdict)}</strong> · n=${escapeHtml(c.n)} · Spearman ${escapeHtml(c.spearman ?? "n/a")} ·
p=${escapeHtml(c.pValue ?? "n/a")} · observations ${escapeHtml(c.observations.resolved)}/${escapeHtml(c.observations.total)} resolved</p>
${quartiles ? `<ul>${quartiles}</ul>` : ""}
<h2>Verify</h2>
<p>Every signal is signed with Ed25519${p.signing.persistent ? "" : " (ephemeral key: signatures do not survive a restart)"}. Public key (SPKI, base64):</p>
<p><code>${escapeHtml(p.signing.publicKey)}</code></p>
<p>Analytics, not investment advice.</p>
</body></html>`;
}
