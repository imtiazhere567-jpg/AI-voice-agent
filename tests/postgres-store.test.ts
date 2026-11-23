import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { createTables, RecordSync, type Sql } from "../core/db/postgres.js";
import { Store } from "../core/store/index.js";
import { EventLog } from "../core/events/index.js";
import { loadTenantsFromDb } from "../core/tenant-config/loader.js";
import { buildApp } from "../http-app.js";

async function freshDb(): Promise<Sql> {
  const db = new PGlite();
  await createTables(db);
  return db;
}

const booking = (id: string, name: string) => ({
  id, tenantId: "t1", serviceId: "s", start: "2026-11-21T15:00:00Z", end: "2026-11-21T16:00:00Z",
  customerName: name, status: "booked" as const, createdAt: `2026-11-20T10:00:0${id.slice(-1)}Z`,
});

describe("Postgres storage", () => {
  it("saves new, changed and removed records, and loads them back after a restart", async () => {
    const db = await freshDb();
    const { store } = await Store.openPostgres(db);
    store.data.bookings.push(booking("b1", "Sara"), booking("b2", "Ali"));
    store.data.sessions.push({ tokenHash: "h1", userId: "u1", expiresAt: "2030-01-01T00:00:00Z" });
    store.data.optOuts.push({ tenantId: "t1", phone: "+17135550100", at: "2026-11-20T10:00:00Z" });
    store.persist();
    await store.flush();

    store.data.bookings[0].status = "cancelled";
    store.data.bookings.splice(1, 1);
    store.data.sessions = []; // replaced list (like logout)
    store.persist();
    await store.flush();

    const { store: again } = await Store.openPostgres(db);
    expect(again.data.bookings).toEqual([{ ...booking("b1", "Sara"), status: "cancelled" }]);
    expect(again.data.sessions).toEqual([]);
    expect(again.isOptedOut("t1", "+17135550100")).toBe(true);
    const { rows } = await db.query(`select tenant_id from app_records where kind = 'bookings'`);
    expect(rows).toEqual([{ tenant_id: "t1" }]); // every record keeps its tenantId
  });

  it("only writes what changed", async () => {
    const db = await freshDb();
    const { store } = await Store.openPostgres(db);
    store.data.bookings.push(booking("b1", "Sara"));
    await store.flush();
    let writes = 0;
    const counting: Sql = { query: (q, p) => { writes++; return db.query(q, p); } };
    const sync = new RecordSync(counting, () => store.data as any);
    sync.markSaved(store.data as any);
    await sync.flush();
    expect(writes).toBe(0);
    store.data.bookings[0].notes = "gate code 12";
    await sync.flush();
    expect(writes).toBe(1);
  });

  it("keeps changes and retries when the database is unreachable", async () => {
    const db = await freshDb();
    let down = true;
    const flaky: Sql = { query: (q, p) => (down ? Promise.reject(new Error("fetch failed")) : db.query(q, p)) };
    const data = { bookings: [booking("b1", "Sara")] };
    const errors: string[] = [];
    const sync = new RecordSync(flaky, () => data, (e) => errors.push(e.message));
    await sync.flush();
    expect(errors).toEqual(["fetch failed"]);
    down = false;
    await sync.flush();
    const { rows } = await db.query(`select id from app_records`);
    expect(rows).toEqual([{ id: "b1" }]);
  });

  it("moves the old JSON files into an empty database the first time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pgmove-"));
    writeFileSync(join(dir, "store.json"), JSON.stringify({ bookings: [booking("b1", "Sara")], calls: [{ callId: "c1", tenantId: "t1", lengthMinutes: 2, outcome: "conversation", createdAt: "2026-11-20T09:00:00Z" }] }));
    writeFileSync(join(dir, "events.jsonl"), JSON.stringify({ id: "e1", tenantId: "t1", type: "call.ended", actor: "ai", at: "2026-11-20T09:00:00Z", payload: {} }) + "\n");
    const db = await freshDb();

    const first = await Store.openPostgres(db, join(dir, "store.json"));
    const firstLog = await EventLog.openPostgres(db, join(dir, "events.jsonl"));
    expect(first.imported).toBe(true);
    expect(firstLog.imported).toBe(true);

    firstLog.events.log("t1", "booking.created", "ai", { apiKey: "secret-value" });
    await firstLog.events.flush();

    // Second start: data comes from the database, the files are not imported again.
    const second = await Store.openPostgres(db, join(dir, "store.json"));
    const secondLog = await EventLog.openPostgres(db, join(dir, "events.jsonl"));
    expect(second.imported).toBe(false);
    expect(second.store.data.calls.map((c) => c.callId)).toEqual(["c1"]);
    expect(secondLog.events.list("t1").map((e) => e.type)).toEqual(["call.ended", "booking.created"]);
    expect(secondLog.events.list("t1")[1].payload).toEqual({ apiKey: "[redacted]" }); // secrets never stored
  });

  it("stores business settings in the database (seeded from the files once)", async () => {
    const db = await freshDb();
    const { tenants, imported } = await loadTenantsFromDb(db, "test-data/tenants");
    expect(imported).toBeGreaterThan(0);
    expect(tenants.get("demo-roofing")?.businessName).toBeTruthy();

    const { store } = await Store.openPostgres(db);
    const events = new EventLog();
    const app = buildApp({
      deps: { store, events, messaging: {} as any, calendar: {} as any, now: () => new Date(), publicBaseUrl: "http://x" },
      tenants, toolSecret: "test-secret-1234567890", tenantDb: db, tenantsDir: "should-not-be-written", requireAuth: false,
    });
    const cur = tenants.get("demo-roofing")!;
    const res = await app.inject({ method: "PUT", url: "/api/tenants/demo-roofing", payload: { ...cur, customInstructions: "Say hi to Bob." } });
    expect(res.statusCode).toBe(200);

    const reloaded = await loadTenantsFromDb(db, "test-data/tenants");
    expect(reloaded.imported).toBe(0);
    expect(reloaded.tenants.get("demo-roofing")?.customInstructions).toBe("Say hi to Bob.");

    if (tenants.size > 1) {
      const del = await app.inject({ method: "DELETE", url: "/api/tenants/demo-roofing" });
      expect(del.statusCode).toBe(200);
      expect((await loadTenantsFromDb(db)).tenants.has("demo-roofing")).toBe(false);
    }
  });
});

