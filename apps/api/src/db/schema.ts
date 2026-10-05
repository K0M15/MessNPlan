import {
  bigint,
  boolean,
  datetime,
  date,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  smallint,
  text,
  time,
  uniqueIndex,
  varchar,
  type AnyMySqlColumn,
} from 'drizzle-orm/mysql-core';
import { sql } from 'drizzle-orm';
import type { WorkingHours } from '@projectplaner/shared';

const id = () => bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey();
const createdAt = () =>
  datetime('created_at', { mode: 'date', fsp: 3 })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP(3)`);
const updatedAt = () =>
  datetime('updated_at', { mode: 'date', fsp: 3 })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP(3)`)
    .$onUpdate(() => new Date());
const version = () => int('version').notNull().default(1);

// ---------------------------------------------------------------------------
// Benutzer & Auth
// ---------------------------------------------------------------------------

export const users = mysqlTable(
  'users',
  {
    id: id(),
    email: varchar('email', { length: 255 }).notNull(),
    passwordHash: varchar('password_hash', { length: 255 }).notNull(),
    name: varchar('name', { length: 160 }).notNull(),
    role: mysqlEnum('role', ['admin', 'planner', 'member', 'viewer']).notNull().default('member'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('users_email_uq').on(t.email)],
);

export const refreshTokens = mysqlTable(
  'refresh_tokens',
  {
    id: id(),
    userId: bigint('user_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    expiresAt: datetime('expires_at', { mode: 'date', fsp: 3 }).notNull(),
    revokedAt: datetime('revoked_at', { mode: 'date', fsp: 3 }),
    ip: varchar('ip', { length: 45 }),
    userAgent: varchar('user_agent', { length: 255 }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('refresh_tokens_hash_uq').on(t.tokenHash),
    index('refresh_tokens_user_idx').on(t.userId),
  ],
);

// ---------------------------------------------------------------------------
// Projekte
// ---------------------------------------------------------------------------

export const projects = mysqlTable(
  'projects',
  {
    id: id(),
    name: varchar('name', { length: 160 }).notNull(),
    description: text('description'),
    timezone: varchar('timezone', { length: 64 }).notNull().default('Europe/Berlin'),
    workweek: json('workweek').$type<number[]>().notNull(),
    workdayStart: time('workday_start').notNull(),
    workdayEnd: time('workday_end').notNull(),
    scheduleAnchor: date('schedule_anchor', { mode: 'string' }),
    status: mysqlEnum('status', ['active', 'archived']).notNull().default('active'),
    createdBy: bigint('created_by', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('projects_status_idx').on(t.status)],
);

export const holidays = mysqlTable(
  'holidays',
  {
    id: id(),
    projectId: bigint('project_id', { mode: 'number', unsigned: true }).references(() => projects.id, {
      onDelete: 'cascade',
    }),
    date: date('date', { mode: 'string' }).notNull(),
    name: varchar('name', { length: 160 }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('holidays_project_date_idx').on(t.projectId, t.date)],
);

export const projectMembers = mysqlTable(
  'project_members',
  {
    projectId: bigint('project_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: mysqlEnum('role', ['planner', 'member', 'viewer']).notNull().default('member'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.userId], name: 'project_members_pk' }),
    index('project_members_user_idx').on(t.userId),
  ],
);

export const projectApiKeys = mysqlTable(
  'project_api_keys',
  {
    id: id(),
    projectId: bigint('project_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 120 }).notNull(),
    /** OpenSSH-Public-Key in einzeiliger Form ("ssh-ed25519 AAAA… [comment]"). */
    publicKey: text('public_key').notNull(),
    keyType: mysqlEnum('key_type', ['ssh-ed25519', 'ssh-rsa']).notNull(),
    /** SHA256-Fingerprint wie `ssh-keygen -lf`, z. B. "SHA256:AbCd…". */
    fingerprint: varchar('fingerprint', { length: 160 }).notNull(),
    expiresAt: datetime('expires_at', { mode: 'date', fsp: 3 }),
    isActive: boolean('is_active').notNull().default(true),
    lastUsedAt: datetime('last_used_at', { mode: 'date', fsp: 3 }),
    createdBy: bigint('created_by', { mode: 'number', unsigned: true }).references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('project_api_keys_project_idx').on(t.projectId)],
);

// ---------------------------------------------------------------------------
// Aufgaben
// ---------------------------------------------------------------------------

export const tasks = mysqlTable(
  'tasks',
  {
    id: id(),
    projectId: bigint('project_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    parentId: bigint('parent_id', { mode: 'number', unsigned: true }).references(
      (): AnyMySqlColumn => tasks.id,
      { onDelete: 'cascade' },
    ),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    estimatedMinutes: int('estimated_minutes', { unsigned: true }),
    progress: smallint('progress').notNull().default(0),
    status: mysqlEnum('status', ['todo', 'in_progress', 'blocked', 'done']).notNull().default('todo'),
    priority: mysqlEnum('priority', ['low', 'normal', 'high', 'urgent']).notNull().default('normal'),
    constraintType: mysqlEnum('constraint_type', [
      'asap',
      'start_no_earlier_than',
      'start_on',
    ])
      .notNull()
      .default('asap'),
    constraintDate: datetime('constraint_date', { mode: 'date', fsp: 3 }),
    isMilestone: boolean('is_milestone').notNull().default(false),
    sortOrder: int('sort_order').notNull().default(0),
    plannedStart: datetime('planned_start', { mode: 'date', fsp: 3 }),
    plannedEnd: datetime('planned_end', { mode: 'date', fsp: 3 }),
    actualStart: datetime('actual_start', { mode: 'date', fsp: 3 }),
    actualEnd: datetime('actual_end', { mode: 'date', fsp: 3 }),
    scheduleVersion: int('schedule_version').notNull().default(0),
    createdBy: bigint('created_by', { mode: 'number', unsigned: true }).references(() => users.id, {
      onDelete: 'set null',
    }),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('tasks_project_idx').on(t.projectId),
    index('tasks_parent_idx').on(t.parentId),
    index('tasks_planned_idx').on(t.projectId, t.plannedStart),
  ],
);

export const taskDependencies = mysqlTable(
  'task_dependencies',
  {
    id: id(),
    projectId: bigint('project_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    predecessorId: bigint('predecessor_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    successorId: bigint('successor_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    type: mysqlEnum('type', ['FS', 'SS', 'FF', 'SF']).notNull().default('FS'),
    lagMinutes: int('lag_minutes').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('task_dependencies_uq').on(t.predecessorId, t.successorId),
    index('task_dependencies_successor_idx').on(t.successorId),
    index('task_dependencies_project_idx').on(t.projectId),
  ],
);

// ---------------------------------------------------------------------------
// Ressourcen & Zuteilungen
// ---------------------------------------------------------------------------

export const resources = mysqlTable(
  'resources',
  {
    id: id(),
    projectId: bigint('project_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number', unsigned: true }).references(() => users.id, {
      onDelete: 'set null',
    }),
    name: varchar('name', { length: 160 }).notNull(),
    type: mysqlEnum('type', ['person', 'machine']).notNull().default('person'),
    email: varchar('email', { length: 255 }),
    capacityMinutesPerDay: int('capacity_minutes_per_day').notNull().default(480),
    /** Wochentags-Arbeitszeiten (0=So … 6=Sa); null = Projekt-Arbeitszeiten erben. */
    workingHours: json('working_hours').$type<WorkingHours>(),
    color: varchar('color', { length: 7 }),
    isActive: boolean('is_active').notNull().default(true),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('resources_project_idx').on(t.projectId)],
);

export const absences = mysqlTable(
  'absences',
  {
    id: id(),
    resourceId: bigint('resource_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => resources.id, { onDelete: 'cascade' }),
    /** Inklusiver Zeitraum (YYYY-MM-DD in Projekt-Zeitzone). */
    startDate: date('start_date', { mode: 'string' }).notNull(),
    endDate: date('end_date', { mode: 'string' }).notNull(),
    type: mysqlEnum('type', ['vacation', 'sick', 'other']).notNull().default('vacation'),
    name: varchar('name', { length: 160 }),
    createdBy: bigint('created_by', { mode: 'number', unsigned: true }).references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('absences_resource_start_idx').on(t.resourceId, t.startDate)],
);

export const assignments = mysqlTable(
  'assignments',
  {
    id: id(),
    taskId: bigint('task_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    resourceId: bigint('resource_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => resources.id, { onDelete: 'cascade' }),
    allocationPercent: smallint('allocation_percent').notNull().default(100),
    plannedStart: datetime('planned_start', { mode: 'date', fsp: 3 }),
    plannedEnd: datetime('planned_end', { mode: 'date', fsp: 3 }),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('assignments_task_resource_uq').on(t.taskId, t.resourceId),
    index('assignments_resource_idx').on(t.resourceId, t.plannedStart),
  ],
);

// ---------------------------------------------------------------------------
// Tags & Kommentare
// ---------------------------------------------------------------------------

export const tags = mysqlTable(
  'tags',
  {
    id: id(),
    projectId: bigint('project_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 60 }).notNull(),
    color: varchar('color', { length: 7 }).notNull().default('#64748b'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('tags_project_name_uq').on(t.projectId, t.name)],
);

export const taskTags = mysqlTable(
  'task_tags',
  {
    taskId: bigint('task_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    tagId: bigint('tag_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.tagId], name: 'task_tags_pk' }),
    index('task_tags_tag_idx').on(t.tagId),
  ],
);

export const comments = mysqlTable(
  'comments',
  {
    id: id(),
    taskId: bigint('task_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number', unsigned: true }).references(() => users.id, {
      onDelete: 'set null',
    }),
    body: text('body').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('comments_task_idx').on(t.taskId)],
);

// ---------------------------------------------------------------------------
// Outlook / Microsoft Graph
// ---------------------------------------------------------------------------

export const outlookConnections = mysqlTable(
  'outlook_connections',
  {
    id: id(),
    userId: bigint('user_id', { mode: 'number', unsigned: true }).references(() => users.id, {
      onDelete: 'cascade',
    }),
    resourceId: bigint('resource_id', { mode: 'number', unsigned: true }).references(
      () => resources.id,
      { onDelete: 'cascade' },
    ),
    mailbox: varchar('mailbox', { length: 255 }).notNull(),
    tenantId: varchar('tenant_id', { length: 64 }),
    accessTokenEnc: text('access_token_enc'),
    refreshTokenEnc: text('refresh_token_enc'),
    expiresAt: datetime('expires_at', { mode: 'date', fsp: 3 }),
    scopes: varchar('scopes', { length: 500 }),
    syncEnabled: boolean('sync_enabled').notNull().default(true),
    status: mysqlEnum('status', ['connected', 'error', 'revoked'])
      .notNull()
      .default('connected'),
    lastError: text('last_error'),
    deltaLink: text('delta_link'),
    lastSyncAt: datetime('last_sync_at', { mode: 'date', fsp: 3 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('outlook_connections_user_uq').on(t.userId),
    uniqueIndex('outlook_connections_resource_uq').on(t.resourceId),
  ],
);

export const outlookEvents = mysqlTable(
  'outlook_events',
  {
    id: id(),
    assignmentId: bigint('assignment_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => assignments.id, { onDelete: 'cascade' }),
    connectionId: bigint('connection_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => outlookConnections.id, { onDelete: 'cascade' }),
    externalEventId: varchar('external_event_id', { length: 255 }).notNull(),
    etag: varchar('etag', { length: 255 }),
    syncState: mysqlEnum('sync_state', ['pending', 'synced', 'error', 'deleted'])
      .notNull()
      .default('pending'),
    lastSyncedAt: datetime('last_synced_at', { mode: 'date', fsp: 3 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('outlook_events_assignment_connection_uq').on(t.assignmentId, t.connectionId),
    index('outlook_events_external_idx').on(t.externalEventId),
  ],
);

// ---------------------------------------------------------------------------
// Infrastruktur (Outbox, Audit)
// ---------------------------------------------------------------------------

export const outboxJobs = mysqlTable(
  'outbox_jobs',
  {
    id: id(),
    type: varchar('type', { length: 64 }).notNull(),
    payload: json('payload').$type<Record<string, unknown>>().notNull(),
    status: mysqlEnum('status', ['pending', 'processing', 'done', 'failed'])
      .notNull()
      .default('pending'),
    attempts: int('attempts').notNull().default(0),
    nextAttemptAt: datetime('next_attempt_at', { mode: 'date', fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    lastError: text('last_error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('outbox_jobs_status_idx').on(t.status, t.nextAttemptAt)],
);

export const auditLog = mysqlTable(
  'audit_log',
  {
    id: id(),
    userId: bigint('user_id', { mode: 'number', unsigned: true }).references(() => users.id, {
      onDelete: 'set null',
    }),
    entityType: varchar('entity_type', { length: 64 }).notNull(),
    entityId: bigint('entity_id', { mode: 'number', unsigned: true }),
    action: varchar('action', { length: 32 }).notNull(),
    diff: json('diff').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [index('audit_log_entity_idx').on(t.entityType, t.entityId)],
);

export const schema = {
  users,
  refreshTokens,
  projects,
  holidays,
  projectMembers,
  projectApiKeys,
  tasks,
  taskDependencies,
  resources,
  absences,
  assignments,
  tags,
  taskTags,
  comments,
  outlookConnections,
  outlookEvents,
  outboxJobs,
  auditLog,
};
