<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { useProjectStore } from '@/stores/project';
import { useToasts } from '@/composables/useToasts';
import {
  formatDateTime as formatDateTimeInZone,
  fromZoneInput,
  toZoneInput,
} from '@/utils/datetime';
import { DEPENDENCY_TYPE_LABELS, type DependencyType } from '@projectplaner/shared';
import type { CommentDto, DependencyDto } from '@/types';

const store = useProjectStore();
const auth = useAuthStore();
const toasts = useToasts();

const timezone = computed(() => store.project?.timezone ?? 'Europe/Berlin');

const tab = ref<'details' | 'deps' | 'resources' | 'comments'>('details');

const form = reactive({
  name: '',
  description: '',
  hours: '',
  status: 'todo' as 'todo' | 'in_progress' | 'blocked' | 'done',
  priority: 'normal' as 'low' | 'normal' | 'high' | 'urgent',
  progress: 0,
  isMilestone: false,
  constraintType: 'asap' as 'asap' | 'start_no_earlier_than' | 'start_on',
  constraintLocal: '',
  actualStartLocal: '',
  actualEndLocal: '',
});

// ---- Auto-Save (Deklarationen vor dem Watcher, der sofort feuert) ----------

const saving = ref(false);
const savedAt = ref<number | null>(null);
const saveError = ref<string | null>(null);
let autosaveTimer: number | undefined;
let lastSyncedTaskId: number | null = null;
let lastSavedSnapshot = '';

function formSnapshot(): string {
  return JSON.stringify({
    name: form.name,
    description: form.description,
    hours: form.hours,
    status: form.status,
    priority: form.priority,
    progress: form.progress,
    isMilestone: form.isMilestone,
    constraintType: form.constraintType,
    constraintLocal: form.constraintLocal,
    actualStartLocal: form.actualStartLocal,
    actualEndLocal: form.actualEndLocal,
  });
}

function isDirty(): boolean {
  return formSnapshot() !== lastSavedSnapshot;
}

function syncForm(): void {
  const task = store.selectedTask;
  if (!task) return;
  // Nutzereingaben nicht durch Server-Refreshes überschreiben: Bei einem
  // Aufgabenwechsel wird immer synchronisiert, sonst nur wenn das Formular
  // unverändert ist (kein laufender Auto-Save).
  const isNewTask = lastSyncedTaskId !== task.id;
  if (!isNewTask && isDirty()) return;

  form.name = task.name;
  form.description = task.description ?? '';
  form.hours = task.estimatedMinutes !== null ? String(task.estimatedMinutes / 60) : '';
  form.status = task.status;
  form.priority = task.priority;
  form.progress = task.progress;
  form.isMilestone = task.isMilestone;
  form.constraintType = task.constraintType;
  form.constraintLocal = toZoneInput(task.constraintDate, timezone.value);
  form.actualStartLocal = toZoneInput(task.actualStart, timezone.value);
  form.actualEndLocal = toZoneInput(task.actualEnd, timezone.value);
  lastSyncedTaskId = task.id;
  // Frischer Snapshot: Ein Auto-Save läuft nur bei echten Änderungen.
  // (savedAt/saveError bleiben erhalten – Server-Refreshes nach dem eigenen
  // Speichern sollen die Statusanzeige nicht sofort wieder ausblenden.)
  lastSavedSnapshot = formSnapshot();
}

watch(
  () => [store.selectedTaskId, store.selectedTask?.version] as const,
  async (current, previous) => {
    // Aufgabenwechsel: zuerst den Formularstand der VORHERIGEN Aufgabe sichern.
    const previousId = previous?.[0];
    if (previousId !== undefined && previousId !== current[0]) {
      await flushPendingSave();
    }
    syncForm();
    if (previousId !== undefined && previousId !== current[0]) {
      // Neuer Task: Statusanzeige des vorherigen Saves zurücksetzen.
      savedAt.value = null;
      saveError.value = null;
    }
    const id = store.selectedTaskId;
    if (id === null) return;
    try {
      const [deps, comments] = await Promise.all([
        store.loadDependencies(id),
        store.loadComments(id),
      ]);
      predecessors.value = deps.predecessors;
      successors.value = deps.successors;
      commentList.value = comments;
    } catch {
      toasts.error('Details konnten nicht geladen werden');
    }
  },
  { immediate: true },
);

