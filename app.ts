import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { isInServiceArea, isOpenAt } from "./core/rules/index.js";
import { buildAutomaticPrompt, buildReceptionistPrompt } from "./modules/voice-receptionist/prompt-builder.js";
import Fastify, { type FastifyRequest } from "fastify";
import type { TenantConfig } from "./core/tenant-config/schema.js";
import * as actions from "./modules/voice-receptionist/actions.js";
import type { Deps } from "./modules/voice-receptionist/actions.js";
import { LiveCalls } from "./modules/voice-receptionist/live-calls.js";
import { parseTenant } from "./core/tenant-config/loader.js";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { deleteTenantConfig, saveTenantConfig, type Sql } from "./core/db/postgres.js";
import { readAsset } from "./core/assets.js";
import { brainKind } from "./modules/voice-receptionist/claude-code-brain.js";
import { join } from "node:path";
import { buildBlandTestCall, buildBlandWebAgent, pickerVoices, type BlandClient } from "./integrations/voice/bland.js";
import type { QuickTunnel } from "./integrations/tunnel.js";
import { Auth, normEmail, passwordProblem, validEmail, type User } from "./core/auth/index.js";

function safeEqual(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

type Body = Record<string, unknown>;
type Req = FastifyRequest<{ Params: { tenantId: string }; Body: Body; Querystring: { token?: string } }>;

/** Builds the HTTP server. Kept separate from startup so tests can call it directly. */
export function buildApp(opts: { deps: Deps; tenants: Map<string, TenantConfig>; toolSecret: string; logger?: boolean; tenantsDir?: string; tenantDb?: Sql; liveSync?: { beforeRequest(): Promise<void>; afterRequest(): Promise<void> }; requireAuth?: boolean; bland?: BlandClient; tunnel?: QuickTunnel }) {
  const { deps, tenants, toolSecret } = opts;
  const requireAuth = opts.requireAuth !== false;
  const auth = new Auth(deps.store, deps.now);
  if (!toolSecret || toolSecret.length < 16) throw new Error("TOOL_SECRET must be set (16+ chars)");
  const live = new LiveCalls(deps, (id) => tenants.get(id));

  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : {
            level: "info",
            // Never print the secret (it can appear in the webhook URL).
            serializers: { req: (r) => ({ method: r.method, url: String(r.url).replace(/token=[^&]+/, "token=[hidden]") }) },
          },
  });

  // Hosts like Vercel: load changes saved by other copies of the app before each request,
  // and finish saving before each reply (the copy may be paused right after it).
  const sync = opts.liveSync;
  if (sync) {
    const open = new WeakSet<object>();
    app.addHook("onRequest", async (req) => { open.add(req); await sync.beforeRequest(); });
    app.addHook("onSend", async (req, _reply, payload) => {
      if (open.delete(req)) await sync.afterRequest();
      return payload;
    });
    app.addHook("onResponse", async (req) => { if (open.delete(req)) await sync.afterRequest(); });
  }

  /** Find the business, and reject callers that don't know the secret. */
  function guard(req: Req, secret: string | undefined): TenantConfig | { error: string; code: number } {
    if (!safeEqual(secret, toolSecret)) return { error: "unauthorized", code: 401 };
    const tenant = tenants.get(req.params.tenantId);
    if (!tenant) return { error: "unknown business", code: 404 };
    return tenant;
  }

  app.get("/health", async () => ({ ok: true, businesses: tenants.size }));

  const toolRoutes: Record<string, (t: TenantConfig, b: Body) => unknown> = {
    "check-service-area": (t, b) => actions.checkServiceArea(deps, t, b),
    "available-slots": (t, b) => actions.getAvailableSlots(deps, t, b),
    book: (t, b) => actions.bookAppointment(deps, t, b),
    callback: (t, b) => actions.createCallback(deps, t, b),
    emergency: (t, b) => actions.emergencyAlert(deps, t, b),
  };

  for (const [path, handler] of Object.entries(toolRoutes)) {
    app.post(`/tools/:tenantId/${path}`, async (req: Req, reply) => {
      const tenant = guard(req, req.headers["x-tool-secret"] as string | undefined);
      if ("error" in tenant) return reply.code(tenant.code).send({ ok: false, message: tenant.error });
      return handler(tenant, req.body ?? {});
    });
  }

  // Bland calls this when a call ends.
  app.post("/webhooks/bland/:tenantId/call-ended", async (req: Req, reply) => {
    const tenant = guard(req, req.query.token);
    if ("error" in tenant) return reply.code(tenant.code).send({ ok: false });
    let body = req.body ?? {};
    // Test call: Bland called the owner, so "to" is the person who talked to the AI.
    const meta = (body.metadata ?? {}) as { test_call?: unknown; web_call?: unknown };
    if (meta.test_call === "true" || meta.test_call === true) body = { ...body, from: body.to, to: body.from };
    const record = await actions.handleCallEnded(deps, tenant, body);
    // Browser test call: there is no phone number, so it isn't spam; it's the owner testing.
    if ((meta.web_call === "true" || meta.web_call === true) && record.outcome === "spam") {
      record.outcome = "conversation";
      record.from = "Browser test call";
    }
    // Every call Bland reports was answered by Bland's AI (it picks up right away).
    if (record.outcome === "conversation") record.handledBy ??= "ai";
    deps.store.persist();
    return { ok: true, outcome: record.outcome };
  });

  // ---------- Bland test call: Bland's AI calls the owner's phone (dashboard, logged in) ----------
  const bland = opts.bland;
  const tunnel = opts.tunnel;
  const blandError = (err: unknown) => {
    const s = String(err);
    if (/INTL_NEEDS_CREDITS|International calls need|outside the US and Canada/i.test(s))
      return "Bland only calls numbers outside the US and Canada after you buy at least $5 of credit (Bland dashboard → Billing). Free credit works for US/Canada numbers.";
    if (/Insufficient balance|\b402\b/i.test(s)) return "Your Bland credit has run out. Add credit in the Bland dashboard → Billing.";
    if (/Invalid phone number/i.test(s)) return "Bland says the phone number is not valid. Use the full number with country code, like +923001234567.";
    if (/\b401\b|unauthori[sz]ed/i.test(s)) return "Bland rejected the API key. Check BLAND_API_KEY in the .env file.";
    if (/International rate limit|\b429\b/i.test(s)) return "Bland's call limit for your account was reached. Wait a bit and try again.";
    if (/fetch failed|ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|network/i.test(s)) return "Couldn't reach Bland. Check your internet connection and try again.";
    return `Bland error: ${s.replace(/^Error:\s*/, "").slice(0, 300)}`;
  };

  // Voices for the voice picker (Bland charges nothing to list them). Kept for an hour.
  let voiceCache: { at: number; voices: ReturnType<typeof pickerVoices> } | null = null;
  app.get("/api/bland/voices", async (_req, reply) => {
    if (!bland) return { ok: false, errors: ["Bland is not set up. Add BLAND_API_KEY to the .env file and restart."] };
    if (!voiceCache || Date.now() - voiceCache.at > 60 * 60_000) {
      const load = async () => ({ at: Date.now(), voices: pickerVoices((await bland.listVoices()).voices ?? []) });
      try { voiceCache = await load(); }
      catch {
        // A short internet drop is common: wait a moment and try once more before showing an error.
        await new Promise((r) => setTimeout(r, 1500));
        try { voiceCache = await load(); }
        catch (err) { return reply.code(502).send({ ok: false, errors: [blandError(err)] }); }
      }
    }
    return { ok: true, voices: voiceCache.voices };
  });

  // Play a voice sample. Bland charges about $0.001-0.004 per new sample, so each one is made once and saved.
  const SAMPLE_TEXT = "Hi, thanks for calling. I'm the automated assistant. How can I help you today?";
  const sampleDir = join(process.env.DATA_DIR || "data", "voice-samples");
  app.get("/api/bland/voices/:voiceId/sample", async (req: FastifyRequest<{ Params: { voiceId: string } }>, reply) => {
    const id = req.params.voiceId;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.code(400).send({ ok: false, errors: ["Unknown voice."] });
    const file = join(sampleDir, `${id}.wav`);
    if (!existsSync(file)) {
      if (!bland) return reply.code(400).send({ ok: false, errors: ["Bland is not set up."] });
      try {
        const { wav, cost } = await bland.speakSample(id, SAMPLE_TEXT);
        mkdirSync(sampleDir, { recursive: true });
        writeFileSync(file, wav);
        deps.events.log("system", "bland.voice_sample", "user", { voiceId: id, cost });
      } catch (err) {
        const s = String(err);
        const msg = /unsupported_voice|voice_not_live|voice_not_found|\b(400|403|404)\b/.test(s) ? "Bland can't play a sample of this voice. Pick it, save, and try it with Real test call (Bland)." : blandError(err);
        return reply.code(502).send({ ok: false, errors: [msg] });
      }
    }
    return reply.type("audio/wav").header("cache-control", "private, max-age=86400").send(readFileSync(file));
  });

  app.get("/api/bland/status", async () => {
    if (!bland) return { configured: false };
    let balance: number | undefined;
    try { balance = ((await bland.me()) as { billing?: { current_balance?: number } }).billing?.current_balance; } catch { /* offline */ }
    return { configured: true, balance, tunnelUrl: tunnel?.url ?? null, canTunnel: Boolean(tunnel?.available()) || /^https:\/\//.test(deps.publicBaseUrl ?? "") };
  });

  app.post("/api/bland/:tenantId/test-call", async (req: Req) => {
    const t = tenants.get(req.params.tenantId);
    if (!t) return { ok: false, errors: ["Unknown business."] };
    if (!bland) return { ok: false, errors: ["Bland is not set up. Add BLAND_API_KEY to the .env file and restart."] };
    const raw = String(req.body?.phone ?? "").trim();
    const digits = raw.replace(/\D/g, "");
    if (!raw.startsWith("+") || digits.length < 8 || digits.length > 15) return { ok: false, errors: ["Enter your full mobile number with country code, like +923001234567 or +17135550199."] };
    const phone = "+" + digits;
    let base = /^https:\/\//.test(deps.publicBaseUrl ?? "") ? deps.publicBaseUrl! : "";
    if (!base) {
      if (!tunnel?.available()) return { ok: false, errors: ["Bland can't reach this computer. Install the free Cloudflare tunnel (cloudflared) or set PUBLIC_BASE_URL."] };
      try { base = await tunnel.start(); } catch (err) { return { ok: false, errors: [String(err).replace(/^Error:\s*/, "")] }; }
    }
    try {
      const res = await bland.sendCall(buildBlandTestCall(t, base, toolSecret, phone));
      if (res.status !== "success" || !res.call_id) return { ok: false, errors: [blandError(res.message ?? JSON.stringify(res.errors ?? res))] };
      deps.events.log(t.tenantId, "bland.test_call", "user", { callId: res.call_id, to: phone });
      return { ok: true, callId: res.call_id, publicUrl: base };
    } catch (err) {
      return { ok: false, errors: [blandError(err)] };
    }
  });

  // Talk to Bland's AI from the browser (free for testing: no international phone call).
  app.post("/api/bland/:tenantId/web-call", async (req: Req) => {
    const t = tenants.get(req.params.tenantId);
    if (!t) return { ok: false, errors: ["Unknown business."] };
    if (!bland) return { ok: false, errors: ["Bland is not set up. Add BLAND_API_KEY to the .env file and restart."] };
    let base = /^https:\/\//.test(deps.publicBaseUrl ?? "") ? deps.publicBaseUrl! : "";
    if (!base) {
      if (!tunnel?.available()) return { ok: false, errors: ["Bland can't reach this computer. Install the free Cloudflare tunnel (cloudflared) or set PUBLIC_BASE_URL."] };
      try { base = await tunnel.start(); } catch (err) { return { ok: false, errors: [String(err).replace(/^Error:\s*/, "")] }; }
    }
    const config = buildBlandWebAgent(t, base, toolSecret);
    const list = (deps.store.data.blandAgents ??= []);
    let saved = list.find((a) => a.tenantId === t.tenantId);
    try {
      // Reuse this business's agent and refresh it with the latest training (and today's tunnel link).
      if (saved) {
        try { await bland.updateAgent(saved.agentId, config); }
        catch (err) { if (!/\b(400|404)\b/.test(String(err))) throw err; list.splice(list.indexOf(saved), 1); saved = undefined; } // deleted in Bland: make a new one
      }
      if (!saved) {
        const res = await bland.createAgent(config);
        const agentId = res.agent?.agent_id ?? res.agent_id;
        if (!agentId) return { ok: false, errors: [blandError(res.message ?? JSON.stringify(res))] };
        saved = { tenantId: t.tenantId, agentId, updatedAt: "" };
        list.push(saved);
      }
      saved.updatedAt = deps.now().toISOString();
      deps.store.persist();
      const auth = await bland.authorizeAgent(saved.agentId);
      if (!auth.token) return { ok: false, errors: [blandError(auth.message ?? JSON.stringify(auth))] };
      deps.events.log(t.tenantId, "bland.web_call", "user", { agentId: saved.agentId });
      return { ok: true, agentId: saved.agentId, token: auth.token };
    } catch (err) {
      return { ok: false, errors: [blandError(err)] };
    }
  });

  app.get("/api/bland/:tenantId/test-call/:callId", async (req: Req) => {
    if (!bland) return { ok: false };
    try {
      const c = await bland.getCall(String((req.params as { callId?: string }).callId));
      return { ok: true, status: c.status ?? null, queueStatus: c.queue_status ?? null, completed: Boolean(c.completed), error: c.error_message ?? null, summary: c.summary ?? null, minutes: c.call_length ?? null, price: c.price ?? null };
    } catch (err) {
      return { ok: false, errors: [blandError(err)] };
    }
  });

  // For business phone systems that can report a missed call (caller hung up before anyone answered).
  app.post("/missed-call/:tenantId", async (req: Req, reply) => {
    const tenant = guard(req, (req.headers["x-tool-secret"] as string | undefined) ?? req.query.token);
    if ("error" in tenant) return reply.code(tenant.code).send({ ok: false });
    return actions.sendTextBack(deps, tenant, req.body?.from);
  });

  // Replies to our texts (STOP / customer questions).
  app.post("/sms/:tenantId/inbound", async (req: Req, reply) => {
    const tenant = guard(req, (req.headers["x-tool-secret"] as string | undefined) ?? req.query.token);
    if ("error" in tenant) return reply.code(tenant.code).send({ ok: false });
    const b = req.body ?? {};
    return actions.handleInboundSms(deps, tenant, { from: b.from ?? b.user_number, body: b.body ?? b.message });
  });

  // ---------- Local dashboard (only from this computer, never through ngrok/internet) ----------

  function isLocal(req: FastifyRequest): boolean {
    const forwarded = req.headers["x-forwarded-for"] || req.headers["x-forwarded-host"];
    return !forwarded && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.ip);
  }

  const AUTH_PAGES = ["/login", "/register", "/forgot", "/reset", "/admin"];
  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0];
    if ((path === "/" || path === "/phone" || AUTH_PAGES.includes(path) || path.startsWith("/api/")) && !isLocal(req)) {
      return reply.code(403).send({ ok: false, message: "Dashboard is only available on the local computer." });
    }
  });

  // ---------- Accounts: who is logged in, and what they may see ----------

  const COOKIE = "sid";
  const ADMIN_ALL = { id: "no-auth", email: "", name: "Test", role: "admin" } as unknown as User; // only when requireAuth=false (tests)
  const tokenOf = (req: FastifyRequest) => (String(req.headers.cookie ?? "").match(/(?:^|;\s*)sid=([a-f0-9]{64})/) ?? [])[1];
  const userOf = (req: FastifyRequest): User | null => (requireAuth ? auth.userForToken(tokenOf(req)) : ADMIN_ALL);
  type CookieReply = { header: (k: string, v: string) => unknown };
  const setCookie = (reply: CookieReply, token: string, maxAge = 7 * 86400) =>
    reply.header("set-cookie", `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`);

  // Routes the login pages and the phone simulator (the "customer") use. No owner login needed.
  const PUBLIC_API = new Set([
    "/api/auth/login", "/api/auth/register", "/api/auth/forgot", "/api/auth/reset", "/api/auth/demo", "/api/auth/logout", "/api/auth/me",
    "/api/phone/businesses", "/api/phone/inbox", "/api/phone/reply", "/api/ai-status", "/api/live/:tenantId/start", "/api/live/:tenantId/:id/caller-say",
    "/api/phone/incoming", "/api/live/:tenantId/:id/pickup",
  ]);
  const ADMIN_ONLY = new Set(["POST /api/tenants", "DELETE /api/tenants/:tenantId"]);

  app.addHook("preHandler", async (req, reply) => {
    const route = req.routeOptions.url ?? "";
    if (!route.startsWith("/api/") || PUBLIC_API.has(route)) return;
    // The phone polls its own call and can hang up as the caller.
    if (req.method === "GET" && route === "/api/live/:tenantId/:id") return;
    if (route === "/api/live/:tenantId/:id/hangup" && (req.body as Body | undefined)?.by !== "staff") return;
    const user = userOf(req);
    if (!user) return reply.code(401).send({ ok: false, errors: ["Please log in."] });
    if (ADMIN_ONLY.has(`${req.method} ${route}`) && user.role !== "admin") return reply.code(403).send({ ok: false, errors: ["Only an admin can do this."] });
    const tid = (req.params as { tenantId?: string }).tenantId;
    if (tid && !auth.canAccess(user, tid)) return reply.code(403).send({ ok: false, errors: ["You don't have access to this business."] });
  });
  const visible = (req: FastifyRequest) => {
    const u = userOf(req);
    return [...tenants.values()].filter((t) => u && auth.canAccess(u, t.tenantId));
  };

  const page = (name: string) => readAsset(`web/${name}`);
  app.get("/", async (req, reply) => {
    if (!userOf(req)) return reply.redirect("/login");
    return reply.type("text/html").header("cache-control", "no-store").send(page("dashboard.html")); // always load the newest version
  });
  for (const p of AUTH_PAGES) {
    app.get(p, async (req, reply) => {
      if (p !== "/reset" && requireAuth && userOf(req)) return reply.redirect("/");
      return reply.type("text/html").send(page("auth.html"));
    });
  }

  const tries = new Map<string, number[]>();
  const tooManyAuth = (ip: string) => {
    const now = Date.now();
    const recent = (tries.get(ip) ?? []).filter((t) => now - t < 10 * 60_000);
    recent.push(now);
    tries.set(ip, recent);
    return recent.length > 20;
  };
  const sessionReply = (reply: CookieReply, user: User) => {
    setCookie(reply, auth.startSession(user));
    return { ok: true, user: auth.publicUser(user) };
  };
  const slow = { ok: false, errors: ["Too many attempts. Please wait a few minutes."] };

  app.post("/api/auth/login", async (req: FastifyRequest<{ Body: Body }>, reply) => {
    if (tooManyAuth(req.ip)) return reply.code(429).send(slow);
    const b = req.body ?? {};
    const user = auth.login(String(b.email ?? ""), String(b.password ?? ""));
    if (!user) return reply.code(401).send({ ok: false, errors: ["Wrong email or password."] });
    if (b.admin === true && user.role !== "admin") return reply.code(403).send({ ok: false, errors: ["This account is not an admin. Use the normal login."] });
    deps.events.log(user.tenantId ?? "admin", "auth.login", "user", { email: user.email });
    return sessionReply(reply, user);
  });

  app.post("/api/auth/demo", async (_req, reply) => {
    const demo = deps.store.data.users.find((u) => u.demo);
    if (!demo) return reply.code(404).send({ ok: false, errors: ["The demo account is not set up."] });
    return sessionReply(reply, demo);
  });

  app.post("/api/auth/logout", async (req, reply) => {
    auth.endSession(tokenOf(req));
    setCookie(reply, "", 0);
    return { ok: true };
  });

  app.get("/api/auth/me", async (req, reply) => {
    const u = requireAuth ? auth.userForToken(tokenOf(req)) : ADMIN_ALL;
    if (!u) return reply.code(401).send({ ok: false });
    return { ok: true, user: auth.publicUser(u) };
  });

  app.post("/api/auth/register", async (req: FastifyRequest<{ Body: Body }>, reply) => {
    if (tooManyAuth(req.ip)) return reply.code(429).send(slow);
    const b = req.body ?? {};
    const email = normEmail(b.email);
    const name = String(b.name ?? "").trim();
    const errors: string[] = [];
    if (name.length < 2) errors.push("Please enter your name.");
    if (!validEmail(email)) errors.push("Please enter a valid email.");
    const pw = passwordProblem(b.password);
    if (pw) errors.push(pw);
    if (validEmail(email) && auth.findByEmail(email)) errors.push("An account with this email already exists. Try logging in.");
    if (errors.length) return reply.code(400).send({ ok: false, errors });
    const created = await createBusiness({ ...b, alertTo: b.alertTo || email });
    if ("errors" in created) return reply.code(400).send({ ok: false, errors: created.errors });
    const user = auth.createUser({ email, name, password: String(b.password), role: "owner", tenantId: created.tenant.tenantId });
    deps.events.log(created.tenant.tenantId, "auth.registered", "user", { email });
    return sessionReply(reply, user);
  });

  // Forgot password. We never say whether the email exists.
  app.post("/api/auth/forgot", async (req: FastifyRequest<{ Body: Body }>, reply) => {
    if (tooManyAuth(req.ip)) return reply.code(429).send(slow);
    const email = normEmail(req.body?.email);
    if (!validEmail(email)) return reply.code(400).send({ ok: false, errors: ["Please enter a valid email."] });
    const token = auth.startReset(email);
    const link = token ? `http://${req.headers.host ?? "127.0.0.1"}/reset?token=${token}` : undefined;
    if (link) {
      const u = auth.findByEmail(email)!;
      // No email provider yet: the email is logged, and in test mode the link is also shown on screen.
      deps.events.log(u.tenantId ?? "admin", "email.simulated", "system", { to: email, subject: "Reset your password", body: "Reset link sent (valid 60 minutes)." });
    }
    const testMode = process.env.GLOBAL_TEST_MODE !== "false";
    return { ok: true, message: "If an account exists for this email, we've sent a reset link.", ...(testMode && link ? { testLink: link } : {}) };
  });

  app.post("/api/auth/reset", async (req: FastifyRequest<{ Body: Body }>, reply) => {
    const pw = passwordProblem(req.body?.password);
    if (pw) return reply.code(400).send({ ok: false, errors: [pw] });
    const user = auth.finishReset(String(req.body?.token ?? ""), String(req.body?.password));
    if (!user) return reply.code(400).send({ ok: false, errors: ["This reset link is invalid or has expired. Please request a new one."] });
    return sessionReply(reply, user);
  });

  // Minimal business list for the phone simulator (no private settings).
  app.get("/api/phone/businesses", async () =>
    [...tenants.values()].map((t) => ({
      tenantId: t.tenantId, businessName: t.businessName, industry: t.industry,
      voice: { ringSeconds: t.voice.ringSeconds }, services: t.services.map((s) => ({ name: s.name })), emergency: { keywords: t.emergency.keywords },
    })),
  );

  app.get("/api/tenants", async (req) => visible(req));
  app.get("/api/ai-status", async () => ({ brain: brainKind() }));

  app.get("/api/dashboard/:tenantId", async (req: Req, reply) => {
    const tenant = tenants.get(req.params.tenantId);
    if (!tenant) return reply.code(404).send({ ok: false });
    const mine = <T extends { tenantId: string }>(rows: T[]) => rows.filter((r) => r.tenantId === tenant.tenantId).reverse();
    return {
      testMode: deps.messaging.isTestMode(tenant),
      isOpenNow: isOpenAt(tenant, deps.now()),
      bookings: mine(deps.store.data.bookings),
      callbacks: mine(deps.store.data.callbacks),
      calls: mine(deps.store.data.calls).map((c) => (c.callerName ? c : { ...c, callerName: nameFor(tenant.tenantId, c.from) })),
      events: [...deps.events.list(tenant.tenantId)].reverse(),
      script: buildReceptionistPrompt(tenant),
      bookingLink: actions.bookingLink(deps, tenant),
      aiBrain: brainKind(),
    };
  });

  // "Try it" buttons: run the same actions Bland would call, plus a simulated hang-up.
  app.post("/api/try/:tenantId/:action", async (req: FastifyRequest<{ Params: { tenantId: string; action: string }; Body: Body }>, reply) => {
    const tenant = tenants.get(req.params.tenantId);
    if (!tenant) return reply.code(404).send({ ok: false, message: "unknown business" });
    const body = req.body ?? {};
    if (req.params.action === "hang-up") {
      const rec = await actions.handleCallEnded(deps, tenant, { call_id: `sim-${Date.now()}`, from: String(body.from ?? ""), call_length: 0.1, transcripts: [] });
      const texted = deps.events.list(tenant.tenantId).some((e) => e.type === "text_back.processed" && e.payload.phone === rec.from && e.at >= rec.createdAt);
      return { ok: true, message: texted ? "Caller hung up → 'Sorry we missed your call' text sent (simulated, see Activity log)." : "Caller hung up → no text (already texted in last 24h, opted out, or text-back disabled)." };
    }
    const handler = toolRoutes[req.params.action];
    if (!handler) return reply.code(404).send({ ok: false, message: "unknown action" });
    return handler(tenant, body);
  });

  // ---------- Customer details: everything we know about one phone number ----------

  type CustReq = FastifyRequest<{ Params: { tenantId: string; id: string }; Querystring: { phone?: string }; Body: Body }>;
  const nameFor = (tenantId: string, phone?: string) => {
    if (!phone) return undefined;
    const d = deps.store.data;
    return d.bookings.find((b) => b.tenantId === tenantId && b.customerPhone === phone)?.customerName
      ?? d.callbacks.find((c) => c.tenantId === tenantId && c.callerPhone === phone && c.callerName)?.callerName
      ?? d.calls.find((c) => c.tenantId === tenantId && c.from === phone && c.callerName)?.callerName;
  };

  app.get("/api/customer/:tenantId", async (req: CustReq, reply) => {
    const t = tenants.get(req.params.tenantId);
    const phone = actions.normalizePhone(req.query.phone);
    if (!t || !phone) return reply.code(400).send({ ok: false, errors: ["Missing phone number"] });
    const d = deps.store.data, tid = t.tenantId;
    const bookings = d.bookings.filter((b) => b.tenantId === tid && b.customerPhone === phone);
    const calls = d.calls.filter((c) => c.tenantId === tid && c.from === phone);
    const callbacks = d.callbacks.filter((c) => c.tenantId === tid && c.callerPhone === phone);
    const messages = d.messages.filter((m) => m.tenantId === tid && m.phone === phone).sort((a, b) => a.at.localeCompare(b.at));
    const svc = (id: string) => t.services.find((s) => s.id === id)?.name ?? id;

    // Timeline: every step that happened with this customer, oldest first.
    type Step = { at: string; kind: string; title: string; detail?: string };
    const steps: Step[] = [];
    const OUT: Record<string, string> = { conversation: "Call answered", hang_up: "Missed call (hung up)", spam: "Blocked call" };
    for (const c of calls) {
      const start = new Date(Date.parse(c.createdAt) - c.lengthMinutes * 60_000).toISOString();
      if (c.direction === "out") { steps.push({ at: start, kind: "call", title: c.outcome === "no_answer" ? "Your team called. No answer" : "Your team called the customer", detail: c.summary }); continue; }
      steps.push({ at: start, kind: "call", title: c.outcome === "hang_up" ? "Called, hung up before anyone answered" : `${OUT[c.outcome]} by ${c.handledBy === "staff" ? "your team" : "the AI"}`, detail: c.summary });
    }
    for (const b of bookings) {
      steps.push({ at: b.createdAt, kind: "booking", title: `Booked ${svc(b.serviceId)} ${b.source === "web" ? "online" : "on the phone"}`, detail: `For ${new Date(b.start).toLocaleString("en-US", { timeZone: t.timezone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` });
      if (b.seenAt) steps.push({ at: b.seenAt, kind: "seen", title: "Owner saw the booking" });
    }
    for (const c of callbacks) {
      steps.push({ at: c.createdAt, kind: c.urgent ? "urgent" : "callback", title: `Callback requested${c.urgent ? " (urgent)" : ""}`, detail: c.reason });
    }
    for (const m of messages) {
      steps.push({ at: m.at, kind: m.direction === "in" ? "msg_in" : "msg_out", title: m.direction === "in" ? "Customer texted" : m.kind === "staff_message" ? `Text sent by ${m.by ?? "your team"}` : m.kind === "missed_call_text_back" ? "Missed-call text sent" : m.kind === "booking_confirmation" ? "Booking confirmation text sent" : "Text sent", detail: m.body });
    }
    for (const e of deps.events.list(tid)) {
      const p = e.payload as Record<string, unknown>;
      if (e.type === "callback.completed" && callbacks.some((c) => c.id === p.callbackId)) steps.push({ at: e.at, kind: "done", title: "Callback marked done" });
      if (e.type === "callback.priority" && callbacks.some((c) => c.id === p.callbackId)) steps.push({ at: e.at, kind: "priority", title: `Priority changed to ${p.urgent ? "urgent" : "normal"}` });
      if (e.type === "callback.called" && callbacks.some((c) => c.id === p.callbackId)) steps.push({ at: e.at, kind: "call_out", title: "Team called the customer back" });
    }
    steps.sort((a, b) => a.at.localeCompare(b.at));
    return { ok: true, phone, name: nameFor(tid, phone) ?? null, bookings, calls, callbacks, messages, timeline: steps };
  });

  // Owner sends a text to a customer (simulated in test mode). It shows on the simulator phone too.
  app.post("/api/messages/:tenantId", async (req: CustReq, reply) => {
    const t = tenants.get(req.params.tenantId)!;
    const phone = actions.normalizePhone(req.body?.phone);
    const body = String(req.body?.body ?? "").trim().slice(0, 600);
    if (!phone || !body) return reply.code(400).send({ ok: false, errors: ["Write a message first."] });
    const by = userOf(req)?.name || "Team";
    const r = await deps.messaging.sms(t, phone, body, "staff_message", by);
    if (r === "blocked_opt_out") return reply.code(400).send({ ok: false, errors: ["This customer replied STOP, so we can't text them."] });
    return { ok: true, result: r };
  });

  app.post("/api/callbacks/:tenantId/:id/priority", async (req: CustReq, reply) => {
    const c = deps.store.data.callbacks.find((x) => x.tenantId === req.params.tenantId && x.id === req.params.id);
    if (!c) return reply.code(404).send({ ok: false });
    c.urgent = req.body?.urgent === true;
    deps.store.persist();
    deps.events.log(c.tenantId, "callback.priority", "user", { callbackId: c.id, urgent: c.urgent });
    return { ok: true };
  });

  app.post("/api/callbacks/:tenantId/:id/called", async (req: CustReq, reply) => {
    const c = deps.store.data.callbacks.find((x) => x.tenantId === req.params.tenantId && x.id === req.params.id);
    if (!c) return reply.code(404).send({ ok: false });
    deps.events.log(c.tenantId, "callback.called", "user", { callbackId: c.id });
    return { ok: true };
  });

  // ---------- Simulator phone inbox: texts sent to "my number", and replies ----------
  // The test phone stands in for every customer, so with ?all=1 it gets the texts of all
  // businesses that are in test mode (nothing real is sent in test mode).
  const testTenant = (id: string) => { const t = tenants.get(id); return t && deps.messaging.isTestMode(t) ? t : undefined; };
  app.get("/api/phone/inbox", async (req: FastifyRequest<{ Querystring: { phone?: string; all?: string } }>) => {
    const all = req.query.all === "1";
    const phone = actions.normalizePhone(req.query.phone);
    if (!all && !phone) return [];
    return deps.store.data.messages
      .filter((m) => (all ? testTenant(m.tenantId) : m.phone === phone && tenants.has(m.tenantId)))
      .map((m) => ({ ...m, businessName: tenants.get(m.tenantId)!.businessName, customerName: nameFor(m.tenantId, m.phone) }));
  });
  app.post("/api/phone/reply", async (req: FastifyRequest<{ Body: Body }>, reply) => {
    const t = tenants.get(String(req.body?.tenantId ?? ""));
    if (!t) return reply.code(404).send({ ok: false });
    return actions.handleInboundSms(deps, t, { from: req.body?.phone, body: String(req.body?.body ?? "").slice(0, 600) });
  });

  app.post("/api/callbacks/:tenantId/:id/done", async (req: FastifyRequest<{ Params: { tenantId: string; id: string } }>, reply) => {
    const task = deps.store.data.callbacks.find((c) => c.tenantId === req.params.tenantId && c.id === req.params.id);
    if (!task) return reply.code(404).send({ ok: false });
    task.status = "done";
    deps.store.persist();
    deps.events.log(task.tenantId, "callback.completed", "user", { callbackId: task.id });
    return { ok: true };
  });

  // ---------- New bookings: "mark as seen" ----------

  app.post("/api/bookings/:tenantId/:id/seen", async (req: FastifyRequest<{ Params: { tenantId: string; id: string } }>, reply) => {
    const ids = req.params.id === "all"
      ? deps.store.data.bookings.filter((b) => b.tenantId === req.params.tenantId && !b.seenAt).map((b) => b.id)
      : [req.params.id];
    let n = 0;
    for (const b of deps.store.data.bookings) {
      if (b.tenantId === req.params.tenantId && ids.includes(b.id) && !b.seenAt) { b.seenAt = deps.now().toISOString(); n++; }
    }
    if (!n && req.params.id !== "all") return reply.code(404).send({ ok: false });
    deps.store.persist();
    deps.events.log(req.params.tenantId, "booking.seen", "user", { count: n, bookingIds: ids });
    return { ok: true, count: n };
  });

  // ---------- AI training: edit / create businesses ----------

  /** Save a business's settings: to Postgres when live, otherwise to its JSON file. */
  async function saveTenant(t: TenantConfig) {
    if (opts.tenantDb) await saveTenantConfig(opts.tenantDb, t);
    else if (opts.tenantsDir) writeFileSync(join(opts.tenantsDir, `${t.tenantId}.json`), JSON.stringify(t, null, 2));
    tenants.set(t.tenantId, t);
  }
  const friendly = (err: unknown) =>
    String((err as Error).message).replace(/^Invalid tenant config in [^:]+:\n/, "").split("\n").map((l) => l.replace(/^\s*-\s*/, "")).filter(Boolean);

  app.put("/api/tenants/:tenantId", async (req: Req, reply) => {
    if (!tenants.has(req.params.tenantId)) return reply.code(404).send({ ok: false, errors: ["Business not found"] });
    try {
      const t = parseTenant({ ...(req.body ?? {}), tenantId: req.params.tenantId }, "your changes");
      await saveTenant(t);
      deps.events.log(t.tenantId, "training.updated", "user", {});
      return { ok: true, tenant: t };
    } catch (err) {
      return reply.code(400).send({ ok: false, errors: friendly(err) });
    }
  });

  app.post("/api/tenants", async (req: FastifyRequest<{ Body: Body }>, reply) => {
    const r = await createBusiness(req.body ?? {});
    return "errors" in r ? reply.code(400).send({ ok: false, errors: r.errors }) : { ok: true, tenant: r.tenant };
  });

  /** Create a new business with sensible defaults (used by admins and by owner sign-up). */
  async function createBusiness(b: Body): Promise<{ tenant: TenantConfig } | { errors: string[] }> {
    const name = String(b.businessName ?? "").trim();
    const industry = String(b.industry ?? "").trim() || "business";
    const alert = String(b.alertTo ?? "").trim();
    const zips = String(b.zipCodes ?? "").match(/\d{5}/g) ?? [];
    const errors: string[] = [];
    if (name.length < 2) errors.push("Please enter the business name.");
    if (!alert) errors.push("Please enter a phone number or email for alerts.");
    if (!zips.length) errors.push("Please enter at least one ZIP code you serve.");
    if (errors.length) return { errors };
    let id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "business";
    for (let i = 2; tenants.has(id); i++) id = `${id.replace(/-\d+$/, "")}-${i}`;
    const phone = actions.normalizePhone(alert);
    const weekday = [{ open: "09:00", close: "17:00" }];
    try {
      const t = parseTenant({
        tenantId: id, businessName: name, industry, timezone: String(b.timezone || "America/Chicago"), testMode: true,
        hours: { mon: weekday, tue: weekday, wed: weekday, thu: weekday, fri: weekday },
        serviceArea: { zipCodes: zips },
        services: [{ id: "consultation", name: "Consultation", appointmentMinutes: 30 }],
        emergency: { keywords: [], action: "transfer", onCallNumbers: phone ? [phone] : [] },
        qualifyingQuestions: [{ field: "zip_code", question: "What ZIP code are you in?", required: true }],
        knowledgeBase: [],
        approvedPrices: [],
        booking: { calendarProvider: "none" },
        escalationContacts: [{ name: "Owner", channel: phone ? "sms" : "email", to: phone ?? alert }],
        voice: { greeting: `Thanks for calling ${name}. I'm the automated assistant.` },
        recording: {},
        textBack: { message: "Sorry we missed your call! This is {businessName}. Book here: {bookingLink} or just reply to this text." },
      }, "new business");
      await saveTenant(t);
      deps.events.log(t.tenantId, "business.created", "user", { name });
      return { tenant: t };
    } catch (err) {
      return { errors: friendly(err) };
    }
  }

  // All businesses with their numbers, for the Businesses page (owners only see their own).
  app.get("/api/businesses", async (req) =>
    visible(req).map((t) => {
      const mine = <T extends { tenantId: string }>(rows: T[]) => rows.filter((r) => r.tenantId === t.tenantId);
      return {
        tenant: t,
        calls: mine(deps.store.data.calls).length,
        bookings: mine(deps.store.data.bookings).length,
        newBookings: mine(deps.store.data.bookings).filter((b) => !b.seenAt).length,
        openCallbacks: mine(deps.store.data.callbacks).filter((c) => c.status === "open").length,
        bookingLink: actions.bookingLink(deps, t),
      };
    }),
  );

  // Remove a business. Its settings are kept (marked deleted in Postgres, or "<id>.json.deleted") so it can be restored.
  app.delete("/api/tenants/:tenantId", async (req: Req, reply) => {
    const id = req.params.tenantId;
    if (!tenants.has(id)) return reply.code(404).send({ ok: false, errors: ["Business not found"] });
    if (tenants.size <= 1) return reply.code(400).send({ ok: false, errors: ["You need at least one business."] });
    if (opts.tenantDb) await deleteTenantConfig(opts.tenantDb, id);
    else if (opts.tenantsDir) {
      const file = join(opts.tenantsDir, `${id}.json`);
      if (existsSync(file)) renameSync(file, `${file}.deleted`);
    }
    tenants.delete(id);
    deps.events.log(id, "business.deleted", "user", {});
    return { ok: true };
  });

  app.get("/api/tenants/:tenantId/script", async (req: Req, reply) => {
    const t = tenants.get(req.params.tenantId);
    if (!t) return reply.code(404).send({ ok: false });
    // script = what the AI follows now; automatic = the version built from the settings (starting point for editing)
    return { script: buildReceptionistPrompt(t), automatic: buildAutomaticPrompt(t), edited: Boolean(t.scriptOverride?.trim()) };
  });

  // ---------- Live calls (phone simulator <-> dashboard) ----------

  type LiveReq = FastifyRequest<{ Params: { tenantId: string; id: string }; Body: Body }>;
  const view = (c: ReturnType<LiveCalls["get"]>) => c && { ...c, secondsLeft: c.status === "ringing" ? Math.max(0, c.ringSeconds - (deps.now().getTime() - Date.parse(c.startedAt)) / 1000) : 0 };

  app.get("/phone", async (_req, reply) => {
    const html = readAsset("web/phone.html");
    return reply.type("text/html").header("cache-control", "no-store").send(html); // always load the newest version
  });
  app.post("/api/live/:tenantId/start", async (req: LiveReq, reply) => {
    const t = tenants.get(req.params.tenantId);
    if (!t) return reply.code(404).send({ ok: false });
    return view(live.start(t, String(req.body?.from ?? "+15550100150")));
  });
  // The owner calls a customer from the dashboard. It rings on the phone simulator.
  app.post("/api/live/:tenantId/call-out", async (req: LiveReq, reply) => {
    const t = tenants.get(req.params.tenantId);
    const phone = actions.normalizePhone(req.body?.phone);
    if (!t || !phone) return reply.code(400).send({ ok: false, errors: ["Missing phone number"] });
    const busy = live.list(t.tenantId).find((c) => c.direction === "out" && c.from === phone && c.status !== "ended");
    if (busy) return view(busy);
    const name = String(req.body?.name ?? "").trim().slice(0, 80) || nameFor(t.tenantId, phone);
    const cbId = String(req.body?.callbackId ?? "");
    if (cbId && deps.store.data.callbacks.some((c) => c.tenantId === t.tenantId && c.id === cbId)) deps.events.log(t.tenantId, "callback.called", "user", { callbackId: cbId });
    return view(live.startOutbound(t, phone, { customerName: name, staffName: userOf(req)?.name }));
  });
  // The phone simulator asks: is a business calling my number right now?
  app.get("/api/phone/incoming", async (req: FastifyRequest<{ Querystring: { phone?: string; all?: string } }>) =>
    (req.query.all === "1" ? live.incomingAll().filter((c) => testTenant(c.tenantId)) : live.incomingFor(String(req.query.phone ?? "")).filter((c) => tenants.has(c.tenantId)))
      .map((c) => ({ ...view(c), businessName: tenants.get(c.tenantId)!.businessName })));
  app.post("/api/live/:tenantId/:id/pickup", async (req: LiveReq, reply) => {
    const c = live.get(req.params.id);
    if (!c || c.tenantId !== req.params.tenantId) return reply.code(404).send({ ok: false });
    return view(live.customerAnswer(c.id));
  });
  app.get("/api/live/:tenantId", async (req: LiveReq) => live.list(req.params.tenantId).map(view));
  app.get("/api/live/:tenantId/:id", async (req: LiveReq, reply) => view(live.get(req.params.id)) ?? reply.code(404).send({ ok: false }));
  app.post("/api/live/:tenantId/:id/answer", async (req: LiveReq) => view(live.staffAnswer(req.params.id)));
  app.post("/api/live/:tenantId/:id/ai", async (req: LiveReq) => view(live.aiAnswer(req.params.id)));
  app.post("/api/live/:tenantId/:id/caller-say", async (req: LiveReq) => view(await live.callerSay(req.params.id, String(req.body?.text ?? ""))));
  app.post("/api/live/:tenantId/:id/staff-say", async (req: LiveReq) => view(live.staffSay(req.params.id, String(req.body?.text ?? ""))));
  app.post("/api/live/:tenantId/:id/hangup", async (req: LiveReq) => view(await live.hangup(req.params.id, req.body?.by === "staff" ? "staff" : "caller")));

  // ---------- Public online booking page (customers) ----------

  const hits = new Map<string, number[]>();
  /** Simple abuse limit: max 30 requests per minute per IP on public routes. */
  function tooMany(ip: string): boolean {
    const now = Date.now();
    const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
    recent.push(now);
    hits.set(ip, recent);
    return recent.length > 30;
  }
  type PubReq = FastifyRequest<{ Params: { tenantId: string }; Querystring: { service?: string }; Body: Body }>;

  app.get("/book/:tenantId", async (req: PubReq, reply) => {
    if (!tenants.has(req.params.tenantId)) return reply.code(404).type("text/html").send("<h1>Business not found</h1>");
    const html = readAsset("web/booking.html");
    return reply.type("text/html").header("cache-control", "no-store").send(html); // always load the newest version
  });

  // Only safe, public info. Never phone numbers, contacts, or settings.
  app.get("/public/:tenantId", async (req: PubReq, reply) => {
    const t = tenants.get(req.params.tenantId);
    if (!t) return reply.code(404).send({ ok: false });
    return {
      businessName: t.businessName,
      industry: t.industry,
      timezone: t.timezone,
      services: t.services.map((s) => ({ id: s.id, name: s.name, minutes: s.appointmentMinutes })),
      approvedPrices: t.approvedPrices,
    };
  });

  app.get("/public/:tenantId/slots", async (req: PubReq, reply) => {
    const t = tenants.get(req.params.tenantId);
    if (!t) return reply.code(404).send({ ok: false });
    if (tooMany(req.ip)) return reply.code(429).send({ ok: false, message: "Too many requests. Please wait a minute." });
    const service = t.services.find((s) => s.id === req.query.service) ?? t.services[0];
    const slots = await deps.calendar.getAvailableSlots(t, service.id, deps.now(), 14);
    return { ok: true, serviceId: service.id, slots };
  });

  app.post("/public/:tenantId/book", async (req: PubReq, reply) => {
    const t = tenants.get(req.params.tenantId);
    if (!t) return reply.code(404).send({ ok: false });
    if (tooMany(req.ip)) return reply.code(429).send({ ok: false, message: "Too many requests. Please wait a minute." });
    const b = req.body ?? {};
    if (b.website) return { ok: true, message: "Thanks!" }; // honeypot: bots fill hidden fields
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (name.length < 2 || name.length > 80) return reply.code(400).send({ ok: false, message: "Please enter your name." });
    if (!actions.normalizePhone(b.phone)) return reply.code(400).send({ ok: false, message: "Please enter a valid phone number." });
    const zip = typeof b.zip === "string" ? b.zip.replace(/\D/g, "").slice(0, 5) : "";
    if (zip.length !== 5) return reply.code(400).send({ ok: false, message: "Please enter your 5-digit ZIP code." });
    if (!isInServiceArea(t, zip)) {
      return reply.code(400).send({ ok: false, outOfArea: true, message: `Sorry, we don't currently serve ZIP ${zip}.` });
    }
    const r = await actions.bookAppointment(deps, t, {
      name, phone: b.phone, zip, start: b.start, service: b.service,
      address: typeof b.address === "string" ? b.address.slice(0, 200) : undefined,
      notes: typeof b.notes === "string" ? b.notes.slice(0, 500) : undefined,
      source: "web",
    });
    if (!r.ok) return reply.code(409).send({ ok: false, message: String(r.message).includes("taken") ? "That time was just taken. Please pick another." : "We couldn't book that. Please call us." });
    return { ok: true, when: r.when, serviceName: r.service_name };
  });

  return app;
}
