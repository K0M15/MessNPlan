import { DateTime } from 'luxon';

export interface CalendarConfig {
  timezone: string;
  /** JS-Wochentage: 0 = Sonntag … 6 = Samstag */
  workweek: number[];
  workdayStart: string; // HH:MM[:SS]
  workdayEnd: string;
  holidays: Set<string>; // YYYY-MM-DD in Projekt-Zeitzone
}

interface DayWindow {
  startMs: number;
  endMs: number;
  minutes: number;
}

interface MaterialDay {
  iso: string;
  startMs: number;
  nextStartMs: number;
  win: DayWindow | null;
}

function parseTime(value: string): { hour: number; minute: number } {
  const [h = '0', m = '0'] = value.split(':');
  return { hour: Number(h), minute: Number(m) };
}

const EPSILON = 1e-6;
const GUARD = 10_000;
const DAY_MS = 86_400_000;
const EPOCH_ISO = '1970-01-01';
/** Obergrenze für die Tages-Summen im Slow-Fallback (~1000 Jahre). */
const MAX_SLOW_SCAN_DAYS = 400_000;

/** Nächster Kalendertag `YYYY-MM-DD` (UTC-Datumsarithmetik, DST-unabhängig). */
function nextIsoDay(iso: string): string {
  const [year = 1970, month = 1, day = 1] = iso.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day) + DAY_MS).toISOString().slice(0, 10);
}

/** Vorheriger Kalendertag `YYYY-MM-DD` (UTC-Datumsarithmetik, DST-unabhängig). */
function previousIsoDay(iso: string): string {
  const [year = 1970, month = 1, day = 1] = iso.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day) - DAY_MS).toISOString().slice(0, 10);
}

/**
 * Arbeitskalender eines Projekts: verschiebt Zeitpunkte unter Beachtung von
 * Arbeitswoche, Tagesfenster und Feiertagen (alles in Projekt-Zeitzone).
 *
 * DST: Die Fenstergrenzen eines Tages werden als Wall-Clock (`set({ hour, … })`)
 * bestimmt, nie per Millisekunden-Addition an den Tagesbeginn. An Umstellungstagen
 * hat ein Arbeitstag dadurch real 23 h bzw. 25 h und das Fenster entsprechend
 * 1 h weniger/mehr verstrichene Minuten; die Fensterlänge wird pro Tag geführt.
 *
 * Performance: Luxon-Zonenberechnungen (`Intl.formatToParts`) sind teuer. Für
 * heiße Pfade (Scheduling, Slack, Auslastung) materialisiert `precomputeRange`
 * die Kalendertage eines Zeitraums einmalig; danach laufen alle Operationen
 * per Binärsuche + Millisekunden-Arithmetik ohne Zonen-Lookups. Außerhalb des
 * materialisierten Bereichs greift ein langsamer, aber korrekter Fallback.
 */
export class WorkCalendar {
  private readonly start: { hour: number; minute: number };
  private readonly end: { hour: number; minute: number };
  private readonly holidaySet: Set<string>;
  private readonly workdayMinutes: number;
  private readonly dayCache = new Map<string, DayWindow | null>();

  private materialDays: MaterialDay[] = [];
  /** minutesPrefix[i] = Arbeitsminuten in materialDays[0..i-1] (DST-Tage zählen real). */
  private minutesPrefix: number[] = [0];

  constructor(readonly config: CalendarConfig) {
    this.start = parseTime(config.workdayStart);
    this.end = parseTime(config.workdayEnd);
    const startMinutes = this.start.hour * 60 + this.start.minute;
    const endMinutes = this.end.hour * 60 + this.end.minute;
    this.workdayMinutes = Math.max(1, endMinutes - startMinutes);
    this.holidaySet = new Set(config.holidays);
  }

  get timezone(): string {
    return this.config.timezone;
  }

  fromDate(date: Date): DateTime {
    return DateTime.fromJSDate(date, { zone: this.config.timezone });
  }

  fromISO(value: string): DateTime {
    return DateTime.fromISO(value, { zone: this.config.timezone });
  }

  now(): DateTime {
    return DateTime.now().setZone(this.config.timezone);
  }

