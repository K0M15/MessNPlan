import { DateTime } from 'luxon';
import type { AbsenceRow, ProjectRow, ResourceRow } from './planningData.js';

/**
 * Ressourcen-Kalender: Verfügbarkeit einer Ressource je Kalendertag/-zeit.
 *
 * Modell (bewusst getrennt vom Projekt-Kalender des CPM):
 * - Verfügbarkeit hängt NUR von den Wochentags-Arbeitszeiten der Ressource und
 *   von datumsbasierten Abwesenheiten ab. Feiertage/Wochenenden des Projekts
 *   sind KEIN Sonderfall für Ressourcen – sie ergeben sich nur indirekt über
 *   die geerbten Projekt-Wochentage, wenn die Ressource keine eigenen Zeiten hat.
 * - Default ohne eigene `workingHours`: Projekt-Arbeitswoche × Projekt-Arbeitszeiten
 *   (ohne Feiertagssperre).
 *
 * DST: Die UTC-Grenzen eines Wochentagsfensters werden je Datum per Luxon-Wall-Clock
 * (`set`) bestimmt, nicht per ms-Addition an den Tagesbeginn. An Umstellungstagen
 * hat das Fenster dadurch real 1 h weniger/mehr Minuten; `availableMinutesOn`,
 * `capacityMinutesOn` und `resourceDaysBetween` liefern die verstrichene Länge.
 *
 * Performance: Wochentagsfenster werden je Ressourcen-/Projekt-Objekt gecacht;
 * Abwesenheiten liegen als zusammengeführte, sortierte Epoch-Tag-Bereiche vor
 * (Binärsuche statt Tages-Schleifen). Die UTC-Grenzen konkreter Tagesfenster
 * liegen in einem begrenzten FIFO-Cache (Cap `WINDOW_CACHE_LIMIT`), damit der
 * Speicher nicht mit der Zahl der angefragten (Zeitzone, Datum)-Paare wächst.
 */

export interface WorkWindow {
  startMinutes: number;
  endMinutes: number;
  minutes: number;
}

export type ResourceLike = Pick<ResourceRow, 'workingHours' | 'capacityMinutesPerDay'>;
export type ProjectLike = Pick<
  ProjectRow,
  'timezone' | 'workweek' | 'workdayStart' | 'workdayEnd'
>;

/** Abwesenheitsbereich in Epoch-Tagen (inklusive); UTC-Datumsarithmetik für reine Daten. */
export interface AbsenceRange {
  startDay: number;
  endDay: number;
}

export interface ResourceDay {
  iso: string;
  /** UTC-Millisekunden des Arbeitsfensters. */
  startMs: number;
  endMs: number;
  windowMinutes: number;
  absent: boolean;
  /** Effektive Tageskapazität: 0 bei Abwesenheit, sonst min(Kapazität, Fensterlänge). */
  capacityMinutes: number;
}

const DAY_MS = 86_400_000;
const MAX_RANGE_DAYS = 20_000;

/** "HH:MM[:SS]" → Minuten seit Mitternacht; null bei ungültigem Format. */
export function parseTimeMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** JS-Wochentag (0 = Sonntag … 6 = Samstag) eines Datums `YYYY-MM-DD`. */
export function isoWeekday(iso: string): number {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay();
}

/** Datum `YYYY-MM-DD` → Epoch-Tag (UTC); NaN bei ungültiger Eingabe. */
export function isoToEpochDay(iso: string): number {
  const [year, month, day] = iso.split('-').map(Number);
  if (!year || !month || !day) return Number.NaN;
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
}

export function addIsoDays(iso: string, days: number): string {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!) + days * DAY_MS).toISOString().slice(0, 10);
}

/** UTC-Grenzen eines lokalen Tagesfensters (aus Wall-Clock abgeleitet). */
interface DayWindowBounds {
  startMs: number;
  endMs: number;
  minutes: number;
}

/** Cap des Fenster-Caches: FIFO, älteste Einträge zuerst. */
const WINDOW_CACHE_LIMIT = 2000;

const windowBoundsCache = new Map<string, DayWindowBounds | null>();

