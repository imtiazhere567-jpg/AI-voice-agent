import pg from "pg";

/**
 * Postgres storage (Neon on Vercel, Supabase, or any Postgres).
 * The app keeps working from memory (fast, simple), and every change is written to Postgres
 * in the background. On start, everything is loaded back from Postgres.
 */

/** The only thing we need from a database client. Works with pg's Pool and with PGlite (tests). */
export interface Sql {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

const SCHEMA = [
  `create table if not exists app_records (
     kind text not null, id text not null, tenant_id text, data jsonb not null,
     updated_at timestamptz not null default now(), primary key (kind, id))`,
  `create index if not exists app_records_tenant on app_records (tenant_id, kind)`,
  `create table if not exists app_events (
     id text primary key, tenant_id text not null, type text not null, actor text not null,
     at text not null, payload jsonb not null)`,
  `create index if not exists app_events_tenant on app_events (tenant_id, at)`,
  `create table if not exists app_tenants (
     tenant_id text primary key, config jsonb not null, deleted_at timestamptz,
     updated_at timestamptz not null default now())`,
];

export async function createTables(sql: Sql): Promise<void> {
  for (const s of SCHEMA) await sql.query(s);
}

/** Connect to Postgres from a connection string (DATABASE_URL) and make sure the tables exist. */
export async function connectPostgres(url: string): Promise<Sql & { end(): Promise<void> }> {
  const pool = new pg.Pool({ connectionString: url, max: 5, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 15_000 });
  pool.on("error", (err) => console.error("Database connection error:", err.message));
  await createTables(pool);
  return pool;
}

const CHUNK = 500;
const chunks = <T>(list: T[]) => Array.from({ length: Math.ceil(list.length / CHUNK) }, (_, i) => list.slice(i * CHUNK, (i + 1) * CHUNK));

// ---------- Store records (calls, bookings, callbacks, messages, users, sessions, ...) ----------

/** How each record is identified, per collection. */
const KEYS: Record<string, (r: any) => string> = {
  bookings: (r) => r.id,
  callbacks: (r) => r.id,
  calls: (r) => r.callId,
  messages: (r) => r.id,
  users: (r) => r.id,
  sessions: (r) => r.tokenHash,
  optOuts: (r) => `${r.tenantId}|${r.phone}`,
  textBacks: (r) => `${r.tenantId}|${r.phone}|${r.at}`,
  blandAgents: (r) => r.tenantId,
};

interface Row { kind: string; id: string; tenantId: string | null; json: string }

function rowsOf(data: Record<string, unknown>): Map<string, Row> {
  const rows = new Map<string, Row>();
  for (const [kind, list] of Object.entries(data)) {
    if (!Array.isArray(list)) continue;
    const seen = new Map<string, number>();
    list.forEach((r: any, i) => {
      let id = String(KEYS[kind]?.(r) ?? i);
      const n = seen.get(id) ?? 0; // two records with the same key: keep both
      seen.set(id, n + 1);
      if (n) id = `${id}#${n}`;
      rows.set(`${kind}\u0000${id}`, { kind, id, tenantId: r?.tenantId ?? null, json: JSON.stringify(r) });
    });
  }
  return rows;
}

/** Load all records back into collections (in the order they were created). */
export async function loadRecords(sql: Sql): Promise<Record<string, unknown[]> | undefined> {
  const { rows } = await sql.query(`select kind, data from app_records order by kind, coalesce(data->>'createdAt', data->>'at', ''), id`);
  if (!rows.length) return undefined;
  const data: Record<string, unknown[]> = {};
  for (const r of rows) (data[r.kind] ??= []).push(typeof r.data === "string" ? JSON.parse(r.data) : r.data);
  return data;
}

/**
 * Writes only what changed since the last save. Saves run one at a time; if a save fails
 * (for example the internet drops) it is tried again 5 seconds later, so nothing is lost.
 */
export class RecordSync {
  private saved = new Map<string, string>();
  private running?: Promise<void>;
  private again = false;
  private retry?: NodeJS.Timeout;

  constructor(private sql: Sql, private current: () => Record<string, unknown>, private onError = (e: Error) => console.error("Database save failed, will retry:", e.message)) {}

  /** Mark this data as already in the database. */
  markSaved(data: Record<string, unknown>): void {
    this.saved = new Map([...rowsOf(data)].map(([k, r]) => [k, r.json]));
  }

  schedule(): void {
    if (this.running) { this.again = true; return; }
    this.running = this.run().finally(() => { this.running = undefined; });
  }

  /** Wait until every change is in the database (used on shutdown and in tests). */
  async flush(): Promise<void> {
    if (this.running) await this.running;
    this.schedule();
    await this.running;
  }

