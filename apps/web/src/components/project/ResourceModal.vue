<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import {
  ABSENCE_TYPES,
  ABSENCE_TYPE_LABELS,
  type AbsenceType,
  type WeekdayKey,
  type WorkingHours,
} from '@projectplaner/shared';
import { useAuthStore } from '@/stores/auth';
import { useProjectStore } from '@/stores/project';
import { useToasts } from '@/composables/useToasts';
import { formatCalendarDate } from '@/utils/datetime';
import type { OutlookConnectionDto, ResourceDto } from '@/types';

const store = useProjectStore();
const auth = useAuthStore();
const toasts = useToasts();

const emit = defineEmits<{ close: [] }>();

/** Mo–So für das Arbeitszeiten-Grid; DB-Schema: 0=So … 6=Sa. */
const weekdays = [
  { value: 1, label: 'Mo' },
  { value: 2, label: 'Di' },
  { value: 3, label: 'Mi' },
  { value: 4, label: 'Do' },
  { value: 5, label: 'Fr' },
  { value: 6, label: 'Sa' },
  { value: 0, label: 'So' },
] as const;

interface WorkHoursDay {
  enabled: boolean;
  start: string;
  end: string;
}

const workHours = reactive<Record<number, WorkHoursDay>>({
  0: { enabled: false, start: '08:00', end: '16:00' },
  1: { enabled: false, start: '08:00', end: '16:00' },
  2: { enabled: false, start: '08:00', end: '16:00' },
  3: { enabled: false, start: '08:00', end: '16:00' },
  4: { enabled: false, start: '08:00', end: '16:00' },
  5: { enabled: false, start: '08:00', end: '16:00' },
  6: { enabled: false, start: '08:00', end: '16:00' },
});

/** Vorbelegung aus den Projekt-Arbeitszeiten (Mo–So-Raster). */
function projectDefaults(): Record<number, WorkHoursDay> {
  const project = store.project;
  const start = project?.workdayStart.slice(0, 5) ?? '08:00';
  const end = project?.workdayEnd.slice(0, 5) ?? '16:00';
  const workweek = project?.workweek ?? [1, 2, 3, 4, 5];
  const result: Record<number, WorkHoursDay> = {};
  for (const day of [0, 1, 2, 3, 4, 5, 6]) {
    result[day] = { enabled: workweek.includes(day), start, end };
  }
  return result;
}

/** Übernimmt eigene Arbeitszeiten (null = Projektwerte) ins Grid. */
function setWorkHours(own: WorkingHours | null): void {
  const defaults = projectDefaults();
  for (const day of [0, 1, 2, 3, 4, 5, 6]) {
    if (own === null) {
      Object.assign(workHours[day]!, defaults[day]!);
      continue;
    }
    const entry = own[String(day) as WeekdayKey];
    Object.assign(
      workHours[day]!,
      entry
        ? { enabled: true, start: entry.start.slice(0, 5), end: entry.end.slice(0, 5) }
        : { enabled: false, start: defaults[day]!.start, end: defaults[day]!.end },
    );
  }
}

setWorkHours(null);

function toggleWorkDay(day: number, enabled: boolean): void {
  workHours[day]!.enabled = enabled;
}

/** Grid → workingHours; identisch mit Projektwerten ⇒ null (Erbung beibehalten). */
function buildWorkingHours(): WorkingHours | null {
  const defaults = projectDefaults();
  const own: WorkingHours = {};
  let differs = false;
  for (const { value: day } of weekdays) {
    const entry = workHours[day]!;
    if (entry.enabled) {
      own[String(day) as WeekdayKey] = { start: entry.start, end: entry.end };
      const def = defaults[day]!;
      if (!def.enabled || def.start !== entry.start || def.end !== entry.end) differs = true;
    } else if (defaults[day]!.enabled) {
      differs = true;
    }
  }
  return differs ? own : null;
}

// ---- Abwesenheiten ---------------------------------------------------------

const absenceForm = reactive({
  startDate: '',
  endDate: '',
  type: 'vacation' as AbsenceType,
  name: '',
});
const absenceSaving = ref(false);

const editingAbsences = computed(() =>
  editingId.value !== null && store.absenceResourceId === editingId.value
    ? store.resourceAbsences
    : [],
);

async function addAbsence(): Promise<void> {
  if (editingId.value === null || !absenceForm.startDate || !absenceForm.endDate) return;
  if (absenceForm.endDate < absenceForm.startDate) {
    toasts.error('Enddatum darf nicht vor dem Startdatum liegen');
    return;
  }
  absenceSaving.value = true;
  try {
    const ok = await store.createAbsence(editingId.value, {
      startDate: absenceForm.startDate,
      endDate: absenceForm.endDate,
      type: absenceForm.type,
      name: absenceForm.name.trim() || null,
    });
    if (ok) {
      toasts.success('Abwesenheit angelegt');
      absenceForm.startDate = '';
      absenceForm.endDate = '';
      absenceForm.name = '';
    }
  } finally {
    absenceSaving.value = false;
  }
}

