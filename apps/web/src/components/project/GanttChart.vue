<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { DateTime } from 'luxon';
import { ABSENCE_TYPE_LABELS, type AbsenceType } from '@projectplaner/shared';
import { useProjectStore } from '@/stores/project';
import { useToasts } from '@/composables/useToasts';
import { formatDateTime } from '@/utils/datetime';
import type { ScheduleBarDto, TaskDto } from '@/types';

const store = useProjectStore();
const toasts = useToasts();

const ROW_H = 28;
const RES_ROW_H = 36;
const SECTION_H = 26;
const MIN_PX_PER_MINUTE = 0.0004;
// Cap: 5-Jahres-Achse bei max. Zoom bleibt unter ~4 Mio. px (Browser-Scrolllimits).
const MAX_PX_PER_MINUTE = 1.5;
const DAY_MS = 86_400_000;

type Row =
  | { kind: 'section'; key: string; label: string; height: number }
  | {
      kind: 'task';
      key: string;
      task: TaskDto;
      sched: ScheduleBarDto | undefined;
      depth: number;
      height: number;
    }
  | {
      kind: 'resource';
      key: string;
      resourceId: number;
      label: string;
      color: string | null;
      type: 'person' | 'machine';
      height: number;
    };

/** Einmal je Schedule-Änderung aufgebaut (statt bei jedem Render). */
const schedById = computed(() => new Map((store.schedule?.tasks ?? []).map((t) => [t.id, t])));

const rows = computed<Row[]>(() => {
  const out: Row[] = [];
  const sched = schedById.value;
  const walk = (nodes: TaskDto[], depth: number): void => {
    for (const node of nodes) {
      out.push({
        kind: 'task',
        key: `task-${node.id}`,
        task: node,
        sched: sched.get(node.id),
        depth,
        height: ROW_H,
      });
      if (node.children && node.children.length > 0 && store.expandedIds.has(node.id)) {
        walk(node.children, depth + 1);
      }
    }
  };
  if (store.taskTree.length > 0) {
    out.push({
      kind: 'section',
      key: 'section-tasks',
      label: `Aufgaben (${store.flatTasks.length})`,
      height: SECTION_H,
    });
    walk(store.taskTree, 0);
  }
  const activeResources = store.resources.filter((r) => r.isActive);
  if (activeResources.length > 0) {
    out.push({
      kind: 'section',
      key: 'section-resources',
      label: `Ressourcen-Auslastung (${activeResources.length})`,
      height: SECTION_H,
    });
    for (const resource of activeResources) {
      out.push({
        kind: 'resource',
        key: `resource-${resource.id}`,
        resourceId: resource.id,
        label: resource.name,
        color: resource.color,
        type: resource.type,
        height: RES_ROW_H,
      });
    }
  }
  return out;
});

/** taskId → Zeilenindex; ebenfalls nur bei Struktur-/Schedule-Änderung neu. */
const taskRowIndex = computed(() => {
  const map = new Map<number, number>();
  for (let i = 0; i < rows.value.length; i++) {
    const row = rows.value[i]!;
    if (row.kind === 'task') map.set(row.task.id, i);
  }
  return map;
});

/** Auslastungs-Buckets nach Ressource gruppiert (separater, zoomabhängiger Endpoint). */
const bucketsByResource = computed(() => {
  const map = new Map<number, Array<{ start: number; allocated: number; capacity: number }>>();
  for (const bucket of store.utilisation?.buckets ?? []) {
    const list = map.get(bucket.resourceId) ?? [];
    list.push({
      start: new Date(bucket.start).getTime(),
      allocated: bucket.allocatedMinutes,
      capacity: bucket.capacityMinutes,
    });
    map.set(bucket.resourceId, list);
  }
  return map;
});

/** Abwesenheitsfarbe je Art (schraffierte Fläche in der Ressourcenzeile). */
const ABSENCE_COLORS: Record<AbsenceType, string> = {
  vacation: '#f59e0b',
  sick: '#ef4444',
  other: '#64748b',
};

/** Abwesenheiten je Ressource als ms-Bereiche (lokaler Tagesbeginn … Folgetag). */
const absencesByResource = computed(() => {
  const map = new Map<
    number,
    Array<{ start: number; end: number; label: string; color: string }>
  >();
  const timezone = store.schedule?.project.timezone ?? 'Europe/Berlin';
  for (const absence of store.schedule?.absences ?? []) {
    const start = DateTime.fromISO(absence.startDate, { zone: timezone }).startOf('day').toMillis();
    const end = DateTime.fromISO(absence.endDate, { zone: timezone })
      .plus({ days: 1 })
      .startOf('day')
      .toMillis();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const list = map.get(absence.resourceId) ?? [];
    list.push({
      start,
      end,
      label: ABSENCE_TYPE_LABELS[absence.type],
      color: ABSENCE_COLORS[absence.type],
    });
    map.set(absence.resourceId, list);
  }
  return map;
});

const rowTops = computed(() => {
  const tops: number[] = [];
  let y = 0;
  for (const row of rows.value) {
    tops.push(y);
    y += row.height;
  }
  return { tops, total: y };
});

const totalHeight = computed(() => rowTops.value.total);

// ---- Teilaufgabe direkt im Gantt-Baum anlegen ------------------------------

const addingChildOf = ref<number | null>(null);
const newChildName = ref('');
const addChildInput = ref<HTMLInputElement | null>(null);

const addChildIndex = computed(() => {
  if (addingChildOf.value === null) return -1;
  return rows.value.findIndex(
    (row) => row.kind === 'task' && row.task.id === addingChildOf.value,
  );
});

