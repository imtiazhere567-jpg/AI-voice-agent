import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import { EventLog, redact } from "../core/events";
import { Messaging, type SmsProvider } from "../core/messaging";
import { Store } from "../core/store";
import { loadTenantsFromDir } from "../core/tenant-config/loader";
import { LocalCalendar } from "../integrations/calendar/local-calendar";
import { buildBlandInboundConfig, buildBlandTestCall, type BlandClient } from "../integrations/voice/bland";
import * as a from "../modules/voice-receptionist/actions";

const tenants = loadTenantsFromDir(fileURLToPath(new URL("../test-data/tenants", import.meta.url)));
const roofing = tenants.get("demo-roofing")!;
const spa = tenants.get("glow-med-spa")!;
const SECRET = "test-secret-1234567890";
// Monday 2026-11-16 08:00 in Chicago
const NOW = new Date("2026-11-16T14:00:00Z");

let deps: a.Deps;
let sent: { to: string; message: string }[];

function setup(globalTestMode = true) {
  const store = new Store();
  const events = new EventLog();
  sent = [];
  const provider: SmsProvider = { sendSms: async (_f, to, message) => void sent.push({ to, message }) };
  deps = { store, events, messaging: new Messaging(events, store, provider, globalTestMode, () => NOW), calendar: new LocalCalendar(store), now: () => NOW, publicBaseUrl: "https://abc.ngrok.app" };
}
beforeEach(() => setup());

const smsEvents = (tenantId = roofing.tenantId) => deps.events.list(tenantId).filter((e) => e.type.startsWith("sms."));

describe("booking", () => {
  it("offers slots in business hours, respecting minimum notice", async () => {
    const r = await a.getAvailableSlots(deps, roofing, { service: "inspection" });
    const slots = r.slots as { start: string; label: string }[];
    expect(slots).toHaveLength(3);
    // 12h notice from Mon 8am -> first slot Tue 7:00 am Chicago; 60 min + 30 min buffer
    expect(slots.map((s) => s.label)).toEqual([
      "Tuesday, November 17 at 7:00 AM",
      "Tuesday, November 17 at 8:30 AM",
      "Tuesday, November 17 at 10:00 AM",
    ]);
  });

  it("books, confirms by text (simulated in test mode) and alerts the team", async () => {
    const { slots } = (await a.getAvailableSlots(deps, roofing, {})) as unknown as { slots: { start: string }[] };
    const r = await a.bookAppointment(deps, roofing, { name: "Sarah Lee", phone: "(713) 555-0199", zip: "77002", start: slots[0].start, service: "inspection" });
    expect(r.ok).toBe(true);
    expect(deps.store.data.bookings).toHaveLength(1);
    expect(sent).toHaveLength(0); // test mode: nothing real goes out
    const sms = smsEvents();
    expect(sms.some((e) => e.type === "sms.simulated" && e.payload.to === "+17135550199" && e.payload.kind === "booking_confirmation")).toBe(true);
    expect(sms.some((e) => e.payload.kind === "team_alert")).toBe(true);
  });

  it("never double-books the same time", async () => {
    const { slots } = (await a.getAvailableSlots(deps, roofing, {})) as unknown as { slots: { start: string }[] };
    expect((await a.bookAppointment(deps, roofing, { name: "A", start: slots[0].start })).ok).toBe(true);
    const second = await a.bookAppointment(deps, roofing, { name: "B", start: slots[0].start });
    expect(second.ok).toBe(false);
    expect(second.message).toMatch(/just taken/);
    const again = (await a.getAvailableSlots(deps, roofing, {})) as unknown as { slots: { start: string }[] };
    expect(again.slots.map((s) => s.start)).not.toContain(slots[0].start);
  });

  it("refuses to book outside the service area", async () => {
    const r = await a.bookAppointment(deps, roofing, { name: "X", zip: "90210", start: "2026-11-17T07:00:00.000-06:00" });
    expect(r.ok).toBe(false);
    expect(deps.store.data.bookings).toHaveLength(0);
  });

  it("ignores unfilled Bland placeholders like {{input.phone}}", async () => {
    expect(a.normalizePhone("{{input.phone}}")).toBeUndefined();
    expect(a.normalizePhone("713-555-0199")).toBe("+17135550199");
  });
});

