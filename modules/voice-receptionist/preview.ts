// Usage: npm run preview-prompt -- demo-roofing
import { fileURLToPath } from "node:url";
import { loadTenantsFromDir } from "../../core/tenant-config/loader";
import { buildReceptionistPrompt } from "./prompt-builder";

const tenants = loadTenantsFromDir(fileURLToPath(new URL("../../test-data/tenants", import.meta.url)));
const id = process.argv[2];

if (!id || !tenants.has(id)) {
  console.log(`Pick a business: ${[...tenants.keys()].join(", ")}`);
  process.exit(1);
}
console.log(buildReceptionistPrompt(tenants.get(id)!));
