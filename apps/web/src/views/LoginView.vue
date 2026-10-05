<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ApiClientError } from '@/api/client';
import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

const email = ref('');
const password = ref('');
const error = ref<string | null>(null);

async function submit(): Promise<void> {
  error.value = null;
  try {
    await auth.login(email.value, password.value);
    const next = typeof route.query.next === 'string' ? route.query.next : '/';
    await router.push(next);
  } catch (err) {
    if (err instanceof ApiClientError) {
      error.value = err.problem?.detail ?? 'Anmeldung fehlgeschlagen';
    } else {
      error.value = 'Anmeldung fehlgeschlagen';
    }
  }
}
</script>

<template>
  <div class="grid min-h-full place-items-center bg-slate-100 px-4">
    <div class="w-full max-w-sm">
      <div class="mb-6 flex flex-col items-center gap-2">
        <span class="grid h-10 w-10 place-items-center rounded-lg bg-indigo-600 text-lg font-bold text-white">P</span>
        <h1 class="text-xl font-semibold text-slate-900">ProjectPlaner</h1>
        <p class="text-sm text-slate-500">Bitte anmelden</p>
      </div>

      <form
        class="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
        @submit.prevent="submit"
      >
        <div>
          <label for="email" class="mb-1 block text-sm font-medium text-slate-700">E-Mail</label>
          <input
            id="email"
            v-model="email"
            type="email"
            required
            autocomplete="username"
            class="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200"
          />
        </div>
        <div>
          <label for="password" class="mb-1 block text-sm font-medium text-slate-700">Passwort</label>
          <input
            id="password"
            v-model="password"
            type="password"
            required
            autocomplete="current-password"
            class="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200"
          />
        </div>

        <p v-if="error" class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{{ error }}</p>

        <button
          type="submit"
          :disabled="auth.loading"
          class="w-full rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:opacity-60"
        >
          {{ auth.loading ? 'Anmelden…' : 'Anmelden' }}
        </button>
      </form>
    </div>
  </div>
</template>
