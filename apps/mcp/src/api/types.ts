import type {
  ConstraintType,
  DependencyType,
  Priority,
  TaskStatus,
} from '@projectplaner/shared';

// ---------------------------------------------------------------------------
// JSON-freundliche Eingaben (die API validiert zusätzlich per Zod)
// ---------------------------------------------------------------------------

export interface CreateTaskPayload {
  name: string;
  parentId?: number | null;
  description?: string | null;
  estimatedMinutes?: number | null;
  status?: TaskStatus;
  priority?: Priority;
  constraintType?: ConstraintType;
  constraintDate?: string | null;
  isMilestone?: boolean;
}

export interface CreateDependencyPayload {
  predecessorId: number;
  successorId: number;
  type?: DependencyType;
  lagMinutes?: number;
}

export interface CreateAssignmentPayload {
  resourceId: number;
  allocationPercent?: number;
}

// ---------------------------------------------------------------------------
// DTOs (nur die Felder, die der MCP-Server tatsächlich auswertet)
// ---------------------------------------------------------------------------

export interface ProjectDto {
  id: number;
  name: string;
  description?: string | null;
  status?: string;
  timezone?: string;
  workweek?: number[];
  workdayStart?: string;
  workdayEnd?: string;
  scheduleAnchor?: string | null;
  version?: number;
  myRole?: string | null;
}

export interface TagDto {
  id: number;
  name: string;
  color: string;
}

export interface AssignmentDto {
  id: number;
  resourceId: number;
  resourceName?: string;
  resourceType?: 'person' | 'machine';
  allocationPercent: number;
  plannedStart?: string | null;
  plannedEnd?: string | null;
}

export interface TaskDto {
  id: number;
  projectId: number;
  parentId: number | null;
  name: string;
  description?: string | null;
  estimatedMinutes: number | null;
  status: string;
  priority?: string;
  constraintType: string;
  constraintDate?: string | null;
  isMilestone: boolean;
  sortOrder?: number;
  progress?: number;
  plannedStart?: string | null;
  plannedEnd?: string | null;
  tags?: TagDto[];
  assignments?: AssignmentDto[];
}

export interface ResourceDto {
  id: number;
  name: string;
  type: 'person' | 'machine';
  email?: string | null;
  capacityMinutesPerDay: number;
  isActive: boolean;
  openAssignmentCount?: number;
}

export interface DependencyDto {
  id: number;
  predecessorId: number;
  successorId: number;
  type: string;
  lagMinutes: number;
  predecessorName?: string;
  successorName?: string;
}

export interface ScheduleComputeResult {
  projectId: number;
  version: number;
  taskCount: number;
  cyclicCount: number;
  computedAt: string;
}

export interface HealthIssueDto {
  rule: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  taskId?: number;
  resourceId?: number;
  details?: Record<string, unknown>;
}

export interface HealthPayload {
  issues: HealthIssueDto[];
  summary: { error: number; warning: number; info: number; total: number };
}

export interface GanttTaskDto {
  id: number;
  parentId: number | null;
  name: string;
  estimatedMinutes: number | null;
  isMilestone: boolean;
  status: string;
  progress: number;
  plannedStart: string | null;
  plannedEnd: string | null;
  critical: boolean;
  slackMinutes: number;
}

export interface UtilizationBucketDto {
  resourceId: number;
  start: string;
  allocatedMinutes: number;
  capacityMinutes: number;
}

export interface GanttPayload {
  project: { id: number; name: string; timezone: string; version: number };
  version: number;
  tasks: GanttTaskDto[];
  edges: Array<{ id: number; predecessorId: number; successorId: number; type: string; lagMinutes: number }>;
  resources: Array<{ id: number; name: string; type: 'person' | 'machine'; capacityMinutesPerDay: number }>;
  assignments: Array<{ id: number; taskId: number; resourceId: number; allocationPercent: number }>;
  utilization?: {
    from: string;
    to: string;
    bucketMinutes: number;
    buckets: UtilizationBucketDto[];
  };
}

export interface GanttQuery {
  from?: string;
  to?: string;
}

// ---------------------------------------------------------------------------
// TaskApi – austauschbarer Zugriffsweg auf die ProjectPlaner-API
// ---------------------------------------------------------------------------

/**
 * Zugriffsweg auf die ProjectPlaner-REST-API.
 *
 * Es gibt zwei Implementierungen:
 * - `RestSessionApi`: Service-Login per E-Mail/Passwort (Cookie-Session mit
 *   401-Refresh). Kann lesen und schreiben.
 * - `SshSignedApi`: SSH-signierte externe API (`/api/v1/external`). Kann nur
 *   Aufgabe, Abhängigkeit und Zuteilung anlegen; Lesen wirft
 *   `UnsupportedOperationError`.
 */
export interface TaskApi {
  readonly kind: 'rest' | 'ssh';
  listProjects(): Promise<ProjectDto[]>;
  getProject(projectId: number): Promise<{ project: ProjectDto; members: unknown[] }>;
  listTasks(projectId: number): Promise<TaskDto[]>;
  listResources(projectId: number): Promise<ResourceDto[]>;
  createTask(projectId: number, input: CreateTaskPayload): Promise<{ task: TaskDto }>;
  addDependency(
    projectId: number,
    input: CreateDependencyPayload,
  ): Promise<{ dependency: DependencyDto }>;
  assignResource(
    projectId: number,
    taskId: number,
    input: CreateAssignmentPayload,
  ): Promise<{ assignment: AssignmentDto }>;
  computeSchedule(projectId: number): Promise<{ result: ScheduleComputeResult }>;
  getHealth(projectId: number): Promise<HealthPayload>;
  getGantt(projectId: number, query?: GanttQuery): Promise<GanttPayload>;
}

// ---------------------------------------------------------------------------
// Fehler
// ---------------------------------------------------------------------------

/** Fehler der ProjectPlaner-API (RFC 7807). */
export class ApiError extends Error {
  readonly status: number;
  readonly problem: unknown;

  constructor(status: number, problem: unknown) {
    const detail =
      problem !== null && typeof problem === 'object' && 'detail' in problem
        ? String((problem as { detail?: unknown }).detail ?? '')
        : '';
    const title =
      problem !== null && typeof problem === 'object' && 'title' in problem
        ? String((problem as { title?: unknown }).title ?? '')
        : '';
    super(detail || title || `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.problem = problem;
  }
}

/** Operation wird vom gewählten Zugriffsweg (SSH-Client) nicht unterstützt. */
export class UnsupportedOperationError extends Error {
  constructor(operation: string) {
    super(
      `${operation} ist mit dem SSH-signierten Zugriffsweg nicht verfügbar – ` +
        'dafür PP_EMAIL/PP_PASSWORD (Service-Login) konfigurieren',
    );
    this.name = 'UnsupportedOperationError';
  }
}
