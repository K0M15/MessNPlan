<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { PROJECT_ROLES } from '@projectplaner/shared';
import { useAuthStore } from '@/stores/auth';
import { useProjectStore } from '@/stores/project';
import { useToasts } from '@/composables/useToasts';
import type { MemberDto, ProjectRole, UserLookupDto } from '@/types';

const emit = defineEmits<{ close: [] }>();

const store = useProjectStore();
const auth = useAuthStore();
const toasts = useToasts();

const roleLabels: Record<ProjectRole, string> = {
  planner: 'Planer',
  member: 'Mitglied',
  viewer: 'Leser',
};

const query = ref('');
const results = ref<UserLookupDto[]>([]);
const newRole = ref<ProjectRole>('member');
const searching = ref(false);
let timer: number | undefined;

function isMember(userId: number): boolean {
  return store.members.some((member) => member.userId === userId);
}

async function search(): Promise<void> {
  searching.value = true;
  try {
    results.value = await store.lookupUsers(query.value);
  } finally {
    searching.value = false;
  }
}

watch(query, () => {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void search(), 300);
});

onMounted(() => {
  void store.refreshMembers();
  void search();
});

onBeforeUnmount(() => window.clearTimeout(timer));

async function add(user: UserLookupDto): Promise<void> {
  if (await store.addMember(user.id, newRole.value)) {
    toasts.success(`${user.name} hinzugefügt`);
  }
}

async function changeRole(member: MemberDto, role: ProjectRole): Promise<void> {
  if (role === member.role) return;
  if (await store.addMember(member.userId, role)) {
    toasts.success(`Rolle von ${member.name} geändert`);
  }
}

async function remove(member: MemberDto): Promise<void> {
  if (!window.confirm(`Mitglied „${member.name}“ aus dem Projekt entfernen?`)) return;
  if (await store.removeMember(member.userId)) {
    toasts.success('Mitglied entfernt');
  }
}
</script>

<template>
  <div class="fixed inset-0 z-50 grid place-items-center bg-slate-900/40 p-4" @click.self="emit('close')">
    <div class="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-xl bg-white shadow-xl">
      <header class="flex items-center justify-between border-b border-slate-100 px-5 py-3">
        <h2 class="font-medium text-slate-900">Mitglieder</h2>
        <button type="button" class="rounded p-1 text-slate-400 hover:bg-slate-100" @click="emit('close')">✕</button>
      </header>

      <div v-if="!store.canPlan" class="p-5 text-sm text-slate-500">
        Nur Projektplaner können Mitglieder verwalten.
      </div>

      <div v-else class="grid flex-1 grid-cols-2 gap-0 overflow-hidden">
        <div class="overflow-y-auto border-r border-slate-100 p-4">
          <h3 class="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
            Projektmitglieder ({{ store.members.length }})
          </h3>
          <p v-if="store.members.length === 0" class="text-sm text-slate-500">Noch keine Mitglieder.</p>
          <ul class="space-y-1.5">
            <li
              v-for="member in store.members"
              :key="member.userId"
              class="rounded-lg border border-slate-200 px-3 py-2 text-sm"
            >
              <div class="flex items-start justify-between gap-2">
                <div class="min-w-0">
                  <p class="truncate font-medium text-slate-800">
                    {{ member.name }}
                    <span v-if="member.userId === auth.user?.id" class="text-xs text-slate-400">(du)</span>
                  </p>
                  <p class="truncate text-xs text-slate-500">{{ member.email }}</p>
                </div>
                <button
                  type="button"
                  class="shrink-0 text-xs text-red-500 hover:underline"
                  @click="remove(member)"
                >
                  entfernen
                </button>
              </div>
              <label class="mt-2 flex items-center gap-2 text-xs text-slate-500">
                Rolle
                <select
                  :value="member.role"
                  class="rounded-md border border-slate-200 px-2 py-1 text-xs"
                  @change="changeRole(member, ($event.target as HTMLSelectElement).value as ProjectRole)"
                >
                  <option v-for="role in PROJECT_ROLES" :key="role" :value="role">
                    {{ roleLabels[role] }}
                  </option>
                </select>
              </label>
            </li>
          </ul>
        </div>

        <div class="flex flex-col overflow-hidden">
          <div class="space-y-3 border-b border-slate-100 p-4">
            <p class="text-xs text-slate-500">
              Als Projektplaner kannst du Mitglieder hinzufügen, Rollen ändern und Mitglieder entfernen.
            </p>
            <div>
              <label for="member-search" class="mb-1 block text-xs text-slate-500">Nutzer suchen</label>
              <input
                id="member-search"
                v-model="query"
                type="search"
                placeholder="Name oder E-Mail…"
                class="w-full rounded-md border border-slate-200 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label for="member-role" class="mb-1 block text-xs text-slate-500">Rolle beim Hinzufügen</label>
              <select id="member-role" v-model="newRole" class="w-full rounded-md border border-slate-200 px-2 py-2 text-sm">
                <option v-for="role in PROJECT_ROLES" :key="role" :value="role">
                  {{ roleLabels[role] }}
                </option>
              </select>
            </div>
          </div>

          <div class="flex-1 overflow-y-auto p-4">
            <p v-if="searching" class="text-sm text-slate-500">Suche…</p>
            <p v-else-if="results.length === 0" class="text-sm text-slate-500">Keine Nutzer gefunden.</p>
            <ul v-else class="space-y-1.5">
              <li
                v-for="user in results"
                :key="user.id"
                class="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm"
              >
                <div class="min-w-0">
                  <p class="truncate text-slate-800">{{ user.name }}</p>
                  <p class="truncate text-xs text-slate-500">{{ user.email }}</p>
                </div>
                <span v-if="isMember(user.id)" class="shrink-0 text-xs text-slate-400">bereits Mitglied</span>
                <button
                  v-else
                  type="button"
                  class="shrink-0 rounded-md border border-indigo-200 bg-indigo-50 px-2 py-1 text-xs text-indigo-700 hover:bg-indigo-100"
                  @click="add(user)"
                >
                  Hinzufügen
                </button>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
