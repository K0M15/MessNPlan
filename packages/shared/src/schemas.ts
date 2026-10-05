import { z } from 'zod';
import {
  CONSTRAINT_TYPES,
  DEFAULT_CAPACITY_MINUTES_PER_DAY,
  DEFAULT_PAGE_SIZE,
  DEFAULT_TIMEZONE,
  DEPENDENCY_TYPES,
  MAX_PAGE_SIZE,
  PRIORITIES,
  PROJECT_ROLES,
  PROJECT_STATUSES,
  RESOURCE_TYPES,
  ROLES,
  TASK_STATUSES,
} from './constants.js';

export const idSchema = z.coerce.number().int().positive();

const timeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Format HH:MM oder HH:MM:SS');

const colorSchema = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{6})$/, 'Hex-Farbe erwartet, z. B. #3b82f6');

const emptyToUndefined = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === '' || v === null ? undefined : v), schema.optional());

// ---------------------------------------------------------------------------
// Auth / Benutzer
// ---------------------------------------------------------------------------

export const loginSchema = z.object({
  email: z.string().email().max(255).transform((v) => v.trim().toLowerCase()),
  password: z.string().min(1).max(200),
});

export const passwordSchema = z.string().min(10, 'Mindestens 10 Zeichen').max(200);

export const createUserSchema = z.object({
  email: z.string().email().max(255).transform((v) => v.trim().toLowerCase()),
  name: z.string().min(1).max(160),
  password: passwordSchema,
  role: z.enum(ROLES).default('member'),
});

