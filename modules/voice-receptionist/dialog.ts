import { DateTime } from "luxon";
import { findEmergency, isInServiceArea } from "../../core/rules";
import type { TenantConfig } from "../../core/tenant-config/schema";
import type { Slot } from "../../integrations/calendar/local-calendar";
import * as actions from "./actions";
import type { Deps } from "./actions";
import { buildFirstSentence } from "./prompt-builder";

/**
 * Conversation engine for the phone SIMULATOR (and as a fallback).
 * Everything it says comes from the business's training settings, so it works for any industry.
 * Real phone calls are handled by Bland using the same settings (see prompt-builder).
 */

export type Stage = "need" | "zip" | "questions" | "slots" | "name" | "phone" | "offer_ticket" | "ticket_name" | "ticket_urgent" | "anything_else" | "ended";

export interface DialogState {
  stage: Stage;
  callerPhone?: string;
  serviceId?: string;
  zip?: string;
  answers: Record<string, string>;
  qIndex: number;
  slots: Slot[];
  chosen?: Slot;
  name?: string;
  phone?: string;
  misses: number;
  outcome: "none" | "info" | "booked" | "callback" | "emergency" | "out_of_area";
  bookedWhen?: string;
  asked: string[]; // questions the AI could not answer
  ticketReason?: string; // what the offered callback request is about
}

export interface Turn {
  say: string[];
  suggestions: string[];
  end?: boolean;
  transfer?: boolean;
}

export function newDialog(callerPhone?: string): DialogState {
  return { stage: "need", callerPhone, answers: {}, qIndex: 0, slots: [], misses: 0, outcome: "none", asked: [] };
}

