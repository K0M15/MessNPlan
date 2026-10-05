<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ROLES, type Role } from '@projectplaner/shared';
import { ApiClientError, api } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { useToasts } from '@/composables/useToasts';
import type { UserDto } from '@/types';

const auth = useAuthStore();
const toasts = useToasts();

const users = ref<UserDto[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);

const showCreate = ref(false);
const creating = ref(false);
const createError = ref<string | null>(null);
const createForm = reactive({ name: '', email: '', password: '', role: 'member' as Role });
const busyUserId = ref<number | null>(null);

const roleLabels: Record<Role, string> = {
  admin: 'Administrator',
  planner: 'Planer',
  member: 'Mitglied',
  viewer: 'Leser',
};

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiClientError) {
    const validation = err.problem?.errors?.map((e) => e.message).join(', ');
    return validation ?? err.problem?.detail ?? err.problem?.title ?? err.message;
  }
  return fallback;
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const res = await api.get<{ items: UserDto[]; total: number }>('/users?pageSize=200');
    users.value = res.items;
  } catch (err) {
    error.value = errorMessage(err, 'Benutzer konnten nicht geladen werden');
  } finally {
    loading.value = false;
  }
}

function openCreate(): void {
  createForm.name = '';
  createForm.email = '';
  createForm.password = '';
  createForm.role = 'member';
  createError.value = null;
  showCreate.value = true;
}

async function createUser(): Promise<void> {
  creating.value = true;
  createError.value = null;
  try {
    await api.post<{ user: UserDto }>('/users', {
      name: createForm.name.trim(),
      email: createForm.email.trim(),
      password: createForm.password,
      role: createForm.role,
    });
    showCreate.value = false;
    toasts.success('Benutzer angelegt');
    await load();
  } catch (err) {
    createError.value = errorMessage(err, 'Benutzer konnte nicht angelegt werden');
  } finally {
    creating.value = false;
  }
}

async function changeRole(user: UserDto, role: Role): Promise<void> {
  if (role === user.role) return;
  busyUserId.value = user.id;
  try {
    await api.patch<{ user: UserDto }>(`/users/${user.id}`, { role });
    toasts.success(`Rolle von ${user.name} geändert`);
    await load();
  } catch (err) {
    toasts.error(errorMessage(err, 'Rolle konnte nicht geändert werden'));
    await load();
  } finally {
    busyUserId.value = null;
  }
}

async function toggleActive(user: UserDto): Promise<void> {
  if (user.isActive && !window.confirm(`Benutzer „${user.name}“ deaktivieren?`)) return;
  busyUserId.value = user.id;
  try {
    if (user.isActive) {
      await api.del(`/users/${user.id}`);
      toasts.success(`${user.name} deaktiviert`);
    } else {
      await api.patch<{ user: UserDto }>(`/users/${user.id}`, { isActive: true });
      toasts.success(`${user.name} aktiviert`);
    }
    await load();
  } catch (err) {
    toasts.error(errorMessage(err, 'Status konnte nicht geändert werden'));
  } finally {
    busyUserId.value = null;
  }
}

onMounted(load);
</script>

