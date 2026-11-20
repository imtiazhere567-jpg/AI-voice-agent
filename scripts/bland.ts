// Bland setup helper.
//   npm run bland -- status                         check key + list your numbers
//   npm run bland -- preview <tenantId>             show the config that would be sent (no changes)
//   npm run bland -- connect <tenantId> <+1number>  point a Bland number at this business's receptionist
import { loadTenantsFromDir } from "../core/tenant-config/loader";
import { BlandClient, buildBlandInboundConfig } from "../integrations/voice/bland";

try {
  process.loadEnvFile(".env");
} catch {}

const [cmd, tenantId, number] = process.argv.slice(2);
const tenants = loadTenantsFromDir(process.env.TENANTS_DIR || "test-data/tenants");
const bland = new BlandClient(process.env.BLAND_API_KEY ?? "");

function getTenant() {
  const t = tenantId && tenants.get(tenantId);
  if (!t) throw new Error(`Pick a business: ${[...tenants.keys()].join(", ")}`);
  return t;
}

function config() {
  const url = process.env.PUBLIC_BASE_URL;
  if (!url) throw new Error("Set PUBLIC_BASE_URL in .env first (your server's public https address).");
  return buildBlandInboundConfig(getTenant(), url, process.env.TOOL_SECRET ?? "");
}

if (cmd === "status") {
  const me = (await bland.me()) as { status?: string; billing?: { current_balance?: number } };
  console.log(`Account: ${me.status}, balance: $${me.billing?.current_balance}`);
  const { inbound_numbers = [] } = await bland.listInboundNumbers();
  console.log(inbound_numbers.length ? inbound_numbers.map((n) => `  ${n.phone_number}  webhook: ${n.webhook ?? "-"}`).join("\n") : "  No phone numbers yet.");
} else if (cmd === "preview") {
  const c = config();
  console.log(JSON.stringify({ ...c, webhook: c.webhook.replace(/token=[^&]+/, "token=[hidden]"), tools: c.tools.map((t) => ({ ...t, headers: "[hidden]" })) }, null, 2));
} else if (cmd === "connect") {
  if (!number) throw new Error("Usage: npm run bland -- connect <tenantId> <+1number>");
  const res = await bland.updateInboundNumber(number, config());
  console.log(JSON.stringify(res, null, 2));
  console.log(`\nDone. Add "phoneNumber": "${number}" to ${tenantId}'s settings file.`);
} else {
  console.log("Commands: status | preview <tenantId> | connect <tenantId> <+1number>");
}
