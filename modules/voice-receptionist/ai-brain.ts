import Anthropic from "@anthropic-ai/sdk";
import { DateTime } from "luxon";
import type { TenantConfig } from "../../core/tenant-config/schema.js";
import * as actions from "./actions.js";
import type { Deps } from "./actions.js";
import { buildFirstSentence, buildReceptionistPrompt } from "./prompt-builder.js";

/**
 * Real AI conversation (Claude) for the phone simulator.
 * Claude understands free speech, follows the owner's training + extra instructions,
 * and uses tools to check the service area, find times, book, create callbacks and alert on-call.
 * Turned on when ANTHROPIC_API_KEY is set. Without a key, the local Claude Code brain
 * (claude-code-brain.ts) is used if Claude Code is installed; otherwise the rule-based dialog.
 */

export const AI_MODEL = "claude-opus-5-5";

export function claudeAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

type Outcome = "none" | "info" | "booked" | "callback" | "emergency" | "out_of_area";

export interface BrainTurn {
  say: string[];
  end?: boolean;
  transfer?: boolean;
}

export const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "check_service_area",
    description: "Check whether a 5-digit ZIP code is inside the business's service area. Use it as soon as the caller gives a ZIP code.",
    input_schema: { type: "object", properties: { zip: { type: "string", description: "5-digit ZIP code" } }, required: ["zip"], additionalProperties: false },
  },
  {
    name: "get_available_slots",
    description: "Get the next open appointment times for a service. Offer the caller 2 or 3 of the returned times.",
    input_schema: { type: "object", properties: { service: { type: "string", description: "Service the caller wants, using the business's service name" } }, required: ["service"], additionalProperties: false },
  },
  {
    name: "book_appointment",
    description: "Book the appointment once the caller picked a time and you have their full name. 'start' must be the exact start value returned by get_available_slots.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Caller's full name" },
        phone: { type: "string", description: "Best phone number. Use the caller's number unless they gave a different one." },
        service: { type: "string" },
        start: { type: "string", description: "Exact start value of the chosen slot" },
        zip: { type: "string" },
        address: { type: "string" },
        notes: { type: "string", description: "Short notes: the problem and the answers to the qualifying questions" },
      },
      required: ["name", "service", "start"],
      additionalProperties: false,
    },
  },
  {
    name: "create_callback",
    description: "Create a task for a team member to call the caller back. Use when you cannot book, the caller wants a person, is upset, is outside the service area, or asked a business question you could not answer.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" }, phone: { type: "string" }, reason: { type: "string" }, notes: { type: "string" }, urgent: { type: "boolean", description: "True if the caller said it is urgent" } },
      required: ["reason", "urgent"],
      additionalProperties: false,
    },
  },
  {
    name: "emergency_alert",
    description: "Alert the on-call team immediately when the caller describes an emergency.",
    input_schema: {
      type: "object",
      properties: { description: { type: "string" }, name: { type: "string" }, phone: { type: "string" }, address: { type: "string" } },
      required: ["description"],
      additionalProperties: false,
    },
  },
  {
    name: "end_call",
    description: "Hang up after you have said goodbye. Set transfer=true when you are transferring an emergency caller to the on-call team.",
    input_schema: { type: "object", properties: { transfer: { type: "boolean" } }, required: [], additionalProperties: false },
  },
];

export function phoneCallRules(tenant: TenantConfig, callerPhone: string | undefined): string {
  const now = DateTime.now().setZone(tenant.timezone).toFormat("cccc, LLLL d yyyy, h:mm a");
  return `
# This is a live phone call
- Right now it is ${now} (${tenant.timezone}). The caller's number is ${callerPhone ?? "unknown"}.
- Everything you write is spoken out loud. Reply in 1 to 3 short, natural sentences. No lists, no markdown, no emojis.
- Ask one question at a time and listen to the answer. Never repeat a question the caller already answered.
- Answer questions as described in "Answering questions" above: business facts only from your instructions, general ${tenant.industry} questions from your own knowledge (briefly, "usually…", the team confirms details), and only questions you truly can't answer get "I'm not sure about that one. I'll note your question and a team member will get back to you on it." Don't say that for questions you can answer.
- A question you truly couldn't answer, or something you can't do (outside the service area, no open times): say so briefly, then ASK "Would you like me to create a request so our team can call you back?" Put any unanswered question in the callback notes.
  - If they say yes: get their name if you don't have it, ask "Is this urgent, or can it wait until our normal business hours?", then call create_callback (urgent true/false), then confirm "Your request has been created and our team will call you back soon," and ask if there is anything else.
  - If they say no: say "No problem" and ask if there is anything else.
- Question that has nothing to do with ${tenant.businessName} or ${tenant.industry} (weather, sports, general knowledge, other companies, jokes, personal advice): politely say you can only help with ${tenant.businessName} questions, then ask how you can help with that. Do not end the call.
- If the caller asks for a person: get their name, ask if it is urgent, create the callback, confirm it, and ask if there is anything else.
- Speech-to-text can be messy. If what the caller said is unclear, ask them to repeat it.
- When booking, read the times in a friendly way (for example "Tuesday at 9 AM"), never the raw start value.
- Never end the call on your own after a request, a booking or an unanswered question. Always ask "Is there anything else I can help you with?" first.
- Only when the caller says they are done (no, that's all, bye), say a short goodbye and call end_call. The one exception is an emergency transfer.`;
}