export const updateUserSchema = z
  .object({
    email: z.string().email().max(255).transform((v) => v.trim().toLowerCase()),
    name: z.string().min(1).max(160),
    password: passwordSchema,
    role: z.enum(ROLES),
    isActive: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Mindestens ein Feld angeben');

// ---------------------------------------------------------------------------
// Projekte
// ---------------------------------------------------------------------------

export const projectCreateSchema = z.object({
  name: z.string().min(1).max(160),
  description: z.string().max(10_000).nullish(),
  timezone: z.string().min(1).max(64).default(DEFAULT_TIMEZONE),
  workweek: z.array(z.number().int().min(0).max(6)).min(1).max(7).default([1, 2, 3, 4, 5]),
  workdayStart: timeSchema.default('08:00'),
  workdayEnd: timeSchema.default('16:00'),
  scheduleAnchor: z.coerce.date().nullish(),
  status: z.enum(PROJECT_STATUSES).default('active'),
});

export const projectUpdateSchema = projectCreateSchema.partial();

export const projectMemberSchema = z.object({
  userId: idSchema,
  role: z.enum(PROJECT_ROLES).default('member'),
});

export const projectDeleteSchema = z.object({
  name: z.string().min(1).max(160),
});

export const holidayCreateSchema = z.object({
  date: z.coerce.date(),
  name: z.string().min(1).max(160),
});

// ---------------------------------------------------------------------------
// Aufgaben
// ---------------------------------------------------------------------------

export const taskCreateSchema = z.object({
  parentId: idSchema.nullish(),
  name: z.string().min(1).max(255),
  description: z.string().max(20_000).nullish(),
  estimatedMinutes: z
    .number()
    .int()
    .min(0)
    .max(60 * 24 * 366)
    .nullish(),
  status: z.enum(TASK_STATUSES).default('todo'),
  priority: z.enum(PRIORITIES).default('normal'),
  constraintType: z.enum(CONSTRAINT_TYPES).default('asap'),
  constraintDate: z.coerce.date().nullish(),
  isMilestone: z.boolean().default(false),
  sortOrder: z.number().int().min(0).optional(),
});

export const taskUpdateSchema = z
  .object({
    name: z.string().min(1).max(255),
    description: z.string().max(20_000).nullish(),
    estimatedMinutes: z
      .number()
      .int()
      .min(0)
      .max(60 * 24 * 366)
      .nullish(),
    status: z.enum(TASK_STATUSES),
    priority: z.enum(PRIORITIES),
    constraintType: z.enum(CONSTRAINT_TYPES),
    constraintDate: z.coerce.date().nullish(),
    isMilestone: z.boolean(),
    progress: z.number().int().min(0).max(100),
    actualStart: z.coerce.date().nullish(),
    actualEnd: z.coerce.date().nullish(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Mindestens ein Feld angeben');

export const taskMoveSchema = z.object({
  parentId: idSchema.nullish(),
  sortOrder: z.number().int().min(0).optional(),
});

export const dependencyCreateSchema = z
  .object({
    predecessorId: idSchema,
    successorId: idSchema,
    type: z.enum(DEPENDENCY_TYPES).default('FS'),
    lagMinutes: z.number().int().min(-60 * 24 * 366).max(60 * 24 * 366).default(0),
  })
  .refine((v) => v.predecessorId !== v.successorId, {
    message: 'Eine Aufgabe kann nicht von sich selbst abhängen',
    path: ['successorId'],
  });

export const dependencyUpdateSchema = z
  .object({
    type: z.enum(DEPENDENCY_TYPES),
    lagMinutes: z.number().int().min(-60 * 24 * 366).max(60 * 24 * 366),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Mindestens ein Feld angeben');

// ---------------------------------------------------------------------------
// Ressourcen / Zuteilungen
// ---------------------------------------------------------------------------

export const resourceCreateSchema = z.object({
  name: z.string().min(1).max(160),
  type: z.enum(RESOURCE_TYPES).default('person'),
  userId: idSchema.nullish(),
  email: emptyToUndefined(z.string().email().max(255).transform((v) => v.trim().toLowerCase())),
  capacityMinutesPerDay: z
    .number()
    .int()
    .min(0)
    .max(24 * 60)
    .default(DEFAULT_CAPACITY_MINUTES_PER_DAY),
  workingHours: z.record(z.string(), z.unknown()).nullish(),
  color: emptyToUndefined(colorSchema),
  isActive: z.boolean().default(true),
});

export const resourceUpdateSchema = resourceCreateSchema.partial();

export const assignmentCreateSchema = z.object({
  resourceId: idSchema,
  allocationPercent: z.number().int().min(1).max(400).default(100),
});

export const assignmentUpdateSchema = z
  .object({
    allocationPercent: z.number().int().min(1).max(400),
  })
  .refine((v) => Object.keys(v).length > 0, 'Mindestens ein Feld angeben');

// ---------------------------------------------------------------------------
// Tags / Kommentare
// ---------------------------------------------------------------------------

export const tagCreateSchema = z.object({
  name: z.string().min(1).max(60),
  color: colorSchema.optional(),
});

export const tagUpdateSchema = tagCreateSchema.partial().refine(
  (v) => Object.keys(v).length > 0,
  'Mindestens ein Feld angeben',
);

export const taskTagsSchema = z.object({
  tagIds: z.array(idSchema).max(50),
});

export const commentCreateSchema = z.object({
  body: z.string().min(1).max(20_000),
});

// ---------------------------------------------------------------------------
// Scheduling / Gantt / Outlook
// ---------------------------------------------------------------------------

export const scheduleComputeSchema = z.object({
  leveling: z.boolean().default(false),
});

export const ganttQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  pxPerMinute: z.coerce.number().positive().max(10).optional(),
  bucketMinutes: z.coerce.number().int().positive().max(60 * 24 * 31).optional(),
});

export const outlookConnectionUpdateSchema = z.object({
  syncEnabled: z.boolean(),
});

// ---------------------------------------------------------------------------
// Generisch
// ---------------------------------------------------------------------------

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  q: z.string().max(200).optional(),
});

export const listQuerySchema = paginationQuerySchema.partial().extend({
  projectId: idSchema.optional(),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type ProjectCreateInput = z.infer<typeof projectCreateSchema>;
export type ProjectUpdateInput = z.infer<typeof projectUpdateSchema>;
export type ProjectDeleteInput = z.infer<typeof projectDeleteSchema>;
export type TaskCreateInput = z.infer<typeof taskCreateSchema>;
export type TaskUpdateInput = z.infer<typeof taskUpdateSchema>;
export type TaskMoveInput = z.infer<typeof taskMoveSchema>;
export type DependencyCreateInput = z.infer<typeof dependencyCreateSchema>;
export type DependencyUpdateInput = z.infer<typeof dependencyUpdateSchema>;
export type ResourceCreateInput = z.infer<typeof resourceCreateSchema>;
export type ResourceUpdateInput = z.infer<typeof resourceUpdateSchema>;
export type AssignmentCreateInput = z.infer<typeof assignmentCreateSchema>;
export type AssignmentUpdateInput = z.infer<typeof assignmentUpdateSchema>;
export type TagCreateInput = z.infer<typeof tagCreateSchema>;
export type TagUpdateInput = z.infer<typeof tagUpdateSchema>;
export type CommentCreateInput = z.infer<typeof commentCreateSchema>;
export type ScheduleComputeInput = z.infer<typeof scheduleComputeSchema>;
export type GanttQuery = z.infer<typeof ganttQuerySchema>;
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/** RFC-7807-Fehlerformat der API. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  errors?: Array<{ path: string; message: string }>;
}
