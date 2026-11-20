import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import type { Booking, Store } from "../../core/store/index.js";
import type { TenantConfig, Weekday } from "../../core/tenant-config/schema.js";

export interface Slot {
  start: string; // ISO with offset
  end: string;
  label: string; // spoken form, e.g. "Tuesday, November 17 at 9:00 AM"
}

export interface BookingRequest {
  serviceId: string;
  start: string;
  customerName: string;
  customerPhone?: string;
  address?: string;
  notes?: string;
  source?: "phone" | "web";
}

/** Any calendar (built-in, Google, Calendly) must provide these two things. */
export interface CalendarAdapter {
  getAvailableSlots(tenant: TenantConfig, serviceId: string, now: Date, days?: number): Promise<Slot[]>;
  book(tenant: TenantConfig, req: BookingRequest, now: Date): Promise<Booking>;
}

const weekdayKeys: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export class SlotTakenError extends Error {}

/**
 * Built-in calendar: slots come from the business's opening hours, booking rules
 * (buffer, max per day, minimum notice) and existing bookings.
 */
export class LocalCalendar implements CalendarAdapter {
  constructor(private store: Store) {}

  async getAvailableSlots(tenant: TenantConfig, serviceId: string, now: Date, days = 7): Promise<Slot[]> {
    const service = tenant.services.find((s) => s.id === serviceId);
    if (!service) throw new Error(`Unknown service "${serviceId}"`);
    const { bufferMinutes, maxPerDay, minLeadHours } = tenant.booking;
    const nowLocal = DateTime.fromJSDate(now).setZone(tenant.timezone);
    const earliest = nowLocal.plus({ hours: minLeadHours });
    const existing = this.store.data.bookings.filter((b) => b.tenantId === tenant.tenantId && b.status === "booked");

    const slots: Slot[] = [];
    for (let d = 0; d < days; d++) {
      const day = nowLocal.startOf("day").plus({ days: d });
      const dayKey = weekdayKeys[day.weekday - 1];
      const bookedThatDay = existing.filter((b) => DateTime.fromISO(b.start).setZone(tenant.timezone).hasSame(day, "day")).length;
      let available = maxPerDay - bookedThatDay;

      for (const period of tenant.hours[dayKey] ?? []) {
        const [oh, om] = period.open.split(":").map(Number);
        const [ch, cm] = period.close.split(":").map(Number);
        const close = day.set({ hour: ch, minute: cm });
        let start = day.set({ hour: oh, minute: om });

        while (available > 0 && start.plus({ minutes: service.appointmentMinutes }) <= close) {
          const end = start.plus({ minutes: service.appointmentMinutes });
          const clashes = existing.some((b) => {
            const bs = DateTime.fromISO(b.start).minus({ minutes: bufferMinutes });
            const be = DateTime.fromISO(b.end).plus({ minutes: bufferMinutes });
            return start < be && end > bs;
          });
          if (start >= earliest && !clashes) {
            slots.push({
              start: start.toISO()!,
              end: end.toISO()!,
              label: start.toFormat("cccc, LLLL d 'at' h:mm a"),
            });
            available--;
          }
          start = end.plus({ minutes: bufferMinutes });
        }
      }
    }
    return slots;
  }

  async book(tenant: TenantConfig, req: BookingRequest, now: Date): Promise<Booking> {
    const slots = await this.getAvailableSlots(tenant, req.serviceId, now, 30);
    const wanted = DateTime.fromISO(req.start).toMillis();
    const slot = slots.find((s) => DateTime.fromISO(s.start).toMillis() === wanted);
    if (!slot) throw new SlotTakenError("That time is no longer available.");

    const booking: Booking = {
      id: randomUUID(),
      tenantId: tenant.tenantId,
      serviceId: req.serviceId,
      start: slot.start,
      end: slot.end,
      customerName: req.customerName,
      customerPhone: req.customerPhone,
      address: req.address,
      notes: req.notes,
      status: "booked",
      source: req.source ?? "phone",
      createdAt: now.toISOString(),
    };
    this.store.data.bookings.push(booking);
    this.store.persist();
    return booking;
  }
}
