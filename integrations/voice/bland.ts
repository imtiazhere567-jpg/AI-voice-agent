import type { SmsProvider } from "../../core/messaging/index.js";
import type { TenantConfig } from "../../core/tenant-config/schema.js";
import { buildFirstSentence, buildReceptionistPrompt } from "../../modules/voice-receptionist/prompt-builder.js";

const BLAND_API = "https://api.bland.ai";

/** Thin Bland API client. The API key is only ever sent to Bland. */
export class BlandClient implements SmsProvider {
  constructor(private apiKey: string, private baseUrl = BLAND_API) {
    if (!apiKey) throw new Error("BLAND_API_KEY is missing. Add it to .env");
  }

  private async request<T = unknown>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: { authorization: this.apiKey, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Bland ${method} ${path} failed (${res.status}): ${text.slice(0, 500)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  me() {
    return this.request("GET", "/v1/me");
  }

  listInboundNumbers() {
    return this.request<{ inbound_numbers?: { phone_number: string; webhook?: string }[] }>("GET", "/v1/inbound");
  }

  /** Buys a US number (about $15/month, charged by Bland). */
  purchaseNumber(areaCode: string) {
    return this.request("POST", "/v1/inbound/purchase", { area_code: areaCode, country_code: "US" });
  }

  updateInboundNumber(phoneNumber: string, config: BlandInboundConfig) {
    return this.request("POST", `/v1/inbound/${encodeURIComponent(phoneNumber)}`, config);
  }

  /** Bland's AI calls a phone number (uses Bland credit). Calls outside the US/Canada need purchased credit. */
  sendCall(body: BlandOutboundCall) {
    return this.request<{ status?: string; message?: string; call_id?: string; errors?: unknown }>("POST", "/v1/calls", body);
  }

  // ---- Web agents: talk to Bland's AI in the browser (no phone call) ----
  createAgent(body: BlandWebAgent) {
    return this.request<{ status?: string; message?: string; agent_id?: string; agent?: { agent_id?: string } }>("POST", "/v1/agents", body);
  }

  updateAgent(agentId: string, body: BlandWebAgent) {
    return this.request<{ status?: string; message?: string }>("POST", `/v1/agents/${encodeURIComponent(agentId)}`, body);
  }

  /** Single-use session token the browser uses to start the web call. */
  authorizeAgent(agentId: string) {
    return this.request<{ token?: string; status?: string; message?: string }>("POST", `/v1/agents/${encodeURIComponent(agentId)}/authorize`, {});
  }

  /**
   * Speak a short text in a voice and return it as a WAV file (docs.bland.ai/api-v2/post/tts).
   * Costs about $0.015 per 1,000 characters (minimum $0.001), so callers should cache the result.
   */
  async speakSample(voiceId: string, text: string): Promise<{ wav: Buffer; cost?: string }> {
    const res = await fetch(this.baseUrl + "/v2/tts", {
      method: "POST",
      headers: { authorization: this.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ text, voice: voiceId, audio: { encoding: "pcm_s16le", sample_rate: 24000, container: "wav" } }),
    });
    if (res.ok) return { wav: Buffer.from(await res.arrayBuffer()), cost: res.headers.get("x-cost") ?? undefined };
    const err = (await res.text()).slice(0, 300);
    // The new service only speaks Bland's newer voices (V2/V3). Older voices use the older sample service.
    if (res.status === 400 && /unsupported_voice/.test(err)) return this.speakSampleOld(voiceId, text);
    throw new Error(`Bland POST /v2/tts failed (${res.status}): ${err}`);
  }

  /** Older sample service (POST /v1/voices/{id}/sample): works for every voice type. About $0.0012 per sample. */
  private async speakSampleOld(voiceId: string, text: string): Promise<{ wav: Buffer; cost?: string }> {
    const res = await fetch(`${this.baseUrl}/v1/voices/${encodeURIComponent(voiceId)}/sample`, {
      method: "POST",
      headers: { authorization: this.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok || !/audio/.test(res.headers.get("content-type") ?? "")) {
      throw new Error(`Bland POST /v1/voices/sample failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    }
    return { wav: Buffer.from(await res.arrayBuffer()), cost: res.headers.get("x-cost") ?? undefined };
  }

  /** All voices the account can use (free to list). */
  listVoices() {
    return this.request<{ voices?: BlandVoice[] }>("GET", "/v1/voices");
  }

  getCall(callId: string) {
    return this.request<BlandCallDetails>("GET", `/v1/calls/${encodeURIComponent(callId)}`);
  }

  /** Requires a Bland plan with SMS (Agent Phone Plan / Enterprise). */
  async sendSms(fromNumber: string, toNumber: string, message: string): Promise<void> {
    await this.request("POST", "/v1/sms/send", { agent_number: fromNumber, user_number: toNumber, agent_message: message });
  }
}

export interface BlandTool {
  name: string;
  description: string;
  speech?: string;
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: Record<string, string>;
  input_schema: { example: Record<string, unknown>; type: "object"; properties: Record<string, { type: string; description: string }>; required?: string[] };
  response: Record<string, string>;
}

export interface BlandInboundConfig {
  prompt: string;
  first_sentence: string;
  voice?: string;
  model: "base";
  language: string;
  record: boolean;
  max_duration: number;
  transfer_phone_number?: string;
  webhook: string;
  metadata: Record<string, string>;
  summary_prompt: string;
  tools: BlandTool[];
}

/** POST /v1/calls body (docs.bland.ai/api-v1/post/calls). The prompt field is "task" here. */
export interface BlandOutboundCall extends Omit<BlandInboundConfig, "prompt" | "model"> {
  phone_number: string;
  task: string;
  wait_for_greeting: boolean;
}

export interface BlandVoice {
  id: string;
  name: string;
  description?: string | null;
  public?: boolean;
  is_live?: boolean;
  tags?: string[] | null;
  ratings?: number | null;
  total_ratings?: number | null;
  average_rating?: number | null;
}

/** A short, sorted list for the voice picker: usable English voices, Bland's curated ones and best rated first. */
export function pickerVoices(all: BlandVoice[]) {
  // Hide only voices marked as another language (many good voices, like Bland's curated ones, have no language tag).
  const OTHER_LANG = /\b(french|spanish|italian|german|dutch|portuguese|hindi|arabic|chinese|mandarin|japanese|korean|russian|polish|turkish|swedish|tagalog|vietnamese)\b/i;
  const english = (v: BlandVoice) => { const s = [...(v.tags ?? []), v.description ?? ""].join(" "); return /english|american|british|australian/i.test(s) || !OTHER_LANG.test(s); };
  const gender = (v: BlandVoice) => { const s = [...(v.tags ?? []), v.description ?? ""].join(" "); return /\bfemale\b|\bwoman\b/i.test(s) ? "female" : /\bmale\b|\bman\b/i.test(s) ? "male" : ""; };
  return all
    .filter((v) => v.public && v.is_live && english(v) && !/^Public - /.test(v.name))
    .map((v) => ({
      id: v.id,
      name: v.name,
      description: (v.description ?? "").trim().replace(/\.$/, ""),
      gender: gender(v),
      curated: (v.tags ?? []).includes("Bland Curated"),
      ratings: v.total_ratings ?? v.ratings ?? 0,
      rating: v.average_rating ?? null,
    }))
    .sort((a, b) => Number(b.curated) - Number(a.curated) || b.ratings - a.ratings)
    .map((v, i, arr) => { const n = arr.slice(0, i).filter((x) => x.name.toLowerCase() === v.name.toLowerCase()).length; return n ? { ...v, name: `${v.name} ${n + 1}` } : v; }); // "Allan", "Allan 2"
}

export interface BlandCallDetails {
  status?: string; // completed, failed, busy, no-answer, canceled, unknown
  queue_status?: string;
  completed?: boolean;
  error_message?: string | null;
  summary?: string;
  call_length?: number;
  price?: number;
  concatenated_transcript?: string;
  transcripts?: { user: string; text: string }[];
}

/**
 * A test call: Bland's AI calls the owner's own phone so they can try the real receptionist
 * without buying a phone number. Same instructions and tools as a real inbound call.
 */
export function buildBlandTestCall(tenant: TenantConfig, publicBaseUrl: string, toolSecret: string, phone: string): BlandOutboundCall {
  const { prompt, model: _model, metadata, ...rest } = buildBlandInboundConfig(tenant, publicBaseUrl, toolSecret);
  return {
    ...rest,
    phone_number: phone,
    task:
      `This is a TEST CALL. The business owner asked to try the receptionist, so you are calling their phone. ` +
      `After your first sentence, act exactly as if they had called ${tenant.businessName}: they are the caller.\n\n${prompt}`,
    wait_for_greeting: true, // let them say "hello" first, like answering a phone
    max_duration: Math.min(rest.max_duration, 5), // keep test calls short to save credit
    metadata: { ...metadata, test_call: "true" },
  };
}

/** Web agent settings (docs.bland.ai/api-v1/post/agents). */
export interface BlandWebAgent {
  prompt: string;
  first_sentence: string;
  voice?: string;
  model: "base";
  language: string;
  max_duration: number;
  webhook: string;
  metadata: Record<string, string>;
  tools: BlandTool[];
}

/** The same receptionist as on real calls, but the person talks from the browser (owner testing). */
export function buildBlandWebAgent(tenant: TenantConfig, publicBaseUrl: string, toolSecret: string): BlandWebAgent {
  const c = buildBlandInboundConfig(tenant, publicBaseUrl, toolSecret);
  return {
    prompt: `This is a TEST from the business owner, talking to you from a web browser instead of a phone. Treat them exactly like a caller of ${tenant.businessName}. ` +
      `You don't know their phone number: ask for it when you need it (booking, callback).\n\n${c.prompt}`,
    first_sentence: c.first_sentence.slice(0, 199),
    ...(c.voice ? { voice: c.voice } : {}),
    model: "base", // "turbo" doesn't support custom tools
    language: c.language,
    max_duration: Math.min(c.max_duration, 5),
    webhook: c.webhook,
    metadata: { ...c.metadata, web_call: "true" },
    tools: c.tools,
  };
}

interface ToolSpec {
  name: string;
  path: string;
  description: string;
  speech?: string;
  fields: Record<string, { description: string; example: string; required?: boolean }>;
}

const TOOL_SPECS: ToolSpec[] = [
  {
    name: "check_service_area",
    path: "check-service-area",
    description: "Check whether a ZIP code is inside the business's service area. Use as soon as you know the ZIP code.",
    speech: "One moment while I check that.",
    fields: { zip: { description: "5-digit ZIP code", example: "77002", required: true } },
  },
  {
    name: "get_available_slots",
    path: "available-slots",
    description: "Get the next open appointment times for a service.",
    speech: "Let me check the calendar.",
    fields: { service: { description: "Service the caller wants", example: "inspection" } },
  },
  {
    name: "book_appointment",
    path: "book",
    description: "Book the appointment after the caller picked a time. 'start' must be the exact start value from get_available_slots.",
    speech: "Great, booking that now.",
    fields: {
      name: { description: "Caller's full name", example: "Sarah Lee", required: true },
      phone: { description: "Best callback phone number (required: ask for it and read it back)", example: "7135550199", required: true },
      address: { description: "Street address of the job / caller", example: "123 Main St, Houston TX" },
      zip: { description: "ZIP code", example: "77002" },
      service: { description: "Service to book", example: "inspection" },
      start: { description: "Exact start value of the chosen slot", example: "2026-11-17T09:00:00.000-06:00", required: true },
      notes: { description: "Short notes: problem description and answers to the questions", example: "Missing shingles after storm; home; insurance claim" },
    },
  },
  {
    name: "create_callback",
    path: "callback",
    description: "Create a task for a team member to call the caller back. Use when you cannot book, the caller wants a person, is upset, or asked something you cannot answer.",
    fields: {
      name: { description: "Caller's name", example: "John Smith" },
      phone: { description: "Callback phone number (required: ask for it and read it back)", example: "7135550199", required: true },
      reason: { description: "Why they need a callback", example: "Wants to speak to the owner about a warranty" },
      notes: { description: "Anything else useful, including any question you couldn't answer", example: "Prefers mornings" },
      urgent: { description: "\"true\" if the caller said it is urgent, \"false\" if it can wait until business hours", example: "false" },
    },
  },
  {
    name: "emergency_alert",
    path: "emergency",
    description: "Alert the on-call team about an emergency. Use immediately when the caller describes an emergency.",
    speech: "I'm alerting our on-call team right now.",
    fields: {
      description: { description: "What is happening", example: "Water coming through the ceiling", required: true },
      name: { description: "Caller's name", example: "John Smith" },
      phone: { description: "Callback phone number", example: "7135550199" },
      address: { description: "Address", example: "123 Main St" },
    },
  },
];

export function buildBlandTools(tenant: TenantConfig, publicBaseUrl: string, toolSecret: string): BlandTool[] {
  const base = publicBaseUrl.replace(/\/$/, "");
  return TOOL_SPECS.map((t) => ({
    name: t.name,
    description: t.description,
    ...(t.speech ? { speech: t.speech } : {}),
    url: `${base}/tools/${tenant.tenantId}/${t.path}`,
    method: "POST",
    headers: { "x-tool-secret": toolSecret },
    body: Object.fromEntries(Object.keys(t.fields).map((f) => [f, `{{input.${f}}}`])),
    input_schema: {
      example: Object.fromEntries(Object.entries(t.fields).map(([f, v]) => [f, v.example])),
      type: "object",
      properties: Object.fromEntries(Object.entries(t.fields).map(([f, v]) => [f, { type: "string", description: v.description }])),
      required: Object.entries(t.fields).filter(([, v]) => v.required).map(([f]) => f),
    },
    response: { result: "$.message" },
  }));
}

/** Everything Bland needs to run this business's receptionist. Same code for every business. */
export function buildBlandInboundConfig(tenant: TenantConfig, publicBaseUrl: string, toolSecret: string): BlandInboundConfig {
  if (!/^https:\/\//.test(publicBaseUrl)) throw new Error("PUBLIC_BASE_URL must start with https:// (Bland requirement)");
  const base = publicBaseUrl.replace(/\/$/, "");
  return {
    prompt: buildReceptionistPrompt(tenant),
    first_sentence: buildFirstSentence(tenant),
    ...(tenant.voice.voiceId ? { voice: tenant.voice.voiceId } : {}),
    model: "base", // "turbo" does not support tools or transfers
    language: tenant.voice.language === "en" ? "en-US" : tenant.voice.language,
    record: tenant.recording.enabled,
    max_duration: tenant.voice.maxCallMinutes,
    ...(tenant.emergency.action === "transfer" && tenant.emergency.onCallNumbers[0]
      ? { transfer_phone_number: tenant.emergency.onCallNumbers[0] }
      : {}),
    webhook: `${base}/webhooks/bland/${tenant.tenantId}/call-ended?token=${encodeURIComponent(toolSecret)}`,
    metadata: { tenantId: tenant.tenantId },
    summary_prompt:
      "Summarize this call for the business owner in 2-4 short sentences: who called, what they need, urgency, " +
      "answers to qualifying questions, and the outcome (booked / callback needed / emergency / no action). " +
      "List any question the assistant could not answer.",
    tools: buildBlandTools(tenant, base, toolSecret),
  };
}