async function removeAbsence(id: number): Promise<void> {
  if (!window.confirm('Abwesenheit löschen?')) return;
  if (await store.deleteAbsence(id)) toasts.success('Abwesenheit gelöscht');
}

function connectionFor(resourceId: number): OutlookConnectionDto | undefined {
  return store.outlook?.items.find((item) => item.resourceId === resourceId);
}

function canConnect(resource: ResourceDto): boolean {
  const allowed = store.canPlan || resource.userId === auth.user?.id;
  return allowed && store.outlook?.configured === true;
}

/** Kürzt Fehlermeldungen für die Liste; der volle Text bleibt im title-Attribut. */
function shortError(text: string, max = 160): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const statusMeta: Record<OutlookConnectionDto['status'], { label: string; className: string }> = {
  connected: { label: 'verbunden', className: 'bg-emerald-50 text-emerald-700' },
  error: { label: 'Fehler', className: 'bg-red-50 text-red-700' },
  revoked: { label: 'getrennt', className: 'bg-slate-100 text-slate-500' },
};

const editingId = ref<number | null>(null);
const form = reactive({
  name: '',
  type: 'person' as 'person' | 'machine',
  email: '',
  capacityMinutesPerDay: 480,
  color: '#6366f1',
  isActive: true,
});

function resetAbsenceForm(): void {
  absenceForm.startDate = '';
  absenceForm.endDate = '';
  absenceForm.type = 'vacation';
  absenceForm.name = '';
}

function reset(): void {
  editingId.value = null;
  form.name = '';
  form.type = 'person';
  form.email = '';
  form.capacityMinutesPerDay = 480;
  form.color = '#6366f1';
  form.isActive = true;
  setWorkHours(null);
  resetAbsenceForm();
}

function edit(resource: ResourceDto): void {
  editingId.value = resource.id;
  form.name = resource.name;
  form.type = resource.type;
  form.email = resource.email ?? '';
  form.capacityMinutesPerDay = resource.capacityMinutesPerDay;
  form.color = resource.color ?? '#6366f1';
  form.isActive = resource.isActive;
  setWorkHours(resource.workingHours ?? null);
  resetAbsenceForm();
  void store.loadAbsences(resource.id);
}

async function submit(): Promise<void> {
  if (!form.name.trim()) return;
  for (const { value: day } of weekdays) {
    const entry = workHours[day]!;
    if (entry.enabled && entry.end <= entry.start) {
      toasts.error(`Arbeitszeit für ${weekdays.find((d) => d.value === day)?.label}: Ende muss nach Start liegen`);
      return;
    }
  }
  const payload = {
    name: form.name.trim(),
    type: form.type,
    email: form.email.trim() || null,
    capacityMinutesPerDay: Number(form.capacityMinutesPerDay),
    workingHours: buildWorkingHours(),
    color: form.color,
    isActive: form.isActive,
  };
  const ok =
    editingId.value === null
      ? await store.createResource(payload)
      : await store.updateResource(
          editingId.value,
          payload,
          store.resources.find((r) => r.id === editingId.value)?.version ?? 1,
        );
  if (ok) {
    toasts.success(editingId.value === null ? 'Ressource angelegt' : 'Ressource gespeichert');
    reset();
  }
}

async function remove(resource: ResourceDto): Promise<void> {
  if (!window.confirm(`Ressource „${resource.name}“ und alle Zuteilungen entfernen?`)) return;
  if (await store.deleteResource(resource.id)) toasts.success('Ressource entfernt');
}
</script>

