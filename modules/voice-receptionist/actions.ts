import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { fillTemplate, findEmergency, isInServiceArea } from "../../core/rules/index.js";
import type { EventLog } from "../../core/events/index.js";
import type { Messaging } from "../../core/messaging/index.js";
import type { CallRecord, Store } from "../../core/store/index.js";
import type { TenantConfig } from "../../core/tenant-config/schema.js";
import { SlotTakenError, type CalendarAdapter } from "../../integrations/calendar/local-calendar.js";

export interface Deps {
  store: Store;
  events: EventLog;
  messaging: Messaging;
  calendar: CalendarAdapter;
  now: () => Date;
  publicBaseUrl?: string; // e.g. https://abc.ngrok.app, used for the online booking link
}

/** The link customers get to book online: the tenant's own link, or our booking page. */
export function bookingLink(d: Deps, tenant: TenantConfig): string | undefined {
  return tenant.textBack.bookingLink ?? (d.publicBaseUrl ? `${d.publicBaseUrl.replace(/\/$/, "")}/book/${tenant.tenantId}` : undefined);
}

/** Every action returns a short sentence Bland's AI can say or use. */
export interface ActionResult {
  ok: boolean;
  message: string;
  [extra: string]: unknown;
}

const clean = (v: unknown) => (typeof v === "string" && v.trim() && !v.includes("{{") ? v.trim() : undefined);

/** Normalize a US phone number to +1XXXXXXXXXX. Returns undefined if it doesn't look valid. */
export function normalizePhone(raw: unknown): string | undefined {
  const s = clean(raw);
  if (!s) return undefined;
  const digits = s.replace(/\D/g, "");
  if (s.startsWith("+") && digits.length >= 8) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return undefined;
}

function matchService(tenant: TenantConfig, wanted: unknown) {
  const w = clean(wanted)?.toLowerCase();
  if (!w) return tenant.services[0];
  return (
    tenant.services.find((s) => s.id === w || s.name.toLowerCase() === w) ??
    tenant.services.find((s) => s.name.toLowerCase().includes(w) || w.includes(s.id)) ??
    tenant.services[0]
  );
}

// ---------- During the call ----------

export function checkServiceArea(d: Deps, tenant: TenantConfig, input: { zip?: unknown }): ActionResult {
  const zip = clean(input.zip)?.replace(/\D/g, "").slice(0, 5);
  if (!zip || zip.length !== 5) return { ok: false, in_area: false, message: "I didn't catch a valid 5-digit ZIP code. Please ask again." };
  const inArea = isInServiceArea(tenant, zip);
  d.events.log(tenant.tenantId, "service_area.checked", "system", { zip, inArea });
  return inArea
    ? { ok: true, in_area: true, message: `ZIP ${zip} is in our service area. Continue and offer to book.` }
    : {
        ok: true, in_area: false, served_zip_codes: tenant.serviceArea.zipCodes,
        message: `ZIP ${zip} is outside our service area. Do not book. Tell the caller we don't serve ${zip} yet and someone will follow up, then use create_callback. ` +
          `We serve these ZIP codes: ${tenant.serviceArea.zipCodes.join(", ")}. If the caller asks which areas we cover, tell them these. Don't check ${zip} again.`,
      };
}

export async function getAvailableSlots(d: Deps, tenant: TenantConfig, input: { service?: unknown }): Promise<ActionResult> {
  const service = matchService(tenant, input.service);
  const slots = (await d.calendar.getAvailableSlots(tenant, service.id, d.now())).slice(0, 3);
  d.events.log(tenant.tenantId, "slots.offered", "system", { serviceId: service.id, slots: slots.map((s) => s.start) });
  if (slots.length === 0) {
    return { ok: false, slots: [], message: "No openings in the next week. Offer a callback and use create_callback." };
  }
  return {
    ok: true,
    service_id: service.id,
    slots,
    message: `Available times for ${service.name}: ${slots.map((s, i) => `(${i + 1}) ${s.label} [start=${s.start}]`).join("; ")}. Offer these. When booking, pass the exact start value.`,
  };
}

