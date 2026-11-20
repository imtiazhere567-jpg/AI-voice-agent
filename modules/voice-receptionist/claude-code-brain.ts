import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { TenantConfig } from "../../core/tenant-config/schema.js";
import type { Deps } from "./actions.js";
import { AIConversation, TOOLS, claudeAvailable, phoneCallRules, type BrainTurn } from "./ai-brain.js";
import { buildFirstSentence, buildReceptionistPrompt } from "./prompt-builder.js";

/**
 * LOCAL TESTING ONLY: the phone simulator talks through the Claude Code program installed
 * and logged in on this computer (your own Claude subscription), so no API key is needed.
 *
 * - It runs `claude -p` in headless mode. We never read or copy the login token.
 * - One Claude Code process per call, so it remembers the conversation and replies fast.
 * - Never used in production (NODE_ENV=production) or in tests. Real customers need an API key
 *   (or Bland.ai for real phone calls): a personal subscription is not for serving other people.
 *
 * .env options:  AI_BRAIN=auto | api | claude-code | rules   (default auto)
 *                CLAUDE_CODE_PATH=…\claude.exe   CLAUDE_CODE_MODEL=sonnet
 */

export type BrainKind = "claude" | "claude-code" | "rules";

let cachedPath: string | null | undefined;
export function findClaudeCode(): string | null {
  if (cachedPath !== undefined) return cachedPath;
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  const candidates = [
    process.env.CLAUDE_CODE_PATH,
    join(homedir(), ".local", "bin", exe),
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map((d) => join(d, exe)),
  ].filter((p): p is string => Boolean(p));
  return (cachedPath = candidates.find((p) => existsSync(p)) ?? null);
}

/** Which brain the simulator uses right now. */
export function brainKind(): BrainKind {
  const want = (process.env.AI_BRAIN ?? "auto").toLowerCase();
  const localOk = process.env.NODE_ENV !== "production" && !process.env.VITEST && Boolean(findClaudeCode());
  if (want === "rules") return "rules";
  if (want === "api") return claudeAvailable() ? "claude" : "rules";
  if (want === "claude-code") return localOk ? "claude-code" : "rules";
  return claudeAvailable() ? "claude" : localOk ? "claude-code" : "rules";
}

const REPLY_SCHEMA = {
  type: "object",
  properties: {
    say: { type: "string", description: "What you say out loud now. Can be empty when you only run a tool first." },
    tools: {
      type: "array",
      description: "Tools to run now, in order. Empty if none.",
      items: {
        type: "object",
        properties: { name: { type: "string", enum: TOOLS.map((t) => t.name) }, input: { type: "object" } },
        required: ["name", "input"],
      },
    },
  },
  required: ["say", "tools"],
};

function toolGuide(): string {
  return TOOLS.map((t) => {
    const s = t.input_schema as { properties?: Record<string, { type?: string; description?: string }>; required?: string[] };
    const fields = Object.entries(s.properties ?? {}).map(([k, v]) => `${k} (${v.type}${s.required?.includes(k) ? ", required" : ""})${v.description ? `: ${v.description}` : ""}`);
    return `- ${t.name}: ${t.description}\n  input: ${fields.length ? fields.join("; ") : "none"}`;
  }).join("\n");
}

const TURN_TIMEOUT_MS = 90_000;

// Same for every business and every call, so a Claude Code process can be started early and reused.
// The business's own instructions arrive in the first message of the call.
const SYSTEM_PROMPT = `You are an AI phone receptionist for a small business, on a live phone call.
The first message of the call gives you the business's instructions and the call details. Follow them for the whole call.

# Tools
You can't call tools directly. To use one, put it in "tools" in your JSON reply. The system runs it and sends you the result in the next message, then you continue.
${toolGuide()}

# How to reply
Every reply is JSON: {"say": "...", "tools": [...]}.
- "say" is spoken to the caller. Keep it to 1 to 3 short sentences.
- When you need a tool result before you can answer (times, service area, booking), put the tool in "tools" and leave "say" EMPTY. Don't guess the result. You speak after you see the result.
- The only exception is end_call: say your goodbye in "say" and put end_call in "tools" in the same reply.
- Messages that start with "Caller:" are what the caller said. Messages that start with "Tool results:" come from the system, not the caller.`;

type Reply = { say: string; tools: { name: string; input: Record<string, unknown> }[] };