  private async run(): Promise<void> {
    try {
      do { this.again = false; await this.writeChanges(); } while (this.again);
    } catch (err) {
      this.onError(err as Error);
      clearTimeout(this.retry);
      this.retry = setTimeout(() => this.schedule(), 5000);
      this.retry.unref?.();
    }
  }

  private async writeChanges(): Promise<void> {
    const now = rowsOf(this.current());
    const upserts = [...now].filter(([k, r]) => this.saved.get(k) !== r.json);
    const deletes = [...this.saved.keys()].filter((k) => !now.has(k));
    for (const part of chunks(upserts)) {
      await this.sql.query(
        `insert into app_records (kind, id, tenant_id, data, updated_at)
         select e->>'kind', e->>'id', e->>'tenantId', e->'data', now() from jsonb_array_elements($1::jsonb) e
         on conflict (kind, id) do update set tenant_id = excluded.tenant_id, data = excluded.data, updated_at = now()`,
        [JSON.stringify(part.map(([, r]) => ({ kind: r.kind, id: r.id, tenantId: r.tenantId, data: JSON.parse(r.json) })))],
      );
      for (const [k, r] of part) this.saved.set(k, r.json);
    }
    for (const part of chunks(deletes)) {
      await this.sql.query(
        `delete from app_records r using jsonb_array_elements($1::jsonb) d where r.kind = d->>'kind' and r.id = d->>'id'`,
        [JSON.stringify(part.map((k) => { const [kind, id] = k.split("\u0000"); return { kind, id }; }))],
      );
      for (const k of part) this.saved.delete(k);
    }
  }
}

// ---------- Activity log ----------

export interface EventRow { id: string; tenantId: string; type: string; actor: string; at: string; payload: Record<string, unknown> }

export async function loadEvents(sql: Sql): Promise<EventRow[]> {
  const { rows } = await sql.query(`select id, tenant_id, type, actor, at, payload from app_events order by at, id`);
  return rows.map((r) => ({ id: r.id, tenantId: r.tenant_id, type: r.type, actor: r.actor, at: r.at, payload: typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload }));
}

/** Adds new log entries in the background; keeps them and retries if the database is unreachable. */
export class EventSync {
  private pending: EventRow[] = [];
  private running?: Promise<void>;
  private retry?: NodeJS.Timeout;

  constructor(private sql: Sql, private onError = (e: Error) => console.error("Database log save failed, will retry:", e.message)) {}

  add(...events: EventRow[]): void {
    this.pending.push(...events);
    this.schedule();
  }

  async flush(): Promise<void> {
    if (this.running) await this.running;
    if (this.pending.length) { this.schedule(); await this.running; }
  }

  private schedule(): void {
    if (this.running) return;
    this.running = this.run().finally(() => { this.running = undefined; });
  }

  private async run(): Promise<void> {
    try {
      while (this.pending.length) {
        const part = this.pending.slice(0, CHUNK);
        await this.sql.query(
          `insert into app_events (id, tenant_id, type, actor, at, payload)
           select e->>'id', e->>'tenantId', e->>'type', e->>'actor', e->>'at', e->'payload' from jsonb_array_elements($1::jsonb) e
           on conflict (id) do nothing`,
          [JSON.stringify(part)],
        );
        this.pending.splice(0, part.length);
      }
    } catch (err) {
      this.onError(err as Error);
      clearTimeout(this.retry);
      this.retry = setTimeout(() => this.schedule(), 5000);
      this.retry.unref?.();
    }
  }
}

// ---------- Business settings (tenant configs) ----------

export async function loadTenantConfigs(sql: Sql): Promise<unknown[]> {
  const { rows } = await sql.query(`select config from app_tenants where deleted_at is null order by tenant_id`);
  return rows.map((r) => (typeof r.config === "string" ? JSON.parse(r.config) : r.config));
}

export async function saveTenantConfig(sql: Sql, tenant: { tenantId: string }): Promise<void> {
  await sql.query(
    `insert into app_tenants (tenant_id, config, deleted_at, updated_at) values ($1, $2::jsonb, null, now())
     on conflict (tenant_id) do update set config = excluded.config, deleted_at = null, updated_at = now()`,
    [tenant.tenantId, JSON.stringify(tenant)],
  );
}

/** Deleted businesses are only marked as deleted, so they can be restored. */
export async function deleteTenantConfig(sql: Sql, tenantId: string): Promise<void> {
  await sql.query(`update app_tenants set deleted_at = now() where tenant_id = $1`, [tenantId]);
}

export async function countTenantConfigs(sql: Sql): Promise<number> {
  const { rows } = await sql.query(`select count(*)::int as n from app_tenants`);
  return Number(rows[0]?.n ?? 0);
}
