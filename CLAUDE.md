# SMB AI Automation — rules for every Claude Code session

Spec: `docs/spec.pdf`. Decisions that change the spec: `docs/decisions.md`.

## Current focus
Module 1 (AI Voice Receptionist) only. Module 2 (Speed-to-Lead) is skipped for now; Module 3 later.

## Rules
- Multi-business: nothing business-specific in code. Everything (name, hours, services, emergencies,
  questions, answers, prices) comes from the tenant config (`core/tenant-config/schema.ts`).
- Work one step at a time, small changes, each with tests (`npm test`, `npm run typecheck`).
- Every stored record carries `tenantId`.
- Rules first (ZIP, hours, emergency keywords are code). AI only for conversation and summaries.
- Voice provider is Bland AI, behind an adapter in `integrations/voice/` so it can be swapped.
- No Claude API key at runtime (owner decision). Bland handles conversation + summaries.
- Never send real SMS, calls or bookings when test mode is on (tenant `testMode` or `GLOBAL_TEST_MODE`).
- Never quote prices unless from the tenant's approved price list. Never promise insurance or diagnose.
- Always disclose "automated assistant" in the first sentence of every call.
- Never log secrets, API keys, or full card/bank details.
- Record spec-changing decisions in `docs/decisions.md`.
