/**
 * Pure(ish) admin-stats collector: reads the billing tables directly and
 * aggregates per-key usage, tool totals, and x402 payment counts. Kept
 * separate from the tool wrapper so it's unit-testable against a bare
 * in-memory SQLite database.
 */
import type Database from "better-sqlite3";

export interface KeyStats {
  /** First 10 hex chars of the key's SHA-256 hash — enough to tell keys
   * apart without exposing the raw key (keys are never stored in plaintext). */
  keyHashPrefix: string;
  tier: string;
  label: string | null;
  disabled: boolean;
  createdAt: number;
  callsThisPeriod: number;
  topTools: Array<{ tool: string; count: number }>;
}

export interface AdminStats {
  period: string;
  totalKeys: number;
  keys: KeyStats[];
  toolTotalsThisPeriod: Array<{ tool: string; count: number }>;
  totalCallsThisPeriod: number;
  x402PaymentsTotal: number;
  x402PaymentsLast30d: number;
}

/** Current UTC billing period in the same "YYYY-MM" format the billing service uses. */
export function currentPeriod(now = Date.now()): string {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function collectAdminStats(db: Database.Database, period: string, now = Date.now()): AdminStats {
  const keyRows = db
    .prepare(`SELECT key_hash, tier, label, disabled, created_at FROM api_keys ORDER BY created_at DESC`)
    .all() as Array<{ key_hash: string; tier: string; label: string | null; disabled: number; created_at: number }>;

  const usageRows = db.prepare(`SELECT key_hash, tool, count FROM usage_counters WHERE period = ?`).all(period) as Array<{
    key_hash: string;
    tool: string;
    count: number;
  }>;

  const usageByKey = new Map<string, Array<{ tool: string; count: number }>>();
  const toolTotals = new Map<string, number>();
  let totalCallsThisPeriod = 0;
  for (const r of usageRows) {
    const arr = usageByKey.get(r.key_hash) ?? [];
    arr.push({ tool: r.tool, count: r.count });
    usageByKey.set(r.key_hash, arr);
    toolTotals.set(r.tool, (toolTotals.get(r.tool) ?? 0) + r.count);
    totalCallsThisPeriod += r.count;
  }

  const keys: KeyStats[] = keyRows.map((k) => {
    const usage = (usageByKey.get(k.key_hash) ?? []).sort((a, b) => b.count - a.count);
    return {
      keyHashPrefix: k.key_hash.slice(0, 10),
      tier: k.tier,
      label: k.label,
      disabled: k.disabled === 1,
      createdAt: k.created_at,
      callsThisPeriod: usage.reduce((a, u) => a + u.count, 0),
      topTools: usage.slice(0, 5),
    };
  });

  const toolTotalsThisPeriod = [...toolTotals.entries()]
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count);

  const totalRow = db.prepare(`SELECT COUNT(*) as c FROM x402_payments`).get() as { c: number };
  const last30Row = db.prepare(`SELECT COUNT(*) as c FROM x402_payments WHERE created_at >= ?`).get(now - 30 * 86_400_000) as {
    c: number;
  };

  return {
    period,
    totalKeys: keyRows.length,
    keys,
    toolTotalsThisPeriod,
    totalCallsThisPeriod,
    x402PaymentsTotal: totalRow.c,
    x402PaymentsLast30d: last30Row.c,
  };
}
