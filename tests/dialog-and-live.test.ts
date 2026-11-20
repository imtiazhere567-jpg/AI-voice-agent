import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { EventLog } from "../core/events/index.js";
import { Messaging } from "../core/messaging/index.js";
import { Store } from "../core/store/index.js";
import { loadTenantsFromDir } from "../core/tenant-config/loader.js";
import type { TenantConfig } from "../core/tenant-config/schema.js";
import { LocalCalendar } from "../integrations/calendar/local-calendar.js";
import type { Deps } from "../modules/voice-receptionist/actions.js";
import { handle, newDialog, summarize } from "../modules/voice-receptionist/dialog.js";
import { LiveCalls, isEcho } from "../modules/voice-receptionist/live-calls.js";

const tenants = loadTenantsFromDir(fileURLToPath(new URL("../test-data/tenants", import.meta.url)));
const roofing = tenants.get("demo-roofing")!;
const spa = tenants.get("glow-med-spa")!;
const NOW = new Date("2026-11-16T14:00:00Z"); // Monday 8am Chicago
let deps: Deps;

beforeEach(() => {
  const store = new Store();
  const events = new EventLog();
  deps = { store, events, messaging: new Messaging(events, store, undefined, true, () => NOW), calendar: new LocalCalendar(store), now: () => NOW };
});

async function talk(t: TenantConfig, lines: string[]) {
  const s = newDialog("+15550100150");
  const said: string[] = [];
  for (const l of lines) said.push(...(await handle(deps, t, s, l)).say);
  return { s, said: said.join(" ") };
}

