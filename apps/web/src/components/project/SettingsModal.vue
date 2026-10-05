<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { useProjectStore } from '@/stores/project';
import { useToasts } from '@/composables/useToasts';
import { formatCalendarDate } from '@/utils/datetime';
import ApiKeysTab from './ApiKeysTab.vue';

const emit = defineEmits<{ close: [] }>();

const store = useProjectStore();
const toasts = useToasts();

const tab = ref<'general' | 'calendar' | 'api-keys'>('general');
const saving = ref(false);
const addingHoliday = ref(false);

const form = reactive({
  name: '',
  description: '',
  timezone: '',
  status: 'active' as 'active' | 'archived',
  workweek: [] as number[],
  workdayStart: '08:00',
  workdayEnd: '16:00',
  scheduleAnchor: '',
});

const holidayForm = reactive({ date: '', name: '' });

/** Mo–So für die Checkboxen; DB-Schema: 0=So … 6=Sa. */
const weekdays = [
  { value: 1, label: 'Mo' },
  { value: 2, label: 'Di' },
  { value: 3, label: 'Mi' },
  { value: 4, label: 'Do' },
  { value: 5, label: 'Fr' },
  { value: 6, label: 'Sa' },
  { value: 0, label: 'So' },
];

const commonTimezones = [
  'Europe/Berlin',
  'Europe/Vienna',
  'Europe/Zurich',
  'Europe/London',
  'Europe/Paris',
  'Europe/Madrid',
  'Europe/Amsterdam',
  'Europe/Warsaw',
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
];

onMounted(() => {
  const project = store.project;
  if (project) {
    form.name = project.name;
    form.description = project.description ?? '';
    form.timezone = project.timezone;
    form.status = project.status;
    form.workweek = [...project.workweek];
    form.workdayStart = project.workdayStart.slice(0, 5);
    form.workdayEnd = project.workdayEnd.slice(0, 5);
    form.scheduleAnchor = project.scheduleAnchor ?? '';
  }
  void store.loadHolidays();
});

function isDayChecked(day: number): boolean {
  return form.workweek.includes(day);
}

function toggleDay(day: number): void {
  if (isDayChecked(day)) {
    form.workweek = form.workweek.filter((d) => d !== day);
  } else {
    form.workweek = [...form.workweek, day];
  }
}

async function save(): Promise<void> {
  if (!form.name.trim()) {
    toasts.error('Bitte einen Projektnamen angeben');
    return;
  }
  if (form.workweek.length === 0) {
    toasts.error('Mindestens einen Arbeitstag auswählen');
    return;
  }
  saving.value = true;
  try {
    const ok = await store.updateProject({
      name: form.name.trim(),
      description: form.description.trim() || null,
      timezone: form.timezone.trim() || 'Europe/Berlin',
      status: form.status,
      workweek: [...form.workweek].sort((a, b) => a - b),
      workdayStart: form.workdayStart,
      workdayEnd: form.workdayEnd,
      scheduleAnchor: form.scheduleAnchor || null,
    });
    if (ok) toasts.success('Projekteinstellungen gespeichert');
  } finally {
    saving.value = false;
  }
}

async function addHoliday(): Promise<void> {
  if (!holidayForm.date || !holidayForm.name.trim()) return;
  addingHoliday.value = true;
  try {
    const ok = await store.createHoliday(holidayForm.date, holidayForm.name.trim());
    if (ok) {
      toasts.success('Feiertag angelegt');
      holidayForm.date = '';
      holidayForm.name = '';
    }
  } finally {
    addingHoliday.value = false;
  }
}

async function removeHoliday(id: number, name: string): Promise<void> {
  if (!window.confirm(`Feiertag „${name}“ löschen?`)) return;
  if (await store.deleteHoliday(id)) toasts.success('Feiertag gelöscht');
}
</script>

