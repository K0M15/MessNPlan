<script setup lang="ts">
import { computed, ref } from 'vue';
import { useProjectStore } from '@/stores/project';
import { formatDateTime } from '@/utils/datetime';
import type { TaskDto } from '@/types';

const store = useProjectStore();
const timezone = computed(() => store.project?.timezone ?? 'Europe/Berlin');

interface Row {
  task: TaskDto;
  depth: number;
}

const rows = computed<Row[]>(() => {
  const out: Row[] = [];
  const walk = (nodes: TaskDto[], depth: number): void => {
    for (const node of nodes) {
      out.push({ task: node, depth });
      if (node.children && node.children.length > 0 && store.expandedIds.has(node.id)) {
        walk(node.children, depth + 1);
      }
    }
  };
  walk(store.taskTree, 0);
  return out;
});

const addingChildOf = ref<number | null>(null);
const newTaskName = ref('');

const severityByTask = computed(() => {
  const map = new Map<number, 'error' | 'warning' | 'info'>();
  const rank = { error: 3, warning: 2, info: 1 } as const;
  for (const issue of store.health?.issues ?? []) {
    if (!issue.taskId) continue;
    const current = map.get(issue.taskId);
    if (!current || rank[issue.severity] > rank[current]) map.set(issue.taskId, issue.severity);
  }
  return map;
});

function formatHours(minutes: number | null): string {
  if (minutes === null) return '–';
  if (minutes === 0) return '0';
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours} h` : `${hours.toFixed(1)} h`;
}

function formatPlanDate(iso: string | null): string {
  return formatDateTime(iso, timezone.value);
}

const statusMeta: Record<TaskDto['status'], { label: string; className: string }> = {
  todo: { label: 'Offen', className: 'bg-slate-300' },
  in_progress: { label: 'In Arbeit', className: 'bg-blue-500' },
  blocked: { label: 'Blockiert', className: 'bg-red-500' },
  done: { label: 'Fertig', className: 'bg-emerald-500' },
};

function startAddChild(taskId: number): void {
  addingChildOf.value = taskId;
  newTaskName.value = '';
}

async function submitAddChild(): Promise<void> {
  if (!newTaskName.value.trim() || addingChildOf.value === null) return;
  await store.createTask({ parentId: addingChildOf.value, name: newTaskName.value.trim() });
  addingChildOf.value = null;
  newTaskName.value = '';
}

const rootTaskName = ref('');
async function addRootTask(): Promise<void> {
  if (!rootTaskName.value.trim()) return;
  await store.createTask({ name: rootTaskName.value.trim() });
  rootTaskName.value = '';
}
</script>

<template>
  <div class="rounded-xl border border-slate-200 bg-white shadow-sm">
    <div v-if="store.canWrite" class="flex gap-2 border-b border-slate-100 p-2">
      <input
        v-model="rootTaskName"
        placeholder="Neue Aufgabe…"
        class="min-w-0 flex-1 rounded-md border border-slate-200 px-2 py-1.5 text-sm outline-none focus:border-indigo-400"
        @keydown.enter="addRootTask"
      />
      <button
        type="button"
        class="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
        @click="addRootTask"
      >
        Hinzufügen
      </button>
    </div>

    <div class="grid grid-cols-[minmax(0,1fr)_90px_130px_130px_80px] items-center gap-2 border-b border-slate-100 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-500">
      <span>Aufgabe</span>
      <span class="text-right">Dauer</span>
      <span>Start</span>
      <span>Ende</span>
      <span>Status</span>
    </div>

    <p v-if="rows.length === 0" class="p-4 text-sm text-slate-500">
      Noch keine Aufgaben. Lege oben die erste Aufgabe an.
    </p>

    <div v-for="row in rows" :key="row.task.id">
      <div
        class="group grid cursor-pointer grid-cols-[minmax(0,1fr)_90px_130px_130px_80px] items-center gap-2 border-b border-slate-50 px-3 py-1.5 text-sm transition hover:bg-slate-50"
        :class="{ 'bg-indigo-50 hover:bg-indigo-50': store.selectedTaskId === row.task.id }"
        @click="store.setSelection(row.task.id)"
      >
        <span class="flex min-w-0 items-center gap-1.5" :style="{ paddingLeft: `${row.depth * 16}px` }">
          <button
            v-if="row.task.children && row.task.children.length > 0"
            type="button"
            class="grid h-4 w-4 shrink-0 place-items-center rounded text-slate-400 hover:bg-slate-200"
            @click.stop="store.toggleExpanded(row.task.id)"
          >
            {{ store.expandedIds.has(row.task.id) ? '▾' : '▸' }}
          </button>
          <span v-else class="w-4 shrink-0" />

          <span
            v-if="severityByTask.get(row.task.id)"
            class="shrink-0 text-xs"
            :title="store.health?.issues.find((i) => i.taskId === row.task.id)?.message"
          >
            <span v-if="severityByTask.get(row.task.id) === 'error'">🔴</span>
            <span v-else-if="severityByTask.get(row.task.id) === 'warning'">🟡</span>
            <span v-else>ℹ️</span>
          </span>

          <span v-if="row.task.isMilestone" class="shrink-0 text-xs">◆</span>
          <span v-if="row.task.constraintType !== 'asap'" class="shrink-0 text-xs" title="Start-Constraint gepinnt">📌</span>

          <span class="truncate" :class="{ 'font-medium': row.task.children?.length }">{{ row.task.name }}</span>

          <span v-if="row.task.tags?.length" class="flex shrink-0 gap-1">
            <span
              v-for="tag in row.task.tags"
              :key="tag.id"
              class="h-2 w-2 rounded-full"
              :style="{ backgroundColor: tag.color }"
              :title="tag.name"
            />
          </span>

          <button
            v-if="store.canWrite"
            type="button"
            class="ml-auto hidden shrink-0 rounded px-1 text-xs text-slate-400 hover:bg-slate-200 group-hover:block"
            title="Teilaufgabe anlegen"
            @click.stop="startAddChild(row.task.id)"
          >
            +
          </button>
        </span>
        <span class="text-right text-slate-500">{{ formatHours(row.task.estimatedMinutes) }}</span>
        <span class="text-xs text-slate-500">{{ formatPlanDate(row.task.plannedStart) }}</span>
        <span class="text-xs text-slate-500">{{ formatPlanDate(row.task.plannedEnd) }}</span>
        <span class="flex items-center gap-1.5 text-xs text-slate-600">
          <span class="h-2 w-2 rounded-full" :class="statusMeta[row.task.status].className" />
          {{ statusMeta[row.task.status].label }}
        </span>
      </div>

      <div v-if="addingChildOf === row.task.id" class="border-b border-slate-50 bg-slate-50 px-3 py-1.5" :style="{ paddingLeft: `${(row.depth + 1) * 16 + 12}px` }">
        <input
          v-model="newTaskName"
          autofocus
          :placeholder="`Teilaufgabe von „${row.task.name}“…`"
          class="w-full rounded-md border border-slate-200 px-2 py-1 text-sm outline-none focus:border-indigo-400"
          @keydown.enter="submitAddChild"
          @keydown.esc="addingChildOf = null"
        />
      </div>
    </div>
  </div>
</template>