describe("AI conversation (simulator brain)", () => {
  it("books a full roofing appointment from a natural conversation", async () => {
    const { s, said } = await talk(roofing, ["Hi, I need someone to inspect my roof", "77002", "It's my home", "insurance", "shingle", "the first one", "My name is sarah lee", "yes"]);
    expect(s.outcome).toBe("booked");
    expect(said).toContain("You're all set, Sarah!");
    expect(deps.store.data.bookings[0]).toMatchObject({ customerName: "Sarah Lee", customerPhone: "+15550100150", serviceId: "inspection", source: "phone" });
    expect(deps.store.data.bookings[0].notes).toContain("home");
    expect(summarize(roofing, s)).toMatch(/Booked for/);
  });

  it("outside the service area: offers a ticket, creates it on yes, confirms, and keeps the call going", async () => {
    const { s, said } = await talk(roofing, ["I want a roof repair estimate", "90210", "yes please", "Ali Khan", "it can wait"]);
    expect(said).toContain("Is this urgent");
    expect(s.outcome).toBe("out_of_area");
    expect(said).toContain("Would you like me to create a request");
    expect(said).toContain("Your request has been created");
    expect(said).toContain("Is there anything else I can help you with?");
    expect(s.stage).toBe("anything_else");
    expect(deps.store.data.bookings).toHaveLength(0);
    expect(deps.store.data.callbacks[0]).toMatchObject({ callerName: "Ali Khan" });
    expect(deps.store.data.callbacks[0].reason).toMatch(/90210/);
  });

  it("unknown question: offers a ticket; saying no keeps the call going without one", async () => {
    const { s, said } = await talk(roofing, ["Do you guys do gutter installation?", "no thanks"]);
    expect(said).toContain("Would you like me to create a request");
    expect(said).toContain("No problem. Is there anything else");
    expect(s.stage).toBe("anything_else");
    expect(deps.store.data.callbacks).toHaveLength(0);
    const end = await handle(deps, roofing, s, "no that's all");
    expect(end.end).toBe(true);
  });

  it("handles emergencies first, per business", async () => {
    const r = await talk(roofing, ["water coming through the ceiling!"]);
    expect(r.s.outcome).toBe("emergency");
    const sp = await talk(spa, ["I think I'm having an allergic reaction"]);
    expect(sp.said).toContain("call 911");
  });

  it("answers from the knowledge base and only quotes approved prices", async () => {
    const r = await talk(roofing, ["Do you have a warranty?"]);
    expect(r.said).toContain("10-year workmanship warranty");
    const p = await talk(spa, ["how much is botox?"]);
    expect(p.said).toContain("$12 per unit");
    const plumbing = tenants.get("quickfix-plumbing")!;
    expect((await talk(plumbing, ["how much does it cost?"])).said).toMatch(/not able to quote prices/);
  });

  it("works for a brand-new business type with only its own settings", async () => {
    const dental: TenantConfig = {
      ...spa, tenantId: "smile-dental", businessName: "Smile Dental", industry: "dentist",
      services: [{ id: "cleaning", name: "Teeth cleaning", appointmentMinutes: 45 }, { id: "whitening", name: "Teeth whitening", appointmentMinutes: 60 }],
      qualifyingQuestions: [{ field: "new_patient", question: "Are you a new patient?", required: true }],
      knowledgeBase: [{ topic: "insurance accepted", answer: "We accept Delta Dental and most PPO plans." }],
      emergency: { ...spa.emergency, keywords: ["knocked out tooth"] },
    };
    const kb = await talk(dental, ["Which insurance do you accept?"]);
    expect(kb.said).toContain("Delta Dental");
    const { s, said } = await talk(dental, ["I'd like a whitening appointment", "yes I am new", "2", "John Smith", "yes"]);
    expect(s.outcome).toBe("booked");
    expect(said).toContain("teeth whitening");
  });

  it("tells the caller when a question is off-topic, but still answers relevant ones", async () => {
    const off = await talk(roofing, ["Who won the football game last night?"]);
    expect(off.said).toMatch(/can only help with questions about Demo Roofing/);
    const off2 = await talk(spa, ["tell me a joke"]);
    expect(off2.said).toMatch(/can only help with questions about Glow Med Spa/);
    const rel = await talk(roofing, ["Do you guys do gutter installation?"]);
    expect(rel.said).toMatch(/don't have that information/);
    expect(rel.said).not.toMatch(/can only help/);
  });

  it("understands 'I don't want anything' as goodbye, and takes the name from 'yes, my name is…'", async () => {
    const bye = await talk(roofing, ["Do you offer financing?", "I don't want anything else"]);
    expect(bye.s.stage).toBe("ended");
    expect(deps.store.data.callbacks).toHaveLength(0);
    const t = await talk(roofing, ["do you install solar panels?", "yes, my name is Ali Raza", "yes it's urgent"]);
    expect(t.said).toContain("marked it as urgent");
    expect(t.said).toContain("Your request has been created");
    expect(deps.store.data.callbacks[0]).toMatchObject({ callerName: "Ali Raza", urgent: true });
  });

  it("hands over to a person when asked", async () => {
    const r = await talk(roofing, ["can I speak to a real person please", "John Smith", "it can wait"]);
    expect(r.s.outcome).toBe("callback");
    expect(deps.store.data.callbacks).toHaveLength(1);
    expect(deps.store.data.callbacks[0]).toMatchObject({ callerName: "John Smith", urgent: false });
    expect(r.said).toContain("Your request has been created");
    expect(r.s.stage).toBe("anything_else"); // call continues
    const off = await handle(deps, roofing, r.s, "what's the weather like?");
    expect(off.end).toBeFalsy(); // off-topic question never ends the call
  });
});

describe("live calls (ring → staff or AI)", () => {
  it("AI answers when nobody picks up, and the call is saved", async () => {
    const live = new LiveCalls(deps, (id) => tenants.get(id));
    const c = live.start(roofing, "5550100150");
    expect(c.status).toBe("ringing");
    live.aiAnswer(c.id);
    expect(c.status).toBe("ai");
    expect(c.messages.some((m) => m.from === "ai" && m.text.includes("automated assistant"))).toBe(true);
    await live.callerSay(c.id, "Do you offer financing?");
    expect(c.messages.at(-2)?.text).toContain("financing is available");
    await live.hangup(c.id, "caller");
    expect(deps.store.data.calls[0]).toMatchObject({ outcome: "conversation", handledBy: "ai" });
  });

  it("staff can answer, and the AI does not reply", async () => {
    const live = new LiveCalls(deps, (id) => tenants.get(id));
    const c = live.start(roofing, "5550100150");
    live.staffAnswer(c.id);
    live.aiAnswer(c.id); // timer firing late must not steal the call
    expect(c.status).toBe("staff");
    await live.callerSay(c.id, "hello?");
    live.staffSay(c.id, "Hi, this is Mike from Demo Roofing");
    expect(c.messages.filter((m) => m.from === "ai")).toHaveLength(0);
    await live.hangup(c.id, "staff");
    expect(deps.store.data.calls[0].handledBy).toBe("staff");
  });

  it("ignores the AI's own voice picked up by the mic (echo), but not real answers", async () => {
    const live = new LiveCalls(deps, (id) => tenants.get(id));
    live.useClaude = () => false;
    const c = live.start(roofing, "5550100150");
    live.aiAnswer(c.id);
    const before = c.messages.length;
    await live.callerSay(c.id, "thanks for calling demo roofing I'm the automated assistant");
    expect(c.messages.length).toBe(before); // ignored
    await live.callerSay(c.id, "yes");
    expect(c.messages.length).toBeGreaterThan(before); // short real answers always go through
  });

  it("does not treat a real answer that reuses the AI's words as echo", () => {
    const ai = ["We offer roof inspections, roof repair estimates, full roof replacement estimates, and storm damage assessments. Which one are you looking for?"];
    expect(isEcho("full roof replacement estimate?", ai)).toBe(false);
    expect(isEcho("full roof estimate", ai)).toBe(false);
    expect(isEcho("I want a roof repair estimate for my house please", ai)).toBe(false);
    expect(isEcho("roof repair estimates full roof replacement estimates and storm damage", ai)).toBe(true);
  });

  it("hanging up while ringing = missed call + text-back", async () => {
    const live = new LiveCalls(deps, (id) => tenants.get(id));
    const c = live.start(roofing, "5550100150");
    await live.hangup(c.id, "caller");
    expect(deps.store.data.calls[0].outcome).toBe("hang_up");
    expect(deps.events.list(roofing.tenantId, "text_back.processed")).toHaveLength(1);
  });
});

describe("calling a customer from the dashboard", () => {
  it("rings the customer's phone; they answer and talk with the team", async () => {
    const live = new LiveCalls(deps, (id) => tenants.get(id));
    const c = live.startOutbound(roofing, "(555) 906-0847", { customerName: "Jason Patel" });
    expect(c.status).toBe("ringing");
    expect(live.incomingFor("5559060847").map((x) => x.id)).toEqual([c.id]);
    expect(live.aiAnswer(c.id)!.status).toBe("ringing"); // the AI never takes a call the team is making
    live.customerAnswer(c.id);
    expect(c.status).toBe("staff");
    expect(live.incomingFor("5559060847")).toHaveLength(0);
    live.staffSay(c.id, "Hi Jason, calling about your roof inspection.");
    await live.callerSay(c.id, "Great, thanks for calling.");
    await live.hangup(c.id, "caller");
    const rec = deps.store.data.calls[0];
    expect(rec).toMatchObject({ direction: "out", outcome: "conversation", handledBy: "staff", callerName: "Jason Patel", from: "+15559060847" });
    expect(rec.transcript).toContain("caller: Great, thanks for calling.");
  });

  it("declined or unanswered: saved as 'no answer', and no missed-call text is sent", async () => {
    const live = new LiveCalls(deps, (id) => tenants.get(id));
    const c = live.startOutbound(roofing, "5559060847");
    await live.hangup(c.id, "caller");
    expect(c.messages.at(-1)!.text).toMatch(/declined/);
    expect(deps.store.data.calls[0]).toMatchObject({ direction: "out", outcome: "no_answer" });
    expect(deps.events.list(roofing.tenantId, "text_back.processed")).toHaveLength(0);
    expect(deps.store.data.messages).toHaveLength(0);
  });

  it("works through the API: dashboard calls, phone sees it ringing and picks up", async () => {
    const app = buildApp({ deps, tenants, toolSecret: "test-secret-1234567890", requireAuth: false });
    const start = await app.inject({ method: "POST", url: "/api/live/demo-roofing/call-out", payload: { phone: "5559060847", name: "Jason" } });
    const id = start.json().id;
    const incoming = await app.inject({ method: "GET", url: "/api/phone/incoming?phone=(555)%20906-0847" });
    expect(incoming.json()[0]).toMatchObject({ id, businessName: roofing.businessName, direction: "out" });
    // The test phone gets calls and texts for any customer (test mode), even with another "my number".
    const any = await app.inject({ method: "GET", url: "/api/phone/incoming?all=1" });
    expect(any.json().map((c: { id: string }) => c.id)).toContain(id);
    await deps.messaging.sms(roofing, "+15559060847", "Hi Jason", "staff_message", "Owner");
    const inbox = await app.inject({ method: "GET", url: "/api/phone/inbox?all=1" });
    expect(inbox.json().at(-1)).toMatchObject({ phone: "+15559060847", body: "Hi Jason", businessName: roofing.businessName });
    const picked = await app.inject({ method: "POST", url: `/api/live/demo-roofing/${id}/pickup`, payload: {} });
    expect(picked.json().status).toBe("staff");
    await app.close();
  });
});

describe("AI training from the dashboard", () => {
  it("saves valid changes and rejects broken ones with a readable message", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tenants-"));
    const map = new Map(tenants);
    const app = buildApp({ deps, tenants: map, toolSecret: "test-secret-1234567890", logger: false, requireAuth: false, tenantsDir: dir });
    const ok = await app.inject({ method: "PUT", url: "/api/tenants/demo-roofing", payload: { ...roofing, customInstructions: "Always mention our 10-year warranty." } });
    expect(ok.json().ok).toBe(true);
    expect(map.get("demo-roofing")!.customInstructions).toContain("warranty");
    expect(JSON.parse(readFileSync(join(dir, "demo-roofing.json"), "utf8")).customInstructions).toContain("warranty");
    const script = (await app.inject({ method: "GET", url: "/api/tenants/demo-roofing/script" })).json().script;
    expect(script).toContain("Always mention our 10-year warranty.");

    const bad = await app.inject({ method: "PUT", url: "/api/tenants/demo-roofing", payload: { ...roofing, services: [] } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().errors[0]).toMatch(/services/);
  });

  it("creates a new business of any type", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tenants-"));
    const map = new Map(tenants);
    const app = buildApp({ deps, tenants: map, toolSecret: "test-secret-1234567890", logger: false, requireAuth: false, tenantsDir: dir });
    const r = await app.inject({ method: "POST", url: "/api/tenants", payload: { businessName: "Bright Smile Dental", industry: "dentist", alertTo: "713-555-0100", zipCodes: "77002, 77003" } });
    expect(r.json()).toMatchObject({ ok: true, tenant: { tenantId: "bright-smile-dental", industry: "dentist", testMode: true } });
    expect(map.has("bright-smile-dental")).toBe(true);
  });

  it("lists and deletes businesses (keeping a backup file)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tenants-"));
    const map = new Map(tenants);
    const app = buildApp({ deps, tenants: map, toolSecret: "test-secret-1234567890", logger: false, requireAuth: false, tenantsDir: dir });
    await app.inject({ method: "POST", url: "/api/tenants", payload: { businessName: "Temp Biz", alertTo: "a@b.com", zipCodes: "77002" } });
    expect((await app.inject({ method: "GET", url: "/api/businesses" })).json()).toHaveLength(4);
    expect((await app.inject({ method: "DELETE", url: "/api/tenants/temp-biz", payload: {} })).json().ok).toBe(true);
    expect(map.has("temp-biz")).toBe(false);
    expect(readFileSync(join(dir, "temp-biz.json.deleted"), "utf8")).toContain("Temp Biz");
  });

  it("customer details: history, timeline, and two-way texts with the simulator phone", async () => {
    const app = buildApp({ deps, tenants, toolSecret: "test-secret-1234567890", logger: false, requireAuth: false });
    await talk(roofing, ["can I speak to a real person please", "Ali Raza", "it's urgent"]);
    const sent = await app.inject({ method: "POST", url: "/api/messages/demo-roofing", payload: { phone: "+15550100150", body: "Hi Ali, we will call you at 3pm." } });
    expect(sent.json().ok).toBe(true);
    const inbox = (await app.inject({ method: "GET", url: "/api/phone/inbox?phone=5550100150" })).json();
    expect(inbox.at(-1)).toMatchObject({ body: "Hi Ali, we will call you at 3pm.", businessName: "Demo Roofing Co." });
    await app.inject({ method: "POST", url: "/api/phone/reply", payload: { tenantId: "demo-roofing", phone: "5550100150", body: "Great, thanks!" } });
    const cust = (await app.inject({ method: "GET", url: "/api/customer/demo-roofing?phone=5550100150" })).json();
    expect(cust.name).toBe("Ali Raza");
    expect(cust.callbacks[0].urgent).toBe(true);
    expect(cust.messages.map((m: { direction: string }) => m.direction)).toEqual(["out", "in"]);
    expect(cust.timeline.map((s: { kind: string }) => s.kind)).toEqual(expect.arrayContaining(["urgent", "msg_out", "msg_in"]));
  });

  it("marks new bookings as seen", async () => {
    const app = buildApp({ deps, tenants, toolSecret: "test-secret-1234567890", logger: false, requireAuth: false });
    deps.store.data.bookings.push({ id: "b1", tenantId: "demo-roofing", serviceId: "inspection", start: NOW.toISOString(), end: NOW.toISOString(), customerName: "A", status: "booked", createdAt: NOW.toISOString() });
    await app.inject({ method: "POST", url: "/api/bookings/demo-roofing/b1/seen" });
    expect(deps.store.data.bookings[0].seenAt).toBeTruthy();
  });
});
