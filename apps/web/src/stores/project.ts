import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { Socket } from 'socket.io-client';
import { REALTIME_EVENTS, type DependencyType } from '@projectplaner/shared';
import { ApiClientError, api } from '@/api/client';
import { connectSocket } from '@/api/socket';
import { useToasts } from '@/composables/useToasts';
import { useAuthStore } from '@/stores/auth';
import type {
  ApiKeyDto,
  CommentDto,
  DependencyDto,
  GanttPayloadDto,
  HealthDto,
  HolidayDto,
  MemberDto,
  OutlookConnectionsDto,
  ProjectDto,
  ProjectRole,
  ResourceDto,
  TagDto,
  TaskDto,
  UserLookupDto,
} from '@/types';

interface CreateTaskInput {
  parentId?: number | null;
  name: string;
  estimatedMinutes?: number | null;
  isMilestone?: boolean;
}

export const useProjectStore = defineStore('project', () => {
  const toasts = useToasts();
  const auth = useAuthStore();

  const projectId = ref<number | null>(null);
  const project = ref<ProjectDto | null>(null);
  const members = ref<MemberDto[]>([]);
  const holidays = ref<HolidayDto[]>([]);
  const taskTree = ref<TaskDto[]>([]);
  const resources = ref<ResourceDto[]>([]);
  const tags = ref<TagDto[]>([]);
  const schedule = ref<GanttPayloadDto | null>(null);
  const health = ref<HealthDto | null>(null);
  const outlook = ref<OutlookConnectionsDto | null>(null);
  const apiKeys = ref<ApiKeyDto[]>([]);
  const presence = ref<
    Array<{
      userId: number;
      name: string;
      role: string;
      selection?: { taskId: number | null };
    }>
  >([]);
  /** Fremd-Auswahl je User (userId → taskId). */
  const presenceSelections = ref<Map<number, number | null>>(new Map());
  const loading = ref(false);
  const error = ref<string | null>(null);

  const selectedTaskId = ref<number | null>(null);
  const expandedIds = ref<Set<number>>(new Set());

  let socket: Socket | null = null;
  let refreshTimer: number | undefined;

  const flatTasks = computed<TaskDto[]>(() => {
    const out: TaskDto[] = [];
    const walk = (nodes: TaskDto[]): void => {
      for (const node of nodes) {
        out.push(node);
        if (node.children && node.children.length > 0) walk(node.children);
      }
    };
    walk(taskTree.value);
    return out;
  });

  const taskById = computed(() => new Map(flatTasks.value.map((t) => [t.id, t])));
  const selectedTask = computed(() =>
    selectedTaskId.value !== null ? (taskById.value.get(selectedTaskId.value) ?? null) : null,
  );

  function handleError(err: unknown, fallback: string): string {
    if (err instanceof ApiClientError) {
      if (err.status === 409) {
        void refreshData();
        return 'Konflikt: Daten wurden zwischenzeitlich geändert, Ansicht wird aktualisiert.';
      }
      return err.problem?.detail ?? err.problem?.title ?? fallback;
    }
    return fallback;
  }

  async function load(id: number): Promise<void> {
    if (projectId.value !== id) {
      disconnectRealtime();
      projectId.value = id;
      selectedTaskId.value = null;
      expandedIds.value = new Set();
      apiKeys.value = [];
    }
    loading.value = true;
    error.value = null;
    try {
      const [projectRes, taskRes, resourceRes, tagRes, scheduleRes, healthRes, outlookRes] =
        await Promise.all([
          api.get<{ project: ProjectDto; members: MemberDto[] }>(`/projects/${id}`),
          api.get<{ items: TaskDto[] }>(`/projects/${id}/tasks?tree=1`),
          api.get<{ items: ResourceDto[] }>(`/projects/${id}/resources`),
          api.get<{ items: TagDto[] }>(`/projects/${id}/tags`),
          api.get<GanttPayloadDto>(`/projects/${id}/gantt`),
          api.get<HealthDto>(`/projects/${id}/health`),
          api.get<OutlookConnectionsDto>(`/projects/${id}/outlook/connections`),
        ]);
      project.value = projectRes.project;
      members.value = projectRes.members;
      taskTree.value = taskRes.items;
      resources.value = resourceRes.items;
      tags.value = tagRes.items;
      schedule.value = scheduleRes;
      health.value = healthRes;
      outlook.value = outlookRes;
      // Elternknoten initial aufklappen, damit die Struktur sichtbar ist.
      const parents = new Set<number>();
      const collect = (nodes: TaskDto[]): void => {
        for (const node of nodes) {
          if (node.children && node.children.length > 0) {
            parents.add(node.id);
            collect(node.children);
          }
        }
      };
      collect(taskTree.value);
      expandedIds.value = parents;
      connectRealtime(id);
    } catch (err) {
      error.value = handleError(err, 'Projekt konnte nicht geladen werden');
    } finally {
      loading.value = false;
    }
  }

  async function refreshTasks(): Promise<void> {
    if (projectId.value === null) return;
    const res = await api.get<{ items: TaskDto[] }>(`/projects/${projectId.value}/tasks?tree=1`);
    taskTree.value = res.items;
  }

  async function refreshSchedule(): Promise<void> {
    if (projectId.value === null) return;
    schedule.value = await api.get<GanttPayloadDto>(`/projects/${projectId.value}/gantt`);
  }

  async function refreshResources(): Promise<void> {
    if (projectId.value === null) return;
    const res = await api.get<{ items: ResourceDto[] }>(`/projects/${projectId.value}/resources`);
    resources.value = res.items;
  }

  async function refreshTags(): Promise<void> {
    if (projectId.value === null) return;
    const res = await api.get<{ items: TagDto[] }>(`/projects/${projectId.value}/tags`);
    tags.value = res.items;
  }

  // ---- Projekt, Mitglieder, Kalender --------------------------------------

  async function refreshProject(): Promise<void> {
    if (projectId.value === null) return;
    const res = await api.get<{ project: ProjectDto; members: MemberDto[] }>(
      `/projects/${projectId.value}`,
    );
    project.value = res.project;
    members.value = res.members;
  }

  async function refreshMembers(): Promise<void> {
    if (projectId.value === null) return;
    const res = await api.get<{ items: MemberDto[] }>(`/projects/${projectId.value}/members`);
    members.value = res.items;
  }

  async function lookupUsers(q: string): Promise<UserLookupDto[]> {
    try {
      const res = await api.get<{ items: UserLookupDto[] }>(
        `/users/lookup?q=${encodeURIComponent(q.trim())}`,
      );
      return res.items;
    } catch (err) {
      toasts.error(handleError(err, 'Nutzersuche fehlgeschlagen'));
      return [];
    }
  }

  async function addMember(userId: number, role: ProjectRole): Promise<boolean> {
    if (projectId.value === null) return false;
    try {
      await api.post(`/projects/${projectId.value}/members`, { userId, role });
      await refreshProject();
      return true;
    } catch (err) {
      toasts.error(handleError(err, 'Mitglied konnte nicht gespeichert werden'));
      return false;
    }
  }

  async function removeMember(userId: number): Promise<boolean> {
    if (projectId.value === null) return false;
    try {
      await api.del(`/projects/${projectId.value}/members/${userId}`);
      await refreshProject();
      return true;
    } catch (err) {
      toasts.error(handleError(err, 'Mitglied konnte nicht entfernt werden'));
      return false;
    }
  }

  async function updateProject(patch: Record<string, unknown>): Promise<boolean> {
    if (projectId.value === null || project.value === null) return false;
    try {
      await api.patch(`/projects/${projectId.value}`, patch, project.value.version);
      await refreshProject();
      scheduleRefresh();
      return true;
    } catch (err) {
      toasts.error(handleError(err, 'Projekt konnte nicht gespeichert werden'));
      return false;
    }
  }

  async function loadHolidays(): Promise<void> {
    if (projectId.value === null) return;
    const res = await api.get<{ items: HolidayDto[] }>(`/projects/${projectId.value}/holidays`);
    holidays.value = res.items;
  }

  async function createHoliday(dateISO: string, name: string): Promise<boolean> {
    if (projectId.value === null) return false;
    try {
      await api.post(`/projects/${projectId.value}/holidays`, { date: dateISO, name });
      await loadHolidays();
      scheduleRefresh();
      return true;
    } catch (err) {
      toasts.error(handleError(err, 'Feiertag konnte nicht angelegt werden'));
      return false;
    }
  }

  async function deleteHoliday(id: number): Promise<boolean> {
    if (projectId.value === null) return false;
    try {
      await api.del(`/projects/${projectId.value}/holidays/${id}`);
      await loadHolidays();
      scheduleRefresh();
      return true;
    } catch (err) {
      toasts.error(handleError(err, 'Feiertag konnte nicht gelöscht werden'));
      return false;
    }
  }

  // ---- API-Schlüssel (externer Zugang) ------------------------------------

  async function loadApiKeys(): Promise<void> {
    if (projectId.value === null) return;
    const res = await api.get<{ items: ApiKeyDto[] }>(`/projects/${projectId.value}/api-keys`);
    apiKeys.value = res.items;
  }

  async function createApiKey(input: {
    name: string;
    publicKey: string;
    expiresAt?: string | null;
  }): Promise<boolean> {
    if (projectId.value === null) return false;
    try {
      await api.post(`/projects/${projectId.value}/api-keys`, input);
      await loadApiKeys();
      return true;
    } catch (err) {
      toasts.error(handleError(err, 'API-Schlüssel konnte nicht angelegt werden'));
      return false;
    }
  }

  async function updateApiKey(
    id: number,
    patch: { name?: string; expiresAt?: string | null; isActive?: boolean },
  ): Promise<boolean> {
    try {
      await api.patch(`/api-keys/${id}`, patch);
      await loadApiKeys();
      return true;
    } catch (err) {
      toasts.error(handleError(err, 'API-Schlüssel konnte nicht geändert werden'));
      return false;
    }
  }

  async function deleteApiKey(id: number): Promise<boolean> {
    try {
      await api.del(`/api-keys/${id}`);
      await loadApiKeys();
      return true;
    } catch (err) {
      toasts.error(handleError(err, 'API-Schlüssel konnte nicht gelöscht werden'));
      return false;
    }
  }

  async function refreshHealth(): Promise<void> {
    if (projectId.value === null) return;
    health.value = await api.get<HealthDto>(`/projects/${projectId.value}/health`);
  }

  async function refreshData(): Promise<void> {
    try {
      await Promise.all([
        refreshTasks(),
        refreshSchedule(),
        refreshResources(),
        refreshHealth(),
        refreshOutlook(),
      ]);
    } catch {
      /* Folgefehler ignorieren */
    }
  }

  function scheduleRefresh(): void {
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => {
      void refreshData();
    }, 400);
  }

  function connectRealtime(id: number): void {
    socket = connectSocket();
    socket.emit('project:join', id);
    socket.on(REALTIME_EVENTS.SCHEDULE_UPDATED, () => scheduleRefresh());
    socket.on(REALTIME_EVENTS.TASK_CHANGED, () => scheduleRefresh());
    socket.on(REALTIME_EVENTS.PROJECT_CHANGED, () => scheduleRefresh());
    socket.on(
      REALTIME_EVENTS.PRESENCE_STATE,
      (
        users: Array<{
          userId: number;
          name: string;
          role: string;
          selection?: { taskId: number | null };
        }>,
      ) => applyPresenceState(users),
    );
    socket.on(
      REALTIME_EVENTS.PRESENCE_SELECTION,
      (payload: { userId: number; selection: { taskId: number | null } }) => {
        applyPresenceSelection(payload);
      },
    );
  }

  /** Übernimmt die vollständige Presence-Liste und räumt Auswahlen abwesender User auf. */
  function applyPresenceState(
    users: Array<{
      userId: number;
      name: string;
      role: string;
      selection?: { taskId: number | null };
    }>,
  ): void {
    presence.value = users;
    const next = new Map<number, number | null>();
    for (const user of users) {
      // Eigene Auswahl wird im Gantt bereits als eigene Markierung gezeigt.
      if (user.userId === auth.user?.id) continue;
      const taskId = user.selection?.taskId;
      if (taskId !== null && taskId !== undefined) next.set(user.userId, taskId);
    }
    presenceSelections.value = next;
  }

  function applyPresenceSelection(payload: {
    userId: number;
    selection: { taskId: number | null };
  }): void {
    if (payload.userId === auth.user?.id) return;
    const next = new Map(presenceSelections.value);
    if (payload.selection?.taskId === null || payload.selection?.taskId === undefined) {
      next.delete(payload.userId);
    } else {
      next.set(payload.userId, payload.selection.taskId);
    }
    presenceSelections.value = next;
  }

  function disconnectRealtime(): void {
    if (!socket) return;
    if (projectId.value !== null) socket.emit('project:leave', projectId.value);
    socket.off(REALTIME_EVENTS.SCHEDULE_UPDATED);
    socket.off(REALTIME_EVENTS.TASK_CHANGED);
    socket.off(REALTIME_EVENTS.PROJECT_CHANGED);
    socket.off(REALTIME_EVENTS.PRESENCE_STATE);
    socket.off(REALTIME_EVENTS.PRESENCE_SELECTION);
    socket = null;
    presence.value = [];
    presenceSelections.value = new Map();
  }

  function setSelection(taskId: number | null): void {
    selectedTaskId.value = taskId;
    if (socket && projectId.value !== null) {
      socket.emit('presence:selection', { projectId: projectId.value, taskId });
    }
  }

  function toggleExpanded(taskId: number): void {
    const next = new Set(expandedIds.value);
    if (next.has(taskId)) next.delete(taskId);
    else next.add(taskId);
    expandedIds.value = next;
  }

  // ---- Mutationen ---------------------------------------------------------

  async function createTask(input: CreateTaskInput): Promise<TaskDto | null> {
    if (projectId.value === null) return null;
    try {
      const res = await api.post<{ task: TaskDto }>(`/projects/${projectId.value}/tasks`, input);
      await refreshTasks();
      if (res.task.parentId) {
        const next = new Set(expandedIds.value);
        next.add(res.task.parentId);
        expandedIds.value = next;
      }
      setSelection(res.task.id);
      return res.task;
    } catch (err) {
      toasts.error(handleError(err, 'Aufgabe konnte nicht angelegt werden'));
      return null;
    }
  }

  async function updateTask(
    taskId: number,
    patch: Record<string, unknown>,
  ): Promise<boolean> {
    const task = taskById.value.get(taskId);
    if (!task) return false;
    try {
      await api.patch(`/tasks/${taskId}`, patch, task.version);
      await refreshTasks();
      return true;
    } catch (err) {
      toasts.error(handleError(err, 'Aufgabe konnte nicht gespeichert werden'));
      return false;
    }
  }

  async function deleteTask(taskId: number): Promise<boolean> {
    try {
      await api.del(`/tasks/${taskId}`);
      if (selectedTaskId.value === taskId) selectedTaskId.value = null;
      await refreshTasks();
      return true;
    } catch (err) {
      toasts.error(handleError(err, 'Aufgabe konnte nicht gelöscht werden'));
      return false;
    }
  }

  async function moveTask(
    taskId: number,
    parentId: number | null,
    sortOrder?: number,
    version?: number,
  ): Promise<boolean> {
    try {
      await api.post(`/tasks/${taskId}/move`, { parentId, sortOrder }, { version });
      await refreshTasks();
      return true;
    } catch (err) {
      toasts.error(handleError(err, 'Verschieben fehlgeschlagen'));
      return false;
    }
  }

  async function recompute(): Promise<void> {
    if (projectId.value === null) return;
    try {
      await api.post(`/projects/${projectId.value}/schedule`, {});
      await refreshData();
      toasts.success('Plan neu berechnet');
    } catch (err) {
      toasts.error(handleError(err, 'Neuberechnung fehlgeschlagen'));
    }
  }

  async function loadDependencies(taskId: number): Promise<{
    predecessors: DependencyDto[];
    successors: DependencyDto[];
  }> {
    return api.get(`/tasks/${taskId}/dependencies`);
  }

  async function addDependency(
    taskId: number,
    input: { predecessorId: number; successorId: number; type: DependencyType; lagMinutes: number },
  ): Promise<boolean> {
    try {
      await api.post(`/tasks/${taskId}/dependencies`, input);
      await refreshData();
      return true;
    } catch (err) {
      toasts.error(handleError(err, 'Abhängigkeit konnte nicht angelegt werden'));
      return false;
    }
  }

  async function updateDependency(
    id: number,
    input: { type?: DependencyType; lagMinutes?: number },
  ): Promise<boolean> {
    try {
      await api.patch(`/dependencies/${id}`, input);
      await refreshData();
      return true;
    } catch (err) {
      toasts.error(handleError(err, 'Abhängigkeit konnte nicht geändert werden'));
      return false;
    }
  }

  async function deleteDependency(id: number): Promise<boolean> {
    try {
      await api.del(`/dependencies/${id}`);
      await refreshData();
      return true;
    } catch (err) {
      toasts.error(handleError(err, 'Abhängigkeit konnte nicht gelöscht werden'));
      return false;
    }
  }

  async function assignResource(
    taskId: number,
    resourceId: number,
    allocationPercent: number,
  ): Promise<boolean> {
    try {
      await api.post(`/tasks/${taskId}/assignments`, { resourceId, allocationPercent });
      await refreshData();
      return true;
    } catch (err) {
      toasts.error(handleError(err, 'Zuteilung fehlgeschlagen'));
      return false;
    }
  }

  async function updateAssignment(
    id: number,
    allocationPercent: number,
    version?: number,
  ): Promise<boolean> {
    try {
      await api.patch(`/assignments/${id}`, { allocationPercent }, version);
      await refreshData();
      return true;
    } catch (err) {
      toasts.error(handleError(err, 'Zuteilung konnte nicht geändert werden'));
      return false;
    }
  }

  async function removeAssignment(id: number): Promise<boolean> {
    try {
      await api.del(`/assignments/${id}`);
      await refreshData();
      return true;
    } catch (err) {
      toasts.error(handleError(err, 'Zuteilung konnte nicht entfernt werden'));
      return false;
    }
  }

  async function setTaskTags(taskId: number, tagIds: number[]): Promise<boolean> {
    try {
      await api.put(`/tasks/${taskId}/tags`, { tagIds });
      await refreshData();
      return true;
    } catch (err) {
      toasts.error(handleError(err, 'Tags konnten nicht gespeichert werden'));
      return false;
    }
  }

  async function loadComments(taskId: number): Promise<CommentDto[]> {
    const res = await api.get<{ items: CommentDto[] }>(`/tasks/${taskId}/comments`);
    return res.items;
  }

  async function addComment(taskId: number, body: string): Promise<boolean> {
    try {
      await api.post(`/tasks/${taskId}/comments`, { body });
      await refreshTasks();
      return true;
    } catch (err) {
      toasts.error(handleError(err, 'Kommentar konnte nicht gespeichert werden'));
      return false;
    }
  }

  async function updateComment(id: number, body: string): Promise<boolean> {
    try {
      await api.patch(`/comments/${id}`, { body });
      return true;
    } catch (err) {
      toasts.error(handleError(err, 'Kommentar konnte nicht geändert werden'));
      return false;
    }
  }

  async function deleteComment(id: number): Promise<boolean> {
    try {
      await api.del(`/comments/${id}`);
      return true;
    } catch (err) {
      toasts.error(handleError(err, 'Kommentar konnte nicht gelöscht werden'));
      return false;
    }
  }

  async function createTag(name: string, color: string): Promise<TagDto | null> {
    if (projectId.value === null) return null;
    try {
      const res = await api.post<{ tag: TagDto }>(`/projects/${projectId.value}/tags`, {
        name,
        color,
      });
      await refreshTags();
      return res.tag;
    } catch (err) {
      toasts.error(handleError(err, 'Tag konnte nicht angelegt werden'));
      return null;
    }
  }

  async function createResource(input: Record<string, unknown>): Promise<boolean> {
    if (projectId.value === null) return false;
    try {
      await api.post(`/projects/${projectId.value}/resources`, input);
      await refreshResources();
      return true;
    } catch (err) {
      toasts.error(handleError(err, 'Ressource konnte nicht angelegt werden'));
      return false;
    }
  }

  async function updateResource(id: number, patch: Record<string, unknown>, version: number): Promise<boolean> {
    try {
      await api.patch(`/resources/${id}`, patch, version);
      await refreshResources();
      return true;
    } catch (err) {
      toasts.error(handleError(err, 'Ressource konnte nicht geändert werden'));
      return false;
    }
  }

  async function deleteResource(id: number): Promise<boolean> {
    try {
      await api.del(`/resources/${id}`);
      await refreshResources();
      return true;
    } catch (err) {
      toasts.error(handleError(err, 'Ressource konnte nicht gelöscht werden'));
      return false;
    }
  }

  // ---- Outlook ------------------------------------------------------------

  async function refreshOutlook(): Promise<void> {
    if (projectId.value === null) return;
    outlook.value = await api.get<OutlookConnectionsDto>(
      `/projects/${projectId.value}/outlook/connections`,
    );
  }

  async function connectOutlook(resourceId: number): Promise<void> {
    if (projectId.value === null) return;
    try {
      const res = await api.get<{ authorizeUrl: string }>(
        `/integrations/outlook/connect?resourceId=${resourceId}&projectId=${projectId.value}`,
      );
      window.location.href = res.authorizeUrl;
    } catch (err) {
      toasts.error(handleError(err, 'Outlook-Verbindung konnte nicht gestartet werden'));
    }
  }

  async function toggleOutlookSync(connectionId: number, enabled: boolean): Promise<boolean> {
    try {
      await api.patch(`/integrations/outlook/connections/${connectionId}`, { syncEnabled: enabled });
      await refreshOutlook();
      return true;
    } catch (err) {
      toasts.error(handleError(err, 'Outlook-Einstellung konnte nicht geändert werden'));
      return false;
    }
  }

  async function disconnectOutlook(connectionId: number): Promise<boolean> {
    try {
      await api.del(`/integrations/outlook/connections/${connectionId}`);
      await refreshOutlook();
      return true;
    } catch (err) {
      toasts.error(handleError(err, 'Outlook-Verbindung konnte nicht getrennt werden'));
      return false;
    }
  }

  async function syncOutlookNow(): Promise<void> {
    if (projectId.value === null) return;
    try {
      await api.post(`/projects/${projectId.value}/outlook/sync`, {});
      toasts.success('Outlook-Synchronisierung wurde angestoßen');
    } catch (err) {
      toasts.error(handleError(err, 'Synchronisierung konnte nicht gestartet werden'));
    }
  }

  const canWrite = computed(
    () => project.value?.myRole === 'admin' || project.value?.myRole === 'planner' || project.value?.myRole === 'member',
  );
  const canPlan = computed(
    () => project.value?.myRole === 'admin' || project.value?.myRole === 'planner',
  );

  return {
    projectId,
    project,
    members,
    holidays,
    taskTree,
    flatTasks,
    taskById,
    resources,
    tags,
    schedule,
    health,
    loading,
    error,
    outlook,
    presence,
    presenceSelections,
    selectedTaskId,
    selectedTask,
    expandedIds,
    canWrite,
    canPlan,
    load,
    refreshData,
    refreshTasks,
    refreshSchedule,
    refreshHealth,
    refreshTags,
    refreshProject,
    refreshMembers,
    lookupUsers,
    addMember,
    removeMember,
    updateProject,
    loadHolidays,
    createHoliday,
    deleteHoliday,
    apiKeys,
    loadApiKeys,
    createApiKey,
    updateApiKey,
    deleteApiKey,
    setSelection,
    toggleExpanded,
    createTask,
    updateTask,
    deleteTask,
    moveTask,
    recompute,
    loadDependencies,
    addDependency,
    updateDependency,
    deleteDependency,
    assignResource,
    updateAssignment,
    removeAssignment,
    setTaskTags,
    loadComments,
    addComment,
    updateComment,
    deleteComment,
    createTag,
    createResource,
    updateResource,
    deleteResource,
    refreshOutlook,
    connectOutlook,
    toggleOutlookSync,
    disconnectOutlook,
    syncOutlookNow,
    disconnectRealtime,
  };
});