const predecessors = ref<DependencyDto[]>([]);
const successors = ref<DependencyDto[]>([]);
const commentList = ref<CommentDto[]>([]);

const otherTasks = computed(() =>
  store.flatTasks.filter((t) => t.id !== store.selectedTaskId),
);

const newDep = reactive({
  direction: 'pred' as 'pred' | 'succ',
  taskId: '' as string,
  type: 'FS' as DependencyType,
  lag: 0,
});
const newAssignment = reactive({ resourceId: '', allocation: 100 });
const newComment = ref('');

/** Ressourcen, die der Aufgabe noch nicht zugeteilt sind (Select-Optionen). */
const unassignedResources = computed(() => {
  const assigned = new Set((store.selectedTask?.assignments ?? []).map((a) => a.resourceId));
  return store.resources.filter((resource) => !assigned.has(resource.id));
});

function scheduleAutoSave(): void {
  window.clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(() => {
    void save();
  }, 1000);
}

// Jede Änderung an den Detailfeldern plant ein Debounce-Speichern (1 s) ein.
watch(form, () => scheduleAutoSave(), { deep: true });

/** Speichert den aktuellen Formularstand für eine konkrete Aufgabe. */
async function persistForm(taskId: number): Promise<boolean> {
  if (!isDirty()) return true;
  // <input type="number"> liefert mit v-model eine Zahl (oder '' im leeren Feld).
  const rawHours = form.hours === null || form.hours === undefined ? '' : String(form.hours);
  const hours = rawHours.trim() === '' ? null : Number(rawHours.replace(',', '.'));
  if (hours !== null && (!Number.isFinite(hours) || hours < 0)) {
    toasts.error('Ungültige Stundenzahl');
    return false;
  }

  saving.value = true;
  saveError.value = null;
  try {
    const ok = await store.updateTask(taskId, {
      name: form.name.trim() || 'Aufgabe',
      description: form.description,
      estimatedMinutes: hours === null ? null : Math.round(hours * 60),
      status: form.status,
      priority: form.priority,
      progress: Number(form.progress),
      isMilestone: form.isMilestone,
      constraintType: form.constraintType,
      constraintDate:
        form.constraintType === 'asap'
          ? null
          : fromZoneInput(form.constraintLocal, timezone.value),
      actualStart: fromZoneInput(form.actualStartLocal, timezone.value),
      actualEnd: fromZoneInput(form.actualEndLocal, timezone.value),
    });
    if (ok) {
      lastSavedSnapshot = formSnapshot();
      savedAt.value = Date.now();
    } else {
      saveError.value = 'Speichern fehlgeschlagen';
    }
    return ok;
  } finally {
    saving.value = false;
  }
}

async function save(): Promise<boolean> {
  const task = store.selectedTask;
  if (!task) return true;
  return persistForm(task.id);
}

/**
 * Sicheres Speichern vor Tab-Wechsel, Schließen oder Aufgabenwechsel:
 * adressiert bewusst den zuletzt synchronisierten Task (nicht die neue Auswahl).
 */
async function flushPendingSave(): Promise<void> {
  window.clearTimeout(autosaveTimer);
  if (lastSyncedTaskId === null || !isDirty()) return;
  const task = store.taskById.get(lastSyncedTaskId);
  if (!task) return;
  await persistForm(task.id);
}

function changeTab(key: 'details' | 'deps' | 'resources' | 'comments'): void {
  void flushPendingSave();
  tab.value = key;
}

