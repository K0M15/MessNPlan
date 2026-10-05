<script setup lang="ts">
import { useToasts } from '@/composables/useToasts';

const { toasts, dismiss } = useToasts();
</script>

<template>
  <div class="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-80 flex-col gap-2">
    <div
      v-for="toast in toasts"
      :key="toast.id"
      class="pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2 text-sm shadow-lg"
      :class="{
        'border-emerald-200 bg-emerald-50 text-emerald-800': toast.kind === 'success',
        'border-red-200 bg-red-50 text-red-800': toast.kind === 'error',
        'border-slate-200 bg-white text-slate-700': toast.kind === 'info',
      }"
    >
      <span class="flex-1">{{ toast.message }}</span>
      <button
        type="button"
        class="shrink-0 text-xs opacity-60 hover:opacity-100"
        aria-label="Schließen"
        @click="dismiss(toast.id)"
      >
        ✕
      </button>
    </div>
  </div>
</template>