export async function bookAppointment(
  d: Deps,
  tenant: TenantConfig,
  input: { name?: unknown; phone?: unknown; address?: unknown; zip?: unknown; service?: unknown; start?: unknown; notes?: unknown; source?: "phone" | "web" },
): Promise<ActionResult> {
  const name = clean(input.name);
  const start = clean(input.start);
  const phone = normalizePhone(input.phone);
  if (!name || !start) return { ok: false, message: "I need the caller's name and the chosen time to book." };

  const zip = clean(input.zip)?.replace(/\D/g, "").slice(0, 5);
  if (zip && !isInServiceArea(tenant, zip)) {
    return { ok: false, message: "This address is outside the service area. Do not book. Use create_callback." };
  }

  const service = matchService(tenant, input.service);
  try {
    const booking = await d.calendar.book(
      tenant,
      { serviceId: service.id, start, customerName: name, customerPhone: phone, address: clean(input.address), notes: clean(input.notes), source: input.source ?? "phone" },
      d.now(),
    );
    const when = DateTime.fromISO(booking.start).setZone(tenant.timezone).toFormat("cccc, LLLL d 'at' h:mm a");
    d.events.log(tenant.tenantId, "booking.created", input.source === "web" ? "user" : "ai", { bookingId: booking.id, serviceId: service.id, start: booking.start, source: booking.source });

    if (phone) {
      await d.messaging.sms(tenant, phone, `${tenant.businessName}: you're booked for ${service.name} on ${when}. Reply STOP to opt out.`, "booking_confirmation");
    }
    await d.messaging.notifyTeam(tenant, input.source === "web" ? "New online booking" : "New booking by AI receptionist", `${name} (${phone ?? "no phone"}) - ${service.name} on ${when}. ${clean(input.address) ?? ""} ${clean(input.notes) ?? ""}`.trim());

    return { ok: true, booking_id: booking.id, when, service_name: service.name, message: `Booked ${service.name} for ${name} on ${when}. Confirm this with the caller and say they'll get a text confirmation.` };
  } catch (err) {
    if (err instanceof SlotTakenError) {
      return { ok: false, message: "That time was just taken. Use get_available_slots again and offer new times." };
    }
    d.events.log(tenant.tenantId, "booking.failed", "system", { error: String(err) });
    return { ok: false, message: "Booking failed on our side. Apologize, and use create_callback so the team books it manually." };
  }
}

export async function createCallback(
  d: Deps,
  tenant: TenantConfig,
  input: { name?: unknown; phone?: unknown; reason?: unknown; notes?: unknown; urgent?: unknown },
): Promise<ActionResult> {
  const task = {
    id: randomUUID(),
    tenantId: tenant.tenantId,
    callerName: clean(input.name),
    callerPhone: normalizePhone(input.phone),
    reason: clean(input.reason) ?? "Caller needs a follow-up",
    notes: clean(input.notes),
    urgent: input.urgent === true || input.urgent === "true",
    status: "open" as const,
    createdAt: d.now().toISOString(),
  };
  d.store.data.callbacks.push(task);
  d.store.persist();
  d.events.log(tenant.tenantId, "callback.created", "ai", { callbackId: task.id, reason: task.reason, urgent: task.urgent });
  await d.messaging.notifyTeam(
    tenant,
    task.urgent ? "URGENT callback needed" : "Callback needed",
    `${task.callerName ?? "Caller"} (${task.callerPhone ?? "no number given"}): ${task.reason}. ${task.notes ?? ""}`.trim(),
  );
  return { ok: true, message: "Callback created. Tell the caller a team member will call them back as soon as possible." };
}

/** Alert on-call people by text. The live transfer itself is done by Bland. */
export async function emergencyAlert(
  d: Deps,
  tenant: TenantConfig,
  input: { name?: unknown; phone?: unknown; address?: unknown; description?: unknown },
): Promise<ActionResult> {
  const description = clean(input.description) ?? "Emergency reported";
  const phone = normalizePhone(input.phone);
  const text = `EMERGENCY for ${tenant.businessName}: ${description}. Caller ${clean(input.name) ?? ""} ${phone ?? "(no number)"} ${clean(input.address) ?? ""}`.replace(/\s+/g, " ").trim();
  d.events.log(tenant.tenantId, "emergency.reported", "ai", { description, keyword: findEmergency(tenant, description) });
  for (const n of tenant.emergency.onCallNumbers) await d.messaging.sms(tenant, n, text, "emergency_alert");
  await createCallback(d, tenant, { name: input.name, phone: input.phone, reason: `EMERGENCY: ${description}`, urgent: true });
  return { ok: true, message: "The on-call team has been alerted by text and will call back within 15 minutes. Tell the caller exactly that." };
}

// ---------- After the call / missed calls ----------

const TEXT_BACK_COOLDOWN_HOURS = 24;

/** Send the "sorry we missed you" text, at most once per caller per day. */
export async function sendTextBack(d: Deps, tenant: TenantConfig, rawPhone: unknown): Promise<ActionResult> {
  const phone = normalizePhone(rawPhone);
  if (!tenant.textBack.enabled) return { ok: false, message: "Text-back disabled for this business." };
  if (!phone) return { ok: false, message: "No valid caller number (blocked or anonymous)." };

  const since = d.now().getTime() - TEXT_BACK_COOLDOWN_HOURS * 3600_000;
  const recent = d.store.data.textBacks.some((t) => t.tenantId === tenant.tenantId && t.phone === phone && Date.parse(t.at) > since);
  if (recent) return { ok: false, message: "Already texted this caller in the last 24 hours." };

  const message = fillTemplate(tenant.textBack.message, { businessName: tenant.businessName, bookingLink: bookingLink(d, tenant) ?? "(booking link)" })
    + " Reply STOP to opt out.";
  const result = await d.messaging.sms(tenant, phone, message, "missed_call_text_back");
  if (result === "sent" || result === "simulated") {
    d.store.data.textBacks.push({ tenantId: tenant.tenantId, phone, at: d.now().toISOString() });
    d.store.persist();
  }
  d.events.log(tenant.tenantId, "text_back.processed", "system", { phone, result });
  return { ok: result === "sent" || result === "simulated", message: `Text-back ${result}.` };
}

