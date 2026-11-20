import type { EventLog, EventRecord } from "../events/index.js";
import type { Store } from "../store/index.js";
import type { TenantConfig } from "../tenant-config/schema.js";
import { parseTenant } from "../tenant-config/loader.js";
import { dbVersion, loadEventsSince, loadRecords, loadTenantConfigs, type Sql } from "./postgres.js";

/**
 * Keeps this copy of the app in step with the database, for hosts like Vercel that start
 * several copies of the app and may pause them right after a reply.
 * - Before a request: if another copy saved something, load the newest data.
 * - Before the reply is sent: finish saving every change, so nothing is lost when the copy is paused.
 */
export class LiveSync {
  private version = "";
  private busy = 0;
  private refreshing?: Promise<void>;

  constructor(
    private sql: Sql,
    private store: Store,
    private events: EventLog,
    private tenants: Map<string, TenantConfig>,
    private onError = (e: Error) => console.error("Database refresh failed:", e.message),
  ) {}

  async start(): Promise<void> {
    this.version = await dbVersion(this.sql);
  }

  /** Call when a request starts. */
  async beforeRequest(): Promise<void> {
    this.busy++;
    if (this.refreshing) return this.refreshing; // wait for a refresh that is already running
    if (this.busy > 1) return; // other requests are using the data right now: don't swap it under them
    this.refreshing = this.refresh().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  /** Call before the reply is sent. */
  async afterRequest(): Promise<void> {
    try {
      await Promise.all([this.store.flush(), this.events.flush()]);
    } finally {
      this.busy = Math.max(0, this.busy - 1);
    }
  }

  private async refresh(): Promise<void> {
    try {
      const v = await dbVersion(this.sql);
      if (v === this.version) return;
      const since = this.events.latestAt();
      const [records, newEvents, tenantRows] = await Promise.all([
        loadRecords(this.sql),
        loadEventsSince(this.sql, since),
        loadTenantConfigs(this.sql),
      ]);
      this.store.replaceAll((records ?? {}) as Parameters<Store["replaceAll"]>[0]);
      this.events.addLoaded(newEvents as EventRecord[]);
      const fresh = tenantRows.map((t) => parseTenant(t, "database"));
      if (fresh.length) {
        this.tenants.clear();
        for (const t of fresh) this.tenants.set(t.tenantId, t);
      }
      this.version = v;
    } catch (err) {
      this.onError(err as Error); // keep working with the data we have
    }
  }
}