export class AIConversation {
  private messages: Anthropic.Beta.BetaMessageParam[];
  outcome: Outcome = "none";
  name?: string;
  bookedWhen?: string;
  service?: string;
  zip?: string;
  private _client?: Anthropic;
  private get client() { return (this._client ??= new Anthropic()); }
  protected system: string;

  constructor(protected d: Deps, protected tenant: TenantConfig, protected callerPhone?: string) {
    this.system = buildReceptionistPrompt(tenant) + "\n" + phoneCallRules(tenant, callerPhone);
    this.messages = [
      { role: "user", content: "(The call has connected. The caller has not said anything yet.)" },
      { role: "assistant", content: buildFirstSentence(tenant) },
    ];
  }

  greeting(): string {
    return buildFirstSentence(this.tenant);
  }

  /** Free anything the conversation holds (the Claude Code brain stops its process). */
  close(): void {}

  protected async runTool(name: string, input: Record<string, unknown>): Promise<{ text: string; end?: boolean; transfer?: boolean }> {
    const d = this.d, t = this.tenant;
    const phone = (input.phone as string | undefined) || this.callerPhone;
    switch (name) {
      case "check_service_area": {
        const r = actions.checkServiceArea(d, t, input);
        if (r.ok) this.zip = String(input.zip);
        if (r.ok && r.in_area === false) this.outcome = "out_of_area";
        return { text: r.message };
      }
      case "get_available_slots": {
        this.service = String(input.service ?? "");
        const r = await actions.getAvailableSlots(d, t, input);
        return { text: r.message };
      }
      case "book_appointment": {
        const r = await actions.bookAppointment(d, t, { ...input, phone, source: "phone" });
        if (r.ok) { this.outcome = "booked"; this.name = String(input.name); this.bookedWhen = String(r.when); this.service = String(r.service_name); }
        return { text: r.message };
      }
      case "create_callback": {
        if (input.name) this.name = String(input.name);
        const r = await actions.createCallback(d, t, { ...input, phone });
        if (this.outcome === "none" || this.outcome === "info") this.outcome = "callback";
        return { text: r.message };
      }
      case "emergency_alert": {
        this.outcome = "emergency";
        const r = await actions.emergencyAlert(d, t, { ...input, phone });
        return { text: r.message };
      }
      case "end_call":
        return { text: "Call ended.", end: true, transfer: input.transfer === true };
    }
    return { text: `Unknown tool ${name}` };
  }

  /** The caller said something. Returns what the AI says back. */
  async reply(text: string): Promise<BrainTurn> {
    this.messages.push({ role: "user", content: text });
    const said: string[] = [];
    let end = false, transfer = false;

    for (let step = 0; step < 8; step++) {
      const response = await this.client.beta.messages.create({
        model: AI_MODEL,
        max_tokens: 2000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "low" },
        system: this.system,
        tools: TOOLS,
        messages: this.messages,
      });

      if (response.stop_reason === "refusal") {
        return { say: ["Sorry, I can't help with that. Is there anything else about our services I can help with?"] };
      }
      // Keep the full content (including thinking blocks) in the history.
      this.messages.push({ role: "assistant", content: response.content });
      for (const b of response.content) if (b.type === "text" && b.text.trim()) said.push(b.text.trim());

      const uses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (!uses.length) break;

      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const u of uses) {
        try {
          const r = await this.runTool(u.name, (u.input ?? {}) as Record<string, unknown>);
          if (r.end) { end = true; transfer ||= Boolean(r.transfer); }
          results.push({ type: "tool_result", tool_use_id: u.id, content: r.text });
        } catch (err) {
          results.push({ type: "tool_result", tool_use_id: u.id, content: `Error: ${String(err)}`, is_error: true });
        }
      }
      this.messages.push({ role: "user", content: results });
      if (end) break;
    }
    if (this.outcome === "none" && said.length) this.outcome = "info";
    return { say: said, end, transfer };
  }

  summary(): string {
    const who = this.name ?? "Caller";
    const parts = [this.service ? `${who} asked about ${this.service.toLowerCase()}${this.zip ? ` (ZIP ${this.zip})` : ""}.` : `${who} called.`];
    const out: Record<Outcome, string> = {
      booked: `Booked for ${this.bookedWhen}. Confirmation text sent.`,
      callback: "Callback task created.",
      emergency: "Emergency reported. On-call team alerted.",
      out_of_area: "Outside service area. Callback task created.",
      info: "Questions answered by the AI.",
      none: "No booking made.",
    };
    parts.push(out[this.outcome]);
    return parts.join(" ");
  }
}
