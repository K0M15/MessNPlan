<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useProjectStore } from '@/stores/project';
import { useToasts } from '@/composables/useToasts';
import GanttChart from '@/components/project/GanttChart.vue';
import HealthPanel from '@/components/project/HealthPanel.vue';
import MembersModal from '@/components/project/MembersModal.vue';
import ResourceModal from '@/components/project/ResourceModal.vue';
import SettingsModal from '@/components/project/SettingsModal.vue';
import TaskDrawer from '@/components/project/TaskDrawer.vue';
import TaskTree from '@/components/project/TaskTree.vue';

const props = defineProps<{ id: string }>();
const store = useProjectStore();
const toasts = useToasts();
const route = useRoute();

const view = ref<'gantt' | 'list'>('gantt');
const showResources = ref(false);
const showHealth = ref(true);
const showMembers = ref(false);
const showSettings = ref(false);
const recomputing = ref(false);

const healthCount = computed(() => store.health?.summary.total ?? 0);
const hasOutlookError = computed(
  () => store.outlook?.items.some((item) => item.status === 'error') ?? false,
);

async function load(): Promise<void> {
  await store.load(Number(props.id));
}

onMounted(async () => {
  await load();
  if (route.query.outlook === 'connected') {
    toasts.success('Outlook-Kalender verbunden');
    await store.refreshOutlook();
  } else if (route.query.outlook === 'error') {
    toasts.error(
      `Outlook-Verbindung fehlgeschlagen (${String(route.query.reason ?? 'unbekannt')})`,
    );
  }
});
watch(() => props.id, load);
onBeforeUnmount(() => store.disconnectRealtime());

async function recompute(): Promise<void> {
  recomputing.value = true;
  try {
    await store.recompute();
  } finally {
    recomputing.value = false;
  }
}

async function createRootTask(): Promise<void> {
  const task = await store.createTask({ name: 'Neue Aufgabe' });
  if (task) toasts.success('Aufgabe angelegt');
}
</script>

<template>
  <div>
    <p v-if="store.loading" class="text-sm text-slate-500">Lade Projekt…</p>
    <p v-else-if="store.error" class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
      {{ store.error }}
      <RouterLink to="/" class="underline">Zur Projektübersicht</RouterLink>
    </p>

    <template v-else-if="store.project">
      <div class="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <RouterLink to="/" class="text-sm text-indigo-600 hover:underline">← Alle Projekte</RouterLink>
          <h1 class="mt-1 text-xl font-semibold text-slate-900">{{ store.project.name }}</h1>
          <p v-if="store.project.description" class="text-sm text-slate-500">
            {{ store.project.description }}
          </p>
          <div class="mt-2 flex flex-wrap gap-2 text-xs text-slate-500">
            <span class="rounded-full bg-white px-2 py-0.5 ring-1 ring-slate-200">
              Plan-Version {{ store.schedule?.version ?? 0 }}
            </span>
            <span class="rounded-full bg-white px-2 py-0.5 ring-1 ring-slate-200">
              {{ store.flatTasks.length }} Aufgaben
            </span>
            <span class="rounded-full bg-white px-2 py-0.5 ring-1 ring-slate-200">
              {{ store.resources.length }} Ressourcen
            </span>
            <span
              v-if="healthCount > 0"
              class="rounded-full bg-red-50 px-2 py-0.5 font-medium text-red-700 ring-1 ring-red-200"
            >
              {{ healthCount }} Check-Hinweise
            </span>
            <span v-else class="rounded-full bg-emerald-50 px-2 py-0.5 text-emerald-700 ring-1 ring-emerald-200">
              Planung vollständig
            </span>
            <span
              v-if="store.presence.length > 1"
              class="flex items-center gap-1 rounded-full bg-white px-2 py-0.5 ring-1 ring-slate-200"
              :title="store.presence.map((p) => p.name).join(', ')"
            >
              <span
                v-for="person in store.presence.slice(0, 5)"
                :key="person.userId"
                class="grid h-5 w-5 place-items-center rounded-full bg-indigo-100 text-[10px] font-medium text-indigo-700"
              >
                {{ person.name.slice(0, 1).toUpperCase() }}
              </span>
              <span v-if="store.presence.length > 5">+{{ store.presence.length - 5 }}</span>
            </span>
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <div class="flex overflow-hidden rounded-md border border-slate-200 bg-white text-sm">
            <button
              type="button"
              class="px-3 py-1.5"
              :class="view === 'gantt' ? 'bg-indigo-600 text-white' : 'text-slate-600 hover:bg-slate-50'"
              @click="view = 'gantt'"
            >
              Gantt
            </button>
            <button
              type="button"
              class="px-3 py-1.5"
              :class="view === 'list' ? 'bg-indigo-600 text-white' : 'text-slate-600 hover:bg-slate-50'"
              @click="view = 'list'"
            >
              Liste
            </button>
          </div>

          <button
            v-if="store.canPlan"
            type="button"
            class="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
            @click="showMembers = true"
          >
            Mitglieder
          </button>
          <button
            v-if="store.canPlan"
            type="button"
            class="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
            @click="showSettings = true"
          >
            Einstellungen
          </button>
          <button
            v-if="store.canPlan"
            type="button"
            class="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
            @click="showResources = true"
          >
            Ressourcen
          </button>
          <button
            type="button"
            class="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
            @click="showHealth = !showHealth"
          >
            {{ showHealth ? 'Check ausblenden' : 'Check anzeigen' }}
          </button>
          <button
            v-if="store.canWrite"
            type="button"
            class="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
            :disabled="recomputing"
            @click="recompute"
          >
            {{ recomputing ? 'Berechne…' : 'Neu berechnen' }}
          </button>
        </div>
      </div>

      <div
        v-if="hasOutlookError"
        class="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
      >
        <span>Outlook-Sync hat Fehler – Details unter Ressourcen</span>
        <button
          type="button"
          class="rounded-md border border-red-300 bg-white px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-100"
          @click="showResources = true"
        >
          Ressourcen öffnen
        </button>
      </div>

      <HealthPanel v-if="showHealth" class="mb-4" />

      <GanttChart v-if="view === 'gantt'" :key="store.projectId ?? 0" />
      <TaskTree v-else />
      <TaskDrawer />

      <button
        v-if="store.canWrite"
        type="button"
        class="fixed bottom-6 left-6 rounded-full bg-indigo-600 px-4 py-3 text-sm font-medium text-white shadow-lg transition hover:bg-indigo-700"
        title="Neue Aufgabe"
        @click="createRootTask"
      >
        + Aufgabe
      </button>

      <ResourceModal v-if="showResources" @close="showResources = false" />
      <MembersModal v-if="showMembers" @close="showMembers = false" />
      <SettingsModal v-if="showSettings" @close="showSettings = false" />
    </template>
  </div>
</template>
