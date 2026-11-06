export interface Slot {
  startTime: string;
  endTime: string;
  available: boolean;
  reason?: string;
}

export class AvailabilityService {
  private static toMinutes(timeStr: string): number {
    const [h, m] = timeStr.split(':').map(Number);
    return h * 60 + m;
  }

  private static toTimeString(minutes: number): string {
    const h = Math.floor(minutes / 60).toString().padStart(2, '0');
    const m = (minutes % 60).toString().padStart(2, '0');
    return `${h}:${m}`;
  }

  public static generateSlots(params: {
    workStart: string;
    workEnd: string;
    breakStart?: string | null;
    breakEnd?: string | null;
    existingBookings: Array<{ startTime: string; endTime: string }>;
    durationMinutes: number;
    bufferMinutes: number;
    intervalMinutes?: number;
  }): Slot[] {
    const {
      workStart,
      workEnd,
      breakStart,
      breakEnd,
      existingBookings,
      durationMinutes,
      bufferMinutes,
      intervalMinutes = 15,
    } = params;

    const startMin = this.toMinutes(workStart);
    const endMin = this.toMinutes(workEnd);
    const breakStartMin = breakStart ? this.toMinutes(breakStart) : null;
    const breakEndMin = breakEnd ? this.toMinutes(breakEnd) : null;

    const slots: Slot[] = [];
    const totalSlotSpan = durationMinutes + bufferMinutes;

    for (let current = startMin; current + durationMinutes <= endMin; current += intervalMinutes) {
      const slotEnd = current + durationMinutes;
      const slotEndWithBuffer = current + totalSlotSpan;

      let isAvailable = true;
      let reason: string | undefined;

      // 1. Validasi Jam Istirahat (14:00 - 15:00)
      if (breakStartMin !== null && breakEndMin !== null) {
        if (current < breakEndMin && slotEndWithBuffer > breakStartMin) {
          isAvailable = false;
          reason = 'Jam Istirahat Barber';
        }
      }

      // 2. Validasi Booking yang Sudah Terisi (Overlapping Check)
      if (isAvailable) {
        for (const b of existingBookings) {
          const bookedStartMin = this.toMinutes(b.startTime);
          const bookedEndMin = this.toMinutes(b.endTime);

          if (current < bookedEndMin && slotEndWithBuffer > bookedStartMin) {
            isAvailable = false;
            reason = 'Sudah Terisi Booking Lain';
            break;
          }
        }
      }

      slots.push({
        startTime: this.toTimeString(current),
        endTime: this.toTimeString(slotEnd),
        available: isAvailable,
        reason,
      });
    }

    return slots;
  }
}