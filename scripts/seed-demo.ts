// Fill the local store with ~2 weeks of realistic SAMPLE activity so the dashboard can be demoed.
//   npm run seed-demo          add demo data (replaces previous demo data)
//   npm run seed-demo -- --clear   remove all demo data
// Stop the server first; start it again afterwards.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store, type Booking, type CallRecord, type CallbackTask } from "../core/store";
import type { EventRecord } from "../core/events";
import { loadTenantsFromDir } from "../core/tenant-config/loader";
import { LocalCalendar } from "../integrations/calendar/local-calendar";

try { process.loadEnvFile(".env"); } catch {}
const dataDir = process.env.DATA_DIR || "data";
const storeFile = join(dataDir, "store.json");
const eventsFile = join(dataDir, "events.jsonl");
const clearOnly = process.argv.includes("--clear");

const DEMO_PREFIX = "demo-";
const isDemo = (id: string) => id.startsWith(DEMO_PREFIX);
const id = () => DEMO_PREFIX + randomUUID();

// ---- remove previous demo data ----
mkdirSync(dataDir, { recursive: true });
const store = new Store(storeFile);
store.data.bookings = store.data.bookings.filter((b) => !isDemo(b.id));
store.data.callbacks = store.data.callbacks.filter((c) => !isDemo(c.id));
store.data.calls = store.data.calls.filter((c) => !isDemo(c.callId));
store.data.textBacks = store.data.textBacks.filter((t) => !t.phone.startsWith("+1555"));
store.data.messages = store.data.messages.filter((m) => !isDemo(m.id));
let events: EventRecord[] = existsSync(eventsFile)
  ? readFileSync(eventsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : [];
events = events.filter((e) => !isDemo(e.id));

if (clearOnly) {
  store.persist();
  writeFileSync(eventsFile, events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : ""));
  console.log("Demo data removed.");
  process.exit(0);
}

// ---- generate ----
let seed = 42;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)];
const between = (a: number, b: number) => Math.floor(a + rnd() * (b - a + 1));

const FIRST = ["Sarah", "James", "Maria", "David", "Emily", "Michael", "Jessica", "Daniel", "Ashley", "Chris", "Laura", "Kevin", "Olivia", "Brian", "Sofia", "Ryan", "Megan", "Jason", "Rachel", "Tyler", "Nicole", "Marcus", "Hannah", "Luis"];
const LAST = ["Johnson", "Garcia", "Miller", "Davis", "Martinez", "Wilson", "Anderson", "Thomas", "Moore", "Lee", "Walker", "Hall", "Young", "King", "Wright", "Lopez", "Hill", "Scott", "Green", "Baker", "Nguyen", "Patel"];
const phone = () => `+1555${String(between(1000000, 9999999))}`; // 555 numbers: fictional

const NOTES: Record<string, string[]> = {
  roofing: ["Missing shingles after last week's storm", "Small leak near chimney", "Wants quote for full replacement, 20-year-old roof", "Insurance adjuster visit scheduled, needs inspection first", "Gutter damage and lifted shingles"],
  "med spa": ["First-time client, interested in Botox for forehead lines", "Returning client, wants HydraFacial before wedding", "Asked about filler for lips", "Wants consultation for skin texture"],
  plumbing: ["Kitchen sink draining slowly", "Water heater not heating, 12 years old", "Leak under bathroom vanity", "Toilet running constantly", "Low water pressure in shower"],
};
const CALLBACK_REASONS = ["Wants to speak with the owner about warranty", "Asked about financing options not in knowledge base", "Existing customer, question about invoice", "Caller asked for a person", "Outside service area, asked for a referral"];

const tenants = loadTenantsFromDir(process.env.TENANTS_DIR || "test-data/tenants");
const calendar = new LocalCalendar(store);
const now = Date.now();
const DAY = 86_400_000;
let counts = { calls: 0, bookings: 0, callbacks: 0 };

function ev(tenantId: string, type: string, actor: EventRecord["actor"], at: number, payload: Record<string, unknown>) {
  events.push({ id: id(), tenantId, type, actor, at: new Date(at).toISOString(), payload: { ...payload, demo: true } });
}

