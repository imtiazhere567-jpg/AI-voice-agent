import { z } from "zod";

/**
 * Tenant (business) configuration.
 * Everything a business can change lives here, never in code.
 */

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24h HH:MM, e.g. 07:30");
const phone = z.string().regex(/^\+[1-9]\d{6,14}$/, "Use E.164 format, e.g. +17135550100");

const openPeriod = z.object({ open: time, close: time });

export const weekdays = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof weekdays)[number];

export const tenantSchema = z.object({
  tenantId: z.string().regex(/^[a-z0-9-]+$/, "lowercase letters, numbers, dashes"),
  businessName: z.string().min(1),
  industry: z.string().min(1), // free text: "roofing", "med spa", "plumbing", ...
  timezone: z.string().min(1), // IANA, e.g. America/Chicago
  testMode: z.boolean().default(true),
  phoneNumber: phone.optional(), // the business's AI receptionist number (Bland), once purchased

  hours: z.record(z.enum(weekdays), z.array(openPeriod)), // missing day = closed

  serviceArea: z.object({
    zipCodes: z.array(z.string().regex(/^\d{5}$/)).min(1),
  }),

  services: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        appointmentMinutes: z.number().int().positive(),
      }),
    )
    .min(1),

  emergency: z.object({
    keywords: z.array(z.string().min(1)),
    // What the AI says/does. "transfer" = warm transfer to on-call. "redirect" = tell caller to call 911 etc.
    action: z.enum(["transfer", "redirect"]).default("transfer"),
    redirectMessage: z.string().optional(),
    onCallNumbers: z.array(phone), // tried in order
  }),

  qualifyingQuestions: z.array(
    z.object({
      field: z.string().regex(/^[a-z_]+$/),
      question: z.string(),
      required: z.boolean().default(true),
    }),
  ),

  knowledgeBase: z.array(z.object({ topic: z.string(), answer: z.string() })),

  // Prices may ONLY be quoted from this list. Empty = never quote prices.
  approvedPrices: z.array(z.object({ item: z.string(), price: z.string() })).default([]),

  booking: z.object({
    calendarProvider: z.enum(["google", "calendly", "none"]),
    bufferMinutes: z.number().int().min(0).default(30),
    maxPerDay: z.number().int().positive().default(8),
    minLeadHours: z.number().min(0).default(2),
  }),

  escalationContacts: z
    .array(
      z.object({
        name: z.string(),
        channel: z.enum(["sms", "email"]),
        to: z.string(),
      }),
    )
    .min(1),

  voice: z.object({
    greeting: z.string().min(1),
    language: z.string().default("en"),
    voiceId: z.string().optional(), // Bland voice name/id
    maxCallMinutes: z.number().positive().default(8),
    // How long the business phone rings before the AI picks up.
    ringSeconds: z.number().int().min(3).max(60).default(15),
  }),

  // Free-text extra instructions the owner writes to train the AI (tone, upsells, things to avoid...).
  customInstructions: z.string().max(4000).default(""),
  /** The owner's own edited version of the full AI script (Preview AI script → Edit). Empty = built automatically. */
  scriptOverride: z.string().max(20000).default(""),

  recording: z.object({
    enabled: z.boolean().default(true),
    notice: z.string().default("This call may be recorded for quality."),
    retentionDays: z.number().int().positive().default(90),
  }),

  textBack: z.object({
    enabled: z.boolean().default(true),
    message: z.string().min(1), // may use {businessName} and {bookingLink}
    bookingLink: z.string().url().optional(),
  }),
});

export type TenantConfig = z.infer<typeof tenantSchema>;
