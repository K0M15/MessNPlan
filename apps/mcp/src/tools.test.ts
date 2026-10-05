import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from './server.js';
import { TOOL_NAMES } from './tools.js';
import {
  ApiError,
  UnsupportedOperationError,
  type GanttPayload,
  type ProjectDto,
  type ResourceDto,
  type TaskApi,
  type TaskDto,
} from './api/types.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function project(overrides: Partial<ProjectDto> = {}): ProjectDto {
  return {
    id: 1,
    name: 'Projekt A',
    status: 'active',
    timezone: 'Europe/Berlin',
    workweek: [1, 2, 3, 4, 5],
    workdayStart: '08:00',
    workdayEnd: '16:00',
    version: 1,
    myRole: 'planner',
    ...overrides,
  };
}

function task(overrides: Partial<TaskDto> = {}): TaskDto {
  return {
    id: 1,
    projectId: 1,
    parentId: null,
    name: 'Aufgabe',
    estimatedMinutes: 60,
    status: 'todo',
    priority: 'normal',
    constraintType: 'asap',
    constraintDate: null,
    isMilestone: false,
    sortOrder: 1,
    ...overrides,
  };
}

function ganttPayload(overrides: Partial<GanttPayload> = {}): GanttPayload {
  return {
    project: { id: 1, name: 'Projekt A', timezone: 'Europe/Berlin', version: 1 },
    version: 3,
    tasks: [
      {
        id: 1,
        parentId: null,
        name: 'A',
        estimatedMinutes: 60,
        isMilestone: false,
        status: 'todo',
        progress: 0,
        plannedStart: '2026-01-05T08:00:00.000Z',
        plannedEnd: '2026-01-05T09:00:00.000Z',
        critical: true,
        slackMinutes: 0,
      },
    ],
    edges: [],
    resources: [{ id: 1, name: 'Anna', type: 'person', capacityMinutesPerDay: 480 }],
    assignments: [{ id: 1, taskId: 1, resourceId: 1, allocationPercent: 100 }],
    utilization: {
      from: '2026-01-05T08:00:00.000Z',
      to: '2026-01-05T10:00:00.000Z',
      bucketMinutes: 60,
      buckets: [
        { resourceId: 1, start: '2026-01-05T08:00:00.000Z', allocatedMinutes: 480, capacityMinutes: 240 },
        { resourceId: 1, start: '2026-01-05T09:00:00.000Z', allocatedMinutes: 120, capacityMinutes: 240 },
      ],
    },
    ...overrides,
  };
}

function fakeApi(overrides: Partial<TaskApi> = {}): TaskApi {
  return {
    kind: 'rest',
    listProjects: vi.fn(async () => [project()]),
    getProject: vi.fn(async (id: number) => ({ project: project({ id }), members: [] })),
    listTasks: vi.fn(async () => [] as TaskDto[]),
    listResources: vi.fn(async () => [] as ResourceDto[]),
    createTask: vi.fn(async (_projectId: number, input: { name: string }) => ({
      task: task({ name: input.name }),
    })),
    addDependency: vi.fn(async () => ({
      dependency: {
        id: 1,
        predecessorId: 1,
        successorId: 2,
        type: 'FS',
        lagMinutes: 0,
      },
    })),
    assignResource: vi.fn(async () => ({
      assignment: { id: 1, resourceId: 5, allocationPercent: 100 },
    })),
    computeSchedule: vi.fn(async () => ({
      result: { projectId: 1, version: 2, taskCount: 3, cyclicCount: 0, computedAt: 'x' },
    })),
    getHealth: vi.fn(async () => ({
      issues: [],
      summary: { error: 0, warning: 0, info: 0, total: 0 },
    })),
    getGantt: vi.fn(async () => ganttPayload()),
    ...overrides,
  };
}

async function connect(api: TaskApi) {
  const server = createMcpServer(api);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(clientTransport);
  return { client, server };
}

interface ToolResponse {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
}

