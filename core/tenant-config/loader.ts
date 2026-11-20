import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tenantSchema, type TenantConfig } from "./schema.js";
import { countTenantConfigs, loadTenantConfigs, saveTenantConfig, type Sql } from "../db/postgres.js";

/** Parse and validate one tenant config. Throws a readable error if invalid. */
export function parseTenant(raw: unknown, source = "config"): TenantConfig {
  const result = tenantSchema.safeParse(raw);
  if (!result.success) {
    const problems = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid tenant config in ${source}:\n${problems}`);
  }
  return result.data;
}

/** Load every *.json tenant in a folder (local storage, used when there is no database). */
export function loadTenantsFromDir(dir: string): Map<string, TenantConfig> {
  const tenants = new Map<string, TenantConfig>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const path = join(dir, file);
    // .replace ignores a BOM that some Windows editors add at the start of the file
    const tenant = parseTenant(JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, "")), file);
    if (tenants.has(tenant.tenantId)) throw new Error(`Duplicate tenantId "${tenant.tenantId}" in ${file}`);
    tenants.set(tenant.tenantId, tenant);
  }
  return tenants;
}

/**
 * Load businesses from Postgres. The first time (no businesses in the database yet),
 * the JSON files in the folder are copied into the database.
 */
export async function loadTenantsFromDb(sql: Sql, seedDir?: string): Promise<{ tenants: Map<string, TenantConfig>; imported: number }> {
  let imported = 0;
  if (seedDir && existsSync(seedDir) && (await countTenantConfigs(sql)) === 0) {
    for (const t of loadTenantsFromDir(seedDir).values()) { await saveTenantConfig(sql, t); imported++; }
  }
  const tenants = new Map<string, TenantConfig>();
  for (const raw of await loadTenantConfigs(sql)) {
    const tenant = parseTenant(raw, "database");
    tenants.set(tenant.tenantId, tenant);
  }
  return { tenants, imported };
}
