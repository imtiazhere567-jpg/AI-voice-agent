import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fillTemplate } from "../../core/rules/index.js";
import type { TenantConfig } from "../../core/tenant-config/schema.js";

export const PROMPT_VERSION = "voice-receptionist/v1";

const templatePath = fileURLToPath(new URL(`../../prompts/${PROMPT_VERSION}.md`, import.meta.url));

const bullets = (items: string[]) => items.map((i) => `- ${i}`).join("\n");

/**
 * The script the AI follows. If the owner edited it (Preview AI script → Edit), their version is used,
 * and the safety rules are always added at the end so they can't be edited away.
 */
export function buildReceptionistPrompt(tenant: TenantConfig): string {
  const edited = tenant.scriptOverride?.trim();
  return edited ? `${edited}\n\n${safetyRules(tenant)}` : buildAutomaticPrompt(tenant);
}

const priceRuleFor = (tenant: TenantConfig) =>
  tenant.approvedPrices.length === 0
    ? "Never quote any price. Say the team will go over pricing with them."
    : `You may ONLY quote these exact prices. For anything else, say the team will go over pricing:\n${bullets(
        tenant.approvedPrices.map((p) => `${p.item}: ${p.price}`),
      )}`;

/** Always added after an edited script (the owner can't remove these). */
export function safetyRules(tenant: TenantConfig): string {
  return `# Safety rules (always on, added by the system)
- Prices: ${priceRuleFor(tenant)}
- Never make up facts about the business. Never diagnose the caller's specific problem. Never promise what insurance will cover.
- Use check_service_area for ZIP codes, get_available_slots and book_appointment to book, emergency_alert for emergencies, and create_callback for follow-ups.
- If the caller asks for a person, is upset, or you fail to understand them twice in a row: use create_callback and tell them a team member will call back.`;
}

/** The script built from the business's settings. Same code for every business. */
export function buildAutomaticPrompt(tenant: TenantConfig): string {
  const template = readFileSync(templatePath, "utf8");

  const emergencyInstruction =
    tenant.emergency.action === "redirect"
      ? `   If it is an emergency, say exactly: "${tenant.emergency.redirectMessage ?? "Please hang up and call 911."}" Then use the emergency_alert tool.`
      : `   If it is an emergency: get the caller's name, phone number and address quickly, use the emergency_alert tool, then tell the caller you are transferring them to the on-call team and transfer the call. If the transfer fails, tell the caller the on-call team has been alerted and will call back within 15 minutes.`;

  const priceRule = priceRuleFor(tenant);

  return fillTemplate(template, {
    businessName: tenant.businessName,
    industry: tenant.industry,
    greeting: tenant.voice.greeting,
    recordingNotice: tenant.recording.enabled ? tenant.recording.notice : "",
    emergencyKeywords: tenant.emergency.keywords.map((k) => `"${k}"`).join(", "),
    emergencyInstruction,
    qualifyingQuestions: tenant.qualifyingQuestions
      .map((q, i) => `   ${i + 1}. ${q.question}${q.required ? "" : " (optional)"}`)
      .join("\n"),
    services: bullets(tenant.services.map((s) => s.name)),
    openingHours: openingHours(tenant),
    timezone: tenant.timezone,
    serviceAreaZips: tenant.serviceArea.zipCodes.join(", "),
    serviceAreaLongNote: tenant.serviceArea.zipCodes.length > 10
      ? " The list is long: don't read all of it. Ask for their ZIP code, or give a few examples and offer to check one."
      : "",
    knowledgeBase: bullets(tenant.knowledgeBase.map((k) => `${k.topic}: ${k.answer}`)),
    priceRule,
    maxCallMinutes: String(tenant.voice.maxCallMinutes),
    customInstructions: tenant.customInstructions.trim() || "(none)",
  });
}

const DAY_NAMES = [["mon", "Monday"], ["tue", "Tuesday"], ["wed", "Wednesday"], ["thu", "Thursday"], ["fri", "Friday"], ["sat", "Saturday"], ["sun", "Sunday"]] as const;
const clock = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 || 12}${m ? ":" + String(m).padStart(2, "0") : ""} ${h < 12 ? "AM" : "PM"}`;
};

/** "- Monday: 7 AM to 6 PM" for every day; days without hours are closed. */
export function openingHours(tenant: TenantConfig): string {
  return bullets(DAY_NAMES.map(([k, name]) => {
    const periods = tenant.hours[k] ?? [];
    return `${name}: ${periods.length ? periods.map((p) => `${clock(p.open)} to ${clock(p.close)}`).join(" and ") : "closed"}`;
  }));
}

/** The first sentence the caller hears. Must contain the AI disclosure. */
export function buildFirstSentence(tenant: TenantConfig): string {
  return [tenant.voice.greeting, tenant.recording.enabled ? tenant.recording.notice : "", "How can I help you today?"]
    .filter(Boolean)
    .join(" ");
}
