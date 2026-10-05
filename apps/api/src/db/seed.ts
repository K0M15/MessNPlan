import { eq } from 'drizzle-orm';
import { hashPassword } from '../auth/passwords.js';
import { logger } from '../logger.js';
import { closeDatabase, db } from './client.js';
import {
  assignments,
  comments,
  projectMembers,
  projects,
  resources,
  tags,
  taskDependencies,
  taskTags,
  tasks,
  users,
} from './schema.js';

const ADMIN_EMAIL = (process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com').toLowerCase();
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? 'admin1234!';
const ADMIN_NAME = process.env.SEED_ADMIN_NAME ?? 'Administrator';
const WITH_DEMO = (process.env.SEED_DEMO ?? 'true') !== 'false';
const DEMO_PROJECT_NAME = 'Demo: Website-Relaunch';

async function seedAdmin(): Promise<number> {
  const [existing] = await db.select().from(users).where(eq(users.email, ADMIN_EMAIL)).limit(1);
  if (existing) {
    logger.info({ email: ADMIN_EMAIL }, 'Admin existiert bereits – übersprungen');
    return existing.id;
  }
  const [created] = await db
    .insert(users)
    .values({
      email: ADMIN_EMAIL,
      name: ADMIN_NAME,
      role: 'admin',
      passwordHash: await hashPassword(ADMIN_PASSWORD),
    })
    .$returningId();
  logger.info({ email: ADMIN_EMAIL }, 'Admin angelegt');
  return created!.id;
}

async function seedDemo(adminId: number): Promise<void> {
  const [existing] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.name, DEMO_PROJECT_NAME))
    .limit(1);
  if (existing) {
    logger.info('Demo-Projekt existiert bereits – übersprungen');
    return;
  }

  const [project] = await db
    .insert(projects)
    .values({
      name: DEMO_PROJECT_NAME,
      description: 'Beispielprojekt mit Aufgabenbaum, Abhängigkeiten und Ressourcen.',
      timezone: 'Europe/Berlin',
      workweek: [1, 2, 3, 4, 5],
      workdayStart: '08:00:00',
      workdayEnd: '16:00:00',
      scheduleAnchor: new Date().toISOString().slice(0, 10),
      createdBy: adminId,
    })
    .$returningId();
  const projectId = project!.id;

  await db.insert(projectMembers).values({ projectId, userId: adminId, role: 'planner' });

  interface TaskSeed {
    key: string;
    name: string;
    estimatedMinutes: number | null;
    parentKey?: string;
    isMilestone?: boolean;
    priority?: 'low' | 'normal' | 'high' | 'urgent';
  }

  const taskSeeds: TaskSeed[] = [
    { key: 'concept', name: 'Konzept', estimatedMinutes: null },
    { key: 'interviews', name: 'Stakeholder-Interviews', estimatedMinutes: 480, parentKey: 'concept' },
    {
      key: 'ia',
      name: 'Informationsarchitektur',
      estimatedMinutes: 720,
      parentKey: 'concept',
      priority: 'high',
    },
    { key: 'design', name: 'Design', estimatedMinutes: null },
    { key: 'wireframes', name: 'Wireframes', estimatedMinutes: 960, parentKey: 'design' },
    { key: 'ui', name: 'UI-Design', estimatedMinutes: 1200, parentKey: 'design', priority: 'high' },
    { key: 'build', name: 'Umsetzung', estimatedMinutes: null },
    { key: 'frontend', name: 'Frontend-Entwicklung', estimatedMinutes: 2400, parentKey: 'build' },
    { key: 'backend', name: 'Backend/API', estimatedMinutes: 1920, parentKey: 'build' },
    { key: 'content', name: 'Content-Migration', estimatedMinutes: 960, parentKey: 'build' },
    { key: 'qa', name: 'Qualitätssicherung', estimatedMinutes: 1200, parentKey: 'build' },
    {
      key: 'launch',
      name: 'Launch',
      estimatedMinutes: 0,
      parentKey: 'build',
      isMilestone: true,
      priority: 'urgent',
    },
  ];

  const ids = new Map<string, number>();
  for (const [index, seed] of taskSeeds.entries()) {
    const [task] = await db
      .insert(tasks)
      .values({
        projectId,
        parentId: seed.parentKey ? (ids.get(seed.parentKey) ?? null) : null,
        name: seed.name,
        estimatedMinutes: seed.estimatedMinutes,
        isMilestone: seed.isMilestone ?? false,
        priority: seed.priority ?? 'normal',
        sortOrder: index,
        createdBy: adminId,
      })
      .$returningId();
    ids.set(seed.key, task!.id);
  }

  const dependencies: Array<[string, string, 'FS' | 'SS', number]> = [
    ['interviews', 'ia', 'FS', 0],
    ['ia', 'wireframes', 'FS', 0],
    ['wireframes', 'ui', 'FS', 0],
    ['ui', 'frontend', 'FS', 0],
    ['ui', 'backend', 'FS', 0],
    ['wireframes', 'content', 'SS', 0],
    ['frontend', 'qa', 'FS', 0],
    ['backend', 'qa', 'FS', 0],
    ['qa', 'launch', 'FS', 0],
  ];
  await db.insert(taskDependencies).values(
    dependencies.map(([pred, succ, type, lag]) => ({
      projectId,
      predecessorId: ids.get(pred)!,
      successorId: ids.get(succ)!,
      type,
      lagMinutes: lag,
    })),
  );

  const resourceSeeds = [
    { name: 'Anna Beispiel', type: 'person' as const, email: 'anna@example.com', color: '#6366f1', key: 'anna' },
    { name: 'Ben Muster', type: 'person' as const, email: 'ben@example.com', color: '#0ea5e9', key: 'ben' },
    { name: 'CI-Server', type: 'machine' as const, email: null, color: '#64748b', key: 'ci', capacity: 1440 },
  ];
  const resourceIds = new Map<string, number>();
  for (const resource of resourceSeeds) {
    const [created] = await db
      .insert(resources)
      .values({
        projectId,
        name: resource.name,
        type: resource.type,
        email: resource.email,
        color: resource.color,
        capacityMinutesPerDay: resource.capacity ?? 480,
      })
      .$returningId();
    resourceIds.set(resource.key, created!.id);
  }

  const assignmentSeeds: Array<[string, string, number]> = [
    ['interviews', 'anna', 100],
    ['ia', 'anna', 50],
    ['wireframes', 'ben', 100],
    ['ui', 'anna', 100],
    ['frontend', 'ben', 100],
    ['backend', 'anna', 100],
    ['content', 'ben', 50],
    ['qa', 'ben', 100],
  ];
  await db.insert(assignments).values(
    assignmentSeeds.map(([taskKey, resourceKey, allocation]) => ({
      taskId: ids.get(taskKey)!,
      resourceId: resourceIds.get(resourceKey)!,
      allocationPercent: allocation,
    })),
  );

  const tagSeeds = [
    { name: 'design', color: '#ec4899' },
    { name: 'frontend', color: '#22c55e' },
    { name: 'backend', color: '#f59e0b' },
    { name: 'content', color: '#8b5cf6' },
  ];
  const tagIds = new Map<string, number>();
  for (const tag of tagSeeds) {
    const [created] = await db
      .insert(tags)
      .values({ projectId, name: tag.name, color: tag.color })
      .$returningId();
    tagIds.set(tag.name, created!.id);
  }

  await db.insert(taskTags).values([
    { taskId: ids.get('wireframes')!, tagId: tagIds.get('design')! },
    { taskId: ids.get('ui')!, tagId: tagIds.get('design')! },
    { taskId: ids.get('frontend')!, tagId: tagIds.get('frontend')! },
    { taskId: ids.get('backend')!, tagId: tagIds.get('backend')! },
    { taskId: ids.get('content')!, tagId: tagIds.get('content')! },
  ]);

  await db.insert(comments).values([
    {
      taskId: ids.get('interviews')!,
      userId: adminId,
      body: 'Termine mit Marketing und Support sind für nächste Woche angesetzt.',
    },
    {
      taskId: ids.get('launch')!,
      userId: adminId,
      body: 'Launch-Fenster mit dem Betrieb abstimmen.',
    },
  ]);

  logger.info({ projectId }, 'Demo-Projekt angelegt');
}

async function main(): Promise<void> {
  const adminId = await seedAdmin();
  if (WITH_DEMO) {
    await seedDemo(adminId);
  }
  logger.info('Seed abgeschlossen');
  await closeDatabase();
}

main().catch((err) => {
  logger.error({ err }, 'Seed fehlgeschlagen');
  process.exitCode = 1;
});