describe("service area, callbacks, emergencies", () => {
  it("checks ZIP per business", () => {
    expect(a.checkServiceArea(deps, roofing, { zip: "77002" }).in_area).toBe(true);
    expect(a.checkServiceArea(deps, roofing, { zip: "90210" }).in_area).toBe(false);
    expect(a.checkServiceArea(deps, roofing, { zip: "abc" }).ok).toBe(false);
  });

  it("creates a callback task and alerts the team", async () => {
    await a.createCallback(deps, roofing, { name: "John", phone: "7135550111", reason: "Wants the owner" });
    expect(deps.store.data.callbacks[0]).toMatchObject({ callerPhone: "+17135550111", reason: "Wants the owner", urgent: false });
    expect(deps.events.list(roofing.tenantId, "callback.created")).toHaveLength(1);
  });

  it("emergency texts every on-call number and makes an urgent callback", async () => {
    await a.emergencyAlert(deps, roofing, { description: "water coming through the ceiling", phone: "7135550111" });
    const alerts = smsEvents().filter((e) => e.payload.kind === "emergency_alert").map((e) => e.payload.to);
    expect(alerts).toEqual(roofing.emergency.onCallNumbers);
    expect(deps.store.data.callbacks[0].urgent).toBe(true);
  });
});

describe("after the call", () => {
  const hangUp = { call_id: "c1", from: "+17135550150", call_length: 0.1, transcripts: [{ user: "assistant", text: "Thanks for calling" }] };

  it("hang-up sends one text-back, not two within 24h", async () => {
    expect((await a.handleCallEnded(deps, roofing, hangUp)).outcome).toBe("hang_up");
    await a.handleCallEnded(deps, roofing, { ...hangUp, call_id: "c2" });
    const textBacks = smsEvents().filter((e) => e.payload.kind === "missed_call_text_back");
    expect(textBacks).toHaveLength(1);
    expect(String(textBacks[0].payload.message)).toContain("Demo Roofing Co.");
    expect(String(textBacks[0].payload.message)).toContain("https://abc.ngrok.app/book/demo-roofing");
  });

  it("a real conversation is saved with summary and recording, no text-back", async () => {
    const rec = await a.handleCallEnded(deps, roofing, {
      call_id: "c3", from: "+17135550150", call_length: 3.2, summary: "Booked inspection", recording_url: "https://rec/1",
      transcripts: [{ user: "user", text: "I need an inspection" }],
    });
    expect(rec).toMatchObject({ outcome: "conversation", summary: "Booked inspection", recordingUrl: "https://rec/1" });
    expect(smsEvents().filter((e) => e.payload.kind === "missed_call_text_back")).toHaveLength(0);
    expect(deps.events.list(roofing.tenantId, "call.ended")).toHaveLength(1);
  });

  it("anonymous callers are marked spam and not texted", async () => {
    expect((await a.handleCallEnded(deps, roofing, { call_id: "c4", from: "anonymous", call_length: 0.05 })).outcome).toBe("spam");
    expect(smsEvents()).toHaveLength(0);
  });

  it("STOP opts the caller out; no more texts", async () => {
    await a.handleInboundSms(deps, roofing, { from: "+17135550150", body: "STOP" });
    await a.sendTextBack(deps, roofing, "+17135550150");
    expect(smsEvents().map((e) => e.type)).toEqual(["sms.received", "sms.blocked_opt_out"]);
    expect(deps.events.list(roofing.tenantId, "contact.opted_out")).toHaveLength(1);
  });

  it("sends real texts only when test mode is off everywhere", async () => {
    setup(false);
    await a.sendTextBack(deps, { ...roofing, testMode: false, phoneNumber: "+17135550000" }, "+17135550150");
    expect(sent).toHaveLength(1);
    setup(false);
    await a.sendTextBack(deps, roofing, "+17135550150"); // tenant still in test mode
    expect(sent).toHaveLength(0);
  });
});