function parseJson(response: ToolResponse): unknown {
  const first = response.content[0];
  if (!first || first.type !== 'text' || first.text === undefined) {
    throw new Error('Keine Textantwort');
  }
  return JSON.parse(first.text);
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResponse> {
  return (await client.callTool({ name, arguments: args })) as unknown as ToolResponse;
}

// ---------------------------------------------------------------------------

describe('MCP-Tools', () => {
  it('registriert genau die neun erwarteten Tools', async () => {
    const { client, server } = await connect(fakeApi());
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
    await server.close();
  });

  it('list_projects liefert kompakte Projektfelder', async () => {
    const { client } = await connect(fakeApi());
    const result = await callTool(client, 'list_projects', {});
    expect(result.isError).toBeUndefined();
    expect(parseJson(result)).toEqual({
      projects: [
        {
          id: 1,
          name: 'Projekt A',
          status: 'active',
          timezone: 'Europe/Berlin',
          myRole: 'planner',
        },
      ],
    });
  });

  it('get_project bündelt Projekt, Aufgaben und Ressourcen', async () => {
    const api = fakeApi({
      listTasks: vi.fn(async () => [task({ id: 1 }), task({ id: 2, parentId: 1 })]),
      listResources: vi.fn(
        async (): Promise<ResourceDto[]> => [
          { id: 5, name: 'Anna', type: 'person', capacityMinutesPerDay: 480, isActive: true },
        ],
      ),
    });
    const { client } = await connect(api);
    const result = parseJson(await callTool(client, 'get_project', { projectId: 1 })) as {
      taskCount: number;
      tasks: Array<{ id: number }>;
      resources: Array<{ id: number }>;
    };
    expect(result.taskCount).toBe(2);
    expect(result.tasks.map((t) => t.id)).toEqual([1, 2]);
    expect(result.resources.map((r) => r.id)).toEqual([5]);
  });

  it('list_tasks filtert und ergänzt Eltern im Baum', async () => {
    const tasks = [
      task({ id: 1, name: 'Wurzel A' }),
      task({ id: 2, name: 'Kind A1', parentId: 1, status: 'done' }),
      task({ id: 3, name: 'Wurzel B', status: 'done' }),
      task({ id: 4, name: 'Kind A2', parentId: 1, status: 'todo' }),
    ];
    const api = fakeApi({ listTasks: vi.fn(async () => tasks) });
    const { client } = await connect(api);

    const result = parseJson(
      await callTool(client, 'list_tasks', { projectId: 1, status: 'done' }),
    ) as {
      mode: string;
      items: Array<{ id: number; children: Array<{ id: number }> }>;
    };

    expect(result.mode).toBe('tree');
    // Treffer sind 2 und 3; Elternknoten 1 wird als Träger ergänzt.
    expect(result.items.map((item) => item.id)).toEqual([1, 3]);
    expect(result.items[0]!.children.map((child) => child.id)).toEqual([2]);
  });

  it('list_tasks kürzt flache Ausgaben und meldet truncated', async () => {
    const tasks = [1, 2, 3, 4].map((id) => task({ id }));
    const api = fakeApi({ listTasks: vi.fn(async () => tasks) });
    const { client } = await connect(api);

    const result = parseJson(
      await callTool(client, 'list_tasks', { projectId: 1, tree: false, limit: 2 }),
    ) as { totalCount: number; returned: number; truncated: boolean };
    expect(result).toMatchObject({ totalCount: 4, returned: 2, truncated: true });
  });

  it('create_task reicht Felder durch und liefert die kompakte Aufgabe', async () => {
    const api = fakeApi();
    const { client } = await connect(api);
    const response = await callTool(client, 'create_task', {
      projectId: 1,
      name: 'Neu',
      parentId: 2,
      estimatedMinutes: 90,
      constraintType: 'start_no_earlier_than',
      constraintDate: '2026-02-01T08:00:00Z',
    });

    expect(response.isError).toBeUndefined();
    expect(api.createTask).toHaveBeenCalledWith(1, {
      name: 'Neu',
      parentId: 2,
      estimatedMinutes: 90,
      constraintType: 'start_no_earlier_than',
      constraintDate: '2026-02-01T08:00:00Z',
    });
    expect(parseJson(response)).toMatchObject({ task: { name: 'Neu' } });
  });

  it('add_dependency und assign_resource nutzen Standardwerte', async () => {
    const api = fakeApi();
    const { client } = await connect(api);

    await callTool(client, 'add_dependency', { projectId: 1, predecessorId: 1, successorId: 2 });
    expect(api.addDependency).toHaveBeenCalledWith(1, {
      predecessorId: 1,
      successorId: 2,
      type: 'FS',
      lagMinutes: 0,
    });

    await callTool(client, 'assign_resource', { projectId: 1, taskId: 2, resourceId: 5 });
    expect(api.assignResource).toHaveBeenCalledWith(1, 2, {
      resourceId: 5,
      allocationPercent: 100,
    });
  });

  it('get_health filtert nach Severity und kürzt', async () => {
    const issues = [
      { rule: 'missing_estimate', severity: 'error' as const, message: 'E1', taskId: 1 },
      { rule: 'no_resource', severity: 'warning' as const, message: 'W1', taskId: 2 },
      { rule: 'overdue', severity: 'warning' as const, message: 'W2', taskId: 3 },
    ];
    const api = fakeApi({
      getHealth: vi.fn(async () => ({
        issues,
        summary: { error: 1, warning: 2, info: 0, total: 3 },
      })),
    });
    const { client } = await connect(api);

    const result = parseJson(
      await callTool(client, 'get_health', { projectId: 1, severity: 'warning', limit: 1 }),
    ) as { totalCount: number; truncated: boolean; issues: Array<{ message: string }> };
    expect(result.totalCount).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.issues.map((issue) => issue.message)).toEqual(['W1']);
  });

  it('get_gantt_summary aggregiert Auslastung und kritische Aufgaben', async () => {
    const { client } = await connect(fakeApi());
    const result = parseJson(await callTool(client, 'get_gantt_summary', { projectId: 1 })) as {
      taskCount: number;
      criticalTaskCount: number;
      utilization: { maxUtilizationPercent: number; overloadedResources: unknown[] };
    };
    expect(result.taskCount).toBe(1);
    expect(result.criticalTaskCount).toBe(1);
    expect(result.utilization.maxUtilizationPercent).toBe(200);
    expect(result.utilization.overloadedResources).toHaveLength(1);
  });

  it('liefert bei nicht unterstützten SSH-Operationen einen Tool-Fehler', async () => {
    const sshApi = fakeApi({
      kind: 'ssh',
      listProjects: vi.fn(() => {
        throw new UnsupportedOperationError('list_projects');
      }),
    });
    const { client } = await connect(sshApi);
    const response = await callTool(client, 'list_projects', {});
    expect(response.isError).toBe(true);
    expect(response.content[0]?.text).toContain('nicht verfügbar');
  });

  it('verpackt API-Fehler mit Status und Detail', async () => {
    const api = fakeApi({
      createTask: vi.fn(async () => {
        throw new ApiError(409, { title: 'Conflict', detail: 'Duplikat' });
      }),
    });
    const { client } = await connect(api);
    const response = await callTool(client, 'create_task', { projectId: 1, name: 'X' });
    expect(response.isError).toBe(true);
    expect(response.content[0]?.text).toBe('HTTP 409: Duplikat');
  });
});
