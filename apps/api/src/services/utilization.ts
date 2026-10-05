import { unprocessable } from '../errors.js';
import type { PlanningData } from './planningData.js';
import { buildAbsenceIndex, resourceDaysBetween, type ResourceDay } from './resourceCalendar.js';
import { taskDurationMinutes } from './scheduler.js';

export interface UtilizationBucketDto {
  resourceId: number;
  start: string;
  allocatedMinutes: number;
  capacityMinutes: number;
}

export interface UtilizationDto {
  from: string;
  to: string;
  bucketMinutes: number;
  buckets: UtilizationBucketDto[];
}

const MAX_BUCKETS = 50_000;
const MAX_SLOT_MINUTES = 60;

/** Zerlegt ein Ressourcen-Tagesfenster in ~stündliche Slots (variable Länge je Wochentag). */
function daySlots(day: ResourceDay): { startMs: number; minutes: number }[] {
  if (day.windowMinutes <= 0) return [];
  const count = Math.max(1, Math.ceil(day.windowMinutes / MAX_SLOT_MINUTES));
  const lengthMinutes = day.windowMinutes / count;
  const slots: { startMs: number; minutes: number }[] = [];
  for (let slot = 0; slot < count; slot++) {
    slots.push({ startMs: day.startMs + slot * lengthMinutes * 60_000, minutes: lengthMinutes });
  }
  return slots;
}

/**
 * Aggregiert Ressourcen-Auslastung in Zeit-Buckets.
 *
 * Kapazitäts- und Belegungs-Slots stammen aus den Wochentags-Arbeitsfenstern der
 * Ressource (variable Länge je Wochentag; Abwesenheit ⇒ Kapazität 0 am Tag),
 * NICHT aus dem Projekt-Kalender. Näherung wie bisher: Der Aufwand einer Aufgabe
 * wird gleichmäßig auf ihre Ressourcen-Arbeitstage und innerhalb eines Tages
 * gleichmäßig auf dessen Slots verteilt. Bucket-Semantik/DTO bleiben unverändert.
 */
export function buildUtilization(
  data: PlanningData,
  from: Date,
  to: Date,
  bucketMinutes: number,
): UtilizationDto {
  const { resources, tasks } = data;
  const fromMs = from.getTime();
  const toMs = to.getTime();
  if (toMs <= fromMs) throw unprocessable([], 'Zeitraum ist leer');

  const bucketMs = bucketMinutes * 60_000;
  const bucketCount = Math.ceil((toMs - fromMs) / bucketMs);
  if (bucketCount * Math.max(1, resources.length) > MAX_BUCKETS) {
    throw unprocessable(
      [],
      `Zeitraum/Zoomstufe zu groß (${bucketCount} Buckets × ${resources.length} Ressourcen)`,
    );
  }

  const absenceIndex = buildAbsenceIndex(data.absences);
  const allocated = new Map<string, number>();
  const capacity = new Map<string, number>();

  const addValue = (map: Map<string, number>, resourceId: number, slotStartMs: number, minutes: number) => {
    if (slotStartMs < fromMs || slotStartMs >= toMs) return;
    const index = Math.floor((slotStartMs - fromMs) / bucketMs);
    const key = `${resourceId}:${index}`;
    map.set(key, (map.get(key) ?? 0) + minutes);
  };

  // Kapazität: pro Ressource aus deren Tagesfenstern (0 bei Abwesenheit)
  for (const resource of resources) {
    const ranges = absenceIndex.get(resource.id);
    const days = resourceDaysBetween(resource, data.project, ranges, fromMs, toMs);
    for (const day of days) {
      if (day.capacityMinutes <= 0) continue;
      const slots = daySlots(day);
      const perSlot = day.capacityMinutes / slots.length;
      for (const slot of slots) addValue(capacity, resource.id, slot.startMs, perSlot);
    }
  }

  // Belegung: pro Zuteilung gleichmäßig über die Ressourcen-Arbeitstage und Slots
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const resourceById = new Map(resources.map((r) => [r.id, r]));
  for (const assignment of data.assignments) {
    const task = taskById.get(assignment.taskId);
    if (!task?.plannedStart || !task.plannedEnd) continue;
    const resource = resourceById.get(assignment.resourceId);
    if (!resource) continue;
    const duration = taskDurationMinutes(task);
    if (duration <= 0) continue;

    const days = resourceDaysBetween(
      resource,
      data.project,
      absenceIndex.get(resource.id),
      task.plannedStart.getTime(),
      task.plannedEnd.getTime(),
    );
    if (days.length === 0) continue;

    const perDay = (duration * assignment.allocationPercent) / 100 / days.length;
    for (const day of days) {
      const slots = daySlots(day);
      if (slots.length === 0) continue;
      const perSlot = perDay / slots.length;
      for (const slot of slots) addValue(allocated, assignment.resourceId, slot.startMs, perSlot);
    }
  }

  const buckets: UtilizationBucketDto[] = [];
  const keys = new Set([...allocated.keys(), ...capacity.keys()]);
  for (const key of keys) {
    const [resourceIdRaw, indexRaw] = key.split(':');
    const resourceId = Number(resourceIdRaw);
    const index = Number(indexRaw);
    const startMs = fromMs + index * bucketMs;
    buckets.push({
      resourceId,
      start: new Date(startMs).toISOString(),
      allocatedMinutes: Math.round(allocated.get(key) ?? 0),
      capacityMinutes: Math.round(capacity.get(key) ?? 0),
    });
  }
  buckets.sort((a, b) =>
    a.resourceId === b.resourceId
      ? a.start.localeCompare(b.start)
      : a.resourceId - b.resourceId,
  );

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    bucketMinutes,
    buckets,
  };
}
