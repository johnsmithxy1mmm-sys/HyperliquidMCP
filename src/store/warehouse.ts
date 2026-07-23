/**
 * Warehouse: one SQLite database backing the persistent positioning time-series
 * (snapshots), standing alerts, and the signal track record. This is the
 * keystone that lets whale deltas, alerts, and track record survive restarts.
 */
import type { Config } from "../config.js";
import { getDb } from "../billing/db.js";
import { SqliteSnapshotStore } from "./sqliteSnapshots.js";
import { AlertStore } from "./alertStore.js";
import { SignalStore } from "./signalStore.js";

export class Warehouse {
  readonly snapshots: SqliteSnapshotStore;
  readonly alerts: AlertStore;
  readonly signals: SignalStore;

  constructor(config: Config) {
    const db = getDb(config.dbPath);
    this.snapshots = new SqliteSnapshotStore(db);
    this.alerts = new AlertStore(db);
    this.signals = new SignalStore(db);
  }
}
