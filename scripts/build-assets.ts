// Packs the web pages, prompt templates and demo businesses into generated/assets.ts,
// so they are inside the code on hosts that don't ship extra files (Vercel).
// Runs automatically before tests and on build: npm run assets
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const DIRS = ["web", "prompts", "test-data/tenants"];
const files: Record<string, string> = {};
const walk = (dir: string) => {
  for (const f of readdirSync(dir).sort()) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(html|md|json)$/.test(f)) files[relative(root, p).split("\\").join("/")] = readFileSync(p, "utf8").replace(/^\uFEFF/, "");
  }
};
for (const d of DIRS) walk(join(root, d));
mkdirSync(join(root, "generated"), { recursive: true });
const out = `// Made by scripts/build-assets.ts. Do not edit: edit the real files and run "npm run assets".\nexport const EMBEDDED: Record<string, string> = ${JSON.stringify(files, null, 0)};\n`;
writeFileSync(join(root, "generated", "assets.ts"), out);
console.log(`Packed ${Object.keys(files).length} files into generated/assets.ts`);
