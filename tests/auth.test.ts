import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../http-app.js";
import { Auth, hashPassword, verifyPassword } from "../core/auth/index.js";
import { EventLog } from "../core/events/index.js";
import { Messaging } from "../core/messaging/index.js";
import { Store } from "../core/store/index.js";
import { loadTenantsFromDir } from "../core/tenant-config/loader.js";
import { LocalCalendar } from "../integrations/calendar/local-calendar.js";
import type { Deps } from "../modules/voice-receptionist/actions.js";

const base = loadTenantsFromDir(fileURLToPath(new URL("../test-data/tenants", import.meta.url)));
let deps: Deps, auth: Auth, app: ReturnType<typeof buildApp>;

const cookieOf = (r: { headers: Record<string, unknown> }) => String(r.headers["set-cookie"] ?? "").split(";")[0];

beforeEach(() => {
  const store = new Store();
  const events = new EventLog();
  deps = { store, events, messaging: new Messaging(events, store, undefined, true), calendar: new LocalCalendar(store), now: () => new Date() };
  auth = new Auth(store);
  auth.createUser({ email: "admin@test.com", name: "Admin", password: "Admin1234", role: "admin" });
  auth.createUser({ email: "owner@roof.com", name: "Mike", password: "Roof12345", role: "owner", tenantId: "demo-roofing" });
  auth.createUser({ email: "demo@receptionist.app", name: "Demo", password: "Demo1234", role: "owner", tenantId: "demo-roofing", demo: true });
  app = buildApp({ deps, tenants: new Map(base), toolSecret: "test-secret-1234567890", logger: false, tenantsDir: mkdtempSync(join(tmpdir(), "t-")) });
});

const login = async (email: string, password: string, extra = {}) =>
  app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password, ...extra } });

describe("passwords", () => {
  it("are hashed, never stored as plain text", () => {
    const h = hashPassword("Secret123");
    expect(h).not.toContain("Secret123");
    expect(verifyPassword("Secret123", h)).toBe(true);
    expect(verifyPassword("secret123", h)).toBe(false);
  });
});

describe("login / logout", () => {
  it("dashboard redirects to login when not signed in", async () => {
    const r = await app.inject({ method: "GET", url: "/" });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe("/login");
    expect((await app.inject({ method: "GET", url: "/api/tenants" })).statusCode).toBe(401);
  });

  it("logs in with the right password only", async () => {
    expect((await login("owner@roof.com", "wrong")).statusCode).toBe(401);
    const ok = await login("OWNER@roof.com", "Roof12345");
    expect(ok.json()).toMatchObject({ ok: true, user: { email: "owner@roof.com", role: "owner" } });
    expect(ok.json().user.passwordHash).toBeUndefined();
    expect(String(ok.headers["set-cookie"])).toMatch(/HttpOnly/);
  });

  it("logout ends the session", async () => {
    const c = cookieOf(await login("owner@roof.com", "Roof12345"));
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: c } })).statusCode).toBe(200);
    await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie: c }, payload: {} });
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: c } })).statusCode).toBe(401);
  });

  it("admin login page rejects non-admin accounts", async () => {
    expect((await login("owner@roof.com", "Roof12345", { admin: true })).statusCode).toBe(403);
    expect((await login("admin@test.com", "Admin1234", { admin: true })).json().user.role).toBe("admin");
  });

  it("demo button logs into the demo business", async () => {
    const r = await app.inject({ method: "POST", url: "/api/auth/demo", payload: {} });
    expect(r.json().user).toMatchObject({ demo: true, tenantId: "demo-roofing" });
  });
});

