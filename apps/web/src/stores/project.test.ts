import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useProjectStore } from './project';

type Handler = (...args: unknown[]) => void;

interface MockSocket {
  connected: boolean;
  emit: Mock<(event: string, ...args: unknown[]) => void>;
  on: Mock<(event: string, handler: Handler) => void>;
  off: Mock<(event: string, handler?: Handler) => void>;
  connect: Mock<() => void>;
  disconnect: Mock<() => void>;
  trigger: (event: string, ...args: unknown[]) => void;
  listenerCount: (event: string) => number;
  reset: () => void;
}

const socketMock = vi.hoisted((): MockSocket => {
  const listeners = new Map<string, Set<Handler>>();

  const socket: MockSocket = {
    connected: false,
    emit: vi.fn(),
    on: vi.fn((event: string, handler: Handler) => {
      const handlers = listeners.get(event) ?? new Set<Handler>();
      handlers.add(handler);
      listeners.set(event, handlers);
    }),
    off: vi.fn((event: string, handler?: Handler) => {
      if (handler) listeners.get(event)?.delete(handler);
      else listeners.delete(event);
    }),
    connect: vi.fn(),
    disconnect: vi.fn(),
    trigger: (event: string, ...args: unknown[]) => {
      for (const handler of [...(listeners.get(event) ?? [])]) handler(...args);
    },
    listenerCount: (event: string) => listeners.get(event)?.size ?? 0,
    reset: () => {
      listeners.clear();
      socket.connected = false;
      socket.emit.mockClear();
      socket.on.mockClear();
      socket.off.mockClear();
      socket.connect.mockClear();
      socket.disconnect.mockClear();
    },
  };

  return socket;
});

const apiMock = vi.hoisted(() => ({ get: vi.fn(), getConditional: vi.fn(), post: vi.fn() }));

vi.mock('socket.io-client', () => ({ io: vi.fn(() => socketMock) }));

vi.mock('@/api/client', () => ({
  ApiClientError: class ApiClientError extends Error {
    readonly status: number;
    readonly problem: unknown;
    constructor(status: number, problem: unknown) {
      super(`HTTP ${status}`);
      this.name = 'ApiClientError';
      this.status = status;
      this.problem = problem;
    }
  },
  api: {
    get: apiMock.get,
    getConditional: apiMock.getConditional,
    post: apiMock.post,
    patch: vi.fn(),
    put: vi.fn(),
    del: vi.fn(),
  },
}));

const PROJECT_ID = 7;

/** Minimale Antworten für die sieben Requests aus `store.load`. */
function apiResponse(path: string): unknown {
  switch (path) {
    case `/projects/${PROJECT_ID}`:
      return {
        project: { id: PROJECT_ID, name: 'Testprojekt', timezone: 'Europe/Berlin' },
        members: [],
      };
    case `/projects/${PROJECT_ID}/tasks?tree=1`:
      return { items: [] };
    case `/projects/${PROJECT_ID}/resources`:
      return { items: [] };
    case `/projects/${PROJECT_ID}/tags`:
      return { items: [] };
    case `/projects/${PROJECT_ID}/gantt`:
      return {
        project: { id: PROJECT_ID, timezone: 'Europe/Berlin' },
        version: 1,
        tasks: [],
        edges: [],
        absences: [],
      };
    case `/projects/${PROJECT_ID}/utilisation`:
      return { from: '', to: '', bucketMinutes: 60, buckets: [] };
    case `/projects/${PROJECT_ID}/health`:
      return { issues: [], summary: { error: 0, warning: 0, info: 0, total: 0 } };
    case `/projects/${PROJECT_ID}/outlook/connections`:
      return { configured: false, items: [] };
    default:
      throw new Error(`Unerwarteter API-Aufruf im Test: ${path}`);
  }
}