describe("server security", () => {
  const app = () => buildApp({ deps, tenants, toolSecret: SECRET, logger: false, requireAuth: false });

  it("rejects requests without the secret", async () => {
    const r = await app().inject({ method: "POST", url: "/tools/demo-roofing/check-service-area", payload: { zip: "77002" } });
    expect(r.statusCode).toBe(401);
  });

  it("rejects unknown businesses", async () => {
    const r = await app().inject({ method: "POST", url: "/tools/nope/check-service-area", headers: { "x-tool-secret": SECRET }, payload: { zip: "77002" } });
    expect(r.statusCode).toBe(404);
  });

  it("answers tools and webhooks with the secret", async () => {
    const tool = await app().inject({ method: "POST", url: "/tools/demo-roofing/check-service-area", headers: { "x-tool-secret": SECRET }, payload: { zip: "77002" } });
    expect(tool.json()).toMatchObject({ ok: true, in_area: true });
    const hook = await app().inject({ method: "POST", url: `/webhooks/bland/demo-roofing/call-ended?token=${SECRET}`, payload: { call_id: "w1", from: "+17135550150", call_length: 0.1 } });
    expect(hook.json()).toMatchObject({ ok: true, outcome: "hang_up" });
  });
});

describe("online booking page (public)", () => {
  const app = () => buildApp({ deps, tenants, toolSecret: SECRET, logger: false, requireAuth: false });

  it("shows only safe public info (no phone numbers or contacts)", async () => {
    const r = await app().inject({ method: "GET", url: "/public/demo-roofing" });
    const body = r.json();
    expect(body.businessName).toBe("Demo Roofing Co.");
    expect(JSON.stringify(body)).not.toMatch(/onCall|escalation|\+1713/);
  });

  it("books online and marks the booking as web", async () => {
    const a1 = app();
    const { slots } = (await a1.inject({ method: "GET", url: "/public/demo-roofing/slots?service=inspection" })).json();
    expect(slots.length).toBeGreaterThan(3);
    const r = await a1.inject({ method: "POST", url: "/public/demo-roofing/book", payload: { name: "Web User", phone: "713-555-0177", zip: "77002", service: "inspection", start: slots[0].start } });
    expect(r.json()).toMatchObject({ ok: true, serviceName: "Roof inspection" });
    expect(deps.store.data.bookings[0]).toMatchObject({ source: "web", customerPhone: "+17135550177" });
  });

  it("rejects out-of-area, bad phone, and bots", async () => {
    const a1 = app();
    const bad = (payload: object) => a1.inject({ method: "POST", url: "/public/demo-roofing/book", payload: { name: "X Y", phone: "7135550177", zip: "77002", start: "2026-11-17T07:00:00.000-06:00", ...payload } });
    expect((await bad({ zip: "90210" })).json()).toMatchObject({ ok: false, outOfArea: true });
    expect((await bad({ phone: "123" })).statusCode).toBe(400);
    expect((await bad({ website: "spam.com" })).json()).toMatchObject({ ok: true }); // silently ignored
    expect(deps.store.data.bookings).toHaveLength(0);
  });

  it("dashboard API is not reachable through a tunnel (forwarded requests)", async () => {
    const r = await app().inject({ method: "GET", url: "/api/tenants", headers: { "x-forwarded-for": "1.2.3.4" } });
    expect(r.statusCode).toBe(403);
  });
});

