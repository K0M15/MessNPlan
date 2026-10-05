<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useProjectStore } from '@/stores/project';
import { useToasts } from '@/composables/useToasts';
import { formatDate, formatDateTime } from '@/utils/datetime';
import type { ApiKeyDto } from '@/types';

const store = useProjectStore();
const toasts = useToasts();

const loading = ref(false);
const creating = ref(false);
const busyId = ref<number | null>(null);

const form = reactive({ name: '', publicKey: '', expiresAt: '' });

const SSH_KEY_PATTERN = /^(ssh-ed25519|ssh-rsa)\s+([A-Za-z0-9+/]+={0,2})(\s+.*)?$/;

/** Grobe Formatprüfung im Browser; die API validiert verbindlich. */
function keyFormatError(value: string): string | null {
  const line = value.trim();
  if (!line) return 'Bitte einen Public Key einfügen';
  const match = SSH_KEY_PATTERN.exec(line);
  if (!match) return 'Format "<Typ> <base64> [Kommentar]" erwartet';
  const type = match[1] ?? '';
  try {
    const blob = atob(match[2] ?? '');
    if (blob.length < 4) return 'Schlüsseldaten sind zu kurz';
    const length = (blob.charCodeAt(0) << 24) | (blob.charCodeAt(1) << 16) | (blob.charCodeAt(2) << 8) | blob.charCodeAt(3);
    return blob.slice(4, 4 + length) === type
      ? null
      : 'Schlüsseltyp und Schlüsseldaten passen nicht zusammen';
  } catch {
    return 'Base64-Teil des Schlüssels ist ungültig';
  }
}

const timezone = computed(() => store.project?.timezone ?? 'UTC');

onMounted(async () => {
  loading.value = true;
  try {
    await store.loadApiKeys();
  } finally {
    loading.value = false;
  }
});

function resetForm(): void {
  form.name = '';
  form.publicKey = '';
  form.expiresAt = '';
}

async function create(): Promise<void> {
  if (!form.name.trim()) {
    toasts.error('Bitte einen Namen angeben');
    return;
  }
  const error = keyFormatError(form.publicKey);
  if (error) {
    toasts.error(error);
    return;
  }
  creating.value = true;
  try {
    const expiresAt = form.expiresAt
      ? new Date(`${form.expiresAt}T23:59:59`).toISOString()
      : null;
    const ok = await store.createApiKey({
      name: form.name.trim(),
      publicKey: form.publicKey.trim(),
      expiresAt,
    });
    if (ok) {
      toasts.success('API-Schlüssel angelegt');
      resetForm();
    }
  } finally {
    creating.value = false;
  }
}

async function toggleActive(item: ApiKeyDto): Promise<void> {
  busyId.value = item.id;
  try {
    const ok = await store.updateApiKey(item.id, { isActive: !item.isActive });
    if (ok) toasts.success(item.isActive ? 'API-Schlüssel deaktiviert' : 'API-Schlüssel aktiviert');
  } finally {
    busyId.value = null;
  }
}

async function remove(item: ApiKeyDto): Promise<void> {
  if (!window.confirm(`API-Schlüssel „${item.name}“ löschen?`)) return;
  busyId.value = item.id;
  try {
    if (await store.deleteApiKey(item.id)) toasts.success('API-Schlüssel gelöscht');
  } finally {
    busyId.value = null;
  }
}

function expiresLabel(item: ApiKeyDto): string {
  return item.expiresAt ? formatDate(item.expiresAt, timezone.value) : 'unbegrenzt';
}
</script>

<template>
  <div class="space-y-5">
    <p class="text-xs text-slate-500">
      Externe Clients (z. B. Skripte oder CI-Jobs) authentifizieren sich mit einem SSH-Schlüsselpaar.
      Hier wird nur der <strong>öffentliche</strong> Schlüssel hinterlegt; signiert wird lokal mit dem
      privaten Schlüssel. Aufbau und Beispiele siehe <code>docs/API-external.md</code>.
    </p>

    <div v-if="loading" class="text-sm text-slate-500">Lade API-Schlüssel…</div>
    <p v-else-if="store.apiKeys.length === 0" class="text-sm text-slate-500">
      Noch keine API-Schlüssel hinterlegt.
    </p>
    <ul v-else class="space-y-2">
      <li
        v-for="item in store.apiKeys"
        :key="item.id"
        class="rounded-md border border-slate-200 px-3 py-2 text-sm"
      >
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <span class="font-medium text-slate-800">{{ item.name }}</span>
              <span
                class="rounded px-1.5 py-0.5 text-[11px]"
                :class="item.isActive ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'"
              >
                {{ item.isActive ? 'aktiv' : 'deaktiviert' }}
              </span>
              <span class="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">
                {{ item.keyType }}
              </span>
            </div>
            <div class="mt-0.5 truncate font-mono text-[11px] text-slate-400" :title="item.fingerprint">
              {{ item.fingerprint }}
            </div>
            <div class="mt-1 text-xs text-slate-500">
              Ablauf: {{ expiresLabel(item) }} · Zuletzt verwendet:
              {{ item.lastUsedAt ? formatDateTime(item.lastUsedAt, timezone) : '–' }}
            </div>
          </div>
          <div class="flex shrink-0 gap-2">
            <button
              type="button"
              :disabled="busyId === item.id"
              class="text-xs text-indigo-600 hover:underline disabled:opacity-50"
              @click="toggleActive(item)"
            >
              {{ item.isActive ? 'Deaktivieren' : 'Aktivieren' }}
            </button>
            <button
              type="button"
              :disabled="busyId === item.id"
              class="text-xs text-red-500 hover:underline disabled:opacity-50"
              @click="remove(item)"
            >
              Löschen
            </button>
          </div>
        </div>
      </li>
    </ul>

    <div class="border-t border-slate-100 pt-4">
      <h3 class="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
        Neuen Schlüssel anlegen
      </h3>
      <form class="space-y-3" @submit.prevent="create">
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label for="api-key-name" class="mb-1 block text-xs text-slate-500">Name</label>
            <input
              id="api-key-name"
              v-model="form.name"
              required
              maxlength="120"
              placeholder="z. B. CI-Pipeline"
              class="w-full rounded-md border border-slate-200 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label for="api-key-expires" class="mb-1 block text-xs text-slate-500">
              Ablaufdatum (optional)
            </label>
            <input
              id="api-key-expires"
              v-model="form.expiresAt"
              type="date"
              class="w-full rounded-md border border-slate-200 px-3 py-2 text-sm"
            />
          </div>
        </div>
        <div>
          <label for="api-key-public" class="mb-1 block text-xs text-slate-500">
            Öffentlicher Schlüssel (OpenSSH, einzeilig)
          </label>
          <textarea
            id="api-key-public"
            v-model="form.publicKey"
            rows="3"
            required
            spellcheck="false"
            placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA… user@rechner"
            class="w-full rounded-md border border-slate-200 px-3 py-2 font-mono text-xs"
          />
          <p class="mt-1 text-[11px] text-slate-400">
            Erzeugen z. B. mit <code>ssh-keygen -t ed25519 -C "ci@example"</code>; eingefügt wird
            der Inhalt von <code>~/.ssh/id_ed25519.pub</code>.
          </p>
        </div>
        <div class="flex justify-end">
          <button
            type="submit"
            :disabled="creating"
            class="rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
          >
            {{ creating ? 'Anlegen…' : 'Schlüssel anlegen' }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>