/** Fügt in einen Map-Cache ein und entfernt bei Erreichen des Caps den ältesten Eintrag. */
function setBounded<K, V>(cache: Map<K, V>, key: K, value: V): void {
  if (!cache.has(key) && cache.size >= WINDOW_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

/**
 * UTC-Grenzen eines Wochentagsfensters an einem konkreten Datum. Start/Ende
 * werden per Luxon-Wall-Clock (`set`) bestimmt, damit DST-Umstellungstage
 * korrekt sind; `minutes` ist die tatsächlich verstrichene Fensterlänge.
 * Ergebnis wird begrenzt gecacht – der Cache beeinflusst nur die Performance.
 */
function windowBoundsFor(
  timezone: string,
  iso: string,
  window: WorkWindow,
): DayWindowBounds | null {
  const key = `${timezone}|${iso}|${window.startMinutes}|${window.endMinutes}`;
  const cached = windowBoundsCache.get(key);
  if (cached !== undefined) return cached;

  const base = DateTime.fromISO(iso, { zone: timezone });
  let bounds: DayWindowBounds | null = null;
  if (base.isValid) {
    const start = base.set({
      hour: Math.floor(window.startMinutes / 60),
      minute: window.startMinutes % 60,
      second: 0,
      millisecond: 0,
    });
    const end = base.set({
      hour: Math.floor(window.endMinutes / 60),
      minute: window.endMinutes % 60,
      second: 0,
      millisecond: 0,
    });
    const startMs = start.toMillis();
    const endMs = end.toMillis();
    if (endMs > startMs) bounds = { startMs, endMs, minutes: (endMs - startMs) / 60_000 };
  }

  setBounded(windowBoundsCache, key, bounds);
  return bounds;
}

function isoAtMs(ms: number, timezone: string): string | null {
  return DateTime.fromMillis(ms, { zone: timezone }).toISODate();
}

// ---------------------------------------------------------------------------
// Wochentags-Arbeitszeiten
// ---------------------------------------------------------------------------

interface CachedWindows {
  project: ProjectLike;
  windows: Map<number, WorkWindow>;
}

const windowsCache = new WeakMap<object, CachedWindows>();

function normalizeOwnWindows(raw: unknown): Map<number, WorkWindow> {
  const windows = new Map<number, WorkWindow>();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return windows;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const weekday = Number(key);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) continue;
    if (!value || typeof value !== 'object') continue;
    const entry = value as { start?: unknown; end?: unknown };
    const start = parseTimeMinutes(String(entry.start ?? ''));
    const end = parseTimeMinutes(String(entry.end ?? ''));
    // Validierung start < end: ungültige Einträge werden ignoriert.
    if (start === null || end === null || end <= start) continue;
    windows.set(weekday, { startMinutes: start, endMinutes: end, minutes: end - start });
  }
  return windows;
}

function projectWindows(project: ProjectLike): Map<number, WorkWindow> {
  const windows = new Map<number, WorkWindow>();
  const start = parseTimeMinutes(project.workdayStart);
  const end = parseTimeMinutes(project.workdayEnd);
  if (start === null || end === null || end <= start) return windows;
  for (const weekday of project.workweek) {
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) continue;
    windows.set(weekday, { startMinutes: start, endMinutes: end, minutes: end - start });
  }
  return windows;
}

/**
 * Wochentag → Arbeitsfenster. Eigene `workingHours` gewinnen (auch wenn leer –
 * dann ist die Ressource bewusst nie verfügbar); sonst Projekt-Arbeitswoche ×
 * Projekt-Arbeitszeiten ohne Feiertagssperre.
 */
export function resourceWorkWindows(
  resource: ResourceLike,
  project: ProjectLike,
): Map<number, WorkWindow> {
  const cached = windowsCache.get(resource);
  if (cached && cached.project === project) return cached.windows;

  const raw = resource.workingHours;
  const hasOwn = raw !== null && raw !== undefined && typeof raw === 'object' && !Array.isArray(raw);
  const windows = hasOwn ? normalizeOwnWindows(raw) : projectWindows(project);
  windowsCache.set(resource, { project, windows });
  return windows;
}

// ---------------------------------------------------------------------------
// Abwesenheiten
// ---------------------------------------------------------------------------