describe("Bland config per business", () => {
  it("points tools at this business and carries the secret", () => {
    const c = buildBlandInboundConfig(roofing, "https://abc.ngrok.app/", SECRET);
    expect(c.tools.map((t) => t.name)).toEqual(["check_service_area", "get_available_slots", "book_appointment", "create_callback", "emergency_alert"]);
    expect(c.tools.every((t) => t.url.startsWith("https://abc.ngrok.app/tools/demo-roofing/") && t.headers["x-tool-secret"] === SECRET)).toBe(true);
    expect(c.webhook).toBe(`https://abc.ngrok.app/webhooks/bland/demo-roofing/call-ended?token=${SECRET}`);
    expect(c.transfer_phone_number).toBe(roofing.emergency.onCallNumbers[0]);
    expect(c.first_sentence).toContain("automated assistant");
    expect(c.max_duration).toBe(8);
  });

  it("med spa redirects emergencies to 911 instead of transferring", () => {
    const c = buildBlandInboundConfig(spa, "https://abc.ngrok.app", SECRET);
    expect(c.transfer_phone_number).toBeUndefined();
    expect(c.prompt).toContain("call 911");
  });

  it("requires https", () => {
    expect(() => buildBlandInboundConfig(roofing, "http://localhost:3000", SECRET)).toThrow(/https/);
  });
});

