import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '@/api/client';
import { connectSocket, disconnectSocket } from '@/api/socket';
import type { UserDto } from '@/types';

export const useAuthStore = defineStore('auth', () => {
  const user = ref<UserDto | null>(null);
  const initialized = ref(false);
  const loading = ref(false);

  async function login(email: string, password: string): Promise<void> {
    loading.value = true;
    try {
      const result = await api.post<{ user: UserDto }>('/auth/login', { email, password });
      user.value = result.user;
      initialized.value = true;
      connectSocket();
    } finally {
      loading.value = false;
    }
  }

  async function logout(): Promise<void> {
    try {
      await api.post('/auth/logout');
    } finally {
      user.value = null;
      disconnectSocket();
    }
  }

  /** Stellt eine Session per Refresh-Token wieder her (einmal pro Seitenaufruf). */
  async function bootstrap(): Promise<boolean> {
    if (initialized.value) return user.value !== null;
    initialized.value = true;
    try {
      const result = await api.post<{ user: UserDto }>('/auth/refresh');
      user.value = result.user;
      connectSocket();
      return true;
    } catch {
      user.value = null;
      return false;
    }
  }

  return { user, initialized, loading, login, logout, bootstrap };
});
