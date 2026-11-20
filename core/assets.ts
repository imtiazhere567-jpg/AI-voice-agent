import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EMBEDDED } from "../generated/assets.js";

/** Project folder (where web/, prompts/ and test-data/ are). */
const ROOT = fileURLToPath(new URL("../", import.meta.url));

/**
 * Read a project file such as "web/dashboard.html".
 * Uses the real file when it is there (your computer: edits show right away),
 * otherwise the copy packed into the code (Vercel).
 */
export function readAsset(path: string): string {
  const file = join(ROOT, path);
  if (existsSync(file)) return readFileSync(file, "utf8");
  const packed = EMBEDDED[path];
  if (packed === undefined) throw new Error(`File not found: ${path}`);
  return packed;
}

/** Packed files in a folder, e.g. packedFiles("test-data/tenants/"). */
export function packedFiles(folder: string): { path: string; text: string }[] {
  return Object.entries(EMBEDDED).filter(([p]) => p.startsWith(folder)).map(([path, text]) => ({ path, text }));
}