describe("who sees what", () => {
  it("an owner only sees and changes their own business", async () => {
    const c = cookieOf(await login("owner@roof.com", "Roof12345"));
    const list = (await app.inject({ method: "GET", url: "/api/tenants", headers: { cookie: c } })).json();
    expect(list.map((t: { tenantId: string }) => t.tenantId)).toEqual(["demo-roofing"]);
    expect((await app.inject({ method: "GET", url: "/api/dashboard/glow-med-spa", headers: { cookie: c } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/tenants", headers: { cookie: c }, payload: { businessName: "X" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: "/api/tenants/demo-roofing", headers: { cookie: c }, payload: {} })).statusCode).toBe(403);
  });

  it("the admin sees every business", async () => {
    const c = cookieOf(await login("admin@test.com", "Admin1234"));
    expect((await app.inject({ method: "GET", url: "/api/tenants", headers: { cookie: c } })).json()).toHaveLength(3);
    expect((await app.inject({ method: "GET", url: "/api/dashboard/glow-med-spa", headers: { cookie: c } })).statusCode).toBe(200);
  });

  it("the phone simulator works without logging in, but staff actions need a login", async () => {
    expect((await app.inject({ method: "GET", url: "/api/phone/businesses" })).json()).toHaveLength(3);
    const call = (await app.inject({ method: "POST", url: "/api/live/demo-roofing/start", payload: { from: "5550100150" } })).json();
    expect(call.status).toBe("ringing");
    expect((await app.inject({ method: "GET", url: `/api/live/demo-roofing/${call.id}` })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/api/live/demo-roofing/${call.id}/answer`, payload: {} })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: `/api/live/demo-roofing/${call.id}/hangup`, payload: { by: "caller" } })).statusCode).toBe(200);
  });
});

describe("register", () => {
  it("creates the owner account and their business together", async () => {
    const r = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Sara Khan", email: "sara@smile.com", password: "Smile2026", businessName: "Smile Dental", industry: "dentist", zipCodes: "77002" } });
    expect(r.json()).toMatchObject({ ok: true, user: { role: "owner", tenantId: "smile-dental" } });
    const c = cookieOf(r);
    expect((await app.inject({ method: "GET", url: "/api/tenants", headers: { cookie: c } })).json()[0].businessName).toBe("Smile Dental");
  });

  it("gives clear errors for weak passwords and used emails", async () => {
    const r = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "A B", email: "owner@roof.com", password: "short", businessName: "X Y", zipCodes: "77002" } });
    expect(r.statusCode).toBe(400);
    expect(r.json().errors.join(" ")).toMatch(/at least 8 characters/);
    expect(r.json().errors.join(" ")).toMatch(/already exists/);
  });
});

describe("forgot / reset password", () => {
  it("resets with a one-time link, and the old password stops working", async () => {
    const f = (await app.inject({ method: "POST", url: "/api/auth/forgot", payload: { email: "owner@roof.com" } })).json();
    expect(f.message).toMatch(/If an account exists/);
    const token = new URL(f.testLink).searchParams.get("token");
    const r = await app.inject({ method: "POST", url: "/api/auth/reset", payload: { token, password: "NewPass99" } });
    expect(r.json().ok).toBe(true);
    expect((await login("owner@roof.com", "Roof12345")).statusCode).toBe(401);
    expect((await login("owner@roof.com", "NewPass99")).statusCode).toBe(200);
    // the link only works once
    expect((await app.inject({ method: "POST", url: "/api/auth/reset", payload: { token, password: "Another99" } })).statusCode).toBe(400);
  });

  it("does not reveal whether an email exists", async () => {
    const f = (await app.inject({ method: "POST", url: "/api/auth/forgot", payload: { email: "nobody@x.com" } })).json();
    expect(f.message).toMatch(/If an account exists/);
    expect(f.testLink).toBeUndefined();
  });
});

describe("Dashboard access when hosted", () => {
  it("is local-only on a computer, and open (behind the login) when hosted", async () => {
    const { buildApp } = await import("../http-app.js");
    const { Store } = await import("../core/store/index.js");
    const { EventLog } = await import("../core/events/index.js");
    const { loadTenantsFromDir } = await import("../core/tenant-config/loader.js");
    const mk = (publicDashboard: boolean) => buildApp({
      deps: { store: new Store(), events: new EventLog(), messaging: {} as any, calendar: {} as any, now: () => new Date(), publicBaseUrl: "http://x" },
      tenants: loadTenantsFromDir("test-data/tenants"), toolSecret: "test-secret-1234567890", logger: false, publicDashboard,
    });
    const fromInternet = { url: "/login", headers: { "x-forwarded-for": "203.0.113.9" } };
    expect((await mk(false).inject(fromInternet)).statusCode).toBe(403);
    expect((await mk(true).inject(fromInternet)).statusCode).toBe(200);
    // Still needs a login for the data.
    expect((await mk(true).inject({ url: "/api/tenants", headers: { "x-forwarded-for": "203.0.113.9" } })).statusCode).toBe(401);
  });
});
