import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findEmergency, isInServiceArea, isOpenAt } from "../core/rules";
import { loadTenantsFromDir, parseTenant } from "../core/tenant-config/loader";
import { buildFirstSentence, buildReceptionistPrompt } from "../modules/voice-receptionist/prompt-builder";

const tenants = loadTenantsFromDir(fileURLToPath(new URL("../test-data/tenants", import.meta.url)));
const roofing = tenants.get("demo-roofing")!;
const spa = tenants.get("glow-med-spa")!;
const plumbing = tenants.get("quickfix-plumbing")!;

describe("multi-business config", () => {
  it("loads all three sample businesses", () => {
    expect([...tenants.keys()].sort()).toEqual(["demo-roofing", "glow-med-spa", "quickfix-plumbing"]);
  });

  it("new businesses start in test mode by default", () => {
    const { testMode, ...rest } = roofing;
    expect(parseTenant({ ...rest, tenantId: "new-biz" }).testMode).toBe(true);
  });

  it("rejects a broken config with a readable error", () => {
    expect(() => parseTenant({ ...roofing, timezone: undefined, serviceArea: { zipCodes: ["abc"] } })).toThrow(
      /serviceArea\.zipCodes\.0/,
    );
  });
});

describe("rules (no AI)", () => {
  it("checks service area per business", () => {
    expect(isInServiceArea(roofing, "77002")).toBe(true);
    expect(isInServiceArea(roofing, "77002-1234")).toBe(true);
    expect(isInServiceArea(roofing, "90210")).toBe(false);
    expect(isInServiceArea(spa, "77002")).toBe(false);
  });

  it("detects each business's own emergencies", () => {
    expect(findEmergency(roofing, "There's WATER COMING THROUGH my ceiling")).toBe("water coming through");
    expect(findEmergency(plumbing, "we have a burst pipe")).toBe("burst pipe");
    expect(findEmergency(spa, "I think I'm having an allergic reaction")).toBe("allergic reaction");
    expect(findEmergency(roofing, "I'd like a quote for a new roof")).toBeNull();
  });

  it("checks opening hours in the business's own time zone", () => {
    // Tue 2026-11-17 15:00 UTC = 09:00 Chicago (open), 10:00 New York (open)
    expect(isOpenAt(roofing, new Date("2026-11-17T15:00:00Z"))).toBe(true);
    // Tue 2026-11-17 02:00 UTC = Mon 20:00 Chicago (closed)
    expect(isOpenAt(roofing, new Date("2026-11-17T02:00:00Z"))).toBe(false);
    // Sunday: roofing closed
    expect(isOpenAt(roofing, new Date("2026-11-15T17:00:00Z"))).toBe(false);
    // Monday 16:00 UTC: spa is closed Mondays
    expect(isOpenAt(spa, new Date("2026-11-16T16:00:00Z"))).toBe(false);
  });
});

describe("call script", () => {
  it("discloses the automated assistant in the first sentence, for every business", () => {
    for (const t of tenants.values()) {
      expect(buildFirstSentence(t).toLowerCase()).toContain("automated assistant");
    }
  });

  it("builds a different script per business from the same template", () => {
    const r = buildReceptionistPrompt(roofing);
    const s = buildReceptionistPrompt(spa);
    expect(r).toContain("Demo Roofing Co.");
    expect(r).toContain("Roof inspection");
    expect(s).toContain("Glow Med Spa");
    expect(s).toContain("call 911");
    expect(r).not.toContain("Glow Med Spa");
    expect(r).not.toMatch(/\{\w+\}/); // no unfilled placeholders
    expect(s).not.toMatch(/\{\w+\}/);
  });

  it("only allows approved prices", () => {
    expect(buildReceptionistPrompt(plumbing)).toContain("Never quote any price");
    expect(buildReceptionistPrompt(spa)).toContain("$12 per unit");
  });
});