describe("Bland test call (Bland's AI calls the owner)", () => {
  const fakeBland = (reply: unknown) => {
    const sent: Record<string, unknown>[] = [];
    const client = { sendCall: async (b: Record<string, unknown>) => { sent.push(b); if (reply instanceof Error) throw reply; return reply; }, getCall: async () => ({ status: "completed", completed: true, summary: "Booked." }), me: async () => ({ billing: { current_balance: 1.8 } }) };
    return { client: client as unknown as BlandClient, sent };
  };

  it("builds the call: same prompt and tools, marked as a test, short", () => {
    const c = buildBlandTestCall(roofing, "https://abc.ngrok.app", SECRET, "+17135550199");
    expect(c.phone_number).toBe("+17135550199");
    expect(c.task).toContain("TEST CALL");
    expect(c.task).toContain(roofing.businessName);
    expect(c.tools).toHaveLength(5);
    expect(c.metadata.test_call).toBe("true");
    expect(c.max_duration).toBeLessThanOrEqual(5);
    expect("prompt" in c).toBe(false);
  });

  it("starts a call through the dashboard and reports Bland's answer", async () => {
    const { client, sent } = fakeBland({ status: "success", call_id: "call-1" });
    const app = buildApp({ deps, tenants, toolSecret: SECRET, logger: false, requireAuth: false, bland: client });
    const bad = (await app.inject({ method: "POST", url: "/api/bland/demo-roofing/test-call", payload: { phone: "03001234567" } })).json();
    expect(bad.ok).toBe(false); // needs +country code
    const r = (await app.inject({ method: "POST", url: "/api/bland/demo-roofing/test-call", payload: { phone: "+92 300 1234567" } })).json();
    expect(r).toMatchObject({ ok: true, callId: "call-1" });
    expect(sent[0].phone_number).toBe("+923001234567");
    const s = (await app.inject({ method: "GET", url: "/api/bland/demo-roofing/test-call/call-1" })).json();
    expect(s).toMatchObject({ ok: true, status: "completed", summary: "Booked." });
  });

  it("explains Bland's international-credit rule in plain words", async () => {
    const { client } = fakeBland(new Error('Bland POST /v1/calls failed (402): {"code":"CALL_PLAN_INTL_NEEDS_CREDITS"}'));
    const app = buildApp({ deps, tenants, toolSecret: SECRET, logger: false, requireAuth: false, bland: client });
    const r = (await app.inject({ method: "POST", url: "/api/bland/demo-roofing/test-call", payload: { phone: "+923001234567" } })).json();
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("$5");
  });

  it("browser call: creates the business's Bland agent once, then reuses and updates it", async () => {
    const made: unknown[] = [], updated: string[] = [];
    const client = {
      createAgent: async (b: unknown) => { made.push(b); return { agent: { agent_id: "ag-1" } }; },
      updateAgent: async (id: string) => { updated.push(id); return { status: "success" }; },
      authorizeAgent: async () => ({ token: "tok-123" }),
    } as unknown as BlandClient;
    const app = buildApp({ deps, tenants, toolSecret: SECRET, logger: false, requireAuth: false, bland: client });
    const r1 = (await app.inject({ method: "POST", url: "/api/bland/demo-roofing/web-call", payload: {} })).json();
    expect(r1).toMatchObject({ ok: true, agentId: "ag-1", token: "tok-123" });
    const r2 = (await app.inject({ method: "POST", url: "/api/bland/demo-roofing/web-call", payload: {} })).json();
    expect(r2.agentId).toBe("ag-1");
    expect(made).toHaveLength(1);
    expect(updated).toEqual(["ag-1"]);
    const cfg = made[0] as { prompt: string; tools: unknown[]; metadata: Record<string, string>; model: string };
    expect(cfg.prompt).toContain(roofing.businessName);
    expect(cfg.tools).toHaveLength(5);
    expect(cfg.model).toBe("base");
    expect(cfg.metadata).toMatchObject({ tenantId: "demo-roofing", web_call: "true" });
    expect(deps.store.data.blandAgents).toMatchObject([{ tenantId: "demo-roofing", agentId: "ag-1" }]);
  });

  it("saves a finished browser call (no phone number) as the owner's test, not spam", async () => {
    const app = buildApp({ deps, tenants, toolSecret: SECRET, logger: false, requireAuth: false });
    await app.inject({
      method: "POST", url: `/webhooks/bland/demo-roofing/call-ended?token=${SECRET}`,
      payload: { call_id: "w-1", call_length: 1.5, summary: "Asked about roof inspection.", metadata: { tenantId: "demo-roofing", web_call: "true" }, transcripts: [{ user: "user", text: "hello" }] },
    });
    expect(deps.store.data.calls.at(-1)).toMatchObject({ callId: "w-1", from: "Browser test call", outcome: "conversation", handledBy: "ai" });
  });

  it("records a finished test call with the owner's phone as the caller", async () => {
    const app = buildApp({ deps, tenants, toolSecret: SECRET, logger: false, requireAuth: false });
    await app.inject({
      method: "POST", url: `/webhooks/bland/demo-roofing/call-ended?token=${SECRET}`,
      payload: { call_id: "t-1", from: "+14155550000", to: "+17135550199", call_length: 2, metadata: { tenantId: "demo-roofing", test_call: "true" }, transcripts: [{ user: "user", text: "hi" }] },
    });
    expect(deps.store.data.calls.at(-1)).toMatchObject({ callId: "t-1", from: "+17135550199", outcome: "conversation" });
  });
});

describe("activity log", () => {
  it("never stores secrets", () => {
    expect(redact({ to: "+1", apiKey: "abc", nested: { token: "x" } })).toEqual({ to: "+1", apiKey: "[redacted]", nested: { token: "[redacted]" } });
  });
});

