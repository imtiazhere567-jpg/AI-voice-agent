import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import type { Store } from "../store/index.js";

/**
 * Accounts for the owner dashboard.
 * - "admin": sees and manages every business.
 * - "owner": sees only their own business (tenantId).
 * Passwords are hashed with scrypt (never stored in plain text).
 */

export type Role = "admin" | "owner";

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  tenantId?: string; // owners only
  passwordHash: string; // "salt:hash" (hex)
  demo?: boolean;
  createdAt: string;
  lastLoginAt?: string;
  resetTokenHash?: string;
  resetExpiresAt?: string;
}

export interface Session {
  tokenHash: string;
  userId: string;
  expiresAt: string;
}

export type PublicUser = Omit<User, "passwordHash" | "resetTokenHash" | "resetExpiresAt">;

const SESSION_DAYS = 7;
const RESET_MINUTES = 60;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Tokens are stored hashed, so a leaked data file can't be used to log in.
// Tokens are 256-bit random values, so a fast SHA-256 is safe here (scrypt is only needed for passwords).
const sha = (t: string) => createHash("sha256").update(t).digest("hex");

export const normEmail = (e: unknown) => String(e ?? "").trim().toLowerCase();
export const validEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

export function passwordProblem(p: unknown): string | null {
  const s = String(p ?? "");
  if (s.length < 8) return "Password must be at least 8 characters.";
  if (!/[a-zA-Z]/.test(s) || !/\d/.test(s)) return "Password must include letters and numbers.";
  return null;
}

export class Auth {
  constructor(private store: Store, private now: () => Date = () => new Date()) {}

  private get users() { return this.store.data.users; }
  private get sessions() { return this.store.data.sessions; }

  publicUser(u: User): PublicUser {
    const { passwordHash, resetTokenHash, resetExpiresAt, ...rest } = u;
    return rest;
  }

  findByEmail(email: string): User | undefined {
    return this.users.find((u) => u.email === normEmail(email));
  }

  createUser(input: { email: string; name: string; password: string; role: Role; tenantId?: string; demo?: boolean }): User {
    const email = normEmail(input.email);
    if (this.findByEmail(email)) throw new Error("An account with this email already exists.");
    const user: User = {
      id: randomUUID(), email, name: input.name.trim(), role: input.role, tenantId: input.tenantId,
      passwordHash: hashPassword(input.password), demo: input.demo, createdAt: this.now().toISOString(),
    };
    this.users.push(user);
    this.store.persist();
    return user;
  }

  /** Make sure an account exists with this password (used for the admin and demo accounts). */
  ensureUser(input: { email: string; name: string; password: string; role: Role; tenantId?: string; demo?: boolean }): User {
    const existing = this.findByEmail(input.email);
    if (!existing) return this.createUser(input);
    if (!verifyPassword(input.password, existing.passwordHash)) existing.passwordHash = hashPassword(input.password);
    Object.assign(existing, { role: input.role, tenantId: input.tenantId, demo: input.demo, name: existing.name || input.name });
    this.store.persist();
    return existing;
  }

  login(email: string, password: string): User | null {
    const u = this.findByEmail(email);
    // Always run a hash so response time doesn't reveal whether the email exists.
    const ok = u ? verifyPassword(password, u.passwordHash) : (verifyPassword(password, hashPassword("x1")), false);
    if (!u || !ok) return null;
    u.lastLoginAt = this.now().toISOString();
    this.store.persist();
    return u;
  }

  startSession(user: User): string {
    const token = randomBytes(32).toString("hex");
    const nowMs = this.now().getTime();
    // Drop this user's expired sessions while we're here.
    this.store.data.sessions = this.sessions.filter((s) => Date.parse(s.expiresAt) > nowMs);
    this.sessions.push({ tokenHash: sha(token), userId: user.id, expiresAt: new Date(nowMs + SESSION_DAYS * 86_400_000).toISOString() });
    this.store.persist();
    return token;
  }

  userForToken(token: string | undefined): User | null {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    const h = sha(token);
    const s = this.sessions.find((x) => x.tokenHash === h);
    if (!s || Date.parse(s.expiresAt) < this.now().getTime()) return null;
    return this.users.find((u) => u.id === s.userId) ?? null;
  }

  endSession(token: string | undefined) {
    if (!token) return;
    const h = sha(token);
    this.store.data.sessions = this.sessions.filter((s) => s.tokenHash !== h);
    this.store.persist();
  }

  /** Returns a one-time reset token (to be emailed), or null if there is no such account. */
  startReset(email: string): string | null {
    const u = this.findByEmail(email);
    if (!u || u.demo) return null;
    const token = randomBytes(32).toString("hex");
    u.resetTokenHash = sha(token);
    u.resetExpiresAt = new Date(this.now().getTime() + RESET_MINUTES * 60_000).toISOString();
    this.store.persist();
    return token;
  }

  finishReset(token: string, newPassword: string): User | null {
    if (!/^[a-f0-9]{64}$/.test(token)) return null;
    const h = sha(token);
    const u = this.users.find((x) => x.resetTokenHash === h);
    if (!u || !u.resetExpiresAt || Date.parse(u.resetExpiresAt) < this.now().getTime()) return null;
    u.passwordHash = hashPassword(newPassword);
    u.resetTokenHash = undefined;
    u.resetExpiresAt = undefined;
    // Log out everywhere after a password change.
    this.store.data.sessions = this.sessions.filter((s) => s.userId !== u.id);
    this.store.persist();
    return u;
  }

  canAccess(user: User, tenantId: string): boolean {
    return user.role === "admin" || user.tenantId === tenantId;
  }
}
