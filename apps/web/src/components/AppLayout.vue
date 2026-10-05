<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import ToastHost from '@/components/ToastHost.vue';

const auth = useAuthStore();
const router = useRouter();

const roleLabel = computed(() => {
  switch (auth.user?.role) {
    case 'admin':
      return 'Administrator';
    case 'planner':
      return 'Planer';
    case 'member':
      return 'Mitglied';
    default:
      return 'Leser';
  }
});

async function handleLogout(): Promise<void> {
  await auth.logout();
  await router.push({ name: 'login' });
}
</script>

<template>
  <div class="flex min-h-full flex-col">
    <header class="border-b border-slate-200 bg-white">
      <div class="mx-auto flex h-14 w-full max-w-7xl items-center justify-between px-4">
        <RouterLink to="/" class="flex items-center gap-2 text-slate-900">
          <span
            class="grid h-7 w-7 place-items-center rounded-md bg-indigo-600 text-sm font-bold text-white"
            >P</span>
          <span class="font-semibold">ProjectPlaner</span>
        </RouterLink>
        <div class="flex items-center gap-3 text-sm">
          <RouterLink
            v-if="auth.user?.role === 'admin'"
            to="/admin/users"
            class="rounded-md px-2 py-1 text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
          >
            Benutzer
          </RouterLink>
          <span class="hidden text-slate-500 sm:inline">{{ auth.user?.name }}</span>
          <span class="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
            {{ roleLabel }}
          </span>
          <button
            type="button"
            class="rounded-md px-2 py-1 text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
            @click="handleLogout"
          >
            Abmelden
          </button>
        </div>
      </div>
    </header>
    <main class="mx-auto w-full max-w-7xl flex-1 px-4 py-6">
      <RouterView />
    </main>
    <ToastHost />
  </div>
</template>