/** Absolute Y-Position der Eingabe (unterhalb der Elternzeile im linken Baum). */
const addChildTop = computed(() => {
  const index = addChildIndex.value;
  if (index === -1) return 0;
  return rowTops.value.tops[index]! + rows.value[index]!.height;
});

const addChildParentName = computed(() => {
  const row = addChildIndex.value === -1 ? undefined : rows.value[addChildIndex.value];
  return row?.kind === 'task' ? row.task.name : '';
});

function startAddChild(taskId: number): void {
  addingChildOf.value = taskId;
  newChildName.value = '';
  void nextTick(() => addChildInput.value?.focus());
}

async function submitAddChild(): Promise<void> {
  if (addingChildOf.value === null || !newChildName.value.trim()) return;
  const parentId = addingChildOf.value;
  const name = newChildName.value.trim();
  addingChildOf.value = null;
  newChildName.value = '';
  await store.createTask({ parentId, name });
}

// ---- Zeitraum & Zoom ------------------------------------------------------

/**
 * Fixe Achse (Variante A): Referenz ist der Projektanker; früher geplante
 * Aufgaben erweitern nur nach links. Das Ende reicht mindestens 5 Jahre in
 * die Zukunft. Während einer geöffneten Projektansicht wächst die Achse nur,
 * sie schrumpft nicht (kein Ruckeln beim Bearbeiten).
 */
function computeStaticRange(): { from: number; to: number } {
  const timezone = store.schedule?.project.timezone ?? 'Europe/Berlin';
  const anchorIso = store.schedule?.project.scheduleAnchor;
  const anchor = anchorIso
    ? DateTime.fromISO(anchorIso, { zone: timezone }).startOf('day')
    : DateTime.now().setZone(timezone).startOf('day');

  let minStart = anchor.toMillis();
  let maxEnd = anchor.toMillis();
  for (const task of store.flatTasks) {
    if (task.plannedStart) minStart = Math.min(minStart, new Date(task.plannedStart).getTime());
    if (task.plannedEnd) maxEnd = Math.max(maxEnd, new Date(task.plannedEnd).getTime());
  }

  return {
    from: Math.min(anchor.toMillis(), minStart) - 2 * DAY_MS,
    to: Math.max(anchor.plus({ years: 5 }).toMillis(), maxEnd + 30 * DAY_MS),
  };
}

const range = ref({ from: Date.now() - 7 * DAY_MS, to: Date.now() + 30 * DAY_MS });
let rangeProjectId: number | null = null;

function ensureRange(): void {
  const next = computeStaticRange();
  if (rangeProjectId !== store.projectId) {
    rangeProjectId = store.projectId;
    range.value = next;
    return;
  }
  range.value = {
    from: Math.min(range.value.from, next.from),
    to: Math.max(range.value.to, next.to),
  };
}

const pxPerMinute = ref(0.1);
const timelineWidth = computed(() =>
  Math.max(120, Math.round(((range.value.to - range.value.from) / 60_000) * pxPerMinute.value)),
);

function bucketMinutesForSpan(): number {
  const days = (range.value.to - range.value.from) / DAY_MS;
  if (days <= 2) return 60;
  if (days <= 14) return 240;
  if (days <= 120) return 1440;
  if (days <= 800) return 10_080;
  return 43_200;
}

let utilisationTimer: number | undefined;
function scheduleUtilisationLoad(): void {
  window.clearTimeout(utilisationTimer);
  utilisationTimer = window.setTimeout(() => {
    void store
      .refreshUtilisation({
        from: new Date(range.value.from).toISOString(),
        to: new Date(range.value.to).toISOString(),
        bucketMinutes: bucketMinutesForSpan(),
      })
      .catch(() => undefined);
  }, 350);
}

function scrollToMs(ms: number): void {
  const target = ((ms - range.value.from) / 60_000) * pxPerMinute.value - viewportW.value / 2;
  rightScroll.value?.scrollTo({ left: Math.max(0, target), top: rightScroll.value.scrollTop });
}

function scrollToAnchor(): void {
  const timezone = store.schedule?.project.timezone ?? 'Europe/Berlin';
  const anchorIso = store.schedule?.project.scheduleAnchor;
  const anchor = anchorIso
    ? DateTime.fromISO(anchorIso, { zone: timezone }).startOf('day').toMillis()
    : range.value.from;
  scrollToMs(anchor);
}

function setZoom(preset: 'hour' | 'day' | 'week' | 'month' | 'fit'): void {
  const presets: Record<string, number> = {
    hour: 1,
    day: 0.12,
    week: 0.035,
    month: 0.009,
  };
  let next = presets[preset] ?? pxPerMinute.value;
  if (preset === 'fit') {
    next = viewportW.value / ((range.value.to - range.value.from) / 60_000);
  }
  next = Math.min(MAX_PX_PER_MINUTE, Math.max(MIN_PX_PER_MINUTE, next));
  const centerMs =
    range.value.from + ((scrollLeft.value + viewportW.value / 2) / pxPerMinute.value) * 60_000;
  pxPerMinute.value = next;
  window.requestAnimationFrame(() => {
    const scrollTarget = ((centerMs - range.value.from) / 60_000) * pxPerMinute.value - viewportW.value / 2;
    rightScroll.value?.scrollTo({ left: Math.max(0, scrollTarget), top: rightScroll.value.scrollTop });
  });
}

// ---- Canvas-Setup ---------------------------------------------------------

const rightScroll = ref<HTMLElement | null>(null);
const leftInner = ref<HTMLElement | null>(null);
const canvasBody = ref<HTMLCanvasElement | null>(null);
const canvasHeader = ref<HTMLCanvasElement | null>(null);
const viewportW = ref(800);
const viewportH = ref(500);
const scrollLeft = ref(0);
const scrollTop = ref(0);
let renderQueued = false;