describe("booking shows the call that made it", () => {
  it("links bookings made during a call to that call (not online bookings, not later bookings)", async () => {
    const { slots } = (await a.getAvailableSlots(deps, roofing, {})) as unknown as { slots: { start: string }[] };
    expect((await a.bookAppointment(deps, roofing, { name: "Alex", phone: "7135550111", start: slots[0].start })).ok).toBe(true);
    deps.store.data.bookings.push({ ...deps.store.data.bookings[0], id: "web1", source: "web", start: slots[1].start });
    deps.store.data.bookings.push({ ...deps.store.data.bookings[0], id: "old", createdAt: new Date(NOW.getTime() - 60 * 60_000).toISOString() });
    // Bland's report arrives about a minute after the 2-minute call
    deps.now = () => new Date(NOW.getTime() + 60_000);
    await a.handleCallEnded(deps, roofing, { call_id: "bland-1", from: "+17135550111", call_length: 2, summary: "Alex booked an inspection." });
    const by = (id: string) => deps.store.data.bookings.find((b) => b.id === id)!;
    expect(deps.store.data.bookings[0].callId).toBe("bland-1");
    expect(by("web1").callId).toBeUndefined();
    expect(by("old").callId).toBeUndefined();
  });

  it("links bookings saved before this feature, once at startup", async () => {
    const { slots } = (await a.getAvailableSlots(deps, roofing, {})) as unknown as { slots: { start: string }[] };
    await a.bookAppointment(deps, roofing, { name: "Alex", start: slots[0].start });
    deps.store.data.calls.push({ callId: "old-call", tenantId: roofing.tenantId, from: "Browser test call", lengthMinutes: 1, outcome: "conversation", createdAt: new Date(NOW.getTime() + 20_000).toISOString() });
    a.linkExistingBookings(deps);
    expect(deps.store.data.bookings[0].callId).toBe("old-call");
  });
});

describe("booking link safety", () => {
  it("never links a booking to another customer's call (different phone numbers)", async () => {
    const { slots } = (await a.getAvailableSlots(deps, roofing, {})) as unknown as { slots: { start: string }[] };
    await a.bookAppointment(deps, roofing, { name: "David Lee", phone: "7135550122", start: slots[0].start });
    await a.handleCallEnded(deps, roofing, { call_id: "other", from: "+17135550999", call_length: 2, summary: "Someone else." });
    expect(deps.store.data.bookings[0].callId).toBeUndefined();
    deps.store.data.bookings[0].callId = "other"; // a wrong link saved earlier
    a.linkExistingBookings(deps);
    expect(deps.store.data.bookings[0].callId).toBeUndefined();
  });
});

