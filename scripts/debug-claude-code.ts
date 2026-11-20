// Debug helper: talks to the local Claude Code brain directly and prints every step with timing.
// Run: npx tsx scripts/debug-claude-code.ts
import { ClaudeCodeConversation } from "../modules/voice-receptionist/claude-code-brain";
import { EventLog } from "../core/events";
import { Store } from "../core/store";
import { Messaging } from "../core/messaging";
import { loadTenantsFromDir } from "../core/tenant-config/loader";
import { LocalCalendar } from "../integrations/calendar/local-calendar";

process.env.CLAUDE_CODE_DEBUG = "1";
const tenant = loadTenantsFromDir("test-data/tenants").get("demo-roofing")!;
const store = new Store();
const events = new EventLog();
const deps = { store, events, messaging: new Messaging(events, store, undefined, true), calendar: new LocalCalendar(store), now: () => new Date() };

(async () => {
  const brain = new ClaudeCodeConversation(deps as never, tenant, "+15550100150");
  for (const say of process.argv.slice(2).length ? process.argv.slice(2) : ["hello", "what services do you offer?"]) {
    const t = Date.now();
    const r = await brain.reply(say);
    console.log(`\n>>> "${say}" -> (${((Date.now() - t) / 1000).toFixed(1)}s)`, r.say);
  }
  brain.close();
})().catch((e) => { console.error("FAILED", e); process.exit(1); });