/** Abwesenheiten je Ressource als zusammengeführte, sortierte inklusive Bereiche. */
export function buildAbsenceIndex(
  absences: Array<Pick<AbsenceRow, 'resourceId' | 'startDate' | 'endDate'>>,
): Map<number, AbsenceRange[]> {
  const map = new Map<number, AbsenceRange[]>();
  for (const absence of absences) {
    const startDay = isoToEpochDay(absence.startDate);
    const endDay = isoToEpochDay(absence.endDate);
    if (Number.isNaN(startDay) || Number.isNaN(endDay)) continue;
    const list = map.get(absence.resourceId) ?? [];
    list.push({ startDay, endDay: Math.max(startDay, endDay) });
    map.set(absence.resourceId, list);
  }
  for (const [resourceId, list] of map) {
    list.sort((a, b) => a.startDay - b.startDay);
    const merged: AbsenceRange[] = [];
    for (const range of list) {
      const last = merged[merged.length - 1];
      if (last && range.startDay <= last.endDay + 1) {
        last.endDay = Math.max(last.endDay, range.endDay);
      } else {
        merged.push({ ...range });
      }
    }
    map.set(resourceId, merged);
  }
  return map;
}

/** true, wenn der Epoch-Tag in einem der (sortierten) Abwesenheitsbereiche liegt. */
export function isAbsentOn(ranges: AbsenceRange[] | undefined, epochDay: number): boolean {
  if (!ranges || ranges.length === 0 || Number.isNaN(epochDay)) return false;
  let low = 0;
  let high = ranges.length - 1;
  let best = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (ranges[mid]!.startDay <= epochDay) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best >= 0 && ranges[best]!.endDay >= epochDay;
}

// ---------------------------------------------------------------------------
// Verfügbarkeit je Tag
// ---------------------------------------------------------------------------

export function isAvailableOn(
  resource: ResourceLike,
  project: ProjectLike,
  isoDate: string,
  absences: AbsenceRange[] = [],
): boolean {
  const window = resourceWorkWindows(resource, project).get(isoWeekday(isoDate));
  if (!window) return false;
  return !isAbsentOn(absences, isoToEpochDay(isoDate));
}

/**
 * Verfügbare Minuten am Tag: 0 außerhalb der Arbeitswoche, 0 bei Abwesenheit,
 * sonst die an diesem Datum tatsächlich verstrichene Fensterlänge (DST-korrekt).
 */
export function availableMinutesOn(
  resource: ResourceLike,
  project: ProjectLike,
  isoDate: string,
  absences: AbsenceRange[] = [],
): number {
  const window = resourceWorkWindows(resource, project).get(isoWeekday(isoDate));
  if (!window) return 0;
  if (isAbsentOn(absences, isoToEpochDay(isoDate))) return 0;
  return windowBoundsFor(project.timezone, isoDate, window)?.minutes ?? 0;
}

/** Effektive Tageskapazität: min(`capacityMinutesPerDay`, Fensterlänge); 0 bei Abwesenheit. */
export function capacityMinutesOn(
  resource: ResourceLike,
  project: ProjectLike,
  isoDate: string,
  absences: AbsenceRange[] = [],
): number {
  const available = availableMinutesOn(resource, project, isoDate, absences);
  if (available === 0) return 0;
  return Math.max(0, Math.min(resource.capacityMinutesPerDay, available));
}

/**
 * Alle Ressourcen-Arbeitstage (Wochentagsfenster existiert) im Zeitraum
 * `[fromMs, toMs]` – inklusive Abwesenheitstagen (dort ist `capacityMinutes` 0,
 * damit Zuteilungen an Abwesenheitstagen sichtbar bleiben).
 */
export function resourceDaysBetween(
  resource: ResourceLike,
  project: ProjectLike,
  absences: AbsenceRange[] | undefined,
  fromMs: number,
  toMs: number,
): ResourceDay[] {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) return [];
  const windows = resourceWorkWindows(resource, project);
  const fromIso = isoAtMs(fromMs, project.timezone);
  const toIso = isoAtMs(toMs, project.timezone);
  if (!fromIso || !toIso) return [];

  const days: ResourceDay[] = [];
  let iso = fromIso;
  for (let guard = 0; guard < MAX_RANGE_DAYS && iso <= toIso; guard++) {
    const window = windows.get(isoWeekday(iso));
    if (window) {
      const bounds = windowBoundsFor(project.timezone, iso, window);
      if (bounds) {
        const absent = isAbsentOn(absences, isoToEpochDay(iso));
        days.push({
          iso,
          startMs: bounds.startMs,
          endMs: bounds.endMs,
          windowMinutes: bounds.minutes,
          absent,
          capacityMinutes: absent
            ? 0
            : Math.max(0, Math.min(resource.capacityMinutesPerDay, bounds.minutes)),
        });
      }
    }
    iso = addIsoDays(iso, 1);
  }
  return days;
}
