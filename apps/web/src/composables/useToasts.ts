import { ref } from 'vue';

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  message: string;
}

const toasts = ref<Toast[]>([]);
let nextId = 1;

function dismiss(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id);
}

function push(kind: Toast['kind'], message: string, timeout: number | null = 4000): void {
  const id = nextId++;
  toasts.value.push({ id, kind, message });
  if (timeout !== null) {
    window.setTimeout(() => dismiss(id), timeout);
  }
}

export function useToasts() {
  return {
    toasts,
    dismiss,
    info: (message: string) => push('info', message),
    success: (message: string) => push('success', message),
    error: (message: string) => push('error', message, 8000),
  };
}