  // -------------------------------------------------------------------------
  // Materialisierung
  // -------------------------------------------------------------------------

  /** Anzahl Kalendertage pro Materialisierung (Schutz gegen Endlosbereiche). */
  private static readonly MAX_MATERIAL_DAYS = 20_000;

  /**
   * Materialisiert die Kalendertage in [fromMs, toMs] (inkl. Randtagen).
   * Wiederholte Aufrufe mit kleinerem/überdecktem Bereich sind No-Ops.
   */
  precomputeRange(fromMs: number, toMs: number): void {
    if (this.materialDays.length > 0) {
      const coveredFrom = this.materialDays[0]!.startMs;
      const coveredTo = this.materialDays[this.materialDays.length - 1]!.nextStartMs;
      if (fromMs >= coveredFrom && toMs <= coveredTo) return;
      fromMs = Math.min(fromMs, coveredFrom);
      toMs = Math.max(toMs, coveredTo);
    }

    const start = DateTime.fromMillis(fromMs, { zone: this.config.timezone })
      .startOf('day')
      .minus({ days: 1 });
    const end = DateTime.fromMillis(toMs, { zone: this.config.timezone })
      .startOf('day')
      .plus({ days: 2 });

    const days: MaterialDay[] = [];
    const prefix: number[] = [0];
    let cursor = start;
    for (let i = 0; i < WorkCalendar.MAX_MATERIAL_DAYS && cursor <= end; i++) {
      const next = cursor.plus({ days: 1 });
      const iso = cursor.toISODate() ?? '';
      const win = this.windowForDay(iso, cursor);
      days.push({ iso, startMs: cursor.toMillis(), nextStartMs: next.toMillis(), win });
      prefix.push(prefix[i]! + (win ? win.minutes : 0));
      cursor = next;
    }

    this.materialDays = days;
    this.minutesPrefix = prefix;
  }

  /**
   * Arbeitstag-Fenster eines Tages. Start/Ende werden per Luxon-Wall-Clock
   * (`set`) gesetzt – Millisekunden-Addition an den Tagesbeginn würde die
   * Grenzen an DST-Umstellungstagen um ±1 h verschieben. `minutes` ist die
   * tatsächlich verstrichene Fensterlänge (23-h-/25-h-Tage).
   */
  private windowForDay(iso: string, day: DateTime): DayWindow | null {
    const jsDay = day.weekday % 7;
    if (!this.config.workweek.includes(jsDay) || this.holidaySet.has(iso)) return null;
    const start = day.set({
      hour: this.start.hour,
      minute: this.start.minute,
      second: 0,
      millisecond: 0,
    });
    const end = day.set({
      hour: this.end.hour,
      minute: this.end.minute,
      second: 0,
      millisecond: 0,
    });
    const startMs = start.toMillis();
    const endMs = end.toMillis();
    if (endMs <= startMs) return null;
    return { startMs, endMs, minutes: (endMs - startMs) / 60_000 };
  }

