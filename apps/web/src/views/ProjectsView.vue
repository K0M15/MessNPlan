<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ApiClientError, api } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import type { ProjectDto } from '@/types';

const auth = useAuthStore();
const projects = ref<ProjectDto[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);

const canCreate = computed(() => auth.user?.role === 'admin' || auth.user?.role === 'planner');

const showCreate = ref(false);
const createName = ref('');
const createDescription = ref('');
const createError = ref<string | null>(null);
const creating = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const result = await api.get<{ items: ProjectDto[] }>('/projects');
    projects.value = result.items;
  } catch (err) {
    error.value = err instanceof ApiClientError ? err.message : 'Projekte konnten nicht geladen werden';
  } finally {
    loading.value = false;
  }
}

async function createProject(): Promise<void> {
  creating.value = true;
  createError.value = null;
  try {
    await api.post<{ project: ProjectDto }>('/projects', {
      name: createName.value,
      description: createDescription.value || null,
    });
    showCreate.value = false;
    createName.value = '';
    createDescription.value = '';
    await load();
  } catch (err) {
    createError.value =
      err instanceof ApiClientError
        ? (err.problem?.errors?.map((e) => e.message).join(', ') ?? err.message)
        : 'Projekt konnte nicht angelegt werden';
  } finally {
    creating.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div>
    <div class="mb-6 flex items-center justify-between">
      <div>
        <h1 class="text-xl font-semibold text-slate-900">Projekte</h1>
        <p class="text-sm text-slate-500">Alle Projekte, auf die du Zugriff hast</p>
      </div>
      <button
        v-if="canCreate"
        type="button"
        class="rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-indigo-700"
        @click="showCreate = true"
      >
        Neues Projekt
      </button>
    </div>

    <p v-if="error" class="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{{ error }}</p>
    <p v-if="loading" class="text-sm text-slate-500">Lade Projekte…</p>

    <div v-else-if="projects.length === 0" class="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
      Noch keine Projekte vorhanden.
    </div>

    <ul v-else class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <li v-for="project in projects" :key="project.id">
        <RouterLink
          :to="{ name: 'project', params: { id: project.id } }"
          class="flex h-full flex-col rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-indigo-300 hover:shadow"
        >
          <div class="mb-1 flex items-start justify-between gap-2">
            <h2 class="font-medium text-slate-900">{{ project.name }}</h2>
            <span
              v-if="project.status === 'archived'"
              class="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500"
              >archiviert</span>
          </div>
          <p class="line-clamp-2 flex-1 text-sm text-slate-500">
            {{ project.description || 'Keine Beschreibung' }}
          </p>
          <div class="mt-3 flex items-center justify-between text-xs text-slate-400">
            <span>{{ project.timezone }}</span>
            <span v-if="project.myRole">Rolle: {{ project.myRole }}</span>
          </div>
        </RouterLink>
      </li>
    </ul>

    <div v-if="showCreate" class="fixed inset-0 z-50 grid place-items-center bg-slate-900/40 p-4">
      <form class="w-full max-w-md rounded-xl bg-white p-6 shadow-xl" @submit.prevent="createProject">
        <h2 class="mb-4 text-lg font-semibold text-slate-900">Neues Projekt</h2>
        <div class="space-y-4">
          <div>
            <label for="project-name" class="mb-1 block text-sm font-medium text-slate-700">Name</label>
            <input
              id="project-name"
              v-model="createName"
              required
              maxlength="160"
              class="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200"
            />
          </div>
          <div>
            <label for="project-description" class="mb-1 block text-sm font-medium text-slate-700">Beschreibung</label>
            <textarea
              id="project-description"
              v-model="createDescription"
              rows="3"
              class="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200"
            />
          </div>
          <p v-if="createError" class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {{ createError }}
          </p>
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
            Anlegen
          </button>
        </div>
      </form>
    </div>
  </div>
</template>