/**
 * Sichtbarer Zeilenbereich (virtuelle Liste links + Canvas-Rendering):
 * Binärsuche über rowTops statt O(n)-Scan.
 */
const OVERSCAN_ROWS = 6;
const visibleRange = computed(() => {
  const all = rows.value;
  if (all.length === 0) return { start: 0, end: 0 };
  const { tops } = rowTops.value;
  const top = scrollTop.value;
  const bottom = top + viewportH.value;
  let lo = 0;
  let hi = all.length - 1;
  let first = all.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tops[mid]! + all[mid]!.height >= top) {
      first = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  let end = first;
  while (end < all.length && tops[end]! <= bottom) end += 1;
  return {
    start: Math.max(0, first - OVERSCAN_ROWS),
    end: Math.min(all.length, end + OVERSCAN_ROWS),
  };
});

const visibleWindow = computed(() => {
  const { start, end } = visibleRange.value;
  if (end <= start) return { offset: 0, rows: [] as Row[] };
  return { offset: rowTops.value.tops[start]!, rows: rows.value.slice(start, end) };
});

function queueRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  window.requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function onScroll(): void {
  const el = rightScroll.value;
  if (!el) return;
  scrollLeft.value = el.scrollLeft;
  scrollTop.value = el.scrollTop;
  if (leftInner.value) {
    leftInner.value.style.transform = `translateY(${-el.scrollTop}px)`;
  }
  queueRender();
}

const formatCache = new Map<string, Intl.DateTimeFormat>();
function formatter(key: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  let f = formatCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('de-DE', {
      timeZone: store.schedule?.project.timezone ?? 'Europe/Berlin',
      ...options,
    });
    formatCache.set(key, f);
  }
  return f;
}

function tickMinutes(): number {
  const candidates = [15, 30, 60, 120, 240, 480, 1440, 10080, 43200, 129600];
  return candidates.find((m) => m * pxPerMinute.value >= 80) ?? 129600;
}

