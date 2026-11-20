# Decisions log

| Date | Decision | Reason |
|---|---|---|
| 2026-11-13 | Build Module 1 (Voice Receptionist) first; skip Module 2 for now. | Owner priority. |
| 2026-11-13 | Missed-call text-back replies go to the owner (alert + record) instead of Module 2. | Module 2 not built yet. |
| 2026-11-13 | Voice provider: Bland AI, behind a swappable adapter. | Owner choice. |
| 2026-11-13 | No Claude API key at runtime. Bland's LLM handles the conversation and call summaries; rules run in our code. | Owner choice. Claude Code is used to build the system. |
| 2026-11-13 | Language: TypeScript (Node). | One language for server, tools and website snippet. |
| 2026-11-13 | Service area v1: ZIP code list. Radius needs geocoding, added later. | Keep v1 simple and deterministic. |
| 2026-11-13 | v1 storage is local JSON files (`data/`), every record has tenantId. Move to Postgres before the pilot. | Get the call flow working first; storage is behind a small interface. |
| 2026-11-13 | Built-in calendar (from business hours + booking rules) until Google Calendar / Calendly adapter is added. | Owner hasn't connected a calendar yet. |
| 2026-11-13 | Hang-up detection: call under 15 seconds where the caller never spoke = missed call, triggers text-back (max once per caller per 24h). `/missed-call/:tenantId` endpoint for phone systems that report missed calls directly. | Bland answers every forwarded call, so "hung up before answer" becomes "hung up during greeting". |
| 2026-11-13 | Bland SMS and warm transfer require a Bland paid plan (Agent Phone Plan / Enterprise). Until then texts are logged only; emergency uses `transfer_phone_number` (cold transfer) + SMS alerts. | Bland docs. |
| 2026-11-13 | No email provider yet: confirmation/alert emails are logged in the event log. | Add an email provider (e.g. Resend/SendGrid) later. |
| 2026-11-13 | Tool calls and webhooks are protected by a shared secret (`TOOL_SECRET`). | Server is public so Bland can reach it. |
| 2026-11-13 | Sample businesses (roofing, med spa, plumbing) are fictional, used to prove multi-business setup. | Owner asked to use sample data until real clients. |
| 2026-11-18 | Phone simulator uses the owner's local Claude Code (headless `claude -p`, their subscription) when installed; no API key. Never in production or for real customers. | Owner wants no API key; local testing only. Real calls stay on Bland. |
| 2026-11-18 | "Real test call (Bland)": a logged-in owner can have Bland's AI call their own phone, even in test mode. Uses Bland credit, max 5 minutes. A free Cloudflare quick tunnel is started on demand so Bland can reach the tool/webhook routes; dashboard and /api stay local-only. | Lets the owner try the real Bland receptionist without buying a number. Owner-initiated call to their own phone, not a customer contact. |
| 2026-11-18 | The AI answers general trade questions from its own knowledge (briefly, "usually…", team confirms on site). Business facts still come only from the tenant config. Only questions it truly can't answer get "I'm not sure, I'll note it for the team." | Owner wants a helpful receptionist, not "I'll note that" for every question. Safety rules unchanged (no made-up business facts, prices, diagnosis or insurance promises). |
| 2026-11-18 | The owner can edit the full AI script (Preview AI script → Edit). The edited version replaces the automatic one; the safety rules (approved prices only, no made-up facts, no diagnosing, no insurance promises) are always appended by the system. "Reset to automatic" returns to the generated script. | Owner asked to edit the script directly. While edited, changes in other training tabs don't flow into the script (shown as a warning). |
| 2026-11-20 | Live storage is Postgres (Neon via Vercel, or any Postgres) when DATABASE_URL is set: calls, bookings, callbacks, messages, users, sessions, the activity log and business settings. The app keeps data in memory and saves changes in the background (retries if the database is unreachable). First start on an empty database copies the old JSON files in. Without DATABASE_URL it still uses local files. | Needed to go live: local files are lost on hosting restarts. Runs as one server instance (Render/Railway style); not split across Vercel serverless functions. |
