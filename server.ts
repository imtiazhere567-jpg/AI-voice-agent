// Start: npm run dev   (reads .env)
import { join } from "node:path";
import { EventLog } from "./core/events/index.js";
import { Messaging } from "./core/messaging/index.js";
import { Store } from "./core/store/index.js";
import { loadTenantsFromDb, loadTenantsFromDir } from "./core/tenant-config/loader.js";
import { connectPostgres } from "./core/db/postgres.js";
import { LiveSync } from "./core/db/live-sync.js";
import { LocalCalendar } from "./integrations/calendar/local-calendar.js";
import { BlandClient } from "./integrations/voice/bland.js";
import { buildApp } from "./http-app.js";
import { QuickTunnel } from "./integrations/tunnel.js";
import { Auth } from "./core/auth/index.js";
import { appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { linkExistingBookings } from "./modules/voice-receptionist/actions.js";

try {
  process.loadEnvFile(".env");
} catch {
  /* .env is optional when variables are set by the host */
}

// On Vercel the app runs as functions: files can't be saved (only /tmp), so the database is required.
const onVercel = Boolean(process.env.VERCEL);
if (onVercel) {
  const missing = ["DATABASE_URL", "TOOL_SECRET", "ADMIN_EMAIL", "ADMIN_PASSWORD"].filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`Missing settings on Vercel: ${missing.join(", ")}. Add them in Vercel -> Project -> Settings -> Environment Variables, then redeploy.`);
}
const dataDir = process.env.DATA_DIR || (onVercel ? "/tmp/data" : "data");
if (onVercel) process.env.DATA_DIR = dataDir; // voice samples are cached in /tmp there
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
  if (!onVercel && (!adminEmail || !adminPassword)) {
    adminEmail = "admin@receptionist.local";
    adminPassword = `Admin-${randomBytes(6).toString("hex")}1`;
    appendFileSync(".env", `\n# Admin login for the owner dashboard (auto-generated, change it any time)\nADMIN_EMAIL=${adminEmail}\nADMIN_PASSWORD=${adminPassword}\n`);
    console.log(`\nCreated admin login. Email: ${adminEmail} (password saved in .env as ADMIN_PASSWORD)\n`);
  }
  auth.ensureUser({ email: adminEmail!, name: "Admin", password: adminPassword!, role: "admin" });
  const demoTenant = tenants.get("demo-roofing") ?? [...tenants.values()][0];
  if (demoTenant) auth.ensureUser({ email: "demo@receptionist.app", name: "Demo Owner", password: "Demo1234", role: "owner", tenantId: demoTenant.tenantId, demo: true });
}

const port = Number(process.env.PORT || 3000);
// Free public link for Bland test calls on a computer. Not needed on Vercel (it has a public address).
const tunnel = onVercel ? undefined : new QuickTunnel(port);
const vercelUrl = process.env.VERCEL_ENV === "production" ? process.env.VERCEL_PROJECT_PRODUCTION_URL : process.env.VERCEL_URL;
const publicBaseUrl = process.env.PUBLIC_BASE_URL || (vercelUrl ? `https://${vercelUrl}` : `http://127.0.0.1:${port}`);
const liveSync = onVercel && db ? new LiveSync(db, store, events, tenants) : undefined;
await liveSync?.start();

const app = buildApp({
  deps: { store, events, messaging, calendar, now: () => new Date(), publicBaseUrl },
  tenants,
  toolSecret: process.env.TOOL_SECRET ?? "",
  tenantsDir,
  tenantDb: db,
  liveSync,
  bland,
  tunnel,
});
process.on("exit", () => tunnel?.stop());
// Before stopping, finish saving everything to the database.
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, async () => {
  tunnel?.stop();
  try { await Promise.race([Promise.all([store.flush(), events.flush()]), new Promise((r) => setTimeout(r, 8000))]); await db?.end(); } catch { /* exiting anyway */ }
  process.exit(0);
});
await app.listen({ port, host: "0.0.0.0" });
app.log.info(`Receptionist server on port ${port} | businesses: ${[...tenants.keys()].join(", ")} | test mode: ${globalTestMode ? "ON (global)" : "per business"}`);