<template>
  <div>
    <div class="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div>
        <RouterLink to="/" class="text-sm text-indigo-600 hover:underline">← Alle Projekte</RouterLink>
        <h1 class="mt-1 text-xl font-semibold text-slate-900">Benutzerverwaltung</h1>
        <p class="text-sm text-slate-500">Konten anlegen, Rollen ändern und Zugänge deaktivieren</p>
      </div>
      <button
        type="button"
        class="rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-indigo-700"
        @click="openCreate"
      >
        Neuer Benutzer
      </button>
    </div>

    <p v-if="error" class="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{{ error }}</p>
    <p v-if="loading" class="text-sm text-slate-500">Lade Benutzer…</p>

    <div v-else class="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
      <table class="min-w-full divide-y divide-slate-100 text-sm">
        <thead class="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-400">
          <tr>
            <th class="px-4 py-2 font-medium">Name</th>
            <th class="px-4 py-2 font-medium">E-Mail</th>
            <th class="px-4 py-2 font-medium">Rolle</th>
            <th class="px-4 py-2 font-medium">Aktiv</th>
            <th class="px-4 py-2"></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-100">
          <tr v-for="user in users" :key="user.id" :class="{ 'opacity-60': !user.isActive }">
            <td class="px-4 py-2 text-slate-800">
              {{ user.name }}
              <span v-if="user.id === auth.user?.id" class="text-xs text-slate-400">(du)</span>
            </td>
            <td class="px-4 py-2 text-slate-500">{{ user.email }}</td>
            <td class="px-4 py-2">
              <select
                :value="user.role"
                :disabled="user.id === auth.user?.id || busyUserId === user.id"
                class="rounded-md border border-slate-200 px-2 py-1 text-sm disabled:opacity-60"
                @change="changeRole(user, ($event.target as HTMLSelectElement).value as Role)"
              >
                <option v-for="role in ROLES" :key="role" :value="role">{{ roleLabels[role] }}</option>
              </select>
            </td>
            <td class="px-4 py-2">
              <span
                class="rounded-full px-2 py-0.5 text-xs"
                :class="user.isActive ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'"
              >
                {{ user.isActive ? 'aktiv' : 'deaktiviert' }}
              </span>
            </td>
            <td class="px-4 py-2 text-right">
              <button
                type="button"
                :disabled="user.id === auth.user?.id || busyUserId === user.id"
                class="text-xs hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                :class="user.isActive ? 'text-red-500' : 'text-emerald-600'"
                @click="toggleActive(user)"
              >
                {{ user.isActive ? 'Deaktivieren' : 'Aktivieren' }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="showCreate" class="fixed inset-0 z-50 grid place-items-center bg-slate-900/40 p-4" @click.self="showCreate = false">
      <form class="w-full max-w-md rounded-xl bg-white p-6 shadow-xl" @submit.prevent="createUser">
        <h2 class="mb-4 text-lg font-semibold text-slate-900">Neuer Benutzer</h2>
        <div class="space-y-4">
          <div>
            <label for="admin-user-name" class="mb-1 block text-sm font-medium text-slate-700">Name</label>
            <input
              id="admin-user-name"
              v-model="createForm.name"
              required
              maxlength="160"
              class="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200"
            />
          </div>
          <div>
            <label for="admin-user-email" class="mb-1 block text-sm font-medium text-slate-700">E-Mail</label>
            <input
              id="admin-user-email"
              v-model="createForm.email"
              type="email"
              required
              class="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200"
            />
          </div>
          <div>
            <label for="admin-user-password" class="mb-1 block text-sm font-medium text-slate-700">
              Passwort (mind. 10 Zeichen)
            </label>
            <input
              id="admin-user-password"
              v-model="createForm.password"
              type="password"
              required
              minlength="10"
              autocomplete="new-password"
              class="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200"
            />
          </div>
          <div>
            <label for="admin-user-role" class="mb-1 block text-sm font-medium text-slate-700">Rolle</label>
            <select
              id="admin-user-role"
              v-model="createForm.role"
              class="w-full rounded-md border border-slate-300 px-2 py-2 text-sm"
            >
              <option v-for="role in ROLES" :key="role" :value="role">{{ roleLabels[role] }}</option>
            </select>
          </div>
          <p v-if="createError" class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{{ createError }}</p>
        </div>
        <div class="mt-6 flex justify-end gap-2">
          <button
            type="button"
            class="rounded-md px-3 py-2 text-sm text-slate-600 transition hover:bg-slate-100"
            @click="showCreate = false"
          >
            Abbrechen
          </button>
          <button
            type="submit"
            :disabled="creating"
            class="rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:opacity-60"
          >
            {{ creating ? 'Anlegen…' : 'Anlegen' }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>