describe("service area answers", () => {
  it("the AI's instructions list the ZIP codes the business serves (from the tenant config)", async () => {
    const { buildReceptionistPrompt } = await import("../modules/voice-receptionist/prompt-builder");
    const p = buildReceptionistPrompt(roofing);
    expect(p).toContain(`We serve these ZIP codes: ${roofing.serviceArea.zipCodes.join(", ")}`);
    expect(p).toMatch(/Do NOT check their old ZIP code again/);
    expect(p).not.toMatch(/\{serviceArea/); // no unfilled placeholders
  });

  it("an out-of-area check tells the AI which ZIP codes are covered", () => {
    const r = a.checkServiceArea(deps, roofing, { zip: "90210" });
    expect(r.in_area).toBe(false);
    expect(r.message).toContain(roofing.serviceArea.zipCodes.join(", "));
    expect(r.message).toMatch(/Don't check 90210 again/);
  });
});

describe("answering questions", () => {
  it("lets the AI answer general trade questions, and hand off only what it truly can't answer", async () => {
    const { buildReceptionistPrompt } = await import("../modules/voice-receptionist/prompt-builder");
    const p = buildReceptionistPrompt(roofing);
    expect(p).not.toMatch(/Answer questions ONLY from the approved answers/);
    expect(p).toMatch(/General roofing questions/);
    expect(p).toMatch(/Never invent a business fact/);
    expect(p).toMatch(/I'm not sure about that one\. I'll note your question/);
    expect(p).toMatch(/Never promise what insurance will cover/);
  });
});

describe("owner-edited AI script", () => {
  it("uses the owner's edited script, always followed by the safety rules", async () => {
    const { buildReceptionistPrompt, buildAutomaticPrompt } = await import("../modules/voice-receptionist/prompt-builder");
    const edited = { ...roofing, scriptOverride: "You are the friendly receptionist for Demo Roofing. Keep it short." };
    const p = buildReceptionistPrompt(edited);
    expect(p.startsWith("You are the friendly receptionist for Demo Roofing.")).toBe(true);
    expect(p).toMatch(/# Safety rules \(always on/);
    expect(p).toMatch(/Never promise what insurance will cover/);
    expect(p).toContain(roofing.approvedPrices[0]?.price ?? "Never quote any price");
    expect(buildReceptionistPrompt({ ...roofing, scriptOverride: "   " })).toBe(buildAutomaticPrompt(roofing));
  });

  it("the script API says whether the script was edited", async () => {
    const app = buildApp({ deps, tenants: new Map([[roofing.tenantId, { ...roofing, scriptOverride: "My own script for the AI, written by the owner of the business." }]]), toolSecret: SECRET, requireAuth: false });
    const r = (await app.inject({ method: "GET", url: `/api/tenants/${roofing.tenantId}/script` })).json();
    expect(r.edited).toBe(true);
    expect(r.script).toMatch(/^My own script/);
    expect(r.automatic).toMatch(/You are the phone receptionist for Demo Roofing/);
  });
});

describe("script completeness (things the AI needs on real Bland calls)", () => {
  it("includes opening hours from the settings, with closed days", async () => {
    const { buildReceptionistPrompt } = await import("../modules/voice-receptionist/prompt-builder");
    const p = buildReceptionistPrompt(roofing);
    expect(p).toContain("- Monday: 7 AM to 6 PM");
    expect(p).toContain("- Saturday: 8 AM to 12 PM");
    expect(p).toContain("- Sunday: closed");
    expect(p).toContain(`Opening hours (${roofing.timezone})`);
  });

  it("covers phone read-back, urgency, existing customers, spoken style, safety, and doesn't repeat the opening", async () => {
    const { buildReceptionistPrompt } = await import("../modules/voice-receptionist/prompt-builder");
    const p = buildReceptionistPrompt(roofing);
    expect(p).toMatch(/Read the phone number back digit by digit/);
    expect(p).toMatch(/Is this urgent, or can it wait/);
    expect(p).toMatch(/reschedule, cancel/);
    expect(p).toMatch(/No lists, no bullet points/);
    expect(p).toMatch(/Is there anything else I can help you with\?/);
    expect(p).toMatch(/Never ask for or accept credit card/);
    expect(p).toMatch(/Never share information about other customers/);
    expect(p).toMatch(/do not say it again/);
    expect(p).not.toMatch(/\{[a-zA-Z]+\}/); // every placeholder filled
  });

  it("Bland tools require a phone number to book or create a callback, and callbacks can be urgent", () => {
    const tools = buildBlandInboundConfig(roofing, "https://abc.ngrok.app", SECRET).tools;
    const book = tools.find((t) => t.name === "book_appointment")!, cb = tools.find((t) => t.name === "create_callback")!;
    expect(book.input_schema.required).toContain("phone");
    expect(cb.input_schema.required).toContain("phone");
    expect(cb.body.urgent).toBe("{{input.urgent}}");
  });
});

describe("voice picker", () => {
  it("keeps usable English voices, Bland's curated first, then best rated, and works out male/female", async () => {
    const { pickerVoices } = await import("../integrations/voice/bland");
    const list = pickerVoices([
      { id: "1", name: "josh", description: "Articulate American Male", public: true, is_live: true, tags: ["english"], ratings: 50 },
      { id: "2", name: "June", description: "American Female.", public: true, is_live: true, tags: ["english", "Bland Curated"], total_ratings: 45 },
      { id: "3", name: "anna-french", description: "French Female", public: true, is_live: true, tags: ["french"], ratings: 8 },
      { id: "4", name: "old", description: "American Male", public: true, is_live: false, tags: ["english"] },
      { id: "5", name: "Public - x1", description: "", public: true, is_live: true, tags: ["english"] },
      { id: "6", name: "Allan", description: null, public: true, is_live: true, tags: ["cloned", "male", "Bland Curated"] },
    ]);
    expect(list.map((v) => v.name)).toEqual(["June", "Allan", "josh"]); // Allan: curated, no language tag
    expect(list.map((v) => v.gender)).toEqual(["female", "male", "male"]);
    expect(list[0]).toMatchObject({ curated: true, description: "American Female" });
  });

  it("sends the chosen voice to Bland", () => {
    const c = buildBlandInboundConfig({ ...roofing, voice: { ...roofing.voice, voiceId: "voice-123" } }, "https://abc.ngrok.app", SECRET);
    expect(c.voice).toBe("voice-123");
  });
});

describe("voice samples", () => {
  it("asks Bland once per voice, then plays the saved copy (no extra cost)", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const old = process.env.DATA_DIR;
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "samples-"));
    let made = 0;
    const bland = { speakSample: async () => { made++; return { wav: Buffer.from("RIFF-test-audio"), cost: "0.001" }; } } as unknown as BlandClient;
    const app = buildApp({ deps, tenants, toolSecret: SECRET, requireAuth: false, bland });
    const id = "9d3a0685-4854-423f-94f9-6e7ad864e59c";
    const r1 = await app.inject({ method: "GET", url: `/api/bland/voices/${id}/sample` });
    const r2 = await app.inject({ method: "GET", url: `/api/bland/voices/${id}/sample` });
    expect(r1.headers["content-type"]).toMatch(/audio\/wav/);
    expect(r2.body).toBe("RIFF-test-audio");
    expect(made).toBe(1);
    expect((await app.inject({ method: "GET", url: "/api/bland/voices/..%2F..%2Fsecret/sample" })).statusCode).toBe(400);
    process.env.DATA_DIR = old;
  });
});

