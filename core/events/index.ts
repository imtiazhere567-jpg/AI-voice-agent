import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { EventSync, loadEvents, type Sql } from "../db/postgres.js";

export type Actor = "ai" | "system" | "user";

export interface EventRecord {
  id: string;
  tenantId: string;
  type: string; // e.g. "call.ended", "booking.created", "sms.simulated"
  actor: Actor;
  at: string; // ISO time
  payload: Record<string, unknown>;
}

const SECRET_KEY = /key|secret|token|password|authorization/i;

/** Remove anything that looks like a secret before it is written. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? "[redacted]" : redact(v)]),
    );
  }
  return value;
}

/** Append-only activity log. Every action in the system is written here. */
export class EventLog {
  private records: EventRecord[] = [];
  private db?: EventSync;

  /** Open the log on Postgres. The first time, the old events.jsonl file is moved into the database. */
  static async openPostgres(sql: Sql, oldFile?: string): Promise<{ events: EventLog; imported: boolean }> {
    const saved = await loadEvents(sql);
    const log = new EventLog(saved.length ? undefined : oldFile);
    log.file = undefined;
    log.db = new EventSync(sql);
    if (saved.length) log.records = saved as EventRecord[];
    const imported = !saved.length && log.records.length > 0;
    if (imported) { log.db.add(...log.records); await log.db.flush(); }
    return { events: log, imported };
  }

  /** Add entries that another copy of the app saved (skips ones we already have). */
  addLoaded(rows: readonly EventRecord[]): number {
    const have = new Set(this.records.map((r) => r.id));
    const add = rows.filter((r) => !have.has(r.id));
    this.records.push(...add);
    if (add.length) this.records.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
    return add.length;
  }

  /** Time of the newest entry in memory. */
  latestAt(): string {
    return this.records.reduce((m, r) => (r.at > m ? r.at : m), "");
  }

  async flush(): Promise<void> {
    await this.db?.flush();
  }

  constructor(private file?: string) {
    if (file && existsSync(file)) {
      this.records = readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    }
  }

  log(tenantId: string, type: string, actor: Actor, payload: Record<string, unknown> = {}): EventRecord {
    const record: EventRecord = {
      id: randomUUID(),
      tenantId,
      type,
      actor,
      at: new Date().toISOString(),
      payload: redact(payload) as Record<string, unknown>,
    };
    this.records.push(record);
    this.db?.add(record);
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, JSON.stringify(record) + "\n");
    }
    return Object.freeze(record);
  }

  list(tenantId: string, type?: string): readonly EventRecord[] {
    return this.records.filter((r) => r.tenantId === tenantId && (!type || r.type === type));
  }
}