  /** Index des materialisierten Tages, der `ms` enthält, oder -1 (außerhalb). */
  private materialIndexAt(ms: number): number {
    const days = this.materialDays;
    if (days.length === 0) return -1;
    if (ms < days[0]!.startMs || ms >= days[days.length - 1]!.nextStartMs) return -1;
    let low = 0;
    let high = days.length - 1;
    let idx = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (days[mid]!.startMs <= ms) {
        idx = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return idx;
  }

  // -------------------------------------------------------------------------
  // Langsame Fallbacks (Luxon, korrekt außerhalb des Materialbereichs)
  // -------------------------------------------------------------------------

  private dayInfoSlow(iso: string): DayWindow | null {
    if (this.dayCache.has(iso)) return this.dayCache.get(iso) ?? null;
    const dt = DateTime.fromISO(iso, { zone: this.config.timezone });
    const info = dt.isValid ? this.windowForDay(iso, dt) : null;
    this.dayCache.set(iso, info);
    return info;
  }

  private windowAtMsSlow(ms: number): DayWindow | null {
    const iso = DateTime.fromMillis(ms, { zone: this.config.timezone }).toISODate();
    return iso ? this.dayInfoSlow(iso) : null;
  }

  private nextWorkingMsSlow(ms: number): number {
    let cursor = ms;
    for (let i = 0; i < GUARD; i++) {
      const dt = DateTime.fromMillis(cursor, { zone: this.config.timezone });
      const info = this.dayInfoSlow(dt.toISODate() ?? '');
      if (info) {
        if (cursor < info.startMs) return info.startMs;
        if (cursor <= info.endMs) return cursor;
      }
      cursor = dt.plus({ days: 1 }).startOf('day').toMillis();
    }
    throw new Error('Kein Arbeitszeitfenster gefunden (Arbeitswoche prüfen)');
  }

  private previousWorkingMsSlow(ms: number): number {
    let cursor = ms;
    for (let i = 0; i < GUARD; i++) {
      const dt = DateTime.fromMillis(cursor, { zone: this.config.timezone });
      const info = this.dayInfoSlow(dt.toISODate() ?? '');
      if (info) {
        if (cursor > info.endMs) return info.endMs;
        if (cursor >= info.startMs) return cursor;
      }
      cursor = dt.minus({ days: 1 }).endOf('day').toMillis();
    }
    throw new Error('Kein Arbeitszeitfenster gefunden (Arbeitswoche prüfen)');
  }

  private addWorkingMsSlow(fromMs: number, minutes: number): number {
    let ms = this.nextWorkingMsSlow(fromMs);
    let remaining = Math.max(0, minutes);
    for (let i = 0; i < GUARD && remaining > EPSILON; i++) {
      const info = this.windowAtMsSlow(ms);
      if (!info) {
        ms = this.nextWorkingMsSlow(ms);
        continue;
      }
      const available = (info.endMs - ms) / 60_000;
      if (remaining <= available + EPSILON) return ms + remaining * 60_000;
      remaining -= available;
      ms = this.nextWorkingMsSlow(info.endMs + 60_000);
    }
    return ms;
  }

  private subtractWorkingMsSlow(toMs: number, minutes: number): number {
    let ms = this.previousWorkingMsSlow(toMs);
    let remaining = Math.max(0, minutes);
    for (let i = 0; i < GUARD && remaining > EPSILON; i++) {
      const info = this.windowAtMsSlow(ms);
      if (!info) {
        ms = this.previousWorkingMsSlow(ms);
        continue;
      }
      const available = (ms - info.startMs) / 60_000;
      if (remaining <= available + EPSILON) return ms - remaining * 60_000;
      remaining -= available;
      ms = this.previousWorkingMsSlow(info.startMs - 60_000);
    }
    return ms;
  }

  private minutesIntoMsSlow(ms: number): number {
    const info = this.windowAtMsSlow(ms);
    if (!info) return 0;
    if (ms <= info.startMs) return 0;
    if (ms >= info.endMs) return info.minutes;
    return (ms - info.startMs) / 60_000;
  }

  /**
   * Arbeitsminuten aller Arbeitstage vor dem lokalen Kalendertag von `ms`.
   * Summiert die echten Tagesfenster (DST-Tage weichen von der Regellänge ab);
   * O(Tage), läuft nur außerhalb des materialisierten Bereichs. Vor 1970 wird
   * rückwärts negativ akkumuliert (Differenzen bleiben dadurch korrekt).
   */
  private workingMinutesBeforeMsSlow(ms: number): number {
    const targetIso = DateTime.fromMillis(ms, { zone: this.config.timezone }).toISODate();
    if (!targetIso) return 0;
    let total = 0;
    if (targetIso >= EPOCH_ISO) {
      let iso = EPOCH_ISO;
      for (let i = 0; iso < targetIso && i < MAX_SLOW_SCAN_DAYS; i++) {
        const win = this.dayInfoSlow(iso);
        if (win) total += win.minutes;
        iso = nextIsoDay(iso);
      }
    } else {
      let iso = EPOCH_ISO;
      for (let i = 0; iso > targetIso && i < MAX_SLOW_SCAN_DAYS; i++) {
        iso = previousIsoDay(iso);
        const win = this.dayInfoSlow(iso);
        if (win) total -= win.minutes;
      }
    }
    return total;
  }

  private workingMinutesBetweenSlow(fromMs: number, toMs: number): number {
    if (toMs <= fromMs) return 0;
    return (
      this.workingMinutesBeforeMsSlow(toMs) -
      this.workingMinutesBeforeMsSlow(fromMs) +
      this.minutesIntoMsSlow(toMs) -
      this.minutesIntoMsSlow(fromMs)
    );
  }

  // -------------------------------------------------------------------------
  // Öffentliche Kernarithmetik (Material-Cache mit Fallback)
  // -------------------------------------------------------------------------

  /** Nächster gültiger Arbeitszeitpunkt ab `ms` (inklusive). */
  nextWorkingMs(ms: number): number {
    const idx = this.materialIndexAt(ms);
    if (idx >= 0) {
      const day = this.materialDays[idx]!;
      if (day.win) {
        if (ms < day.win.startMs) return day.win.startMs;
        if (ms <= day.win.endMs) return ms;
      }
      for (let i = idx + 1; i < this.materialDays.length; i++) {
        const win = this.materialDays[i]!.win;
        if (win) return win.startMs;
      }
      const last = this.materialDays[this.materialDays.length - 1]!;
      return this.nextWorkingMsSlow(last.nextStartMs);
    }
    return this.nextWorkingMsSlow(ms);
  }

  /** Letzter gültiger Arbeitszeitpunkt vor `ms` (inklusive). */
  previousWorkingMs(ms: number): number {
    const idx = this.materialIndexAt(ms);
    if (idx >= 0) {
      const day = this.materialDays[idx]!;
      if (day.win) {
        if (ms > day.win.endMs) return day.win.endMs;
        if (ms >= day.win.startMs) return ms;
      }
      for (let i = idx - 1; i >= 0; i--) {
        const win = this.materialDays[i]!.win;
        if (win) return win.endMs;
      }
      const first = this.materialDays[0]!;
      return this.previousWorkingMsSlow(first.startMs);
    }
    return this.previousWorkingMsSlow(ms);
  }

  addWorkingMs(fromMs: number, minutes: number): number {
    let ms = this.nextWorkingMs(fromMs);
    let remaining = Math.max(0, minutes);
    for (let i = 0; i < GUARD && remaining > EPSILON; i++) {
      const idx = this.materialIndexAt(ms);
      if (idx < 0) return this.addWorkingMsSlow(ms, remaining);
      const day = this.materialDays[idx]!;
      if (!day.win) {
        ms = this.nextWorkingMs(ms);
        continue;
      }
      const available = (day.win.endMs - ms) / 60_000;
      if (remaining <= available + EPSILON) return ms + remaining * 60_000;
      remaining -= available;
      ms = this.nextWorkingMs(day.win.endMs + 60_000);
    }
    return ms;
  }

  subtractWorkingMs(toMs: number, minutes: number): number {
    let ms = this.previousWorkingMs(toMs);
    let remaining = Math.max(0, minutes);
    for (let i = 0; i < GUARD && remaining > EPSILON; i++) {
      const idx = this.materialIndexAt(ms);
      if (idx < 0) return this.subtractWorkingMsSlow(ms, remaining);
      const day = this.materialDays[idx]!;
      if (!day.win) {
        ms = this.previousWorkingMs(ms);
        continue;
      }
      const available = (ms - day.win.startMs) / 60_000;
      if (remaining <= available + EPSILON) return ms - remaining * 60_000;
      remaining -= available;
      ms = this.previousWorkingMs(day.win.startMs - 60_000);
    }
    return ms;
  }

  workingMinutesBetweenMs(fromMs: number, toMs: number): number {
    if (toMs <= fromMs) return 0;
    const fromIdx = this.materialIndexAt(fromMs);
    const toIdx = this.materialIndexAt(toMs);
    if (fromIdx >= 0 && toIdx >= 0) {
      const fromDay = this.materialDays[fromIdx]!;
      const toDay = this.materialDays[toIdx]!;
      const into = (day: MaterialDay, ms: number): number => {
        if (!day.win) return 0;
        if (ms <= day.win.startMs) return 0;
        if (ms >= day.win.endMs) return day.win.minutes;
        return (ms - day.win.startMs) / 60_000;
      };
      // Präfixsumme in Minuten: DST-Tage tragen ihre reale Fensterlänge bei.
      const full = this.minutesPrefix[toIdx]! - this.minutesPrefix[fromIdx]!;
      return full + into(toDay, toMs) - into(fromDay, fromMs);
    }
    return this.workingMinutesBetweenSlow(fromMs, toMs);
  }

  // -------------------------------------------------------------------------
  // Öffentliche DateTime-API (Wrapper um die ms-Arithmetik)
  // -------------------------------------------------------------------------

  nextWorkingMoment(from: DateTime): DateTime {
    return DateTime.fromMillis(this.nextWorkingMs(from.toMillis()), {
      zone: this.config.timezone,
    });
  }

  previousWorkingMoment(from: DateTime): DateTime {
    return DateTime.fromMillis(this.previousWorkingMs(from.toMillis()), {
      zone: this.config.timezone,
    });
  }

  anchorMoment(anchor: string | null): DateTime {
    const base = anchor !== null ? this.fromISO(anchor).startOf('day') : this.now().startOf('day');
    return this.nextWorkingMoment(base);
  }

  addWorkingMinutes(from: DateTime, minutes: number): DateTime {
    return DateTime.fromMillis(this.addWorkingMs(from.toMillis(), minutes), {
      zone: this.config.timezone,
    });
  }

  subtractWorkingMinutes(to: DateTime, minutes: number): DateTime {
    return DateTime.fromMillis(this.subtractWorkingMs(to.toMillis(), minutes), {
      zone: this.config.timezone,
    });
  }

  workingMinutesBetween(from: DateTime, to: DateTime): number {
    return this.workingMinutesBetweenMs(from.toMillis(), to.toMillis());
  }

  isWorkingDay(day: DateTime): boolean {
    return this.windowForDay(day.toISODate() ?? '', day) !== null;
  }

  /** Start des Arbeitsfensters des Tages (UTC-Millisekunden) oder null (kein Arbeitstag). */
  workdayStartMs(iso: string): number | null {
    const idx = this.materialDays.findIndex((d) => d.iso === iso);
    if (idx >= 0) return this.materialDays[idx]!.win?.startMs ?? null;
    return this.dayInfoSlow(iso)?.startMs ?? null;
  }

  /** Arbeitstage (YYYY-MM-DD) zwischen zwei Zeitpunkten, beide inklusive. */
  workingDaysBetween(from: DateTime, to: DateTime): string[] {
    return this.workingDaysInRange(from.toMillis(), to.toMillis()).map((d) => d.iso);
  }

  /** Tagesstart-Millisekunden aller Arbeitstage in [fromMs, toMs]. */
  workingDayStartsBetween(fromMs: number, toMs: number): number[] {
    return this.workingDaysInRange(fromMs, toMs).map((d) => d.win!.startMs);
  }

  private workingDaysInRange(fromMs: number, toMs: number): MaterialDay[] {
    const fromIdx = this.materialIndexAt(fromMs);
    const toIdx = this.materialIndexAt(toMs);
    if (fromIdx >= 0 && toIdx >= 0) {
      const result: MaterialDay[] = [];
      for (let i = fromIdx; i <= toIdx; i++) {
        if (this.materialDays[i]!.win) result.push(this.materialDays[i]!);
      }
      return result;
    }

    // Fallback außerhalb des Materialbereichs
    const result: MaterialDay[] = [];
    let cursor = DateTime.fromMillis(fromMs, { zone: this.config.timezone }).startOf('day');
    const endMs = DateTime.fromMillis(toMs, { zone: this.config.timezone }).startOf('day').toMillis();
    for (let i = 0; i < GUARD && cursor.toMillis() <= endMs; i++) {
      const iso = cursor.toISODate();
      if (iso) {
        const win = this.dayInfoSlow(iso);
        if (win) result.push({ iso, startMs: cursor.toMillis(), nextStartMs: 0, win });
      }
      cursor = cursor.plus({ days: 1 });
    }
    return result;
  }

  /** Arbeitsminuten pro Arbeitstag (konstant je Projekt). */
  workingHoursPerDay(): number {
    return this.workdayMinutes;
  }
}