describe("voice list when the internet drops", () => {
  it("tries again once, and shows a clear message if Bland still can't be reached", async () => {
    let calls = 0;
    const flaky = { listVoices: async () => { if (++calls === 1) throw new TypeError("fetch failed"); return { voices: [{ id: "1", name: "Allan", public: true, is_live: true, tags: ["male", "Bland Curated"] }] }; } } as unknown as BlandClient;
    const ok = (await buildApp({ deps, tenants, toolSecret: SECRET, requireAuth: false, bland: flaky }).inject({ method: "GET", url: "/api/bland/voices" })).json();
    expect(ok.ok).toBe(true);
    expect(calls).toBe(2);

    const down = { listVoices: async () => { throw new TypeError("fetch failed"); } } as unknown as BlandClient;
    const r = await buildApp({ deps, tenants, toolSecret: SECRET, requireAuth: false, bland: down }).inject({ method: "GET", url: "/api/bland/voices" });
    expect(r.statusCode).toBe(502);
    expect(r.json().errors[0]).toBe("Couldn't reach Bland. Check your internet connection and try again.");
  });
});

describe("voice sample for older Bland voices", () => {
  it("falls back to Bland's older sample service when the new one refuses an older voice", async () => {
    const { vi } = await import("vitest");
    const { BlandClient } = await import("../integrations/voice/bland");
    const urls: string[] = [];
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (u) => {
      urls.push(String(u));
      return String(u).endsWith("/v2/tts")
        ? new Response(JSON.stringify({ error: { code: "unsupported_voice", message: "`voice` must be a BTTS_V2 or BTTS_V3 voice." } }), { status: 400 })
        : new Response("RIFF-old-voice", { status: 200, headers: { "content-type": "audio/x-wav", "x-cost": "0.0012" } });
    });
    try {
      const r = await new BlandClient("key").speakSample("5aff7b0c-92d7-4ce6-a502-39d33a401808", "Hi.");
      expect(r.wav.toString()).toBe("RIFF-old-voice");
      expect(r.cost).toBe("0.0012");
      expect(urls.map((u) => u.replace("https://api.bland.ai", ""))).toEqual(["/v2/tts", "/v1/voices/5aff7b0c-92d7-4ce6-a502-39d33a401808/sample"]);
    } finally { spy.mockRestore(); }
  });
});