<template>
  <div class="fixed inset-0 z-50 grid place-items-center bg-slate-900/40 p-4" @click.self="emit('close')">
    <div class="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl bg-white shadow-xl">
      <header class="flex items-center justify-between border-b border-slate-100 px-5 py-3">
        <h2 class="font-medium text-slate-900">Projekt-Einstellungen</h2>
        <button type="button" class="rounded p-1 text-slate-400 hover:bg-slate-100" @click="emit('close')">✕</button>
      </header>

      <div v-if="!store.canPlan" class="p-5 text-sm text-slate-500">
        Keine Berechtigung zum Bearbeiten der Einstellungen.
      </div>

      <template v-else>
        <nav class="flex gap-1 border-b border-slate-100 px-3 pt-2">
          <button
            type="button"
            class="rounded-t-md px-3 py-2 text-sm"
            :class="tab === 'general' ? 'bg-indigo-50 font-medium text-indigo-700' : 'text-slate-600 hover:bg-slate-50'"
            @click="tab = 'general'"
          >
            Allgemein
          </button>
          <button
            type="button"
            class="rounded-t-md px-3 py-2 text-sm"
            :class="tab === 'calendar' ? 'bg-indigo-50 font-medium text-indigo-700' : 'text-slate-600 hover:bg-slate-50'"
            @click="tab = 'calendar'"
          >
            Arbeitszeiten &amp; Feiertage
          </button>
          <button
            type="button"
            class="rounded-t-md px-3 py-2 text-sm"
            :class="tab === 'api-keys' ? 'bg-indigo-50 font-medium text-indigo-700' : 'text-slate-600 hover:bg-slate-50'"
            @click="tab = 'api-keys'"
          >
            API-Schlüssel
          </button>
        </nav>

        <div class="flex-1 space-y-4 overflow-y-auto p-5">
          <form v-if="tab === 'general'" class="space-y-4" @submit.prevent="save">
            <div>
              <label for="settings-name" class="mb-1 block text-xs text-slate-500">Name</label>
              <input
                id="settings-name"
                v-model="form.name"
                required
                maxlength="160"
                class="w-full rounded-md border border-slate-200 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label for="settings-description" class="mb-1 block text-xs text-slate-500">Beschreibung</label>
              <textarea
                id="settings-description"
                v-model="form.description"
                rows="3"
                class="w-full rounded-md border border-slate-200 px-3 py-2 text-sm"
              />
            </div>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label for="settings-timezone" class="mb-1 block text-xs text-slate-500">Zeitzone (IANA)</label>
                <input
                  id="settings-timezone"
                  v-model="form.timezone"
                  list="settings-timezone-list"
                  required
                  class="w-full rounded-md border border-slate-200 px-3 py-2 text-sm"
                />
                <datalist id="settings-timezone-list">
                  <option v-for="zone in commonTimezones" :key="zone" :value="zone" />
                </datalist>
              </div>
              <div>
                <label for="settings-status" class="mb-1 block text-xs text-slate-500">Status</label>
                <select id="settings-status" v-model="form.status" class="w-full rounded-md border border-slate-200 px-2 py-2 text-sm">
                  <option value="active">Aktiv</option>
                  <option value="archived">Archiviert</option>
                </select>
              </div>
            </div>
          </form>

          <div v-else-if="tab === 'calendar'" class="space-y-4">
            <div>
              <span class="mb-1 block text-xs text-slate-500">Arbeitswoche</span>
              <div class="flex flex-wrap gap-2">
                <label
                  v-for="day in weekdays"
                  :key="day.value"
                  class="flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1 text-sm"
                  :class="isDayChecked(day.value) ? 'border-indigo-300 bg-indigo-50 text-indigo-700' : 'border-slate-200 text-slate-600'"
                >
                  <input
                    type="checkbox"
                    :checked="isDayChecked(day.value)"
                    class="rounded border-slate-300"
                    @change="toggleDay(day.value)"
                  />
                  {{ day.label }}
                </label>
              </div>
            </div>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label for="settings-workday-start" class="mb-1 block text-xs text-slate-500">Arbeitsbeginn</label>
                <input
                  id="settings-workday-start"
                  v-model="form.workdayStart"
                  type="time"
                  required
                  class="w-full rounded-md border border-slate-200 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label for="settings-workday-end" class="mb-1 block text-xs text-slate-500">Arbeitsende</label>
                <input
                  id="settings-workday-end"
                  v-model="form.workdayEnd"
                  type="time"
                  required
                  class="w-full rounded-md border border-slate-200 px-3 py-2 text-sm"
                />
              </div>
            </div>
            <div>
              <label for="settings-anchor" class="mb-1 block text-xs text-slate-500">
                Planungsanker (optional)
              </label>
              <input
                id="settings-anchor"
                v-model="form.scheduleAnchor"
                type="date"
                class="w-full rounded-md border border-slate-200 px-3 py-2 text-sm"
              />
            </div>

            <div class="border-t border-slate-100 pt-4">
              <h3 class="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">Feiertage</h3>
              <p v-if="store.holidays.length === 0" class="mb-2 text-sm text-slate-500">
                Noch keine Feiertage hinterlegt.
              </p>
              <ul v-else class="mb-3 space-y-1">
                <li
                  v-for="holiday in store.holidays"
                  :key="holiday.id"
                  class="flex items-center justify-between rounded-md border border-slate-200 px-3 py-1.5 text-sm"
                >
                  <span>
                    {{ formatCalendarDate(holiday.date) }}
                    <span class="text-slate-500">– {{ holiday.name }}</span>
                  </span>
                  <button
                    type="button"
                    class="text-xs text-red-500 hover:underline"
                    @click="removeHoliday(holiday.id, holiday.name)"
                  >
                    löschen
                  </button>
                </li>
              </ul>
              <div class="flex gap-2">
                <input
                  v-model="holidayForm.date"
                  type="date"
                  required
                  class="rounded-md border border-slate-200 px-3 py-2 text-sm"
                  @keyup.enter="addHoliday"
                />
                <input
                  v-model="holidayForm.name"
                  placeholder="Bezeichnung"
                  required
                  maxlength="160"
                  class="min-w-0 flex-1 rounded-md border border-slate-200 px-3 py-2 text-sm"
                  @keyup.enter="addHoliday"
                />
                <button
                  type="button"
                  :disabled="addingHoliday"
                  class="rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm text-indigo-700 hover:bg-indigo-100 disabled:opacity-60"
                  @click="addHoliday"
                >
                  Anlegen
                </button>
              </div>
            </div>
          </div>

          <ApiKeysTab v-else />
        </div>

        <footer class="flex justify-end gap-2 border-t border-slate-100 px-5 py-3">
          <button
            type="button"
            class="rounded-md px-3 py-2 text-sm text-slate-600 hover:bg-slate-100"
            @click="emit('close')"
          >
            Schließen
          </button>
          <button
            v-if="tab !== 'api-keys'"
            type="button"
            :disabled="saving"
            class="rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
            @click="save"
          >
            {{ saving ? 'Speichern…' : 'Speichern' }}
          </button>
        </footer>
      </template>
    </div>
  </div>
</template>
