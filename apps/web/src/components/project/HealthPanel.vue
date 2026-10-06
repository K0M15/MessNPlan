<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useProjectStore } from '@/stores/project';
import type { HealthIssueDto } from '@/types';

const store = useProjectStore();

const emit = defineEmits<{
  close: [];
  /** Ressourcen-Hinweis ohne Aufgabe: Ressourcen-Modal öffnen. */
  'open-resources': [];
}>();

const closeButton = ref<HTMLButtonElement | null>(null);

const grouped = computed<Record<'error' | 'warning' | 'info', HealthIssueDto[]>>(() => {
  const bySeverity: Record<'error' | 'warning' | 'info', HealthIssueDto[]> = {
    error: [],
    warning: [],
    info: [],
  };
  for (const issue of store.health?.issues ?? []) bySeverity[issue.severity].push(issue);
  return bySeverity;
});

const severityMeta = {
  error: { label: 'Fehler', className: 'bg-red-50 text-red-700 border-red-200 hover:bg-red-100' },
  warning: {
    label: 'Warnungen',
    className: 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100',
  },
  info: { label: 'Hinweise', className: 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100' },
} as const;

function taskName(taskId?: number): string {
  if (!taskId) return '';
  return store.taskById.get(taskId)?.name ?? `#${taskId}`;
}

function resourceName(resourceId?: number): string {
  if (!resourceId) return '';
  return store.resources.find((r) => r.id === resourceId)?.name ?? `#${resourceId}`;
}

/** Klick auf einen Hinweis: Modal schließen und zur Aufgabe springen. */
function selectIssue(issue: HealthIssueDto): void {
  emit('close');
  if (issue.taskId) store.focusTask(issue.taskId);
  else if (issue.resourceId) emit('open-resources');
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close');
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown);
  closeButton.value?.focus();
});

onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <Teleport to="body">
    <div
      class="fixed inset-0 z-[70] flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 md:p-8"
      role="dialog"
      aria-modal="true"
      aria-label="Planungs-Check"
      @click.self="emit('close')"
    >
      <div class="w-full max-w-3xl rounded-xl border border-slate-200 bg-white shadow-xl">
        <header class="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-3">
          <h2 class="font-medium text-slate-900">Planungs-Check</h2>
          <span class="rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">
            {{ store.health?.summary.error ?? 0 }} Fehler
          </span>
          <span class="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
            {{ store.health?.summary.warning ?? 0 }} Warnungen
          </span>
          <span class="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs text-slate-600">
            {{ store.health?.summary.info ?? 0 }} Hinweise
          </span>
          <button
            ref="closeButton"
            type="button"
            class="ml-auto rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            aria-label="Schließen"
            @click="emit('close')"
          >
            ✕
          </button>
        </header>

        <div class="max-h-[70vh] overflow-y-auto p-4">
          <p v-if="!store.health || store.health.summary.total === 0" class="text-sm text-emerald-600">
            Alles vollständig geplant – keine Auffälligkeiten. ✅
          </p>

          <div v-else class="grid gap-4 md:grid-cols-3">
            <div v-for="severity in (['error', 'warning', 'info'] as const)" :key="severity">
              <h3 class="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
                {{ severityMeta[severity].label }} ({{ grouped[severity].length }})
              </h3>
              <ul class="max-h-72 space-y-1 overflow-y-auto pr-1">
                <li v-for="(issue, index) in grouped[severity]" :key="index">
                  <button
                    type="button"
                    class="w-full rounded-md border px-2 py-1.5 text-left text-xs transition"
                    :class="severityMeta[severity].className"
                    @click="selectIssue(issue)"
                  >
                    <span v-if="issue.taskId" class="font-medium">{{ taskName(issue.taskId) }}: </span>
                    <span v-else-if="issue.resourceId" class="font-medium">{{ resourceName(issue.resourceId) }}: </span>
                    {{ issue.message }}
                  </button>
                </li>
              </ul>
            </div>
          </div>
        </div>

        <footer class="flex flex-wrap items-center gap-2 border-t border-slate-100 px-4 py-2 text-xs text-slate-400">
          <span>Klick auf einen Hinweis springt zur Aufgabe.</span>
          <button
            type="button"
            class="ml-auto rounded-md border border-slate-200 px-2 py-1 text-slate-600 hover:bg-slate-50"
            @click="store.refreshHealth()"
          >
            Aktualisieren
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>
