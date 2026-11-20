import { randomUUID } from "node:crypto";
import type { EventLog } from "../events/index.js";
import type { Store } from "../store/index.js";
import type { TenantConfig } from "../tenant-config/schema.js";

export interface SmsProvider {
  sendSms(fromNumber: string, toNumber: string, message: string): Promise<void>;
}

export type SendResult = "sent" | "simulated" | "blocked_opt_out" | "failed";

/**
 * All outgoing texts and emails go through here.
 * Test mode (tenant or global) = nothing real is sent; the message is only logged.
 */
export class Messaging {
  constructor(
    private events: EventLog,
    private store: Store,
    private smsProvider: SmsProvider | undefined,
    private globalTestMode: boolean,
    private now: () => Date = () => new Date(),
  ) {}

  isTestMode(tenant: TenantConfig): boolean {
    return this.globalTestMode || tenant.testMode;
  }

  /** Keep a copy of every text to a customer, so it shows in the dashboard thread and on the simulator phone. */
  private record(tenant: TenantConfig, to: string, body: string, kind: string, status: string, by?: string) {
    if (kind === "team_alert" || kind === "emergency_alert") return; // those go to staff, not customers
    this.store.data.messages.push({ id: randomUUID(), tenantId: tenant.tenantId, phone: to, direction: "out", body, kind, by, status, at: this.now().toISOString() });
    this.store.persist();
  }

  async sms(tenant: TenantConfig, to: string, message: string, kind: string, by?: string): Promise<SendResult> {
    const base = { to, kind, message };
    if (this.store.isOptedOut(tenant.tenantId, to)) {
      this.events.log(tenant.tenantId, "sms.blocked_opt_out", "system", base);
      return "blocked_opt_out";
    }
    if (this.isTestMode(tenant) || !this.smsProvider || !tenant.phoneNumber) {
      this.events.log(tenant.tenantId, "sms.simulated", "system", {
        ...base,
        why: this.isTestMode(tenant) ? "test mode" : !this.smsProvider ? "no SMS provider" : "tenant has no phone number",
      });
      this.record(tenant, to, message, kind, "simulated", by);
      return "simulated";
    }
    try {
      await this.smsProvider.sendSms(tenant.phoneNumber, to, message);
      this.events.log(tenant.tenantId, "sms.sent", "system", base);
      this.record(tenant, to, message, kind, "sent", by);
      return "sent";
    } catch (err) {
      this.events.log(tenant.tenantId, "sms.failed", "system", { ...base, error: String(err) });
      return "failed";
    }
  }

  /** No email provider yet: emails are logged so nothing is lost. */
  async email(tenant: TenantConfig, to: string, subject: string, body: string): Promise<SendResult> {
    this.events.log(tenant.tenantId, "email.simulated", "system", { to, subject, body, why: "no email provider yet" });
    return "simulated";
  }

  /** Alert the business's escalation contacts (owner, office manager, ...). */
  async notifyTeam(tenant: TenantConfig, subject: string, body: string): Promise<void> {
    for (const c of tenant.escalationContacts) {
      if (c.channel === "sms") await this.sms(tenant, c.to, `${subject}: ${body}`, "team_alert");
      else await this.email(tenant, c.to, subject, body);
    }
  }

  optOut(tenant: TenantConfig, phone: string): void {
    if (this.store.isOptedOut(tenant.tenantId, phone)) return;
    this.store.data.optOuts.push({ tenantId: tenant.tenantId, phone, at: new Date().toISOString() });
    this.store.persist();
    this.events.log(tenant.tenantId, "contact.opted_out", "user", { phone });
  }
}
