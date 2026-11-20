import type { TenantConfig, Weekday } from "../tenant-config/schema";

/** Deterministic business rules. No AI here. */

export function isInServiceArea(tenant: TenantConfig, zip: string): boolean {
  const clean = zip.trim().slice(0, 5);
  return tenant.serviceArea.zipCodes.includes(clean);
}

/** Returns the matched emergency keyword, or null. Case-insensitive. */
export function findEmergency(tenant: TenantConfig, text: string): string | null {
  const lower = text.toLowerCase();
  return tenant.emergency.keywords.find((k) => lower.includes(k.toLowerCase())) ?? null;
}

const dayMap: Record<string, Weekday> = {
  Mon: "mon", Tue: "tue", Wed: "wed", Thu: "thu", Fri: "fri", Sat: "sat", Sun: "sun",
};

/** Is the business open at this moment, in the business's own time zone? */
export function isOpenAt(tenant: TenantConfig, when: Date): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tenant.timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(when);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const day = dayMap[get("weekday")];
  const hhmm = `${get("hour")}:${get("minute")}`;
  const periods = tenant.hours[day] ?? [];
  return periods.some((p) => hhmm >= p.open && hhmm < p.close);
}

/** Fill {placeholders} in a template string. */
export function fillTemplate(template: string, values: Record<string, string | undefined>): string {
  return template.replace(/\{(\w+)\}/g, (m, key) => values[key] ?? m);
}