describe("Two copies of the app on one database (Vercel)", () => {
  it("each copy sees what the other one saved, and saves before replying", async () => {
    const { LiveSync } = await import("../core/db/live-sync.js");
    const db = await freshDb();
    const { tenants: tA } = await loadTenantsFromDb(db, "test-data/tenants");
    const { tenants: tB } = await loadTenantsFromDb(db);
    const a = { store: (await Store.openPostgres(db)).store, events: (await EventLog.openPostgres(db)).events };
    const b = { store: (await Store.openPostgres(db)).store, events: (await EventLog.openPostgres(db)).events };
    const syncA = new LiveSync(db, a.store, a.events, tA);
    const syncB = new LiveSync(db, b.store, b.events, tB);
    await syncA.start(); await syncB.start();
    const mk = (store: Store, events: EventLog, tenants: typeof tA, sync: InstanceType<typeof LiveSync>) => buildApp({
      deps: { store, events, messaging: {} as any, calendar: {} as any, now: () => new Date(), publicBaseUrl: "http://x" },
      tenants, toolSecret: "test-secret-1234567890", tenantDb: db, liveSync: sync, requireAuth: false, logger: false,
    });
    const appA = mk(a.store, a.events, tA, syncA);
    const appB = mk(b.store, b.events, tB, syncB);

    // Copy A changes the training; copy B shows it on its next request.
    const cur = tA.get("demo-roofing")!;
    expect((await appA.inject({ method: "PUT", url: "/api/tenants/demo-roofing", payload: { ...cur, customInstructions: "Mention the spring offer." } })).statusCode).toBe(200);
    const script = await appB.inject({ url: "/api/tenants/demo-roofing/script" });
    expect(script.json().script).toContain("Mention the spring offer.");
    expect(b.events.list("demo-roofing", "training.updated")).toHaveLength(1);

    // A booking saved by copy A (outside a request, like a Bland tool call) is seen by copy B.
    a.store.data.bookings.push(booking("b1", "Sara") as any);
    a.store.persist();
    await a.store.flush();
    await appB.inject({ url: "/health" });
    expect(b.store.data.bookings.map((x) => x.customerName)).toEqual(["Sara"]);
  });
});

describe("Files packed into the code (Vercel)", () => {
  it("has every page, the AI script template and the demo businesses", async () => {
    const { EMBEDDED } = await import("../generated/assets.js");
    for (const p of ["web/dashboard.html", "web/auth.html", "web/phone.html", "web/booking.html", "prompts/voice-receptionist/v1.md", "test-data/tenants/demo-roofing.json"]) {
      expect(EMBEDDED[p], p).toBeTruthy();
    }
  });

  it("adds the demo businesses to an empty database even without the folder", async () => {
    const db = await freshDb();
    const { tenants, imported } = await loadTenantsFromDb(db, "folder-that-is-not-there");
    expect(imported).toBeGreaterThan(0);
    expect(tenants.has("demo-roofing")).toBe(true);
  });
});
