import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Free Cloudflare "quick tunnel" for LOCAL TESTING: gives this computer a public https link
 * (https://xyz.trycloudflare.com) so Bland can reach our tool and webhook routes.
 * - Started only when needed (the first Bland test call), stopped when the server stops.
 * - The dashboard and /api routes stay blocked for anything that comes through the tunnel (see app.ts isLocal).
 * - The link changes every time the tunnel starts. For a real business use a fixed PUBLIC_BASE_URL instead.
 */

function findCloudflared(): string | null {
  const exe = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
  const candidates = [
    process.env.CLOUDFLARED_PATH,
    "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe",
    "C:\\Program Files\\cloudflared\\cloudflared.exe",
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map((d) => join(d, exe)),
  ].filter((p): p is string => Boolean(p));
  return candidates.find((p) => existsSync(p)) ?? null;
}

export class QuickTunnel {
  private proc?: ChildProcess;
  private starting?: Promise<string>;
  url?: string;

  constructor(private port: number) {}

  available(): boolean {
    return Boolean(findCloudflared());
  }

  /** Returns the public https link, starting the tunnel if it isn't running yet. */
  start(): Promise<string> {
    if (this.url && this.proc && this.proc.exitCode === null) return Promise.resolve(this.url);
    if (this.starting) return this.starting;
    const bin = findCloudflared();
    if (!bin) return Promise.reject(new Error("Cloudflare tunnel (cloudflared) is not installed."));

    this.starting = new Promise<string>((resolve, reject) => {
      const p = spawn(bin, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${this.port}`], { windowsHide: true });
      this.proc = p;
      let log = "";
      const timer = setTimeout(() => { p.kill(); reject(new Error("The tunnel took too long to start. Check your internet and try again.")); }, 45_000);
      const onData = (chunk: Buffer) => {
        log = (log + chunk).slice(-4000);
        const m = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (m && !this.url) {
          this.url = m[0];
          clearTimeout(timer);
          // Cloudflare needs a few seconds before the new link answers.
          setTimeout(() => resolve(this.url!), 4000);
        }
      };
      p.stdout?.on("data", onData);
      p.stderr?.on("data", onData);
      p.on("exit", () => {
        clearTimeout(timer);
        this.url = undefined;
        this.proc = undefined;
        reject(new Error(`The tunnel stopped. ${log.split("\n").filter((l) => /ERR|error/i.test(l)).slice(-2).join(" ")}`.trim()));
      });
    }).finally(() => { this.starting = undefined; });
    return this.starting;
  }

  stop() {
    this.proc?.kill();
    this.proc = undefined;
    this.url = undefined;
  }
}
