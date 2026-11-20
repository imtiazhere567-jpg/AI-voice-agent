// Start: npm run dev   (reads .env)
import { join } from "node:path";
import { EventLog } from "./core/events";
import { Messaging } from "./core/messaging";
import { Store } from "./core/store";
import { loadTenantsFromDb, loadTenantsFromDir } from "./core/tenant-config/loader";
import { connectPostgres } from "./core/db/postgres";
import { LocalCalendar } from "./integrations/calendar/local-calendar";
import { BlandClient } from "./integrations/voice/bland";
import { buildApp } from "./app";
import { QuickTunnel } from "./integrations/tunnel";
import { Auth } from "./core/auth";
import { appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { linkExistingBookings } from "./modules/voice-receptionist/actions";

try {
  process.loadEnvFile(".env");
} catch {
  /* .env is optional when variables are set by the host */
}

const dataDir = process.env.DATA_DIR || "data";
const globalTestMode = process.env.GLOBAL_TEST_MODE !== "false";
const tenantsDir = process.env.TENANTS_DIR || "test-data/tenants";

// Live: everything is saved in Postgres (DATABASE_URL, e.g. Neon). Without it: local files in data/.
const db = process.env.DATABASE_URL ? await connectPostgres(process.env.DATABASE_URL) : undefined;
let tenants, store, events;
if (db) {
  const t = await loadTenantsFromDb(db, tenantsDir);
  const s = await Store.openPostgres(db, join(dataDir, "store.json"));
  const e = await EventLog.openPostgres(db, join(dataDir, "events.jsonl"));
  ({ tenants } = t); ({ store } = s); ({ events } = e);
  console.log(`Database: Postgres connected.${t.imported ? ` Copied ${t.imported} business(es) into the database.` : ""}${s.imported ? " Copied saved calls, bookings and accounts into the database." : ""}${e.imported ? " Copied the activity log into the database." : ""}`);
} else {
  tenants = loadTenantsFromDir(tenantsDir);
  store = new Store(join(dataDir, "store.json"));
  events = new EventLog(join(dataDir, "events.jsonl"));
  console.log("Database: none (DATABASE_URL not set). Saving to local files in data/.");
}
linkExistingBookings({ store });
const bland = process.env.BLAND_API_KEY ? new BlandClient(process.env.BLAND_API_KEY) : undefined;
const messaging = new Messaging(events, store, bland, globalTestMode);
const calendar = new LocalCalendar(store);

// ---- Accounts: one admin (from .env) and one public demo owner ----
{
  const auth = new Auth(store);
  let adminEmail = process.env.ADMIN_EMAIL;
  let adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminEmail || !adminPassword) {
    adminEmail = "admin@receptionist.local";
    adminPassword = `Admin-${randomBytes(6).toString("hex")}1`;
    appendFileSync(".env", `\n# Admin login for the owner dashboard (auto-generated, change it any time)\nADMIN_EMAIL=${adminEmail}\nADMIN_PASSWORD=${adminPassword}\n`);
    console.log(`\nCreated admin login. Email: ${adminEmail} (password saved in .env as ADMIN_PASSWORD)\n`);
  }
  auth.ensureUser({ email: adminEmail, name: "Admin", password: adminPassword, role: "admin" });
  const demoTenant = tenants.get("demo-roofing") ?? [...tenants.values()][0];
  if (demoTenant) auth.ensureUser({ email: "demo@receptionist.app", name: "Demo Owner", password: "Demo1234", role: "owner", tenantId: demoTenant.tenantId, demo: true });
}

const port = Number(process.env.PORT || 3000);
const tunnel = new QuickTunnel(port); // free public link for Bland test calls, started only when needed

const app = buildApp({
  deps: { store, events, messaging, calendar, now: () => new Date(), publicBaseUrl: process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}` },
  tenants,
  toolSecret: process.env.TOOL_SECRET ?? "",
  tenantsDir,
  tenantDb: db,
  bland,
  tunnel,
});
process.on("exit", () => tunnel.stop());
// Before stopping, finish saving everything to the database.
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, async () => {
  tunnel.stop();
  try { await Promise.race([Promise.all([store.flush(), events.flush()]), new Promise((r) => setTimeout(r, 8000))]); await db?.end(); } catch { /* exiting anyway */ }
  process.exit(0);
});
await app.listen({ port, host: "0.0.0.0" });
app.log.info(`Receptionist server on port ${port} | businesses: ${[...tenants.keys()].join(", ")} | test mode: ${globalTestMode ? "ON (global)" : "per business"}`);