function closeDrawer(): void {
  void flushPendingSave();
  store.setSelection(null);
}

async function unpin(): Promise<void> {
  const task = store.selectedTask;
  if (!task) return;
  const ok = await store.updateTask(task.id, {
    constraintType: 'asap',
    constraintDate: null,
  });
  if (ok) {
    syncForm();
    toasts.success('Start-Constraint gelöst');
  }
}

async function toggleTag(tagId: number): Promise<void> {
  const task = store.selectedTask;
  if (!task) return;
  const current = new Set((task.tags ?? []).map((t) => t.id));
  if (current.has(tagId)) current.delete(tagId);
  else current.add(tagId);
  await store.setTaskTags(task.id, [...current]);
}

const newTagName = ref('');
async function createTag(): Promise<void> {
  if (!newTagName.value.trim()) return;
  const tag = await store.createTag(newTagName.value.trim(), '#64748b');
  if (tag && store.selectedTask) {
    await toggleTag(tag.id);
  }
  newTagName.value = '';
}

async function addDependency(): Promise<void> {
  const task = store.selectedTask;
  if (!task || newDep.taskId === '') return;
  const otherId = Number(newDep.taskId);
  const input =
    newDep.direction === 'pred'
      ? { predecessorId: otherId, successorId: task.id }
      : { predecessorId: task.id, successorId: otherId };
  const ok = await store.addDependency(task.id, {
    ...input,
    type: newDep.type,
    lagMinutes: Number(newDep.lag),
  });
  if (ok) {
    const deps = await store.loadDependencies(task.id);
    predecessors.value = deps.predecessors;
    successors.value = deps.successors;
    newDep.taskId = '';
    newDep.lag = 0;
  }
}

async function removeDependency(id: number): Promise<void> {
  const task = store.selectedTask;
  if (!task) return;
  if (!(await store.deleteDependency(id))) return;
  const deps = await store.loadDependencies(task.id);
  predecessors.value = deps.predecessors;
  successors.value = deps.successors;
}

/** Inline-Änderung an Typ/Lag einer bestehenden Abhängigkeit. */
async function updateDependencyFields(
  id: number,
  patch: { type?: DependencyType; lagMinutes?: number },
): Promise<void> {
  const task = store.selectedTask;
  if (!task) return;
  if (!(await store.updateDependency(id, patch))) return;
  const deps = await store.loadDependencies(task.id);
  predecessors.value = deps.predecessors;
  successors.value = deps.successors;
}

async function addAssignment(): Promise<void> {
  const task = store.selectedTask;
  if (!task || newAssignment.resourceId === '') return;
  const ok = await store.assignResource(task.id, Number(newAssignment.resourceId), Number(newAssignment.allocation));
  if (ok) newAssignment.resourceId = '';
}

async function submitComment(): Promise<void> {
  const task = store.selectedTask;
  if (!task || !newComment.value.trim()) return;
  const ok = await store.addComment(task.id, newComment.value.trim());
  if (ok) {
    newComment.value = '';
    commentList.value = await store.loadComments(task.id);
  }
}

async function removeComment(id: number): Promise<void> {
  const task = store.selectedTask;
  if (!task) return;
  if (await store.deleteComment(id)) {
    commentList.value = await store.loadComments(task.id);
  }
}

function formatDateTime(iso: string): string {
  return formatDateTimeInZone(iso, timezone.value);
}

async function removeTask(): Promise<void> {
  const task = store.selectedTask;
  if (!task) return;
  if (!window.confirm(`Aufgabe „${task.name}“ inklusive Teilaufgaben löschen?`)) return;
  if (await store.deleteTask(task.id)) {
    toasts.success('Aufgabe gelöscht');
  }
}

