/** Domänenkonstanten – von API und Web gemeinsam genutzt. */

export const ROLES = ['admin', 'planner', 'member', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const PROJECT_ROLES = ['planner', 'member', 'viewer'] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

export const TASK_STATUSES = ['todo', 'in_progress', 'blocked', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const DEPENDENCY_TYPES = ['FS', 'SS', 'FF', 'SF'] as const;
export type DependencyType = (typeof DEPENDENCY_TYPES)[number];

export const DEPENDENCY_TYPE_LABELS: Record<DependencyType, string> = {
  FS: 'Ende → Start',
  SS: 'Start → Start',
  FF: 'Ende → Ende',
  SF: 'Start → Ende',
};

export const CONSTRAINT_TYPES = ['asap', 'start_no_earlier_than', 'start_on'] as const;
export type ConstraintType = (typeof CONSTRAINT_TYPES)[number];

export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const RESOURCE_TYPES = ['person', 'machine'] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

export const PROJECT_STATUSES = ['active', 'archived'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const OUTLOOK_SYNC_STATES = ['pending', 'synced', 'error', 'deleted'] as const;
export type OutlookSyncState = (typeof OUTLOOK_SYNC_STATES)[number];

export const HEALTH_SEVERITIES = ['error', 'warning', 'info'] as const;
export type HealthSeverity = (typeof HEALTH_SEVERITIES)[number];

/** Regelcodes der „fertig geplant"-Prüfung. */
export const HEALTH_RULES = {
  MISSING_ESTIMATE: 'missing_estimate',
  NO_RESOURCE: 'no_resource',
  ORPHAN_TASK: 'orphan_task',
  DEPENDENCY_CYCLE: 'dependency_cycle',
  OVERDUE: 'overdue',
  RESOURCE_OVERALLOCATED: 'resource_overallocated',
  PARENT_CHILD_MISMATCH: 'parent_child_mismatch',
  MILESTONE_WITHOUT_DATE: 'milestone_without_date',
  RESOURCE_WITHOUT_EMAIL: 'resource_without_email',
} as const;
export type HealthRule = (typeof HEALTH_RULES)[keyof typeof HEALTH_RULES];

/** Minuten pro Arbeitstag (Standard) – 8h. */
export const DEFAULT_CAPACITY_MINUTES_PER_DAY = 480;

/** Default-Arbeitswoche: Mo–Fr. */
export const DEFAULT_WORKWEEK = [1, 2, 3, 4, 5] as const;

export const DEFAULT_TIMEZONE = 'Europe/Berlin';

/** Socket.IO-Events (Server → Client). */
export const REALTIME_EVENTS = {
  SCHEDULE_UPDATED: 'schedule:updated',
  TASK_CHANGED: 'task:changed',
  PROJECT_CHANGED: 'project:changed',
  PRESENCE_STATE: 'presence:state',
  PRESENCE_SELECTION: 'presence:selection',
} as const;

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;