for (const t of tenants.values()) {
  const notes = NOTES[t.industry] ?? NOTES.roofing;
  const area = t.serviceArea.zipCodes;

  // Past 28 days of calls (so "vs previous period" trends have data)
  for (let d = 27; d >= 0; d--) {
    const callsToday = between(d > 13 ? 1 : 2, d > 13 ? 6 : d < 3 ? 9 : 7);
    for (let i = 0; i < callsToday; i++) {
      const at = now - d * DAY - between(0, 10) * 3600_000 - between(0, 59) * 60_000;
      if (at > now) continue;
      const name = `${pick(FIRST)} ${pick(LAST)}`;
      const from = phone();
      const roll = rnd();
      const service = pick(t.services);
      const note = pick(notes);
      let outcome: CallRecord["outcome"] = "conversation";
      let summary: string;

      if (roll < 0.18) {
        outcome = "hang_up";
        summary = "Caller hung up during the greeting. Missed-call text sent.";
        store.data.textBacks.push({ tenantId: t.tenantId, phone: from, at: new Date(at + 40_000).toISOString() });
        ev(t.tenantId, "text_back.processed", "system", at + 40_000, { phone: from, result: "simulated" });
        store.data.messages.push({ id: id(), tenantId: t.tenantId, phone: from, direction: "out", kind: "missed_call_text_back", status: "simulated", at: new Date(at + 40_000).toISOString(), body: `Sorry we missed your call! This is ${t.businessName}. Book online or just reply to this text. Reply STOP to opt out.` });
      } else if (roll < 0.62) {
        // booked during the call (past appointment)
        const start = new Date(at + between(1, 3) * DAY);
        start.setUTCMinutes(0, 0, 0);
        const b: Booking = {
          id: id(), tenantId: t.tenantId, serviceId: service.id, start: start.toISOString(),
          end: new Date(start.getTime() + service.appointmentMinutes * 60_000).toISOString(),
          customerName: name, customerPhone: from, notes: note, status: "booked", source: "phone", createdAt: new Date(at).toISOString(),
        };
        if (start.getTime() < now) { store.data.bookings.push(b); counts.bookings++; }
        summary = `${name} called about: ${note.toLowerCase()}. In service area. Booked ${service.name.toLowerCase()}. Confirmation text sent.`;
        ev(t.tenantId, "booking.created", "ai", at + 120_000, { serviceId: service.id, source: "phone", start: b.start });
        store.data.messages.push({ id: id(), tenantId: t.tenantId, phone: from, direction: "out", kind: "booking_confirmation", status: "simulated", at: new Date(at + 125_000).toISOString(), body: `${t.businessName}: you're booked for ${service.name}. Reply STOP to opt out.` });
      } else if (roll < 0.8) {
        const urgent = rnd() < 0.25;
        const reason = urgent ? `EMERGENCY: ${pick(t.emergency.keywords)}` : pick(CALLBACK_REASONS);
        const cb: CallbackTask = {
          id: id(), tenantId: t.tenantId, callerName: name, callerPhone: from, reason, urgent,
          status: d > 3 ? "done" : "open", createdAt: new Date(at).toISOString(),
        };
        store.data.callbacks.push(cb); counts.callbacks++;
        summary = urgent ? `${name} reported an emergency (${reason.replace("EMERGENCY: ", "")}). On-call team alerted.` : `${name}: ${reason.toLowerCase()}. Callback task created.`;
        ev(t.tenantId, urgent ? "emergency.reported" : "callback.created", "ai", at + 90_000, { reason, description: reason });
      } else {
        summary = `${name} asked about ${service.name.toLowerCase()}. Answered from knowledge base, will book online.`;
      }

      const lengthMinutes = outcome === "hang_up" ? 0.1 : Math.round((1.2 + rnd() * 4.5) * 10) / 10;
      const handledBy = outcome === "hang_up" ? undefined : rnd() < 0.2 ? "staff" : "ai";
      if (handledBy === "staff") summary = `Answered by a team member. ${summary}`;
      const call: CallRecord = { callId: id(), tenantId: t.tenantId, from, lengthMinutes, summary, outcome, handledBy, callerName: outcome === "hang_up" ? undefined : name, createdAt: new Date(at + lengthMinutes * 60_000).toISOString() };
      store.data.calls.push(call); counts.calls++;
      ev(t.tenantId, "call.ended", "system", at + lengthMinutes * 60_000, { from, outcome, summary, lengthMinutes });
    }
  }

  // Make sure the demo always shows a few people waiting for a call back
  const mine = store.data.callbacks.filter((c) => c.tenantId === t.tenantId && isDemo(c.id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  mine.slice(0, 3).forEach((c) => (c.status = "open"));

  // Upcoming appointments in real open slots (next 7 days)
  const upcoming = between(7, 11);
  for (let i = 0; i < upcoming; i++) {
    const service = pick(t.services);
    const slots = await calendar.getAvailableSlots(t, service.id, new Date(), 7);
    if (!slots.length) break;
    const s = slots[between(0, Math.min(slots.length - 1, 12))];
    const name = `${pick(FIRST)} ${pick(LAST)}`;
    const createdAt = now - between(1, 40) * 3600_000;
    store.data.bookings.push({
      id: id(), tenantId: t.tenantId, serviceId: service.id, start: s.start, end: s.end, customerName: name, customerPhone: phone(),
      address: t.industry === "med spa" ? undefined : `${between(100, 9800)} ${pick(["Oak", "Maple", "Main", "Elm", "Cedar", "Pine"])} St`,
      notes: pick(notes), status: "booked", source: rnd() < 0.35 ? "web" : "phone", createdAt: new Date(createdAt).toISOString(),
    });
    counts.bookings++;
  }
}

// Every demo booking is "seen" except the 3 newest per business, so the "New bookings" feature shows something.
for (const t of tenants.values()) {
  const mine = store.data.bookings.filter((b) => b.tenantId === t.tenantId && isDemo(b.id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  mine.forEach((b, i) => { b.seenAt = i < 3 ? undefined : b.createdAt; });
}

events.sort((a, b) => a.at.localeCompare(b.at));
store.persist();
writeFileSync(eventsFile, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
console.log(`Demo data added: ${counts.calls} calls, ${counts.bookings} bookings, ${counts.callbacks} callbacks across ${tenants.size} businesses.`);
console.log("Remove it any time with: npm run seed-demo -- --clear");
