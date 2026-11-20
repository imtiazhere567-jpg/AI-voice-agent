import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Session, User } from "../auth/index.js";
import { loadRecords, RecordSync, type Sql } from "../db/postgres.js";

/**
 * Storage: Postgres when DATABASE_URL is set (live), otherwise one JSON file (or memory only in tests).
 * The app reads and changes `data` in memory; persist() saves the changes. Every record carries tenantId.
 */

export interface Booking {
  id: string;
  tenantId: string;
  serviceId: string;
  start: string; // ISO
  end: string; // ISO
  customerName: string;
  customerPhone?: string;
  address?: string;
  notes?: string;
  status: "booked" | "cancelled";
  source?: "phone" | "web"; // AI phone call or online booking page
  callId?: string; // the call that made this booking (set when the call is saved)
  seenAt?: string; // when the owner marked this new booking as seen
  createdAt: string;
}

export interface CallbackTask {
  id: string;
  tenantId: string;
  callerName?: string;
  callerPhone?: string;
  reason: string;
  notes?: string;
  urgent: boolean;
  status: "open" | "done";
  createdAt: string;
}

export interface CallRecord {
  callId: string;
  tenantId: string;
  from?: string;
  to?: string;
  lengthMinutes: number;
  summary?: string;
  transcript?: string;
  recordingUrl?: string;
  outcome: "conversation" | "hang_up" | "spam" | "no_answer";
  handledBy?: "ai" | "staff";
  direction?: "in" | "out"; // "out" = the business called the customer from the dashboard
  callerName?: string;
  createdAt: string;
}

/** A text message to or from a customer (shown in the dashboard and on the simulator phone). */
export interface Message {
  id: string;
  tenantId: string;
  phone: string; // the customer's number
  direction: "out" | "in";
  body: string;
  kind?: string; // booking_confirmation, missed_call_text_back, staff_message, ...
  by?: string; // who sent it (staff name) for staff messages
  status?: string; // sent / simulated
  at: string;
}

export interface TextBack {
  tenantId: string;
  phone: string;
  at: string;
}

interface Data {
  bookings: Booking[];
  callbacks: CallbackTask[];
  calls: CallRecord[];
  optOuts: { tenantId: string; phone: string; at: string }[];
  textBacks: TextBack[];
  messages: Message[];
  users: User[];
  sessions: Session[];
  /** Bland web agent per business (for "talk in the browser" test calls), reused and updated each time. */
  blandAgents: { tenantId: string; agentId: string; updatedAt: string }[];
}

const empty = (): Data => ({ bookings: [], callbacks: [], calls: [], optOuts: [], textBacks: [], messages: [], users: [], sessions: [], blandAgents: [] });

export class Store {
  readonly data: Data;
  private db?: RecordSync;

  constructor(private file?: string, initial?: Partial<Data>) {
    this.data = initial
      ? { ...empty(), ...initial }
      : file && existsSync(file) ? { ...empty(), ...JSON.parse(readFileSync(file, "utf8")) } : empty();
  }

  /**
   * Open the store on Postgres. The first time (empty database), the old JSON file is moved
   * into the database so no data is lost. Returns how the data was loaded.
   */
  static async openPostgres(sql: Sql, oldFile?: string): Promise<{ store: Store; imported: boolean }> {
    const saved = await loadRecords(sql);
    const store = saved ? new Store(undefined, saved as Partial<Data>) : new Store(oldFile);
    store.file = undefined;
    store.db = new RecordSync(sql, () => store.data as unknown as Record<string, unknown>);
    if (saved) store.db.markSaved(store.data as unknown as Record<string, unknown>);
    const imported = !saved && Object.values(store.data).some((l) => Array.isArray(l) && l.length > 0);
    if (imported) await store.db.flush();
    return { store, imported };
  }

  /** Save after a change (to Postgres in the background, or to the JSON file). */
  persist(): void {
    if (this.db) return this.db.schedule();
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }

  /** Replace everything in memory with what was loaded from the database. */
  replaceAll(saved: Partial<Data>): void {
    const fresh = { ...empty(), ...saved } as Data;
    for (const k of Object.keys(fresh) as (keyof Data)[]) (this.data as any)[k] = fresh[k];
    this.db?.markSaved(this.data as unknown as Record<string, unknown>);
  }

  /** Wait until every change is saved (used before the server stops). */
  async flush(): Promise<void> {
    await this.db?.flush();
  }

  isOptedOut(tenantId: string, phone: string): boolean {
    return this.data.optOuts.some((o) => o.tenantId === tenantId && o.phone === phone);
  }
}