<template>
  <div class="fixed inset-0 z-50 grid place-items-center bg-slate-900/40 p-4" @click.self="emit('close')">
    <div class="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-xl bg-white shadow-xl">
      <header class="flex items-center justify-between border-b border-slate-100 px-5 py-3">
        <h2 class="font-medium text-slate-900">Ressourcen</h2>
        <div class="flex items-center gap-2">
          <button
            v-if="store.canPlan && store.outlook?.configured"
            type="button"
            class="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
            @click="store.syncOutlookNow()"
          >
            Outlook jetzt synchronisieren
          </button>
          <button type="button" class="rounded p-1 text-slate-400 hover:bg-slate-100" @click="emit('close')">✕</button>
        </div>
      </header>

      <div class="grid flex-1 grid-cols-2 gap-0 overflow-hidden">
        <div class="overflow-y-auto border-r border-slate-100 p-4">
          <p v-if="store.resources.length === 0" class="text-sm text-slate-500">Noch keine Ressourcen.</p>
          <ul class="space-y-1.5">
            <li
              v-for="resource in store.resources"
              :key="resource.id"
              class="cursor-pointer rounded-lg border px-3 py-2 text-sm transition"
              :class="editingId === resource.id ? 'border-indigo-300 bg-indigo-50' : 'border-slate-200 hover:bg-slate-50'"
              @click="edit(resource)"
            >
              <div class="flex items-center justify-between">
                <span class="flex items-center gap-2">
                  <span class="h-2.5 w-2.5 rounded-full" :style="{ backgroundColor: resource.color ?? '#94a3b8' }" />
                  <span :class="{ 'opacity-50': !resource.isActive }">{{ resource.name }}</span>
                  <span class="text-xs text-slate-400">{{ resource.type === 'person' ? 'Person' : 'Maschine' }}</span>
                </span>
                <button v-if="store.canPlan" type="button" class="text-xs text-red-500 hover:underline" @click.stop="remove(resource)">
                  löschen
                </button>
              </div>

              <div class="mt-1 flex flex-wrap items-center gap-2 pl-4 text-xs">
                <template v-if="connectionFor(resource.id)">
                  <span class="rounded-full px-1.5 py-0.5" :class="statusMeta[connectionFor(resource.id)!.status].className">
                    {{ statusMeta[connectionFor(resource.id)!.status].label }}
                  </span>
                  <span class="text-slate-400">{{ connectionFor(resource.id)!.mailbox }}</span>
                  <label class="flex items-center gap-1 text-slate-600" @click.stop>
                    <input
                      type="checkbox"
                      :checked="connectionFor(resource.id)!.syncEnabled"
                      @change="store.toggleOutlookSync(connectionFor(resource.id)!.id, ($event.target as HTMLInputElement).checked)"
                    />
                    Sync
                  </label>
                  <button type="button" class="text-red-500 hover:underline" @click.stop="store.disconnectOutlook(connectionFor(resource.id)!.id)">
                    trennen
                  </button>
                  <p
                    v-if="connectionFor(resource.id)!.status === 'error' && connectionFor(resource.id)!.lastError"
                    class="w-full break-words text-red-600"
                    :title="connectionFor(resource.id)!.lastError ?? ''"
                  >
                    {{ shortError(connectionFor(resource.id)!.lastError!) }}
                  </p>
                </template>
                <template v-else>
                  <button
                    v-if="canConnect(resource)"
                    type="button"
                    class="rounded-md border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-indigo-700 hover:bg-indigo-100"
                    @click.stop="store.connectOutlook(resource.id)"
                  >
                    Kalender verbinden
                  </button>
                  <span v-else class="text-slate-400">Kein Kalender verbunden</span>
                </template>
              </div>
            </li>
          </ul>
        </div>

        <form v-if="store.canPlan" class="space-y-3 overflow-y-auto p-4" @submit.prevent="submit">
          <h3 class="text-xs font-medium uppercase tracking-wide text-slate-400">
            {{ editingId === null ? 'Neue Ressource' : 'Ressource bearbeiten' }}
          </h3>
          <div>
            <label class="mb-1 block text-xs text-slate-500">Name</label>
            <input v-model="form.name" required class="w-full rounded-md border border-slate-200 px-3 py-2 text-sm" />
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="mb-1 block text-xs text-slate-500">Typ</label>
              <select v-model="form.type" class="w-full rounded-md border border-slate-200 px-2 py-2 text-sm">
                <option value="person">Person</option>
                <option value="machine">Maschine</option>
              </select>
            </div>
            <div>
              <label class="mb-1 block text-xs text-slate-500">Kapazität (Min/Tag)</label>
              <input v-model.number="form.capacityMinutesPerDay" type="number" min="0" max="1440" class="w-full rounded-md border border-slate-200 px-3 py-2 text-sm" />
            </div>
          </div>
          <div>
            <label class="mb-1 block text-xs text-slate-500">E-Mail (für Outlook-Sync)</label>
            <input v-model="form.email" type="email" class="w-full rounded-md border border-slate-200 px-3 py-2 text-sm" />
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="mb-1 block text-xs text-slate-500">Farbe</label>
              <input v-model="form.color" type="color" class="h-10 w-full rounded-md border border-slate-200" />
            </div>
            <label class="flex items-end gap-2 pb-2 text-sm text-slate-700">
              <input v-model="form.isActive" type="checkbox" class="rounded border-slate-300" />
              Aktiv
            </label>
          </div>

          <div class="border-t border-slate-100 pt-3">
            <h4 class="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">
              Arbeitszeiten (Mo–So)
            </h4>
            <p class="mb-2 text-[11px] text-slate-400">
              Ohne eigene Angaben gelten die Projekt-Arbeitszeiten (ohne Feiertagssperre).
            </p>
            <div class="space-y-1">
              <div v-for="day in weekdays" :key="day.value" class="flex items-center gap-2 text-xs">
                <label class="flex w-14 shrink-0 cursor-pointer items-center gap-1.5 text-slate-600">
                  <input
                    type="checkbox"
                    class="rounded border-slate-300"
                    :checked="workHours[day.value]!.enabled"
                    @change="toggleWorkDay(day.value, ($event.target as HTMLInputElement).checked)"
                  />
                  {{ day.label }}
                </label>
                <input
                  v-model="workHours[day.value]!.start"
                  type="time"
                  :disabled="!workHours[day.value]!.enabled"
                  class="min-w-0 flex-1 rounded-md border border-slate-200 px-2 py-1 text-xs disabled:bg-slate-50 disabled:text-slate-400"
                />
                <span class="text-slate-400">–</span>
                <input
                  v-model="workHours[day.value]!.end"
                  type="time"
                  :disabled="!workHours[day.value]!.enabled"
                  class="min-w-0 flex-1 rounded-md border border-slate-200 px-2 py-1 text-xs disabled:bg-slate-50 disabled:text-slate-400"
                />
              </div>
            </div>
          </div>

          <div v-if="editingId !== null" class="border-t border-slate-100 pt-3">
            <h4 class="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">Abwesenheiten</h4>
            <ul v-if="editingAbsences.length > 0" class="mb-2 space-y-1">
              <li
                v-for="absence in editingAbsences"
                :key="absence.id"
                class="flex items-center justify-between gap-2 rounded-md border border-slate-200 px-2 py-1 text-xs"
              >
                <span class="truncate">
                  {{ formatCalendarDate(absence.startDate) }}–{{ formatCalendarDate(absence.endDate) }}
                  <span class="text-slate-500">{{ ABSENCE_TYPE_LABELS[absence.type] }}</span>
                  <span v-if="absence.name" class="text-slate-400">· {{ absence.name }}</span>
                </span>
                <button type="button" class="shrink-0 text-red-500 hover:underline" @click="removeAbsence(absence.id)">
                  löschen
                </button>
              </li>
            </ul>
            <p v-else class="mb-2 text-xs text-slate-400">Keine Abwesenheiten erfasst.</p>
            <div class="grid grid-cols-2 gap-2">
              <input
                v-model="absenceForm.startDate"
                type="date"
                title="Von"
                class="rounded-md border border-slate-200 px-2 py-1.5 text-xs"
                @keydown.enter.prevent
              />
              <input
                v-model="absenceForm.endDate"
                type="date"
                title="Bis"
                class="rounded-md border border-slate-200 px-2 py-1.5 text-xs"
                @keydown.enter.prevent
              />
            </div>
            <div class="mt-2 grid grid-cols-2 gap-2">
              <select
                v-model="absenceForm.type"
                class="rounded-md border border-slate-200 px-2 py-1.5 text-xs"
                @keydown.enter.prevent
              >
                <option v-for="type in ABSENCE_TYPES" :key="type" :value="type">
                  {{ ABSENCE_TYPE_LABELS[type] }}
                </option>
              </select>
              <input
                v-model="absenceForm.name"
                placeholder="Name (optional)"
                maxlength="160"
                class="min-w-0 rounded-md border border-slate-200 px-2 py-1.5 text-xs"
                @keydown.enter.prevent
              />
            </div>
            <button
              type="button"
              :disabled="absenceSaving || !absenceForm.startDate || !absenceForm.endDate"
              class="mt-2 w-full rounded-md border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs text-indigo-700 hover:bg-indigo-100 disabled:opacity-50"
              @click="addAbsence"
            >
              {{ absenceSaving ? 'Anlegen…' : 'Abwesenheit anlegen' }}
            </button>
          </div>

          <div class="flex gap-2">
            <button type="submit" class="flex-1 rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700">
              {{ editingId === null ? 'Anlegen' : 'Speichern' }}
            </button>
            <button v-if="editingId !== null" type="button" class="rounded-md px-3 py-2 text-sm text-slate-600 hover:bg-slate-100" @click="reset">
              Abbrechen
            </button>
          </div>
        </form>
        <div v-else class="grid place-items-center p-4 text-sm text-slate-500">Keine Berechtigung zum Bearbeiten.</div>
      </div>
    </div>
  </div>
</template>
