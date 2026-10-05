import type {
  AbsenceType,
  HealthSeverity,
  ProjectRole,
  Role,
  DependencyType,
  WorkingHours,
} from '@projectplaner/shared';

export type { AbsenceType, HealthSeverity, ProjectRole, Role, DependencyType, WorkingHours };

export interface UserDto {
  id: number;
  email: string;
  name: string;
  role: Role;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectDto {
  id: number;
  name: string;
  description: string | null;
  timezone: string;
  workweek: number[];
  workdayStart: string;
  workdayEnd: string;
  scheduleAnchor: string | null;
  status: 'active' | 'archived';
  createdBy: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  myRole: ProjectRole | 'admin' | null;
}

export interface MemberDto {
  userId: number;
  role: ProjectRole;
  name: string;
  email: string;
}

export interface UserLookupDto {
  id: number;
  name: string;
  email: string;
}

export interface HolidayDto {
  id: number;
  projectId: number | null;
  date: string;
  name: string;
  createdAt: string;
}

export interface TagDto {
  id: number;
  name: string;
  color: string;
  usageCount?: number;
}

export interface ApiKeyDto {
  id: number;
  projectId: number;
  name: string;
  keyType: 'ssh-ed25519' | 'ssh-rsa';
  fingerprint: string;
  expiresAt: string | null;
  isActive: boolean;
  lastUsedAt: string | null;
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface AssignmentDto {
  id: number;
  resourceId: number;
  resourceName: string;
  resourceType: 'person' | 'machine';
  allocationPercent: number;
  plannedStart: string | null;
  plannedEnd: string | null;
  version?: number;
}

export interface TaskDto {
  id: number;
  projectId: number;
  parentId: number | null;
  name: string;
  description: string | null;
  estimatedMinutes: number | null;
  progress: number;
  status: 'todo' | 'in_progress' | 'blocked' | 'done';
  priority: 'low' | 'normal' | 'high' | 'urgent';
  constraintType: 'asap' | 'start_no_earlier_than' | 'start_on';
  constraintDate: string | null;
  isMilestone: boolean;
  sortOrder: number;
  plannedStart: string | null;
  plannedEnd: string | null;
  actualStart: string | null;
  actualEnd: string | null;
  scheduleVersion: number;
  version: number;
  tags?: TagDto[];
  assignments?: AssignmentDto[];
  children?: TaskDto[];
}

export interface DependencyDto {
  id: number;
  predecessorId: number;
  successorId: number;
  type: DependencyType;
  lagMinutes: number;
  predecessorName: string;
  successorName: string;
}

export interface CommentDto {
  id: number;
  taskId: number;
  userId: number | null;
  userName: string | null;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface ResourceDto {
  id: number;
  projectId: number;
  userId: number | null;
  name: string;
  type: 'person' | 'machine';
  email: string | null;
  capacityMinutesPerDay: number;
  /** Wochentags-Arbeitszeiten (0=So … 6=Sa); null = Projektzeiten erben. */
  workingHours: WorkingHours | null;
  color: string | null;
  isActive: boolean;
  version: number;
  openAssignmentCount?: number;
}

export interface AbsenceDto {
  id: number;
  resourceId: number;
  startDate: string;
  endDate: string;
  type: AbsenceType;
  name: string | null;
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
}

/** Abwesenheit im Gantt-Payload (ohne Audit-Felder). */
export interface GanttAbsenceDto {
  id: number;
  resourceId: number;
  startDate: string;
  endDate: string;
  type: AbsenceType;
  name: string | null;
}

export interface ScheduleTaskDto {
  id: number;
  parentId: number | null;
  name: string;
  estimatedMinutes: number | null;
  isMilestone: boolean;
  status: TaskDto['status'];
  progress: number;
  constraintType: TaskDto['constraintType'];
  constraintDate: string | null;
  plannedStart: string | null;
  plannedEnd: string | null;
  scheduleVersion: number;
  critical: boolean;
  slackMinutes: number;
}

export interface SchedulePayloadDto {
  project: {
    id: number;
    name: string;
    timezone: string;
    workweek: number[];
    workdayStart: string;
    workdayEnd: string;
    scheduleAnchor: string | null;
    version: number;
  };
  version: number;
  tasks: ScheduleTaskDto[];
  edges: Array<{
    id: number;
    predecessorId: number;
    successorId: number;
    type: DependencyType;
    lagMinutes: number;
  }>;
  resources: Array<{
    id: number;
    name: string;
    type: 'person' | 'machine';
    color: string | null;
    capacityMinutesPerDay: number;
    email: string | null;
  }>;
  assignments: Array<{
    id: number;
    taskId: number;
    resourceId: number;
    allocationPercent: number;
    plannedStart: string | null;
    plannedEnd: string | null;
  }>;
}

export interface UtilizationBucketDto {
  resourceId: number;
  start: string;
  allocatedMinutes: number;
  capacityMinutes: number;
}

export interface UtilizationDto {
  from: string;
  to: string;
  bucketMinutes: number;
  buckets: UtilizationBucketDto[];
}

export interface GanttPayloadDto extends SchedulePayloadDto {
  utilization: UtilizationDto;
  absences: GanttAbsenceDto[];
}

export interface HealthIssueDto {
  rule: string;
  severity: HealthSeverity;
  message: string;
  taskId?: number;
  resourceId?: number;
  details?: Record<string, unknown>;
}

export interface HealthDto {
  issues: HealthIssueDto[];
  summary: { error: number; warning: number; info: number; total: number };
}

export interface OutlookConnectionDto {
  id: number;
  resourceId: number | null;
  resourceName: string | null;
  mailbox: string;
  status: 'connected' | 'error' | 'revoked';
  syncEnabled: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
}

export interface OutlookConnectionsDto {
  configured: boolean;
  items: OutlookConnectionDto[];
}