function tickLabel(ms: number, interval: number): string {
  if (interval < 1440) {
    return formatter('hour', {
      weekday: 'short',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(ms);
  }
  if (interval < 43200) {
    return formatter('day', { day: '2-digit', month: '2-digit', year: '2-digit' }).format(ms);
  }
  return formatter('month', { month: 'short', year: 'numeric' }).format(ms);
}

interface BarRect {
  taskId: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

let barRects: BarRect[] = [];

function statusColor(task: TaskDto): string {
  switch (task.status) {
    case 'in_progress':
      return '#3b82f6';
    case 'blocked':
      return '#ef4444';
    case 'done':
      return '#22c55e';
    default:
      return '#94a3b8';
  }
}

function setupCanvas(canvas: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D {
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return ctx;
}

function timeToX(ms: number): number {
  return ((ms - range.value.from) / 60_000) * pxPerMinute.value - scrollLeft.value;
}

// ---- Interaktion ----------------------------------------------------------

interface DragState {
  taskId: number;
  mode: 'move' | 'resize';
  startX: number;
  origStartMs: number;
  origEndMs: number;
  deltaMinutes: number;
  moved: boolean;
}

const drag = ref<DragState | null>(null);
const hoverRow = ref<number | null>(null);

function snapMinutes(): number {
  if (pxPerMinute.value >= 0.5) return 15;
  if (pxPerMinute.value >= 0.1) return 60;
  return 480;
}

function hitTest(x: number, y: number): { bar: BarRect; mode: 'move' | 'resize' } | null {
  for (let i = barRects.length - 1; i >= 0; i--) {
    const bar = barRects[i]!;
    if (x >= bar.x && x <= bar.x + bar.w && y >= bar.y && y <= bar.y + bar.h) {
      const mode = x > bar.x + bar.w - 6 && bar.w > 12 ? 'resize' : 'move';
      return { bar, mode };
    }
  }
  return null;
}

function rowAt(y: number): number | null {
  const absolute = y + scrollTop.value;
  const { tops, total } = rowTops.value;
  if (absolute < 0 || absolute >= total || tops.length === 0) return null;
  // Binärsuche: letzte Zeile mit top <= absolute (Zeilen sind lückenlos).
  let lo = 0;
  let hi = tops.length - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tops[mid]! <= absolute) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

function mouseToLocal(event: MouseEvent): { x: number; y: number } {
  const canvas = canvasBody.value;
  if (!canvas) return { x: 0, y: 0 };
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

interface PanState {
  startX: number;
  startY: number;
  scrollLeft: number;
  scrollTop: number;
}

/** Laufender Pan (mittlere Maustaste) – verschiebt die Zeitachse in x und y. */
let panning: PanState | null = null;

function onMouseDown(event: MouseEvent): void {
  // Mittlere Maustaste: Pan, hat Vorrang vor dem Balken-Drag.
  if (event.button === 1) {
    event.preventDefault();
    const scroller = rightScroll.value;
    panning = {
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: scroller?.scrollLeft ?? 0,
      scrollTop: scroller?.scrollTop ?? 0,
    };
    if (canvasBody.value) canvasBody.value.style.cursor = 'grabbing';
    return;
  }
  if (event.button !== 0) return;

  const { x, y } = mouseToLocal(event);
  const hit = hitTest(x, y);
  if (hit && store.canWrite) {
    const task = store.taskById.get(hit.bar.taskId);
    if (!task?.plannedStart || !task.plannedEnd) return;
    drag.value = {
      taskId: hit.bar.taskId,
      mode: hit.mode,
      startX: event.clientX,
      origStartMs: new Date(task.plannedStart).getTime(),
      origEndMs: new Date(task.plannedEnd).getTime(),
      deltaMinutes: 0,
      moved: false,
    };
    event.preventDefault();
  }
}

function onMouseMove(event: MouseEvent): void {
  const canvas = canvasBody.value;
  if (!canvas) return;

  if (panning) {
    const scroller = rightScroll.value;
    if (scroller) {
      scroller.scrollLeft = panning.scrollLeft - (event.clientX - panning.startX);
      scroller.scrollTop = panning.scrollTop - (event.clientY - panning.startY);
    }
    return;
  }

  const { x, y } = mouseToLocal(event);

  if (drag.value) {
    const deltaPx = event.clientX - drag.value.startX;
    const snapped = Math.round((deltaPx / pxPerMinute.value) / snapMinutes()) * snapMinutes();
    drag.value = {
      ...drag.value,
      deltaMinutes: snapped,
      moved: drag.value.moved || Math.abs(deltaPx) > 3,
    };
    queueRender();
    return;
  }

  const rowIndex = rowAt(y);
  if (rowIndex !== hoverRow.value) {
    hoverRow.value = rowIndex;
    queueRender();
  }
  const hit = hitTest(x, y);
  canvas.style.cursor = hit ? (hit.mode === 'resize' ? 'ew-resize' : 'grab') : 'default';
}

async function commitDrag(): Promise<void> {
  const state = drag.value;
  drag.value = null;
  if (!state) return;

  if (!state.moved || state.deltaMinutes === 0) {
    store.setSelection(state.taskId);
    queueRender();
    return;
  }

  const timezone = store.schedule?.project.timezone ?? 'Europe/Berlin';

  if (state.mode === 'move') {
    const newStart = new Date(state.origStartMs + state.deltaMinutes * 60_000);
    const newEnd = new Date(state.origEndMs + state.deltaMinutes * 60_000);
    // Sofort lokal verschieben; der Server-Plan folgt per Broadcast (schedule:updated).
    const ok = await store.updateTask(
      state.taskId,
      { constraintType: 'start_no_earlier_than', constraintDate: newStart.toISOString() },
      {
        optimistic: {
          plannedStart: newStart.toISOString(),
          plannedEnd: newEnd.toISOString(),
          constraintType: 'start_no_earlier_than',
          constraintDate: newStart.toISOString(),
        },
      },
    );
    if (ok) {
      toasts.success(
        'Aufgabe gepinnt (nicht früher als ' +
          formatDateTime(newStart.toISOString(), timezone) +
          ')',
      );
    }
  } else {
    const durationMs = state.origEndMs - state.origStartMs;
    const newDurationMinutes = Math.max(
      15,
      Math.round((durationMs / 60_000 + state.deltaMinutes) / 15) * 15,
    );
    const newEnd = new Date(state.origStartMs + newDurationMinutes * 60_000);
    const ok = await store.updateTask(
      state.taskId,
      { estimatedMinutes: newDurationMinutes },
      {
        optimistic: {
          estimatedMinutes: newDurationMinutes,
          plannedEnd: newEnd.toISOString(),
        },
      },
    );
    if (ok) toasts.success('Dauer angepasst');
  }
  queueRender();
}

function onMouseUp(): void {
  if (panning) {
    panning = null;
    if (canvasBody.value) canvasBody.value.style.cursor = 'default';
  }
  if (drag.value) {
    void commitDrag();
  }
}

function onMouseLeave(): void {
  hoverRow.value = null;
  // Während eines Pans laufen Mausereignisse über die Fenster-Handler weiter.
  if (panning) return;
  if (drag.value) void commitDrag();
  queueRender();
}

function onWheel(event: WheelEvent): void {
  if (!event.ctrlKey && !event.metaKey) return;
  event.preventDefault();
  const canvas = canvasBody.value;
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const pointerX = event.clientX - rect.left;
  const timeAtPointer = range.value.from + ((scrollLeft.value + pointerX) / pxPerMinute.value) * 60_000;
  const factor = event.deltaY < 0 ? 1.2 : 1 / 1.2;
  const next = Math.min(
    MAX_PX_PER_MINUTE,
    Math.max(MIN_PX_PER_MINUTE, pxPerMinute.value * factor),
  );
  pxPerMinute.value = next;
  window.requestAnimationFrame(() => {
    const targetScroll = ((timeAtPointer - range.value.from) / 60_000) * next - pointerX;
    rightScroll.value?.scrollTo({ left: Math.max(0, targetScroll), top: rightScroll.value.scrollTop });
  });
}

// ---- Rendering ------------------------------------------------------------

function render(): void {
  renderHeader();
  renderBody();
}

function renderHeader(): void {
  const canvas = canvasHeader.value;
  if (!canvas) return;
  const w = viewportW.value;
  const h = 34;
  const ctx = setupCanvas(canvas, w, h);

  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, w, h);

  const interval = tickMinutes();
  const intervalMs = interval * 60_000;
  const viewStart = range.value.from + scrollLeft.value * (60_000 / pxPerMinute.value);
  const viewEnd = range.value.from + (scrollLeft.value + w) * (60_000 / pxPerMinute.value);

  ctx.font = '11px system-ui, sans-serif';
  ctx.textBaseline = 'middle';

  const first = Math.floor(viewStart / intervalMs) * intervalMs;
  for (let ms = first; ms <= viewEnd; ms += intervalMs) {
    const x = Math.round(timeToX(ms)) + 0.5;
    if (x < -100 || x > w + 100) continue;
    ctx.strokeStyle = '#e2e8f0';
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
    ctx.fillStyle = '#64748b';
    ctx.fillText(tickLabel(ms, interval), x + 4, h / 2);
  }

  // Heute-Marker
  const todayX = timeToX(Date.now());
  if (todayX >= 0 && todayX <= w) {
    ctx.strokeStyle = '#ef4444';
    ctx.beginPath();
    ctx.moveTo(todayX, 0);
    ctx.lineTo(todayX, h);
    ctx.stroke();
  }

  ctx.strokeStyle = '#cbd5e1';
  ctx.beginPath();
  ctx.moveTo(0, h - 0.5);
  ctx.lineTo(w, h - 0.5);
  ctx.stroke();
}

function renderBody(): void {
  const canvas = canvasBody.value;
  if (!canvas) return;
  const w = viewportW.value;
  const h = viewportH.value;
  const ctx = setupCanvas(canvas, w, h);

  const positions = rowTops.value.tops;
  const visible = (rowIndex: number): boolean => {
    const top = positions[rowIndex]!;
    return top + rows.value[rowIndex]!.height >= scrollTop.value && top <= scrollTop.value + h;
  };
  const { start, end } = visibleRange.value;

  // Zeilen-Hintergründe (nur sichtbarer Bereich statt alle ~2.000 Zeilen)
  for (let i = start; i < end; i++) {
    const row = rows.value[i]!;
    const y = positions[i]! - scrollTop.value;
    if (row.kind === 'section') {
      ctx.fillStyle = '#f1f5f9';
      ctx.fillRect(0, y, w, row.height);
      ctx.fillStyle = '#475569';
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(row.label, 8, y + row.height / 2);
    } else if (row.kind === 'resource' && row.type === 'machine') {
      ctx.fillStyle = '#fafafa';
      ctx.fillRect(0, y, w, row.height);
    }
    const foreign = row.kind === 'task' ? foreignSelections.value.get(row.task.id) : undefined;
    if (row.kind === 'task' && store.selectedTaskId === row.task.id) {
      ctx.fillStyle = 'rgba(99, 102, 241, 0.06)';
      ctx.fillRect(0, y, w, row.height);
    } else if (foreign) {
      ctx.fillStyle = `${foreign.color}1f`;
      ctx.fillRect(0, y, w, row.height);
    } else if (hoverRow.value === i) {
      ctx.fillStyle = 'rgba(15, 23, 42, 0.03)';
      ctx.fillRect(0, y, w, row.height);
    }
    if (foreign) {
      // Dezente Fremd-Auswahl-Markierung links (eigene Auswahl bleibt Indigo-Tönung).
      ctx.fillStyle = foreign.color;
      ctx.fillRect(0, y, 2.5, row.height);
    }
  }

  // Heute-Linie
  const todayX = Math.round(timeToX(Date.now())) + 0.5;
  if (todayX >= 0 && todayX <= w) {
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.6)';
    ctx.beginPath();
    ctx.moveTo(todayX, 0);
    ctx.lineTo(todayX, h);
    ctx.stroke();
  }

  const taskRowY = (taskId: number): number | null => {
    const index = taskRowIndex.value.get(taskId);
    if (index === undefined || !visible(index)) return null;
    return positions[index]! - scrollTop.value + ROW_H / 2;
  };

  // Abhängigkeitspfeile (Zeiten kommen aus den Task-Stammdaten)
  ctx.strokeStyle = 'rgba(100, 116, 139, 0.7)';
  ctx.fillStyle = 'rgba(100, 116, 139, 0.9)';
  ctx.lineWidth = 1;
  const taskById = store.taskById;
  for (const edge of store.schedule?.edges ?? []) {
    const pred = taskById.get(edge.predecessorId);
    const succ = taskById.get(edge.successorId);
    if (!pred?.plannedEnd || !succ?.plannedStart) continue;
    const y1Raw = taskRowY(edge.predecessorId);
    const y2Raw = taskRowY(edge.successorId);
    if (y1Raw === null || y2Raw === null) continue;
    const x1 = timeToX(new Date(pred.plannedEnd).getTime());
    const x2 = timeToX(new Date(succ.plannedStart).getTime());
    const y1 = y1Raw;
    const y2 = y2Raw;
    const midX = x1 + 10 <= x2 - 10 ? (x1 + x2) / 2 : x1 + 14;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(midX, y1);
    ctx.lineTo(midX, y2);
    ctx.lineTo(x2 - 4, y2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - 6, y2 - 3.5);
    ctx.lineTo(x2 - 6, y2 + 3.5);
    ctx.closePath();
    ctx.fill();
  }

  // Aufgaben-Balken (nur sichtbarer Bereich; Zeiten aus den Task-Stammdaten)
  barRects = [];
  for (let i = start; i < end; i++) {
    const row = rows.value[i]!;
    if (row.kind !== 'task') continue;
    const { task } = row;
    if (!task.plannedStart || !task.plannedEnd) continue;

    const rowY = positions[i]! - scrollTop.value;
    let startMs = new Date(task.plannedStart).getTime();
    let endMs = new Date(task.plannedEnd).getTime();

    const isDragged = drag.value?.taskId === row.task.id;
    if (isDragged && drag.value) {
      if (drag.value.mode === 'move') {
        startMs += drag.value.deltaMinutes * 60_000;
        endMs += drag.value.deltaMinutes * 60_000;
      } else {
        endMs = Math.max(startMs + 15 * 60_000, endMs + drag.value.deltaMinutes * 60_000);
      }
    }

    const x = timeToX(startMs);
    const xEnd = timeToX(endMs);
    const barH = 14;
    const y = rowY + (ROW_H - barH) / 2;
    const width = Math.max(2, xEnd - x);
    const color = statusColor(row.task);

    if (isDragged) {
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = '#6366f1';
      ctx.strokeRect(x - 0.5, y - 0.5, width + 1, barH + 1);
      ctx.setLineDash([]);
    }

    if (row.task.isMilestone) {
      const cx = x;
      const cy = rowY + ROW_H / 2;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(cx, cy - 8);
      ctx.lineTo(cx + 8, cy);
      ctx.lineTo(cx, cy + 8);
      ctx.lineTo(cx - 8, cy);
      ctx.closePath();
      ctx.fill();
      if (row.sched?.critical) {
        ctx.strokeStyle = '#dc2626';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      barRects.push({ taskId: row.task.id, x: cx - 8, y: cy - 8, w: 16, h: 16 });
    } else {
      // Basis (hell) + Fortschritt (voll)
      ctx.fillStyle = `${color}40`;
      roundRect(ctx, x, y, width, barH, 3);
      ctx.fill();
      if (row.task.progress > 0) {
        ctx.fillStyle = color;
        roundRect(ctx, x, y, (width * row.task.progress) / 100, barH, 3);
        ctx.fill();
      }
      ctx.strokeStyle = row.sched?.critical ? '#dc2626' : `${color}`;
      ctx.lineWidth = row.sched?.critical ? 1.5 : 1;
      roundRect(ctx, x + 0.5, y + 0.5, width - 1, barH - 1, 3);
      ctx.stroke();
      barRects.push({ taskId: row.task.id, x, y, w: width, h: barH });
    }

    // Pin für Constraint
    if (row.task.constraintType !== 'asap') {
      ctx.fillStyle = '#f59e0b';
      ctx.beginPath();
      ctx.arc(x, y - 3, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // Label (wenn Platz)
    if (width > 60 && pxPerMinute.value > 0.05) {
      ctx.fillStyle = '#0f172a';
      ctx.font = '10px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      const label = row.task.name;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x + 4, y, width - 8, barH);
      ctx.clip();
      ctx.fillText(label, x + 5, y + barH / 2);
      ctx.restore();
    }
  }

  // Ressourcen-Auslastung (Buckets sind als computed vorbereitet)
  for (let i = start; i < end; i++) {
    const row = rows.value[i]!;
    if (row.kind !== 'resource') continue;
    const rowY = positions[i]! - scrollTop.value;

    // Abwesenheiten schraffieren (Urlaub/Krank/Sonstiges); Balken zeichnen darüber.
    for (const absence of absencesByResource.value.get(row.resourceId) ?? []) {
      let x1 = timeToX(absence.start);
      let x2 = timeToX(absence.end);
      if (x2 < 0 || x1 > w) continue;
      x1 = Math.max(0, x1);
      x2 = Math.min(w, x2);
      const width = x2 - x1;
      if (width < 1) continue;

      ctx.save();
      ctx.beginPath();
      ctx.rect(x1, rowY, width, RES_ROW_H);
      ctx.clip();
      ctx.fillStyle = `${absence.color}18`;
      ctx.fillRect(x1, rowY, width, RES_ROW_H);
      ctx.strokeStyle = `${absence.color}88`;
      ctx.lineWidth = 1;
      for (let stripe = x1 - RES_ROW_H; stripe < x2 + RES_ROW_H; stripe += 6) {
        ctx.beginPath();
        ctx.moveTo(stripe, rowY + RES_ROW_H);
        ctx.lineTo(stripe + RES_ROW_H, rowY);
        ctx.stroke();
      }
      ctx.restore();

      if (width > 46) {
        ctx.fillStyle = absence.color;
        ctx.font = '600 9px system-ui, sans-serif';
        ctx.textBaseline = 'top';
        ctx.fillText(absence.label, x1 + 3, rowY + 2);
      }
    }

    const buckets = bucketsByResource.value.get(row.resourceId) ?? [];
    const bucketMs = (store.utilisation?.bucketMinutes ?? 1440) * 60_000;

    for (const bucket of buckets) {
      const x = timeToX(bucket.start);
      const bw = Math.max(1, (bucketMs / 60_000) * pxPerMinute.value - 1);
      if (x + bw < 0 || x > w) continue;
      // Kapazität 0 (Abwesenheit) mit Belegung → voller roter Balken.
      const ratio =
        bucket.capacity > 0 ? bucket.allocated / bucket.capacity : bucket.allocated > 0 ? 1 : 0;
      const ratioClamped = Math.min(1, ratio);
      const barH = Math.max(2, ratioClamped * (RES_ROW_H - 12));
      const y = rowY + RES_ROW_H - 6 - barH;
      const overloaded = bucket.capacity <= 0 ? bucket.allocated > 0 : bucket.allocated > bucket.capacity * 1.0001;
      ctx.fillStyle = overloaded ? '#ef4444' : ratio > 0.8 ? '#f59e0b' : '#10b981';
      ctx.globalAlpha = 0.85;
      ctx.fillRect(x, y, bw, barH);
      ctx.globalAlpha = 1;
    }
    // 100%-Linie
    ctx.strokeStyle = '#e2e8f0';
    ctx.beginPath();
    ctx.moveTo(0, rowY + 6.5);
    ctx.lineTo(w, rowY + 6.5);
    ctx.stroke();
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, 0);
  ctx.arcTo(x, y + h, x, y, radius === 0 ? 0 : radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

// ---- Lifecycle ------------------------------------------------------------

let resizeObserver: ResizeObserver | null = null;

function measure(): void {
  const scroller = rightScroll.value;
  if (!scroller) return;
  viewportW.value = scroller.clientWidth;
  viewportH.value = scroller.clientHeight;
  queueRender();
}

let fitDone = false;
function ensureFit(): void {
  if (fitDone || viewportW.value === 0) return;
  fitDone = true;
  const spanMinutes = (range.value.to - range.value.from) / 60_000;
  pxPerMinute.value = Math.min(
    MAX_PX_PER_MINUTE,
    Math.max(MIN_PX_PER_MINUTE, viewportW.value / spanMinutes),
  );
}

onMounted(() => {
  ensureRange();
  measure();
  ensureFit();
  scheduleUtilisationLoad();
  queueRender();
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  if (typeof ResizeObserver !== 'undefined' && rightScroll.value) {
    resizeObserver = new ResizeObserver(() => {
      measure();
      ensureFit();
    });
    resizeObserver.observe(rightScroll.value);
  }
});

onBeforeUnmount(() => {
  window.removeEventListener('mousemove', onMouseMove);
  window.removeEventListener('mouseup', onMouseUp);
  window.clearTimeout(utilisationTimer);
  resizeObserver?.disconnect();
});

watch(
  () => store.schedule,
  () => {
    ensureRange();
    queueRender();
  },
);
watch(
  () => [store.utilisation, store.selectedTaskId, store.expandedIds, rows.value.length, store.presenceSelections],
  () => queueRender(),
);
watch(
  () => [range.value.from, range.value.to, pxPerMinute.value] as const,
  () => {
    scheduleUtilisationLoad();
    queueRender();
  },
);

// „Springe zur Aufgabe“: Zeile vertikal und Balken horizontal in den Blick rücken.
watch(
  () => store.focusRequest,
  async (request) => {
    if (!request) return;
    await nextTick();
    const index = rows.value.findIndex(
      (row) => row.kind === 'task' && row.task.id === request.taskId,
    );
    if (index === -1 || !rightScroll.value) return;
    const top = Math.max(0, rowTops.value.tops[index]! - 80);
    const task = store.taskById.get(request.taskId);
    const startMs = task?.plannedStart ? new Date(task.plannedStart).getTime() : null;
    const left =
      startMs !== null && Number.isFinite(startMs)
        ? Math.max(
            0,
            ((startMs - range.value.from) / 60_000) * pxPerMinute.value - viewportW.value / 2,
          )
        : rightScroll.value.scrollLeft;
    rightScroll.value.scrollTo({ left, top, behavior: 'smooth' });
  },
);

// ---- Fremd-Auswahl (Presence) --------------------------------------------

/** Feste Farbskala, je User-ID stabil zugeordnet. */
const PRESENCE_COLORS = [
  '#0ea5e9',
  '#f97316',
  '#22c55e',
  '#a855f7',
  '#ef4444',
  '#14b8a6',
  '#eab308',
  '#ec4899',
];

function presenceColor(userId: number): string {
  return PRESENCE_COLORS[userId % PRESENCE_COLORS.length]!;
}

/** taskId → Markierung des fremden Users, der diese Aufgabe ausgewählt hat. */
const foreignSelections = computed(() => {
  const map = new Map<number, { userId: number; name: string; color: string }>();
  for (const [userId, taskId] of store.presenceSelections) {
    if (taskId === null) continue;
    const user = store.presence.find((p) => p.userId === userId);
    map.set(taskId, {
      userId,
      name: user?.name ?? `Nutzer ${userId}`,
      color: presenceColor(userId),
    });
  }
  return map;
});

const selectionLegend = computed(() => [...foreignSelections.value.values()]);

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((part) => part[0] ?? '')
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

function taskRowStyle(row: Extract<Row, { kind: 'task' }>): Record<string, string | undefined> {
  const ownSelection = store.selectedTaskId === row.task.id;
  const foreign = foreignSelections.value.get(row.task.id);
  return {
    height: `${row.height}px`,
    paddingLeft: `${row.depth * 14 + 8}px`,
    boxShadow: foreign ? `inset 3px 0 0 ${foreign.color}` : undefined,
    backgroundColor: !ownSelection && foreign ? `${foreign.color}14` : undefined,
  };
}

function toggleRow(row: Row): void {
  if (row.kind === 'task') {
    if (row.task.children && row.task.children.length > 0) store.toggleExpanded(row.task.id);
    store.setSelection(row.task.id);
  }
}

const legend = [
  { label: 'Offen', color: '#94a3b8' },
  { label: 'In Arbeit', color: '#3b82f6' },
  { label: 'Blockiert', color: '#ef4444' },
  { label: 'Fertig', color: '#22c55e' },
];
</script>

<template>
  <div class="flex h-[72vh] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
    <div class="flex flex-wrap items-center gap-2 border-b border-slate-100 px-3 py-2 text-xs">
      <span class="font-medium text-slate-500">Zoom:</span>
      <button type="button" class="rounded-md border border-slate-200 px-2 py-1 hover:bg-slate-50" @click="setZoom('hour')">Stunden</button>
      <button type="button" class="rounded-md border border-slate-200 px-2 py-1 hover:bg-slate-50" @click="setZoom('day')">Tage</button>
      <button type="button" class="rounded-md border border-slate-200 px-2 py-1 hover:bg-slate-50" @click="setZoom('week')">Wochen</button>
      <button type="button" class="rounded-md border border-slate-200 px-2 py-1 hover:bg-slate-50" @click="setZoom('month')">Monate</button>
      <button type="button" class="rounded-md border border-slate-200 px-2 py-1 hover:bg-slate-50" @click="setZoom('fit')">Alles</button>
      <span class="mx-1 h-4 w-px bg-slate-200" />
      <button type="button" class="rounded-md border border-slate-200 px-2 py-1 hover:bg-slate-50" @click="scrollToAnchor()">Zum Anker</button>
      <button type="button" class="rounded-md border border-slate-200 px-2 py-1 hover:bg-slate-50" @click="scrollToMs(Date.now())">Heute</button>
      <span class="ml-2 hidden text-slate-400 lg:inline">
        Strg+Mausrad = Zoom · mittlere Maustaste = verschieben · Balken ziehen = pinnen · rechte Kante = Dauer
      </span>
      <span class="ml-auto hidden items-center gap-3 md:flex">
        <span
          v-for="mark in selectionLegend"
          :key="mark.userId"
          class="flex items-center gap-1 text-slate-500"
          :title="`${mark.name} (Auswahl)`"
        >
          <span class="h-2 w-2 rounded-sm" :style="{ backgroundColor: mark.color }" />
          {{ initials(mark.name) }}
        </span>
        <span v-for="item in legend" :key="item.label" class="flex items-center gap-1 text-slate-500">
          <span class="h-2 w-2 rounded-full" :style="{ backgroundColor: item.color }" />
          {{ item.label }}
        </span>
      </span>
    </div>

    <div
      class="grid flex-1 overflow-hidden"
      style="grid-template-columns: 340px minmax(0, 1fr); grid-template-rows: 34px minmax(0, 1fr)"
    >
      <div class="flex items-center border-b border-r border-slate-200 bg-slate-50 px-3 text-xs font-medium text-slate-500">
        Aufgabe / Ressource
      </div>
      <div class="relative overflow-hidden border-b border-slate-200 bg-slate-50">
        <canvas ref="canvasHeader" class="absolute left-0 top-0" />
      </div>

      <div class="relative overflow-hidden border-r border-slate-200 bg-white">
        <div ref="leftInner" class="absolute left-0 top-0 w-full will-change-transform">
          <!-- Höhen-Platzhalter + virtueller Ausschnitt: nur sichtbare Zeilen im DOM -->
          <div class="relative w-full" :style="{ height: `${totalHeight}px` }">
            <div
              class="absolute left-0 top-0 w-full"
              :style="{ transform: `translateY(${visibleWindow.offset}px)` }"
            >
              <template v-for="row in visibleWindow.rows" :key="row.key">
                <div
                  v-if="row.kind === 'section'"
                  class="flex items-center bg-slate-100 px-3 text-[11px] font-semibold uppercase tracking-wide text-slate-500"
                  :style="{ height: `${row.height}px` }"
                >
                  {{ row.label }}
                </div>
                <div
                  v-else-if="row.kind === 'task'"
                  class="flex cursor-pointer items-center gap-1.5 border-b border-slate-50 px-2 text-sm"
                  :class="{ 'bg-indigo-50': store.selectedTaskId === row.task.id }"
                  :style="taskRowStyle(row)"
                  @click="toggleRow(row)"
                >
                  <button
                    v-if="row.task.children && row.task.children.length > 0"
                    type="button"
                    class="grid h-4 w-4 shrink-0 place-items-center rounded text-slate-400 hover:bg-slate-200"
                    @click.stop="store.toggleExpanded(row.task.id)"
                  >
                    {{ store.expandedIds.has(row.task.id) ? '▾' : '▸' }}
                  </button>
                  <span v-else class="w-4 shrink-0" />
                  <span v-if="row.task.isMilestone" class="shrink-0 text-[10px]">◆</span>
                  <span v-if="row.task.constraintType !== 'asap'" class="shrink-0 text-[10px]" title="Start-Constraint">📌</span>
                  <span class="truncate" :class="{ 'font-medium': row.task.children?.length }">{{ row.task.name }}</span>
                  <span class="ml-auto flex shrink-0 items-center gap-1">
                    <span v-if="row.sched?.critical" class="rounded bg-red-50 px-1 text-[10px] text-red-600">kritisch</span>
                    <button
                      v-if="store.canWrite"
                      type="button"
                      class="grid h-4 w-4 shrink-0 place-items-center rounded border border-slate-200 bg-white text-xs leading-none text-slate-500 shadow-sm transition hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-600"
                      title="Teilaufgabe anlegen"
                      @click.stop="startAddChild(row.task.id)"
                    >
                      +
                    </button>
                  </span>
                </div>
                <div
                  v-else
                  class="flex items-center gap-2 border-b border-slate-50 px-3 text-sm text-slate-600"
                  :style="{ height: `${row.height}px` }"
                >
                  <span class="h-2.5 w-2.5 rounded-full" :style="{ backgroundColor: row.color ?? '#94a3b8' }" />
                  <span class="truncate">{{ row.label }}</span>
                  <span class="ml-auto text-[10px] uppercase text-slate-400">{{ row.type === 'person' ? 'Person' : 'Maschine' }}</span>
                </div>
              </template>
            </div>
          </div>

          <!-- Inline-Eingabe: Teilaufgabe direkt im Gantt-Baum anlegen -->
          <div
            v-if="addingChildOf !== null"
            class="absolute inset-x-0 z-20 px-2"
            :style="{ top: `${addChildTop}px` }"
          >
            <input
              ref="addChildInput"
              v-model="newChildName"
              :placeholder="`Teilaufgabe von „${addChildParentName}“…`"
              class="w-full rounded-md border border-indigo-300 bg-white px-2 py-1 text-sm shadow-lg outline-none"
              @mousedown.stop
              @click.stop
              @keydown.enter="submitAddChild"
              @keydown.esc="addingChildOf = null"
            />
          </div>
        </div>
      </div>

      <div ref="rightScroll" class="relative overflow-auto" @scroll="onScroll">
        <div class="relative" :style="{ width: `${timelineWidth}px`, height: `${totalHeight}px` }">
          <canvas
            ref="canvasBody"
            class="sticky left-0 top-0"
            @mousedown="onMouseDown"
            @mousemove="onMouseMove"
            @mouseleave="onMouseLeave"
            @wheel="onWheel"
            @auxclick.prevent
          />
        </div>
      </div>
    </div>
  </div>
</template>
