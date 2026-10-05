<script setup lang="ts">
import { computed } from 'vue';
import { useProjectStore } from '@/stores/project';
import type { HealthIssueDto } from '@/types';

const store = useProjectStore();

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
  error: { label: 'Fehler', className: 'bg-red-50 text-red-700 border-red-200' },
  warning: { label: 'Warnungen', className: 'bg-amber-50 text-amber-700 border-amber-200' },
  info: { label: 'Hinweise', className: 'bg-slate-50 text-slate-600 border-slate-200' },
} as const;

function taskName(taskId?: number): string {
  if (!taskId) return '';
  return store.taskById.get(taskId)?.name ?? `#${taskId}`;
}

function resourceName(resourceId?: number): string {
  if (!resourceId) return '';
  return store.resources.find((r) => r.id === resourceId)?.name ?? `#${resourceId}`;
}
</script>

<template>
  <section v-if="store.health" class="mb-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
    <div class="mb-3 flex items-center gap-3">
      <h2 class="font-medium text-slate-900">Planungs-Check</h2>
      <span class="rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">
        {{ store.health.summary.error }} Fehler
      </span>
      <span class="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
        {{ store.health.summary.warning }} Warnungen
      </span>
      <span class="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs text-slate-600">
        {{ store.health.summary.info }} Hinweise
      </span>
      <button type="button" class="ml-auto text-xs text-slate-500 hover:text-slate-800" @click="store.refreshHealth()">
        Aktualisieren
      </button>
    </div>

    <p v-if="store.health.summary.total === 0" class="text-sm text-emerald-600">
      Alles vollständig geplant – keine Auffälligkeiten. ✅
    </p>

    <div v-else class="grid gap-4 md:grid-cols-3">
      <div v-for="severity in (['error', 'warning', 'info'] as const)" :key="severity">
        <h3 class="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
          {{ severityMeta[severity].label }} ({{ grouped[severity].length }})
        </h3>
        <ul class="max-h-48 space-y-1 overflow-y-auto pr-1">
          <li v-for="(issue, index) in grouped[severity]" :key="index">
            <button
              type="button"
              class="w-full rounded-md border px-2 py-1.5 text-left text-xs transition hover:brightness-95"
              :class="severityMeta[severity].className"
              @click="issue.taskId && store.setSelection(issue.taskId)"
            >
              <span v-if="issue.taskId" class="font-medium">{{ taskName(issue.taskId) }}: </span>
              <span v-else-if="issue.resourceId" class="font-medium">{{ resourceName(issue.resourceId) }}: </span>
              {{ issue.message }}
            </button>
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>
