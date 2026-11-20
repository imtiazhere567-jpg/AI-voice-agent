import { randomUUID } from "node:crypto";
import type { TenantConfig } from "../../core/tenant-config/schema";
import * as actions from "./actions";
import type { Deps } from "./actions";
import { greeting, handle, newDialog, summarize, type DialogState } from "./dialog";
import { AIConversation } from "./ai-brain";
import { ClaudeCodeConversation, brainKind, prewarmClaudeCode } from "./claude-code-brain";

/**
 * Live calls for the phone simulator.
 * A call rings on the dashboard. Staff can answer it; if nobody answers within the
 * business's ring time, the AI picks up. If the caller hangs up while it is still
 * ringing, it counts as a missed call and the text-back is sent.
 */

const wordsOf = (t: string) => (t.toLowerCase().match(/[a-z0-9']+/g) ?? []).filter((w) => w.length > 2);

/** Longest run of words that appears in the same order in both texts. */
function longestRun(a: string[], b: string[]): number {
  let best = 0;
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < b.length; j++) {
      let k = 0;
      while (i + k < a.length && j + k < b.length && a[i + k] === b[j + k]) k++;
      if (k > best) best = k;
    }
  return best;
}

/**
 * True when the text is the AI's own voice picked up by the mic: a long piece of what the AI
 * just said, word for word. Real answers often reuse the AI's words ("full roof replacement
 * estimate" after the AI listed its services), so only long word-for-word repeats count.
 */
export function isEcho(text: string, recentAI: string[]): boolean {
  const w = wordsOf(text);
  if (w.length < 5) return false; // short answers are always real
  return recentAI.some((ai) => {
    const run = longestRun(w, wordsOf(ai));
    return run >= 5 && run / w.length >= 0.7;
  });
}

/** How long a call from the business rings on the customer's phone. */
export const OUTBOUND_RING_SECONDS = 30;

export type LiveStatus = "ringing" | "ai" | "staff" | "ended";

export interface LiveMessage {
  from: "caller" | "ai" | "staff" | "system";
  text: string;
  at: string;
}

export interface LiveCall {
  id: string;
  tenantId: string;
  /** The customer's number (also for calls the business makes). */
  from: string;
  /** "in" = the customer called the business. "out" = the business called the customer from the dashboard. */
  direction: "in" | "out";
  customerName?: string;
  staffName?: string;
  status: LiveStatus;
  startedAt: string;
  ringSeconds: number;
  answeredAt?: string;
  endedAt?: string;
  endedBy?: "caller" | "staff" | "ai" | "no_answer";
  handledBy?: "ai" | "staff";
  messages: LiveMessage[];
  suggestions: string[];
  transferred?: boolean;
  summary?: string;
}

export class LiveCalls {
  private calls = new Map<string, LiveCall>();
  private dialogs = new Map<string, DialogState>();
  private timers = new Map<string, NodeJS.Timeout>();
  private brains = new Map<string, AIConversation>();

  constructor(private deps: Deps, private tenantOf: (id: string) => TenantConfig | undefined) {
    prewarmClaudeCode(); // local Claude Code takes a while to boot: have one ready before the first call
  }

  private now() {
    return this.deps.now().toISOString();
  }
  private add(call: LiveCall, from: LiveMessage["from"], text: string) {
    call.messages.push({ from, text, at: this.now() });
  }

  /** Which real AI to use: the Claude API (key set), local Claude Code, or none = rules. Tests can turn it off. */
  useClaude = (): "claude" | "claude-code" | false => { const k = brainKind(); return k === "rules" ? false : k; };

  get(id: string): LiveCall | undefined {
    return this.calls.get(id);
  }

  /** Active calls, plus calls that ended in the last minute (so screens can show the result). */
  list(tenantId: string): LiveCall[] {
    const cutoff = this.deps.now().getTime() - 60_000;
    return [...this.calls.values()].filter(
      (c) => c.tenantId === tenantId && (c.status !== "ended" || Date.parse(c.endedAt!) > cutoff),
    );
  }

  start(tenant: TenantConfig, from: string): LiveCall {
    const call: LiveCall = {
      id: randomUUID(),
      tenantId: tenant.tenantId,
      from: actions.normalizePhone(from) ?? from,
      status: "ringing",
      startedAt: this.now(),
      ringSeconds: tenant.voice.ringSeconds,
      direction: "in",
      messages: [],
      suggestions: [],
    };
    this.calls.set(call.id, call);
    this.dialogs.set(call.id, newDialog(actions.normalizePhone(from)));
    const kind = this.useClaude();
    if (kind) {
      const Brain = kind === "claude-code" ? ClaudeCodeConversation : AIConversation;
      this.brains.set(call.id, new Brain(this.deps, tenant, actions.normalizePhone(from)));
    }
    this.add(call, "system", `Ringing ${tenant.businessName}…`);
    this.deps.events.log(tenant.tenantId, "call.incoming", "system", { from: call.from, callId: call.id });
    this.timers.set(call.id, setTimeout(() => this.aiAnswer(call.id), tenant.voice.ringSeconds * 1000));
    return call;
  }

  /** The business calls a customer from the dashboard. It rings on the customer's phone. */
  startOutbound(tenant: TenantConfig, to: string, opts: { customerName?: string; staffName?: string } = {}): LiveCall {
    const phone = actions.normalizePhone(to) ?? to;
    const call: LiveCall = {
      id: randomUUID(), tenantId: tenant.tenantId, from: phone, direction: "out", status: "ringing",
      startedAt: this.now(), ringSeconds: OUTBOUND_RING_SECONDS, messages: [], suggestions: [],
      customerName: opts.customerName, staffName: opts.staffName,
    };
    this.calls.set(call.id, call);
    this.add(call, "system", `Calling ${opts.customerName ?? phone}…`);
    this.deps.events.log(tenant.tenantId, "call.outgoing", "user", { to: phone, callId: call.id, by: opts.staffName });
    this.timers.set(call.id, setTimeout(() => void this.hangup(call.id, "no_answer"), OUTBOUND_RING_SECONDS * 1000));
    return call;
  }

  /** Calls from a business that are ringing on this phone number (for the phone simulator). */
  incomingFor(phone: string): LiveCall[] {
    const p = actions.normalizePhone(phone);
    return [...this.calls.values()].filter((c) => c.direction === "out" && c.status === "ringing" && c.from === p);
  }

  /** Every call a business is making right now that is still ringing (the test phone answers for any customer). */
  incomingAll(): LiveCall[] {
    return [...this.calls.values()].filter((c) => c.direction === "out" && c.status === "ringing");
  }

  /** The customer picks up a call from the business. */
  customerAnswer(id: string): LiveCall | undefined {
    const call = this.calls.get(id);
    if (!call || call.direction !== "out" || call.status !== "ringing") return call;
    clearTimeout(this.timers.get(id));
    call.status = "staff";
    call.handledBy = "staff";
    call.answeredAt = this.now();
    this.add(call, "system", `${call.customerName ?? "The customer"} answered.`);
    this.deps.events.log(call.tenantId, "call.outgoing_answered", "user", { callId: id, to: call.from });
    return call;
  }

  /** Nobody picked up (or staff chose "Let AI answer"): the AI takes the call. */
  aiAnswer(id: string): LiveCall | undefined {
    const call = this.calls.get(id);
    const tenant = call && this.tenantOf(call.tenantId);
    if (!call || !tenant || call.status !== "ringing" || call.direction === "out") return call;
    clearTimeout(this.timers.get(id));
    call.status = "ai";
    call.handledBy = "ai";
    call.answeredAt = this.now();
    this.add(call, "system", "No one answered. The AI receptionist picked up.");
    const g = greeting(tenant);
    g.say.forEach((t) => this.add(call, "ai", t));
    call.suggestions = this.brains.has(id) ? [] : g.suggestions;
    this.deps.events.log(tenant.tenantId, "call.answered", "ai", { callId: id, from: call.from });
    return call;
  }

  staffAnswer(id: string): LiveCall | undefined {
    const call = this.calls.get(id);
    if (!call || call.status === "ended" || call.status === "staff") return call;
    clearTimeout(this.timers.get(id));
    const tookOver = call.status === "ai";
    call.status = "staff";
    call.handledBy = "staff";
    call.answeredAt ??= this.now();
    call.suggestions = [];
    this.add(call, "system", tookOver ? "A team member took over the call from the AI." : "A team member answered the call.");
    this.deps.events.log(call.tenantId, "call.answered", "user", { callId: id, from: call.from, tookOver });
    return call;
  }

  async callerSay(id: string, text: string): Promise<LiveCall | undefined> {
    const call = this.calls.get(id);
    const tenant = call && this.tenantOf(call.tenantId);
    if (!call || !tenant || call.status === "ended" || call.status === "ringing" || !text.trim()) return call;
    // Echo guard: the phone mic can pick up the AI's own voice from the speaker.
    // If what "the caller said" is mostly the AI's last words, ignore it.
    if (isEcho(text, call.messages.filter((m) => m.from === "ai" || m.from === "staff").slice(-3).map((m) => m.text))) {
      this.deps.events.log(call.tenantId, "call.echo_ignored", "system", { callId: id, text: text.slice(0, 120) });
      return call;
    }
    this.add(call, "caller", text.trim().slice(0, 500));
    if (call.status === "ai") {
      const brain = this.brains.get(id);
      let turn: { say: string[]; suggestions?: string[]; end?: boolean; transfer?: boolean };
      try {
        turn = brain ? await brain.reply(text) : await handle(this.deps, tenant, this.dialogs.get(id)!, text);
      } catch (err) {
        this.deps.events.log(tenant.tenantId, "ai.error", "system", { error: String(err).slice(0, 300) });
        await actions.createCallback(this.deps, tenant, { phone: call.from, reason: "AI had a technical problem during the call" });
        turn = { say: ["Sorry, I'm having a technical problem. I've asked a team member to call you back right away."], end: true };
      }
      turn.say.forEach((t) => this.add(call, "ai", t));
      call.suggestions = turn.suggestions ?? [];
      if (turn.transfer) {
        call.transferred = true;
        this.add(call, "system", "Transferring to the on-call team…");
      }
      if (turn.end) await this.hangup(id, "ai");
    }
    return call;
  }

  staffSay(id: string, text: string): LiveCall | undefined {
    const call = this.calls.get(id);
    if (!call || call.status !== "staff" || !text.trim()) return call;
    this.add(call, "staff", text.trim().slice(0, 500));
    return call;
  }

  async hangup(id: string, by: "caller" | "staff" | "ai" | "no_answer"): Promise<LiveCall | undefined> {
    const call = this.calls.get(id);
    const tenant = call && this.tenantOf(call.tenantId);
    if (!call || !tenant || call.status === "ended") return call;
    clearTimeout(this.timers.get(id));
    if (call.direction === "out") return this.endOutbound(call, by);
    const wasRinging = call.status === "ringing";
    call.status = "ended";
    call.endedBy = by;
    call.endedAt = this.now();
    call.suggestions = [];
    this.add(call, "system", wasRinging ? "Caller hung up before anyone answered." : `Call ended by ${by === "ai" ? "the AI" : by}.`);

    const dialog = this.dialogs.get(id)!;
    const brain = this.brains.get(id);
    brain?.close();
    const aiSummary = brain ? brain.summary() : summarize(tenant, dialog);
    const aiActed = brain ? brain.outcome !== "none" : dialog.outcome !== "none";
    const talkMinutes = call.answeredAt ? (Date.parse(call.endedAt) - Date.parse(call.answeredAt)) / 60_000 : 0;
    call.summary = wasRinging
      ? "Caller hung up while the phone was ringing. Missed-call text sent."
      : call.handledBy === "staff"
        ? `Answered by a team member. ${aiActed ? aiSummary : ""}`.trim()
        : aiSummary;

    const record = await actions.handleCallEnded(this.deps, tenant, {
      call_id: call.id,
      from: call.from,
      call_length: wasRinging ? 0 : Math.max(talkMinutes, 0.3),
      summary: call.summary,
      concatenated_transcript: call.messages.filter((m) => m.from !== "system").map((m) => `${m.from}: ${m.text}`).join("\n"),
      transcripts: wasRinging ? [] : call.messages.filter((m) => m.from !== "system").map((m) => ({ user: m.from === "caller" ? "user" : "assistant", text: m.text })),
    });
    const name = brain?.name ?? dialog.name;
    if (name) record.callerName = name;
    if (!wasRinging) record.handledBy = call.handledBy;
    this.deps.store.persist();
    this.forgetLater(id);
    return call;
  }

  private forgetLater(id: string) {
    setTimeout(() => { this.calls.delete(id); this.dialogs.delete(id); this.timers.delete(id); this.brains.delete(id); }, 10 * 60_000).unref?.();
  }

  /** End a call the business made. No missed-call text here: the business was the one calling. */
  private endOutbound(call: LiveCall, by: "caller" | "staff" | "ai" | "no_answer"): LiveCall {
    const wasRinging = call.status === "ringing";
    const who = call.customerName ?? "the customer";
    const Who = who.charAt(0).toUpperCase() + who.slice(1);
    call.status = "ended";
    call.endedBy = by;
    call.endedAt = this.now();
    this.add(call, "system", wasRinging
      ? (by === "caller" ? `${Who} declined the call.` : by === "no_answer" ? `${Who} didn't answer.` : "You cancelled the call.")
      : `Call ended by ${by === "caller" ? who : "you"}.`);
    const minutes = call.answeredAt ? Math.max((Date.parse(call.endedAt) - Date.parse(call.answeredAt)) / 60_000, 0.1) : 0;
    call.summary = wasRinging
      ? `Your team called ${who}. ${by === "caller" ? "They declined the call." : by === "no_answer" ? "No answer." : "Cancelled before they answered."}`
      : `Your team called ${who} and talked for ${minutes < 1 ? "under a minute" : `${Math.round(minutes)} min`}.`;
    const talk = call.messages.filter((m) => m.from === "caller" || m.from === "staff");
    this.deps.store.data.calls.push({
      callId: call.id, tenantId: call.tenantId, from: call.from, lengthMinutes: minutes, summary: call.summary,
      transcript: talk.map((m) => `${m.from}: ${m.text}`).join("\n") || undefined,
      outcome: wasRinging ? "no_answer" : "conversation", handledBy: "staff", direction: "out",
      callerName: call.customerName, createdAt: call.endedAt,
    });
    this.deps.store.persist();
    this.deps.events.log(call.tenantId, "call.outgoing_ended", "user", { callId: call.id, to: call.from, answered: !wasRinging, endedBy: by });
    this.forgetLater(call.id);
    return call;
  }
}