/** One running Claude Code process (headless, stream-json), holding one conversation. */
class ClaudeCodeProcess {
  private proc?: ChildProcessWithoutNullStreams;
  private dir: string;
  private buf = "";
  private waiting: { ok: (v: Reply) => void; fail: (e: Error) => void }[] = [];
  dead?: Error;
  readonly startedAt = Date.now();

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), "receptionist-"));
    const bin = findClaudeCode();
    if (!bin) { this.dead = new Error("Claude Code is not installed"); return; }
    const promptFile = join(this.dir, "system.txt");
    writeFileSync(promptFile, SYSTEM_PROMPT);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // Start fast: skip update checks, telemetry and claude.ai connectors (Gmail, Figma…) the receptionist doesn't need.
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    };
    delete env.ANTHROPIC_API_KEY; // use the logged-in subscription, never an API key here

    this.proc = spawn(bin, [
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--model", process.env.CLAUDE_CODE_MODEL || "sonnet",
      "--tools", "", "--strict-mcp-config", "--no-session-persistence",
      "--setting-sources", "local", // don't load your personal plugins/skills/hooks: much faster start
      "--system-prompt-file", promptFile,
      "--json-schema", JSON.stringify(REPLY_SCHEMA),
    ], { cwd: this.dir, env, windowsHide: true });

    this.proc.stdout.on("data", (chunk) => this.onData(String(chunk)));
    let stderr = "";
    this.proc.stderr.on("data", (c) => { stderr = (stderr + c).slice(-500); });
    this.proc.on("error", (e) => this.fail(new Error(`Claude Code could not start: ${e.message}`)));
    this.proc.on("close", (code) => this.fail(new Error(`Claude Code stopped (code ${code}). ${stderr.trim()}`)));
  }

  private onData(chunk: string) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg: { type?: string; subtype?: string; is_error?: boolean; result?: string; structured_output?: unknown };
      try { msg = JSON.parse(line); } catch { continue; }
      if (process.env.CLAUDE_CODE_DEBUG) console.error(`[claude-code ${((Date.now() - this.startedAt) / 1000).toFixed(1)}s]`, msg.type, msg.subtype ?? "", line.slice(0, 200));
      if (msg.type !== "result") continue;
      const w = this.waiting.shift();
      if (!w) continue;
      if (msg.is_error) { w.fail(new Error(`Claude Code error: ${String(msg.result ?? "unknown").slice(0, 200)}`)); continue; }
      let out = msg.structured_output as { say?: unknown; tools?: unknown } | undefined;
      if (!out && msg.result) { try { out = JSON.parse(msg.result); } catch { out = { say: msg.result, tools: [] }; } }
      const tools = Array.isArray(out?.tools) ? (out!.tools as { name: string; input?: Record<string, unknown> }[]).map((t) => ({ name: String(t.name), input: t.input ?? {} })) : [];
      w.ok({ say: typeof out?.say === "string" ? out.say : "", tools });
    }
  }

  private fail(e: Error) {
    this.dead ??= e;
    for (const w of this.waiting.splice(0)) w.fail(e);
  }

  ask(text: string): Promise<Reply> {
    if (this.dead) return Promise.reject(this.dead);
    return new Promise<Reply>((ok, fail) => {
      const timer = setTimeout(() => fail(new Error("Claude Code took too long to answer")), TURN_TIMEOUT_MS);
      this.waiting.push({ ok: (v) => { clearTimeout(timer); ok(v); }, fail: (e) => { clearTimeout(timer); fail(e); } });
      this.proc!.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
    });
  }

  close() {
    this.dead ??= new Error("Call ended");
    try { this.proc?.stdin.end(); } catch { /* already closed */ }
    const p = this.proc, d = this.dir;
    setTimeout(() => { if (p && p.exitCode === null) p.kill(); }, 3000).unref?.();
    setTimeout(() => { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }, 5000).unref?.();
  }
}

// One spare process, started ahead of time, so a new call doesn't wait for Claude Code to boot.
let spare: ClaudeCodeProcess | undefined;
export function prewarmClaudeCode() {
  if (brainKind() !== "claude-code") return;
  if (!spare || spare.dead) spare = new ClaudeCodeProcess();
}
function takeProcess(): ClaudeCodeProcess {
  const p = spare && !spare.dead ? spare : new ClaudeCodeProcess();
  spare = undefined;
  setTimeout(prewarmClaudeCode, 2000).unref?.(); // get the next one ready
  return p;
}

export class ClaudeCodeConversation extends AIConversation {
  private cc: ClaudeCodeProcess;
  private briefed = false;

  constructor(d: Deps, tenant: TenantConfig, callerPhone?: string) {
    super(d, tenant, callerPhone);
    this.cc = takeProcess();
  }

  /** The business's instructions, sent once with the caller's first words. */
  private briefing(): string {
    return `# Business instructions for this call
${buildReceptionistPrompt(this.tenant)}
${phoneCallRules(this.tenant, this.callerPhone)}

# You already answered the call
You said: "${buildFirstSentence(this.tenant)}"

`;
  }

  /** The caller said something. Returns what the AI says back. */
  override async reply(text: string): Promise<BrainTurn> {
    const said: string[] = [];
    let end = false, transfer = false;
    let next = `${this.briefed ? "" : this.briefing()}Caller: ${text}`;
    this.briefed = true;
    for (let step = 0; step < 6; step++) {
      const r = await this.cc.ask(next);
      if (r.say.trim()) said.push(r.say.trim());
      if (!r.tools.length) break;
      const results: string[] = [];
      for (const t of r.tools) {
        try {
          const res = await this.runTool(t.name, t.input);
          if (res.end) { end = true; transfer ||= Boolean(res.transfer); }
          results.push(`- ${t.name}: ${res.text}`);
        } catch (err) {
          results.push(`- ${t.name}: Error: ${String(err)}`);
        }
      }
      if (end) break;
      next = `Tool results:\n${results.join("\n")}`;
    }
    if (this.outcome === "none" && said.length) this.outcome = "info";
    return { say: said, end, transfer };
  }

  override close() {
    this.cc.close();
  }
}