/** ESC schließt das Sheet, ohne die Formularwerte zu speichern. */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && store.selectedTaskId !== null) {
    closeDrawer();
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <aside
    v-if="store.selectedTask"
    class="fixed inset-0 z-50 flex h-full flex-col overflow-hidden rounded-none bg-white md:inset-x-4 md:bottom-4 md:top-auto md:z-40 md:h-[45vh] md:rounded-xl md:border md:border-slate-200 md:shadow-xl"
  >
    <header class="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
      <h2 class="truncate font-medium text-slate-900">{{ store.selectedTask.name }}</h2>
      <button
        type="button"
        class="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
        aria-label="Schließen"
        @click="closeDrawer"
      >
        ✕
      </button>
    </header>

    <nav class="flex gap-1 overflow-x-auto border-b border-slate-100 px-3 pt-2 text-sm">
      <button
        v-for="t in [
          { key: 'details', label: 'Details' },
          { key: 'deps', label: 'Abhängigkeiten' },
          { key: 'resources', label: 'Ressourcen' },
          { key: 'comments', label: 'Kommentare' },
        ] as const"
        :key="t.key"
        type="button"
        class="shrink-0 rounded-t-md px-3 py-1.5"
        :class="
          tab === t.key
            ? 'border-b-2 border-indigo-600 font-medium text-indigo-700'
            : 'text-slate-500 hover:text-slate-800'
        "
        @click="changeTab(t.key)"
      >
        {{ t.label }}
      </button>
    </nav>

    <div class="min-h-0 flex-1 overflow-y-auto p-4">
      <!-- Details -->
      <div v-if="tab === 'details'" class="space-y-4">
        <div>
          <label class="mb-1 block text-xs font-medium text-slate-500">Name</label>
          <input v-model="form.name" class="w-full rounded-md border border-slate-200 px-3 py-2 text-sm outline-none focus:border-indigo-400" />
        </div>
        <div>
          <label class="mb-1 block text-xs font-medium text-slate-500">Beschreibung</label>
          <textarea v-model="form.description" rows="3" class="w-full rounded-md border border-slate-200 px-3 py-2 text-sm outline-none focus:border-indigo-400" />
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="mb-1 block text-xs font-medium text-slate-500">Schätzung (Stunden)</label>
            <input v-model="form.hours" type="number" min="0" step="0.25" class="w-full rounded-md border border-slate-200 px-3 py-2 text-sm outline-none focus:border-indigo-400" />
          </div>
          <div>
            <label class="mb-1 block text-xs font-medium text-slate-500">Fortschritt (%)</label>
            <input v-model.number="form.progress" type="number" min="0" max="100" class="w-full rounded-md border border-slate-200 px-3 py-2 text-sm outline-none focus:border-indigo-400" />
          </div>
          <div>
            <label class="mb-1 block text-xs font-medium text-slate-500">Status</label>
            <select v-model="form.status" class="w-full rounded-md border border-slate-200 px-2 py-2 text-sm outline-none focus:border-indigo-400">
              <option value="todo">Offen</option>
              <option value="in_progress">In Arbeit</option>
              <option value="blocked">Blockiert</option>
              <option value="done">Fertig</option>
            </select>
          </div>
          <div>
            <label class="mb-1 block text-xs font-medium text-slate-500">Priorität</label>
            <select v-model="form.priority" class="w-full rounded-md border border-slate-200 px-2 py-2 text-sm outline-none focus:border-indigo-400">
              <option value="low">Niedrig</option>
              <option value="normal">Normal</option>
              <option value="high">Hoch</option>
              <option value="urgent">Dringend</option>
            </select>
          </div>
        </div>

        <label class="flex items-center gap-2 text-sm text-slate-700">
          <input v-model="form.isMilestone" type="checkbox" class="rounded border-slate-300" />
          Meilenstein
        </label>

        <fieldset class="rounded-lg border border-slate-200 p-3">
          <legend class="px-1 text-xs font-medium text-slate-500">Start-Constraint</legend>
          <div class="space-y-2">
            <select v-model="form.constraintType" class="w-full rounded-md border border-slate-200 px-2 py-2 text-sm">
              <option value="asap">Automatisch (ASAP)</option>
              <option value="start_no_earlier_than">Nicht früher als</option>
              <option value="start_on">Fest am</option>
            </select>
            <input
              v-if="form.constraintType !== 'asap'"
              v-model="form.constraintLocal"
              type="datetime-local"
              class="w-full rounded-md border border-slate-200 px-3 py-2 text-sm"
            />
            <p v-if="form.constraintType !== 'asap'" class="text-xs text-slate-500">
              📌 Pin: Der Planer startet die Aufgabe nicht vor diesem Termin.
              <button type="button" class="text-indigo-600 hover:underline" @click="unpin">Pin lösen</button>
            </p>
          </div>
        </fieldset>

        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="mb-1 block text-xs font-medium text-slate-500">Geplant von</label>
            <p class="text-sm text-slate-700">
              {{ store.selectedTask.plannedStart ? formatDateTime(store.selectedTask.plannedStart) : '–' }}
            </p>
          </div>
          <div>
            <label class="mb-1 block text-xs font-medium text-slate-500">Geplant bis</label>
            <p class="text-sm text-slate-700">
              {{ store.selectedTask.plannedEnd ? formatDateTime(store.selectedTask.plannedEnd) : '–' }}
            </p>
          </div>
          <div>
            <label class="mb-1 block text-xs font-medium text-slate-500">Puffer (kritischer Pfad)</label>
            <p class="text-sm text-slate-700">
              {{ store.schedule?.tasks.find((t) => t.id === store.selectedTaskId)?.critical ? 'kritisch (0)' : `${store.schedule?.tasks.find((t) => t.id === store.selectedTaskId)?.slackMinutes ?? '–'} min` }}
            </p>
          </div>
        </div>

        <div>
          <label class="mb-1 block text-xs font-medium text-slate-500">Tags</label>
          <div class="flex flex-wrap gap-1.5">
            <button
              v-for="tag in store.tags"
              :key="tag.id"
              type="button"
              class="rounded-full border px-2 py-0.5 text-xs transition"
              :style="{
                borderColor: tag.color,
                backgroundColor: (store.selectedTask.tags ?? []).some((t) => t.id === tag.id)
                  ? tag.color
                  : 'transparent',
                color: (store.selectedTask.tags ?? []).some((t) => t.id === tag.id) ? '#fff' : tag.color,
              }"
              @click="toggleTag(tag.id)"
            >
              {{ tag.name }}
            </button>
          </div>
          <div class="mt-2 flex gap-2">
            <input
              v-model="newTagName"
              placeholder="Neuer Tag…"
              class="min-w-0 flex-1 rounded-md border border-slate-200 px-2 py-1 text-xs outline-none focus:border-indigo-400"
              @keydown.enter="createTag"
            />
            <button type="button" class="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-600 hover:bg-slate-200" @click="createTag">
              + Tag
            </button>
          </div>
        </div>
      </div>

      <!-- Abhängigkeiten -->
      <div v-else-if="tab === 'deps'" class="space-y-4 text-sm">
        <div>
          <h3 class="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">Vorgänger</h3>
          <p v-if="predecessors.length === 0" class="text-slate-500">Keine Vorgänger</p>
          <ul v-else class="space-y-1">
            <li v-for="dep in predecessors" :key="dep.id" class="rounded-md bg-slate-50 px-2 py-1.5">
              <div class="flex items-center justify-between gap-2">
                <span class="truncate">{{ dep.predecessorName }}</span>
                <button v-if="store.canWrite" type="button" class="shrink-0 text-xs text-red-500 hover:underline" @click="removeDependency(dep.id)">entfernen</button>
              </div>
              <div v-if="store.canWrite" class="mt-1 flex items-center gap-2">
                <select
                  :value="dep.type"
                  class="rounded border border-slate-200 px-1 py-0.5 text-xs"
                  @change="updateDependencyFields(dep.id, { type: ($event.target as HTMLSelectElement).value as DependencyType })"
                >
                  <option v-for="(label, type) in DEPENDENCY_TYPE_LABELS" :key="type" :value="type">{{ label }}</option>
                </select>
                <input
                  :value="dep.lagMinutes"
                  type="number"
                  class="w-20 rounded border border-slate-200 px-1 py-0.5 text-xs"
                  @change="updateDependencyFields(dep.id, { lagMinutes: Number(($event.target as HTMLInputElement).value) })"
                />
                <span class="text-xs text-slate-400">min Lag</span>
              </div>
            </li>
          </ul>
        </div>
        <div>
          <h3 class="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">Nachfolger</h3>
          <p v-if="successors.length === 0" class="text-slate-500">Keine Nachfolger</p>
          <ul v-else class="space-y-1">
            <li v-for="dep in successors" :key="dep.id" class="rounded-md bg-slate-50 px-2 py-1.5">
              <div class="flex items-center justify-between gap-2">
                <span class="truncate">{{ dep.successorName }}</span>
                <button v-if="store.canWrite" type="button" class="shrink-0 text-xs text-red-500 hover:underline" @click="removeDependency(dep.id)">entfernen</button>
              </div>
              <div v-if="store.canWrite" class="mt-1 flex items-center gap-2">
                <select
                  :value="dep.type"
                  class="rounded border border-slate-200 px-1 py-0.5 text-xs"
                  @change="updateDependencyFields(dep.id, { type: ($event.target as HTMLSelectElement).value as DependencyType })"
                >
                  <option v-for="(label, type) in DEPENDENCY_TYPE_LABELS" :key="type" :value="type">{{ label }}</option>
                </select>
                <input
                  :value="dep.lagMinutes"
                  type="number"
                  class="w-20 rounded border border-slate-200 px-1 py-0.5 text-xs"
                  @change="updateDependencyFields(dep.id, { lagMinutes: Number(($event.target as HTMLInputElement).value) })"
                />
                <span class="text-xs text-slate-400">min Lag</span>
              </div>
            </li>
          </ul>
        </div>

        <div v-if="store.canWrite" class="rounded-lg border border-slate-200 p-3">
          <h3 class="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">Abhängigkeit hinzufügen</h3>
          <div class="space-y-2">
            <select v-model="newDep.direction" class="w-full rounded-md border border-slate-200 px-2 py-2 text-sm">
              <option value="pred">Diese Aufgabe hat einen Vorgänger</option>
              <option value="succ">Diese Aufgabe hat einen Nachfolger</option>
            </select>
            <div class="grid grid-cols-2 gap-2">
              <select v-model="newDep.type" class="w-full rounded-md border border-slate-200 px-2 py-2 text-sm">
                <option v-for="(label, type) in DEPENDENCY_TYPE_LABELS" :key="type" :value="type">{{ label }}</option>
              </select>
              <input v-model.number="newDep.lag" type="number" placeholder="Lag (min)" class="w-full rounded-md border border-slate-200 px-2 py-2 text-sm" />
            </div>
            <select
              v-model="newDep.taskId"
              class="w-full rounded-md border border-slate-200 px-2 py-2 text-sm"
              @change="addDependency()"
            >
              <option value="" disabled>Aufgabe wählen – wird sofort übernommen…</option>
              <option v-for="t in otherTasks" :key="t.id" :value="String(t.id)">{{ t.name }}</option>
            </select>
            <p class="text-xs text-slate-400">
              Die Auswahl legt die Abhängigkeit mit Richtung, Typ und Lag sofort an.
            </p>
          </div>
        </div>
      </div>

      <!-- Ressourcen -->
      <div v-else-if="tab === 'resources'" class="space-y-4 text-sm">
        <p v-if="(store.selectedTask.assignments ?? []).length === 0" class="text-slate-500">
          Noch keine Ressourcen zugeordnet.
        </p>
        <ul v-else class="space-y-2">
          <li v-for="assignment in store.selectedTask.assignments" :key="assignment.id" class="rounded-md bg-slate-50 px-2 py-2">
            <div class="flex items-center justify-between">
              <span class="truncate">{{ assignment.resourceName }}</span>
              <button v-if="store.canWrite" type="button" class="text-xs text-red-500 hover:underline" @click="store.removeAssignment(assignment.id)">
                entfernen
              </button>
            </div>
            <label class="mt-1 flex items-center gap-2 text-xs text-slate-500">
              Auslastung
              <input
                :value="assignment.allocationPercent"
                type="number"
                min="1"
                max="400"
                class="w-20 rounded border border-slate-200 px-2 py-1 text-xs"
                @change="store.updateAssignment(assignment.id, Number(($event.target as HTMLInputElement).value), assignment.version)"
              />
              %
            </label>
          </li>
        </ul>

        <div v-if="store.canWrite" class="rounded-lg border border-slate-200 p-3">
          <div class="flex gap-2">
            <select
              v-model="newAssignment.resourceId"
              class="min-w-0 flex-1 rounded-md border border-slate-200 px-2 py-2 text-sm"
              @change="addAssignment()"
            >
              <option value="" disabled>Ressource wählen – wird sofort zugeteilt…</option>
              <option v-for="r in unassignedResources" :key="r.id" :value="String(r.id)">{{ r.name }}</option>
            </select>
            <input v-model.number="newAssignment.allocation" type="number" min="1" max="400" class="w-20 rounded-md border border-slate-200 px-2 py-2 text-sm" />
            <span class="self-center text-xs text-slate-400">%</span>
          </div>
        </div>
      </div>

      <!-- Kommentare -->
      <div v-else class="space-y-3 text-sm">
        <p v-if="commentList.length === 0" class="text-slate-500">Noch keine Kommentare.</p>
        <ul v-else class="space-y-2">
          <li v-for="comment in commentList" :key="comment.id" class="rounded-lg border border-slate-100 bg-slate-50 p-2">
            <div class="flex items-center justify-between text-xs text-slate-400">
              <span>{{ comment.userName ?? 'Unbekannt' }} · {{ formatDateTime(comment.createdAt) }}</span>
              <button
                v-if="comment.userId === auth.user?.id || store.canPlan"
                type="button"
                class="hover:text-red-500"
                @click="removeComment(comment.id)"
              >
                löschen
              </button>
            </div>
            <p class="mt-1 whitespace-pre-wrap text-slate-700">{{ comment.body }}</p>
          </li>
        </ul>

        <div v-if="store.canWrite">
          <textarea
            v-model="newComment"
            rows="2"
            placeholder="Kommentar schreiben…"
            class="w-full rounded-md border border-slate-200 px-3 py-2 text-sm outline-none focus:border-indigo-400"
          />
          <button type="button" class="mt-2 rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700" @click="submitComment">
            Kommentieren
          </button>
        </div>
      </div>
    </div>

    <!-- Fuß: Auto-Save-Status statt Speichern-Button (speichert debounced + beim Tab-Wechsel). -->
    <footer class="flex shrink-0 flex-wrap items-center gap-2 border-t border-slate-100 bg-white px-4 py-3">
      <span v-if="store.canWrite" class="text-xs" :class="saveError ? 'text-red-600' : 'text-slate-400'">
        <template v-if="saving">Speichert…</template>
        <template v-else-if="saveError">Nicht gespeichert – wird erneut versucht</template>
        <template v-else-if="savedAt">Gespeichert ✓</template>
        <template v-else>Änderungen werden automatisch gespeichert</template>
      </span>
      <button
        v-if="store.canPlan"
        type="button"
        class="ml-auto rounded-md border border-red-200 px-3 py-2 text-sm text-red-600 hover:bg-red-50"
        @click="removeTask"
      >
        Löschen
      </button>
    </footer>
  </aside>
</template>