// ---------- text helpers ----------
const STOP = new Set(["the", "and", "for", "with", "your", "you", "our", "are", "can", "will", "this", "that", "have", "what", "how", "does", "about", "from", "they", "there", "their", "need", "want", "would", "like", "service", "services"]);
const words = (t: string) => t.toLowerCase().match(/[a-z0-9']+/g) ?? [];
const stem = (w: string) => (w.length > 5 ? w.slice(0, 5) : w);
const cap = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());
const joinOr = (a: string[]) => (a.length <= 1 ? a.join("") : `${a.slice(0, -1).join(", ")} or ${a[a.length - 1]}`);

const RX = {
  human: /(speak|talk|transfer|connect|put me through|get me).{0,25}(person|human|someone|manager|owner|representative|staff|agent|somebody)|\b(real person|a human|operator|representative)\b/,
  // "I'm done" in many forms, anywhere in the sentence (plus a plain "no" at the start).
  bye: /^\s*(no|nope|nah|nothing)\b|\b(i (don'?t|do not) (want|need) (anything|nothing|it)|nothing else|not (now|today|needed)|no thanks?|no thank you|that'?s (all|it)|that will be all|bye|goodbye|i'?m (good|done|fine)|all good|never ?mind|forget it)\b/,
  yes: /\b(yes|yeah|yep|yup|sure|correct|right|ok|okay|please|that works|sounds good|this number|same number|that one)\b/,
  no: /^\s*(no|nope|nah|not really|different|another)\b/,
  price: /\b(price|prices|pricing|cost|costs|how much|charge|fee|fees|rate|rates|expensive|cheap)\b/,
  question: /\?|^(what|how|do|does|is|are|can|will|when|where|why|who|which)\b/,
  booking: /\b(book|booking|appointment|schedule|come out|come by|estimate|quote|visit|available|availability|consult|consultation|reserve)\b/,
  zip: /\b(\d{5})\b/,
};

function matchService(tenant: TenantConfig, text: string) {
  const t = text.toLowerCase();
  const tw = new Set(words(t).map(stem));
  const tokenCount = new Map<string, number>();
  const tokensOf = (name: string) => [...new Set(words(name).filter((w) => w.length > 2 && !STOP.has(w)).map(stem))];
  tenant.services.forEach((s) => tokensOf(s.name).forEach((k) => tokenCount.set(k, (tokenCount.get(k) ?? 0) + 1)));
  let best: { s: (typeof tenant.services)[number]; score: number } | undefined;
  for (const s of tenant.services) {
    let score = t.includes(s.name.toLowerCase()) ? 10 : 0;
    if (tw.has(stem(s.id))) score += 3;
    for (const k of tokensOf(s.name)) if (tw.has(k)) score += 1 / (tokenCount.get(k) ?? 1);
    if (score > 0 && (!best || score > best.score)) best = { s, score };
  }
  return best && best.score >= 0.5 ? best.s : undefined;
}

function matchKnowledge(tenant: TenantConfig, text: string) {
  const tw = new Set(words(text).filter((w) => !STOP.has(w)).map(stem));
  let best: { a: string; score: number } | undefined;
  for (const k of tenant.knowledgeBase) {
    let score = 0;
    for (const w of words(k.topic)) if (w.length > 2 && !STOP.has(w) && tw.has(stem(w))) score += 3;
    for (const w of new Set(words(k.answer))) if (w.length > 4 && !STOP.has(w) && tw.has(stem(w))) score += 1;
    if (score >= 3 && (!best || score > best.score)) best = { a: k.answer, score };
  }
  return best?.a;
}

// Words any business caller might use. Anything with none of these and none of the business's own words is off-topic.
const BUSINESS_WORDS = ["hour", "open", "close", "closed", "appointment", "book", "schedule", "available", "price", "cost", "pay", "payment", "financ", "insur", "warrant", "guarant", "locat", "address", "where", "servic", "estimat", "quote", "visit", "cancel", "reschedul", "licens", "staff", "team", "owner", "manager", "problem", "fix", "repair", "install", "replac", "inspect", "consult", "emergenc", "urgent", "discount", "offer", "review", "experienc", "area", "zip", "park"];

export function isRelevant(tenant: TenantConfig, text: string): boolean {
  const tw = words(text).filter((w) => w.length > 2 && !STOP.has(w)).map(stem);
  if (!tw.length) return true; // "hi", "hello", "ok" are fine
  const vocab = new Set<string>(BUSINESS_WORDS.map(stem));
  const add = (s: string) => words(s).filter((w) => w.length > 2 && !STOP.has(w)).forEach((w) => vocab.add(stem(w)));
  add(tenant.industry); add(tenant.businessName);
  tenant.services.forEach((s) => add(s.name));
  tenant.knowledgeBase.forEach((k) => { add(k.topic); add(k.answer); });
  tenant.emergency.keywords.forEach(add);
  tenant.qualifyingQuestions.forEach((q) => add(q.question));
  return tw.some((w) => vocab.has(w) || [...vocab].some((v) => v.length >= 4 && (w.startsWith(v) || v.startsWith(w))));
}

function priceAnswer(tenant: TenantConfig, text: string): string {
  if (!tenant.approvedPrices.length) return "I'm not able to quote prices over the phone, but the team will go over pricing with you.";
  const svc = matchService(tenant, text);
  const hit = tenant.approvedPrices.find((p) => text.toLowerCase().includes(p.item.toLowerCase()) || (svc && p.item.toLowerCase() === svc.name.toLowerCase()));
  if (hit) return `${hit.item} is ${hit.price}.`;
  return `Here's what I can share: ${tenant.approvedPrices.map((p) => `${p.item} is ${p.price}`).join(", ")}. For anything else, the team will go over pricing with you.`;
}

function questionSuggestions(tenant: TenantConfig, question: string): string[] {
  const q = question.toLowerCase();
  const ex = q.match(/for example,? ([^?.]+)/);
  if (ex) return [...ex[1].split(/,| or /).map((s) => cap(s.trim())).filter(Boolean), "Not sure"].slice(0, 4);
  if (/home or (a )?business/.test(q)) return ["Home", "Business"];
  if (/insurance/.test(q)) return ["Insurance claim", "Paying myself"];
  if (/(visited|been here|before|existing)/.test(q)) return ["Yes, I have", "No, first time"];
  if (/(treatment|service)/.test(q)) return tenant.services.slice(0, 4).map((s) => s.name);
  if (/(describe|problem|what happened)/.test(q)) return [];
  return ["Yes", "No", "Not sure"];
}

function pickSlot(slots: Slot[], text: string, tz: string): Slot | undefined {
  const t = text.toLowerCase();
  const local = slots.map((s) => DateTime.fromISO(s.start).setZone(tz));
  // just a number: "2" = the second option
  const only = t.match(/^\s*(?:#|option\s*|number\s*)?([1-3])\s*\.?\s*$/);
  if (only && slots[Number(only[1]) - 1]) return slots[Number(only[1]) - 1];
  // a time like "9", "9:30", "2 pm"
  const tm = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\b/);
  if (tm && !/^\d{3,}$/.test(tm[0])) {
    let h = Number(tm[1]);
    const m = tm[2] ? Number(tm[2]) : undefined;
    if (tm[3]?.startsWith("p") && h < 12) h += 12;
    const i = local.findIndex((d) => (d.hour === h || (!tm[3] && d.hour === h + 12)) && (m === undefined || d.minute === m));
    if (i >= 0) return slots[i];
  }
  const ord: [RegExp, number][] = [[/\b(first|1st|one|earliest|option 1)\b/, 0], [/\b(second|2nd|two|middle|option 2)\b/, 1], [/\b(third|3rd|three|last|latest|option 3)\b/, 2]];
  for (const [rx, i] of ord) if (rx.test(t) && slots[i]) return slots[i];
  const day = local.findIndex((d) => t.includes(d.toFormat("cccc").toLowerCase()));
  if (day >= 0) return slots[day];
  if (/\b(tomorrow)\b/.test(t)) { const i = local.findIndex((d) => d.hasSame(DateTime.now().setZone(tz).plus({ days: 1 }), "day")); if (i >= 0) return slots[i]; }
  if (RX.yes.test(t) && slots.length === 1) return slots[0];
  return undefined;
}

const short = (s: Slot, tz: string) => DateTime.fromISO(s.start).setZone(tz).toFormat("ccc h:mm a");

// ---------- conversation ----------

export function greeting(tenant: TenantConfig): Turn {
  return {
    say: [buildFirstSentence(tenant)],
    suggestions: [`I'd like to book ${tenant.services[0].name.toLowerCase()}`, tenant.knowledgeBase[0] ? `Question about ${tenant.knowledgeBase[0].topic}` : "What are your hours?", "Can I talk to a person?"],
  };
}

function stagePrompt(tenant: TenantConfig, s: DialogState): Turn {
  const qs = tenant.qualifyingQuestions.filter((q) => q.field !== "zip_code");
  switch (s.stage) {
    case "zip": return { say: ["What's the ZIP code where you need the service?"], suggestions: [tenant.serviceArea.zipCodes[0]] };
    case "questions": return { say: [qs[s.qIndex].question], suggestions: questionSuggestions(tenant, qs[s.qIndex].question) };
    case "slots": return { say: [`The open times are ${joinOr(s.slots.map((x) => x.label))}. Which works best?`], suggestions: s.slots.map((x) => short(x, tenant.timezone)) };
    case "name": return { say: ["Can I get your full name, please?"], suggestions: [] };
    case "phone": return s.callerPhone ? { say: ["Is the number you're calling from the best one to reach you?"], suggestions: ["Yes", "Use a different number"] } : { say: ["What's the best phone number to reach you?"], suggestions: [] };
    case "anything_else": return { say: ["Is there anything else I can help you with?"], suggestions: ["No, that's all", "Thank you"] };
    default: return { say: ["Would you like to book an appointment, or is there something else I can help with?"], suggestions: tenant.services.slice(0, 3).map((x) => `Book ${x.name.toLowerCase()}`) };
  }
}

const withPrompt = (tenant: TenantConfig, s: DialogState, lead: string[]): Turn => {
  const p = stagePrompt(tenant, s);
  return { say: [...lead, ...p.say], suggestions: p.suggestions };
};

/** Create the callback request (ticket), confirm it, and keep the call going. */
async function callback(d: Deps, tenant: TenantConfig, s: DialogState, reason: string, say: string[], urgent = false): Promise<Turn> {
  await actions.createCallback(d, tenant, { name: s.name, phone: s.phone ?? s.callerPhone, reason, notes: s.asked.length ? `Unanswered: ${s.asked.join(" | ")}` : undefined, urgent });
  if (s.outcome === "none" || s.outcome === "info") s.outcome = "callback";
  s.ticketReason = undefined;
  s.stage = "anything_else";
  return withPrompt(tenant, s, [...say, "Your request has been created, and our team will call you back soon."]);
}

const URGENT_Q = "Is this urgent, or can it wait until our normal business hours?";

/** Collect what we still need for the request (name, then urgency), then create it. */
function startTicket(s: DialogState, reason: string, lead: string[]): Turn {
  s.ticketReason = reason;
  if (!s.name) { s.stage = "ticket_name"; return { say: [...lead, "Can I get your name for the request?"], suggestions: [] }; }
  s.stage = "ticket_urgent";
  return { say: [...lead, URGENT_Q], suggestions: ["It's urgent", "It can wait"] };
}

/** Ask the caller if they want a callback request instead of hanging up. */
function offerTicket(s: DialogState, reason: string, lead: string[]): Turn {
  s.ticketReason = reason;
  s.stage = "offer_ticket";
  s.misses = 0;
  return { say: [...lead, "Would you like me to create a request so our team can call you back?"], suggestions: ["Yes, please", "No, thanks"] };
}

/** Move to the next thing we still need for a booking. */
async function advance(d: Deps, tenant: TenantConfig, s: DialogState, lead: string[]): Promise<Turn> {
  const needsZip = tenant.qualifyingQuestions.some((q) => q.field === "zip_code" && q.required);
  if (needsZip && !s.zip) { s.stage = "zip"; return withPrompt(tenant, s, lead); }
  if (s.zip && !isInServiceArea(tenant, s.zip)) {
    s.outcome = "out_of_area";
    return offerTicket(s, `Outside service area (ZIP ${s.zip})`, [...lead, `I'm sorry, ZIP ${s.zip} is outside the area we serve, so I can't book it.`]);
  }
  const qs = tenant.qualifyingQuestions.filter((q) => q.field !== "zip_code");
  while (s.qIndex < qs.length && s.answers[qs[s.qIndex].field]) s.qIndex++;
  if (s.qIndex < qs.length) { s.stage = "questions"; return withPrompt(tenant, s, lead); }
  if (!s.chosen) {
    const r = await actions.getAvailableSlots(d, tenant, { service: s.serviceId });
    s.slots = (r.slots as Slot[] | undefined) ?? [];
    if (!s.slots.length) return offerTicket(s, "Wanted to book but no open times", [...lead, "I don't see any open times this week."]);
    s.stage = "slots";
    return withPrompt(tenant, s, lead);
  }
  if (!s.name) { s.stage = "name"; return withPrompt(tenant, s, lead); }
  if (!s.phone) { s.stage = "phone"; return withPrompt(tenant, s, lead); }
  return book(d, tenant, s, lead);
}

async function book(d: Deps, tenant: TenantConfig, s: DialogState, lead: string[]): Promise<Turn> {
  const qs = tenant.qualifyingQuestions;
  const notes = Object.entries(s.answers).map(([f, v]) => `${qs.find((q) => q.field === f)?.question.replace(/\?$/, "") ?? f}: ${v}`).join("; ");
  const r = await actions.bookAppointment(d, tenant, { name: s.name, phone: s.phone, zip: s.zip, service: s.serviceId, start: s.chosen!.start, notes, source: "phone" });
  if (!r.ok) {
    s.chosen = undefined;
    return advance(d, tenant, s, [...lead, "Sorry, that time was just taken."]);
  }
  s.outcome = "booked";
  s.bookedWhen = String(r.when);
  s.stage = "anything_else";
  return withPrompt(tenant, s, [...lead, `You're all set, ${s.name!.split(" ")[0]}! I've booked your ${String(r.service_name).toLowerCase()} for ${r.when}. You'll get a text confirmation shortly.`]);
}

/** Handle one thing the caller said. */
export async function handle(d: Deps, tenant: TenantConfig, s: DialogState, raw: string): Promise<Turn> {
  const text = raw.trim();
  const t = text.toLowerCase();
  if (s.stage === "ended") return { say: [], suggestions: [], end: true };
  if (!t) return withPrompt(tenant, s, ["Sorry, I didn't catch that."]);

  // 1. Emergencies always come first
  if (findEmergency(tenant, t)) {
    s.outcome = "emergency";
    await actions.emergencyAlert(d, tenant, { description: text, name: s.name, phone: s.phone ?? s.callerPhone, address: s.zip });
    s.stage = "ended";
    if (tenant.emergency.action === "redirect") return { say: [tenant.emergency.redirectMessage ?? "If this is an emergency, please hang up and call 911."], suggestions: [], end: true };
    return { say: ["That sounds urgent. I'm alerting our on-call team right now and transferring you.", "If they can't pick up, they'll call you back within 15 minutes."], suggestions: [], end: true, transfer: true };
  }
  // 2. Caller wants a person: create the request right away
  if (RX.human.test(t) && !s.stage.startsWith("ticket")) return startTicket(s, "Caller asked to speak with a person", ["Of course, I'll have someone from the team call you back."]);
  // 3. Answer to "Would you like me to create a request?"
  if (s.stage === "offer_ticket") {
    if (RX.no.test(t) || RX.bye.test(t)) { s.ticketReason = undefined; s.stage = "anything_else"; return withPrompt(tenant, s, ["No problem."]); }
    if (RX.yes.test(t)) {
      // "Yes, my name is Ali Raza" -> take the name from the same sentence
      if (!s.name && /(my name|name is|i'?m |i am |this is |it'?s )/i.test(text)) { const nm = cleanName(text.replace(/^.*?(my name is|name is|my name's|i'?m|i am|this is|it'?s)\s+/i, "")); if (nm.length >= 2) s.name = nm; }
      return startTicket(s, s.ticketReason ?? "Caller needs a follow-up", ["Sure."]);
    }
    s.ticketReason = undefined; s.stage = "need"; // they said something else: treat it as a new request
  }
  if (s.stage === "ticket_name") {
    if (RX.bye.test(t) && !/name/i.test(t)) { s.ticketReason = undefined; s.stage = "anything_else"; return withPrompt(tenant, s, ["No problem, I won't create a request."]); }
    const nm = cleanName(text);
    if (nm.length >= 2) s.name = nm;
    s.stage = "ticket_urgent";
    return { say: [s.name ? `Thanks, ${s.name.split(" ")[0]}.` : "Thanks.", URGENT_Q], suggestions: ["It's urgent", "It can wait"] };
  }
  if (s.stage === "ticket_urgent") {
    const urgent = /\b(urgent|asap|right away|emergency|immediately|today|now|quick|yes)\b/.test(t) && !/\b(not urgent|can wait|no rush|not really|tomorrow|whenever)\b/.test(t);
    return callback(d, tenant, s, s.ticketReason ?? "Caller needs a follow-up", [urgent ? "Got it, I've marked it as urgent." : "Got it."], urgent);
  }
  // 4. Done?
  if ((s.stage === "anything_else" || s.stage === "need") && RX.bye.test(t)) { s.stage = "ended"; return { say: [`Thanks for calling ${tenant.businessName.replace(/\.$/, "")}. Have a great day!`], suggestions: [], end: true }; }
  if (s.stage === "anything_else") s.stage = "need";

  // 4. Side questions (price / FAQ) can be asked at any point
  if (s.stage !== "name" && s.stage !== "phone") {
    if (RX.price.test(t)) { if (s.outcome === "none") s.outcome = "info"; return withPrompt(tenant, s, [priceAnswer(tenant, text)]); }
    // A plain request like "I need a repair estimate" is a booking, not an FAQ question.
    const isAsk = RX.question.test(t) || (s.stage === "need" && !matchService(tenant, text) && !RX.booking.test(t));
    const kb = isAsk ? matchKnowledge(tenant, text) : undefined;
    if (kb) { if (s.outcome === "none") s.outcome = "info"; return withPrompt(tenant, s, [kb]); }
  }

  switch (s.stage) {
    case "need": {
      const svc = matchService(tenant, text);
      const zip = t.match(RX.zip)?.[1];
      if (zip) s.zip = zip;
      if (svc) { s.serviceId = svc.id; s.misses = 0; return advance(d, tenant, s, [`Sure, I can help you with ${svc.name.toLowerCase()}.`]); }
      if (RX.booking.test(t) || RX.yes.test(t)) {
        if (tenant.services.length === 1) { s.serviceId = tenant.services[0].id; return advance(d, tenant, s, ["Happy to help you book."]); }
        return { say: [`Happy to help. Which service do you need? We offer ${joinOr(tenant.services.map((x) => x.name.toLowerCase()))}.`], suggestions: tenant.services.map((x) => x.name) };
      }
      if (!isRelevant(tenant, text)) {
        return withPrompt(tenant, s, [`Sorry, I can only help with questions about ${tenant.businessName.replace(/\.$/, "")}, like booking ${tenant.services[0].name.toLowerCase()}, our hours, or our services.`]);
      }
      if (RX.question.test(t)) {
        s.asked.push(text);
        return offerTicket(s, `Question the AI could not answer: "${text}"`, ["Good question. I don't have that information right now."]);
      }
      if (++s.misses >= 2) return offerTicket(s, "AI could not understand the caller", ["I'm sorry, I'm having trouble understanding."]);
      return { say: [`Sorry, I didn't quite get that. Which service do you need? We offer ${joinOr(tenant.services.map((x) => x.name.toLowerCase()))}.`], suggestions: tenant.services.map((x) => x.name) };
    }
    case "zip": {
      const zip = t.match(RX.zip)?.[1];
      if (!zip) {
        if (++s.misses >= 3) return offerTicket(s, "Could not get a valid ZIP code", ["I'm sorry, I'm having trouble with that."]);
        return { say: ["Sorry, I need the 5-digit ZIP code. Could you say it again?"], suggestions: [tenant.serviceArea.zipCodes[0]] };
      }
      s.zip = zip; s.misses = 0;
      return advance(d, tenant, s, isInServiceArea(tenant, zip) ? ["Great, we serve that area."] : []);
    }
    case "questions": {
      const q = tenant.qualifyingQuestions.filter((x) => x.field !== "zip_code")[s.qIndex];
      s.answers[q.field] = text;
      s.qIndex++;
      return advance(d, tenant, s, ["Got it."]);
    }
    case "slots": {
      const slot = pickSlot(s.slots, text, tenant.timezone);
      if (!slot) {
        if (++s.misses >= 3) return offerTicket(s, "Could not agree on a time", ["Sorry, I couldn't find a time that works."]);
        return withPrompt(tenant, s, ["Sorry, which time would you like?"]);
      }
      s.chosen = slot; s.misses = 0;
      return advance(d, tenant, s, [`${slot.label} it is.`]);
    }
    case "name": {
      const name = cleanName(text);
      if (name.length < 2) return { say: ["Sorry, could you tell me your name again?"], suggestions: [] };
      s.name = name;
      return advance(d, tenant, s, [`Thanks, ${name.split(" ")[0]}.`]);
    }
    case "phone": {
      const typed = actions.normalizePhone(text);
      if (typed) s.phone = typed;
      else if (s.callerPhone && RX.yes.test(t) && !RX.no.test(t)) s.phone = s.callerPhone;
      else if (RX.no.test(t)) return { say: ["Sure, what number should we use?"], suggestions: [] };
      else return { say: ["Sorry, could you say that phone number again?"], suggestions: [] };
      return advance(d, tenant, s, []);
    }
  }
  return withPrompt(tenant, s, []);
}

function cleanName(text: string): string {
  return cap(text.replace(/^(hi|hello|hey)[,!.\s]+/i, "").replace(/^(sure|yes|yeah|ok|okay)[,!.\s]+/i, "").replace(/^please[,!.\s]+/i, "").replace(/^(my name is|my name's|this is|it'?s|i'?m|i am|name'?s)\s+/i, "").replace(/[^a-zA-Z'\-\s]/g, "").trim().split(/\s+/).slice(0, 4).join(" "));
}

/** Short summary for the owner, built from what was collected. */
export function summarize(tenant: TenantConfig, s: DialogState): string {
  const who = s.name ?? "Caller";
  const svc = tenant.services.find((x) => x.id === s.serviceId)?.name;
  const parts: string[] = [];
  if (svc) parts.push(`${who} asked about ${svc.toLowerCase()}${s.zip ? ` (ZIP ${s.zip})` : ""}.`);
  else parts.push(`${who} called.`);
  const answers = Object.values(s.answers);
  if (answers.length) parts.push(`Answers: ${answers.join("; ")}.`);
  const out: Record<DialogState["outcome"], string> = {
    booked: `Booked for ${s.bookedWhen}. Confirmation text sent.`,
    callback: "Callback task created.",
    emergency: "Emergency reported. On-call team alerted.",
    out_of_area: "Outside service area. Callback task created.",
    info: "Answered questions from the knowledge base.",
    none: "No booking made.",
  };
  parts.push(out[s.outcome]);
  if (s.asked.length) parts.push(`Could not answer: ${s.asked.join(" | ")}`);
  return parts.join(" ");
}