describe('useProjectStore – Realtime-Room', () => {
  beforeEach(() => {
    socketMock.reset();
    apiMock.get.mockReset();
    apiMock.getConditional.mockReset();
    apiMock.post.mockReset();
    apiMock.get.mockImplementation((path: string) => Promise.resolve(apiResponse(path)));
    apiMock.getConditional.mockImplementation((path: string) =>
      Promise.resolve({ notModified: false, data: apiResponse(path), etag: '"gv1"' }),
    );
    apiMock.post.mockResolvedValue({ task: {} });
    setActivePinia(createPinia());
  });

  it('tritt dem Room beim Connect bei und nach Reconnect erneut', async () => {
    const store = useProjectStore();
    await store.load(PROJECT_ID);

    expect(socketMock.on).toHaveBeenCalledWith('connect', expect.any(Function));
    // Beim Laden war der Socket noch nicht verbunden → Join erfolgt erst beim connect-Event.
    expect(socketMock.emit).not.toHaveBeenCalledWith('project:join', PROJECT_ID);

    socketMock.connected = true;
    socketMock.trigger('connect');
    expect(socketMock.emit).toHaveBeenCalledWith('project:join', PROJECT_ID);

    store.setSelection(42);
    expect(socketMock.emit).toHaveBeenCalledWith('presence:selection', {
      projectId: PROJECT_ID,
      taskId: 42,
    });

    // Reconnect (Netzabbruch oder Token-Refresh): Room und Auswahl erneut melden.
    socketMock.emit.mockClear();
    socketMock.trigger('connect');
    expect(socketMock.emit).toHaveBeenCalledWith('project:join', PROJECT_ID);
    expect(socketMock.emit).toHaveBeenCalledWith('presence:selection', {
      projectId: PROJECT_ID,
      taskId: 42,
    });
  });

  it('räumt beim Verlassen connect-Handler und Raumzustand auf', async () => {
    const store = useProjectStore();
    await store.load(PROJECT_ID);
    socketMock.connected = true;
    socketMock.trigger('connect');
    socketMock.emit.mockClear();

    store.disconnectRealtime();

    expect(socketMock.emit).toHaveBeenCalledWith('project:leave', PROJECT_ID);
    expect(socketMock.off).toHaveBeenCalledWith('connect', expect.any(Function));
    expect(socketMock.listenerCount('connect')).toBe(0);

    socketMock.trigger('connect');
    expect(socketMock.emit).not.toHaveBeenCalledWith('project:join', PROJECT_ID);

    store.setSelection(11);
    expect(socketMock.emit).not.toHaveBeenCalledWith('presence:selection', expect.anything());
  });

  it('behält optimistische Drag-Werte über Server-Refreshes und rollt bei Bedarf zurück', async () => {
    const store = useProjectStore();
    const baseTask = {
      id: 1,
      projectId: PROJECT_ID,
      parentId: null,
      name: 'Aufgabe',
      plannedStart: '2026-10-05T06:00:00.000Z',
      plannedEnd: '2026-10-05T14:00:00.000Z',
      estimatedMinutes: 480,
      version: 1,
    };
    apiMock.get.mockImplementation((path: string) => {
      if (path === `/projects/${PROJECT_ID}/tasks?tree=1`) {
        return Promise.resolve({ items: [baseTask] });
      }
      return Promise.resolve(apiResponse(path));
    });

    await store.load(PROJECT_ID);
    expect(store.taskById.get(1)?.plannedStart).toBe(baseTask.plannedStart);

    const rollback = store.applyOptimisticTask(1, {
      plannedStart: '2026-10-06T06:00:00.000Z',
      plannedEnd: '2026-10-06T14:00:00.000Z',
    });
    expect(store.taskById.get(1)?.plannedStart).toBe('2026-10-06T06:00:00.000Z');

    // Server liefert noch die alten Zeiten (Compute läuft) → Override bleibt bestehen.
    await store.refreshTasks();
    expect(store.taskById.get(1)?.plannedStart).toBe('2026-10-06T06:00:00.000Z');

    rollback();
    expect(store.taskById.get(1)?.plannedStart).toBe(baseTask.plannedStart);
  });

  it('verschiebt Aufgaben und klappt den neuen Elternteil auf', async () => {
    const store = useProjectStore();
    await store.load(PROJECT_ID);

    const ok = await store.moveTask(2, 1, undefined, 5);

    expect(ok).toBe(true);
    expect(apiMock.post).toHaveBeenCalledWith(
      '/tasks/2/move',
      { parentId: 1, sortOrder: undefined },
      { version: 5 },
    );
    expect(store.expandedIds.has(1)).toBe(true);
  });

  it('springt zur Aufgabe: Vorfahren aufklappen, Auswahl und Fokus-Request', async () => {
    const store = useProjectStore();
    const child = {
      id: 2,
      projectId: PROJECT_ID,
      parentId: 1,
      name: 'Kind',
      plannedStart: null,
      plannedEnd: null,
      estimatedMinutes: null,
      version: 1,
    };
    const parent = {
      id: 1,
      projectId: PROJECT_ID,
      parentId: null,
      name: 'Eltern',
      plannedStart: null,
      plannedEnd: null,
      estimatedMinutes: null,
      version: 1,
      children: [child],
    };
    apiMock.get.mockImplementation((path: string) => {
      if (path === `/projects/${PROJECT_ID}/tasks?tree=1`) {
        return Promise.resolve({ items: [parent] });
      }
      return Promise.resolve(apiResponse(path));
    });
    await store.load(PROJECT_ID);
    expect(store.expandedIds.has(1)).toBe(true);

    store.toggleExpanded(1); // zuklappen
    expect(store.expandedIds.has(1)).toBe(false);

    store.focusTask(2);

    expect(store.expandedIds.has(1)).toBe(true);
    expect(store.selectedTaskId).toBe(2);
    expect(store.focusRequest).toMatchObject({ taskId: 2 });
    expect(store.focusRequest?.nonce).toBeGreaterThan(0);
  });
});
