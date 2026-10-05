import { unprocessable } from '../errors.js';
import type { PlanningData } from './planningData.js';
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

/**
 * Aggregiert Ressourcen-Auslastung in Zeit-Buckets (Arbeitsstunden-Raster).
 * Näherung: Die Aufwände einer Aufgabe werden gleichmäßig auf ihre Arbeitstage
 * und innerhalb eines Tages gleichmäßig auf die Arbeitsstunden verteilt.
 */
export function buildUtilization(
  data: PlanningData,
  from: Date,
  to: Date,
  bucketMinutes: number,
): UtilizationDto {
  const { calendar, resources, tasks } = data;
  const fromMs = from.getTime();
  const toMs = to.getTime();
  if (toMs <= fromMs) throw unprocessable([], 'Zeitraum ist leer');
  calendar.precomputeRange(fromMs, toMs);

  const bucketMs = bucketMinutes * 60_000;
  const bucketCount = Math.ceil((toMs - fromMs) / bucketMs);
  if (bucketCount * Math.max(1, resources.length) > MAX_BUCKETS) {
    throw unprocessable(
      [],
      `Zeitraum/Zoomstufe zu groß (${bucketCount} Buckets × ${resources.length} Ressourcen)`,
    );
  }

  const workdayMinutes = calendar.workingHoursPerDay();
  const hourCount = Math.max(1, Math.ceil(workdayMinutes / 60));
  const slotMinutes = workdayMinutes / hourCount;

  const allocated = new Map<string, number>();
  const capacity = new Map<string, number>();

  const addValue = (map: Map<string, number>, resourceId: number, slotStartMs: number, minutes: number) => {
    if (slotStartMs < fromMs || slotStartMs >= toMs) return;
    const index = Math.floor((slotStartMs - fromMs) / bucketMs);
    const key = `${resourceId}:${index}`;
    map.set(key, (map.get(key) ?? 0) + minutes);
  };

  // Kapazität: pro Ressource und Arbeits-Slot
  const rangeDayStarts = calendar.workingDayStartsBetween(fromMs, toMs);
  for (const resource of resources) {
    const capacityPerSlot = resource.capacityMinutesPerDay / hourCount;
    for (const dayStartMs of rangeDayStarts) {
      for (let slot = 0; slot < hourCount; slot++) {
        addValue(capacity, resource.id, dayStartMs + slot * slotMinutes * 60_000, capacityPerSlot);
      }
    }
  }

  // Belegung: pro Zuteilung gleichmäßig über Arbeitstage und Slots
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  for (const assignment of data.assignments) {
    const task = taskById.get(assignment.taskId);
    if (!task?.plannedStart || !task.plannedEnd) continue;
    const duration = taskDurationMinutes(task);
    if (duration <= 0) continue;

    const assignmentDayStarts = calendar.workingDayStartsBetween(
      task.plannedStart.getTime(),
      task.plannedEnd.getTime(),
    );
    if (assignmentDayStarts.length === 0) continue;

    const perDay = (duration * assignment.allocationPercent) / 100 / assignmentDayStarts.length;
    const perSlot = perDay / hourCount;

    for (const dayStartMs of assignmentDayStarts) {
      for (let slot = 0; slot < hourCount; slot++) {
        addValue(allocated, assignment.resourceId, dayStartMs + slot * slotMinutes * 60_000, perSlot);
      }
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