/** Subset of Bland's post-call webhook that we use. */
export interface CallEndedPayload {
  call_id?: string;
  from?: string;
  to?: string;
  call_length?: number; // minutes
  summary?: string;
  concatenated_transcript?: string;
  transcripts?: { user?: string; text?: string }[];
  recording_url?: string;
}

const HANG_UP_MAX_MINUTES = 0.25; // 15 seconds

/**
 * Bookings made by the AI during this call get its callId, so the owner can see the call summary on the booking.
 * The call is saved when it ends (Bland's report can arrive a few minutes later), so "during the call" =
 * from (saved - length - 3 min) to "saved".
 */
function linkBookingsToCall(d: Pick<Deps, "store">, call: CallRecord): boolean {
  if (call.direction === "out") return false; // the team called the customer: the AI didn't book
  const end = Date.parse(call.createdAt);
  const start = end - (call.lengthMinutes + 3) * 60_000;
  let changed = false;
  for (const b of d.store.data.bookings) {
    if (b.tenantId !== call.tenantId || b.callId || b.source === "web" || phonesClash(b, call)) continue;
    const at = Date.parse(b.createdAt);
    if (at >= start && at <= end) { b.callId = call.callId; changed = true; }
  }
  return changed;
}

/** Both numbers are real phone numbers and they differ: a different customer's call. */
function phonesClash(b: { customerPhone?: string }, call: CallRecord): boolean {
  const x = (b.customerPhone ?? "").replace(/\D/g, "").slice(-10), y = (call.from ?? "").replace(/\D/g, "").slice(-10);
  return x.length === 10 && y.length === 10 && x !== y;
}

/** One-time fix for bookings saved before calls were linked (run at startup). */
export function linkExistingBookings(d: Pick<Deps, "store">): void {
  const calls = d.store.data.calls.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  let changed = false;
  for (const b of d.store.data.bookings) { // undo links that point to another customer's call
    const c = b.callId ? calls.find((x) => x.callId === b.callId) : undefined;
    if (c && phonesClash(b, c)) { delete b.callId; changed = true; }
  }
  for (const c of calls) changed = linkBookingsToCall(d, c) || changed;
  if (changed) d.store.persist();
}

export async function handleCallEnded(d: Deps, tenant: TenantConfig, p: CallEndedPayload): Promise<CallRecord> {
  const callerSpoke = (p.transcripts ?? []).some((t) => t.user === "user" && clean(t.text));
  const length = Number(p.call_length ?? 0);
  const isHangUp = !callerSpoke && length < HANG_UP_MAX_MINUTES;
  const fromPhone = normalizePhone(p.from);

  const record: CallRecord = {
    callId: p.call_id ?? randomUUID(),
    tenantId: tenant.tenantId,
    from: fromPhone ?? clean(p.from),
    to: clean(p.to),
    lengthMinutes: length,
    summary: clean(p.summary),
    transcript: clean(p.concatenated_transcript),
    recordingUrl: clean(p.recording_url),
    outcome: !fromPhone ? "spam" : isHangUp ? "hang_up" : "conversation",
    createdAt: d.now().toISOString(),
  };

  if (!d.store.data.calls.some((c) => c.callId === record.callId && c.tenantId === tenant.tenantId)) {
    d.store.data.calls.push(record);
    linkBookingsToCall(d, record);
    d.store.persist();
  }
  d.events.log(tenant.tenantId, "call.ended", "system", {
    callId: record.callId, from: record.from, lengthMinutes: length, outcome: record.outcome, summary: record.summary, recordingUrl: record.recordingUrl,
  });

  if (record.outcome === "hang_up") await sendTextBack(d, tenant, fromPhone);
  return record;
}

/** A reply text to our number: STOP opts out; anything else goes to the team (Speed-to-Lead not built yet). */
export async function handleInboundSms(d: Deps, tenant: TenantConfig, input: { from?: unknown; body?: unknown }): Promise<ActionResult> {
  const from = normalizePhone(input.from);
  const body = clean(input.body) ?? "";
  if (!from) return { ok: false, message: "Missing sender." };
  d.events.log(tenant.tenantId, "sms.received", "user", { from, body });
  d.store.data.messages.push({ id: randomUUID(), tenantId: tenant.tenantId, phone: from, direction: "in", body, at: d.now().toISOString() });
  d.store.persist();
  if (/^\s*(stop|stopall|unsubscribe|cancel|end|quit)\s*$/i.test(body)) {
    d.messaging.optOut(tenant, from);
    return { ok: true, message: "Opted out." };
  }
  await d.messaging.notifyTeam(tenant, "Customer replied to text", `${from}: ${body}`);
  return { ok: true, message: "Forwarded to team." };
}
