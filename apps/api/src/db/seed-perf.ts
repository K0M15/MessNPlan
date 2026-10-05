/**
 * Performance-Seed: erzeugt ein eigenständiges Projekt „Perf-Test" mit vielen
 * Aufgaben, Abhängigkeiten, Ressourcen und Zuteilungen – ausschließlich für
 * Last-/Performance-Messungen des Gantt-Charts. Das Demo-Projekt bleibt unberührt.
 *
 * Aufruf:
 *   npm run db:seed:perf -w @projectplaner/api -- --tasks 2000 --resources 30 [--clean]
 *
 * Optionen:
 *   --tasks <n>      Anzahl Aufgaben gesamt (Default 2000, Minimum 200)
 *   --resources <n>  Anzahl Ressourcen (Default 30, Minimum 1)
 *   --clean          Vorhandenes Projekt „Perf-Test" vorher löschen (FK-Cascade)
 *   --seed <n>       RNG-Seed für reproduzierbare Daten (Default 4242)
 */
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { logger } from '../logger.js';
import { closeDatabase, db } from './client.js';
import {
  assignments,
  projectMembers,
  projects,
  resources,
  tags,
  taskDependencies,
  taskTags,
  tasks,
  users,
} from './schema.js';

const PROJECT_NAME = 'Perf-Test';
const TASK_CHUNK = 250;

interface Options {
  tasks: number;
  resources: number;
  clean: boolean;
  seed: number;
}

function parseOptions(argv: string[]): Options {
  const options: Options = { tasks: 2000, resources: 30, clean: false, seed: 4242 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--clean') {
      options.clean = true;
    } else if (arg === '--tasks') {
      options.tasks = Number(argv[++i]);
    } else if (arg === '--resources') {
      options.resources = Number(argv[++i]);
    } else if (arg === '--seed') {
      options.seed = Number(argv[++i]);
    } else if (arg !== undefined) {
      throw new Error(`Unbekanntes Argument: ${arg}`);
    }
  }
  if (!Number.isInteger(options.tasks) || options.tasks < 200) {
    throw new Error('--tasks muss eine Ganzzahl >= 200 sein');
  }
  if (!Number.isInteger(options.resources) || options.resources < 1) {
    throw new Error('--resources muss eine Ganzzahl >= 1 sein');
  }
  return options;
}

/** Kleiner, deterministischer PRNG (mulberry32). */
function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type TaskStatus = 'todo' | 'in_progress' | 'blocked' | 'done';
type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';

interface PerfNode {
  /** Index des Elternknotens im `nodes`-Array (null = Wurzel). */
  parentIndex: number | null;
  depth: number;
  sortOrder: number;
  name: string;
  estimatedMinutes: number | null;
  isMilestone: boolean;
  status: TaskStatus;
  progress: number;
  priority: TaskPriority;
  /** Blätter (inkl. Meilensteine) bekommen Zuteilungen/Tags. */
  leaf: boolean;
}

const PHASES = [
  'Analyse',
  'Konzept',
  'Design',
  'Umsetzung',
  'Integration',
  'Qualitätssicherung',
  'Dokumentation',
  'Abnahme',
  'Betrieb',
  'Optimierung',
];

const TOPICS = [
  'Anforderungen',
  'Schnittstellen',
  'Datenmodell',
  'Prototyp',
  'Review',
  'Migration',
  'Automatisierung',
  'Testfälle',
  'Monitoring',
  'Schulung',
  'Freigabe',
  'Rollout',
];

const TAG_SEEDS = [
  { name: 'kritisch', color: '#ef4444' },
  { name: 'backend', color: '#f59e0b' },
  { name: 'frontend', color: '#22c55e' },
  { name: 'infrastruktur', color: '#0ea5e9' },
  { name: 'daten', color: '#8b5cf6' },
  { name: 'doku', color: '#64748b' },
  { name: 'review', color: '#ec4899' },
  { name: 'risiko', color: '#dc2626' },
];

const RESOURCE_COLORS = [
  '#6366f1',
  '#0ea5e9',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#14b8a6',
  '#f97316',
  '#ec4899',
  '#64748b',
];

const DURATIONS = [120, 240, 480, 720, 960, 1440, 1920, 2400];

function randomWorkState(
  rng: () => number,
  isMilestone: boolean,
): { status: TaskStatus; progress: number } {
  if (isMilestone) {
    const done = rng() < 0.2;
    return { status: done ? 'done' : 'todo', progress: done ? 100 : 0 };
  }
  const roll = rng();
  if (roll < 0.1) return { status: 'done', progress: 100 };
  if (roll < 0.3) return { status: 'in_progress', progress: 5 + Math.floor(rng() * 18) * 5 };
  if (roll < 0.35) return { status: 'blocked', progress: Math.floor(rng() * 11) * 5 };
  return { status: 'todo', progress: 0 };
}

function randomPriority(rng: () => number): TaskPriority {
  const roll = rng();
  if (roll < 0.05) return 'urgent';
  if (roll < 0.2) return 'high';
  if (roll < 0.35) return 'low';
  return 'normal';
}

function buildNodes(total: number, rng: () => number): PerfNode[] {
  const nodes: PerfNode[] = [];
  const l1Count = Math.min(10, Math.max(1, Math.floor(total / 200)));
  const l2PerL1 = 2;
  const l3PerL2 = 5;
  const summaryCount = l1Count + l1Count * l2PerL1 + l1Count * l2PerL1 * l3PerL2;
  const leafCount = total - summaryCount;

  const push = (node: Omit<PerfNode, 'leaf'> & { leaf?: boolean }): number => {
    nodes.push({ ...node, leaf: node.leaf ?? false });
    return nodes.length - 1;
  };

  const roots: number[] = [];
  for (let i = 0; i < l1Count; i++) {
    roots.push(
      push({
        parentIndex: null,
        depth: 0,
        sortOrder: i,
        name: `Phase ${String(i + 1).padStart(2, '0')} – ${PHASES[i % PHASES.length]}`,
        estimatedMinutes: null,
        isMilestone: false,
        status: 'todo',
        progress: 0,
        priority: 'normal',
      }),
    );
  }

  const level2: number[] = [];
  for (const rootIndex of roots) {
    for (let j = 0; j < l2PerL1; j++) {
      const root = nodes[rootIndex]!;
      level2.push(
        push({
          parentIndex: rootIndex,
          depth: 1,
          sortOrder: j,
          name: `Teilbereich ${String(j + 1).padStart(2, '0')} – ${root.name.replace(/^Phase \d+ – /, '')}`,
          estimatedMinutes: null,
          isMilestone: false,
          status: 'todo',
          progress: 0,
          priority: 'normal',
        }),
      );
    }
  }

  const level3: number[] = [];
  for (const l2Index of level2) {
    for (let j = 0; j < l3PerL2; j++) {
      level3.push(
        push({
          parentIndex: l2Index,
          depth: 2,
          sortOrder: j,
          name: `Arbeitspaket ${String(level3.length + 1).padStart(3, '0')} – ${TOPICS[(level3.length + j) % TOPICS.length]}`,
          estimatedMinutes: null,
          isMilestone: false,
          status: 'todo',
          progress: 0,
          priority: 'normal',
        }),
      );
    }
  }

  let remaining = leafCount;
  let leafNumber = 0;
  for (const [index, l3Index] of level3.entries()) {
    const perParent =
      Math.floor(leafCount / level3.length) + (index < leafCount % level3.length ? 1 : 0);
    for (let j = 0; j < perParent; j++) {
      const isMilestone = rng() < 0.15;
      const state = randomWorkState(rng, isMilestone);
      leafNumber += 1;
      const topic = TOPICS[Math.floor(rng() * TOPICS.length)] ?? 'Arbeit';
      push({
        parentIndex: l3Index,
        depth: 3,
        sortOrder: j,
        name: `Aufgabe ${String(leafNumber).padStart(4, '0')} – ${topic}`,
        estimatedMinutes: isMilestone
          ? 0
          : (DURATIONS[Math.floor(rng() * DURATIONS.length)] ?? 480),
        isMilestone,
        status: state.status,
        progress: state.progress,
        priority: randomPriority(rng),
        leaf: true,
      });
      remaining -= 1;
    }
  }
  if (remaining !== 0) {
    throw new Error(`Interner Fehler: ${remaining} Blätter nicht verteilt`);
  }
  return nodes;
}

function buildDependencies(nodes: PerfNode[], rng: () => number): Array<{
  predecessorIndex: number;
  successorIndex: number;
  lagMinutes: number;
}> {
  const edges: Array<{ predecessorIndex: number; successorIndex: number; lagMinutes: number }> = [];
  const seen = new Set<string>();
  // Nur Blätter (inkl. Meilensteine) vernetzen: Summary-Aufgaben ergeben sich per
  // Rollup aus ihren Kindern. Das hält den kombinierten Graphen garantiert zyklenfrei.
  const leafIndices = nodes.map((_, index) => index).filter((index) => nodes[index]!.leaf);
  for (let position = 1; position < leafIndices.length; position++) {
    const successor = leafIndices[position]!;
    const desired = position % 2 === 0 ? 2 : 3; // ~2,5 Abhängigkeiten pro Blatt
    for (let attempt = 0; attempt < desired; attempt++) {
      const predecessor = leafIndices[Math.floor(rng() * position)]!;
      const key = `${predecessor}:${successor}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const lagRoll = rng();
      const lagMinutes =
        lagRoll < 0.2 ? (Math.floor(rng() * 9) - 2) * 120 : 0; // teils Lag, teils negativ
      edges.push({ predecessorIndex: predecessor, successorIndex: successor, lagMinutes });
    }
  }
  return edges;
}

async function insertChunks<T>(
  rows: T[],
  size: number,
  insert: (chunk: T[]) => PromiseLike<unknown>,
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += size) {
    await insert(rows.slice(offset, offset + size));
  }
}

async function resolveAdminId(): Promise<number> {
  const email = (process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com').toLowerCase();
  const [byEmail] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (byEmail) return byEmail.id;
  const [firstAdmin] = await db.select().from(users).where(eq(users.role, 'admin')).limit(1);
  if (firstAdmin) {
    logger.info({ email: firstAdmin.email }, 'SEED_ADMIN_EMAIL nicht gefunden – nutze ersten Admin');
    return firstAdmin.id;
  }
  throw new Error('Kein Admin-Benutzer gefunden – bitte zuerst `npm run db:seed` ausführen');
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const startedAt = performance.now();
  const rng = createRng(options.seed);
  const adminId = await resolveAdminId();

  if (options.clean) {
    const [existing] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.name, PROJECT_NAME))
      .limit(1);
    if (existing) {
      await db.delete(projects).where(eq(projects.id, existing.id));
      logger.info({ projectId: existing.id }, `Altes Projekt „${PROJECT_NAME}" gelöscht`);
    }
  } else {
    const [existing] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.name, PROJECT_NAME))
      .limit(1);
    if (existing) {
      throw new Error(
        `Projekt „${PROJECT_NAME}" existiert bereits (ID ${existing.id}) – mit --clean neu anlegen`,
      );
    }
  }

  const [project] = await db
    .insert(projects)
    .values({
      name: PROJECT_NAME,
      description: `Lasttest-Projekt mit ${options.tasks} Aufgaben (generiert).`,
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

  // 1) Aufgabenbaum (4 Ebenen) in Ebenen-Reihenfolge einfügen.
  const nodes = buildNodes(options.tasks, rng);
  const taskIds = new Array<number>(nodes.length).fill(0);
  const nodeIndexByParentSort = new Map<string, number>();
  for (const [index, node] of nodes.entries()) {
    const parentKey = node.parentIndex === null ? 'root' : String(node.parentIndex);
    nodeIndexByParentSort.set(`${parentKey}:${node.sortOrder}`, index);
  }
  let insertedTasks = 0;

  const insertLevel = async (levelIndices: number[]): Promise<void> => {
    for (let offset = 0; offset < levelIndices.length; offset += TASK_CHUNK) {
      const chunk = levelIndices.slice(offset, offset + TASK_CHUNK);
      await db.insert(tasks).values(
        chunk.map((nodeIndex) => {
          const node = nodes[nodeIndex]!;
          return {
            projectId,
            parentId: node.parentIndex === null ? null : (taskIds[node.parentIndex] ?? null),
            name: node.name,
            estimatedMinutes: node.estimatedMinutes,
            progress: node.progress,
            status: node.status,
            priority: node.priority,
            isMilestone: node.isMilestone,
            sortOrder: node.sortOrder,
            createdBy: adminId,
          };
        }),
      );
      insertedTasks += chunk.length;
      logger.info(
        { tasks: `${insertedTasks}/${nodes.length}` },
        `Aufgaben eingefügt: ${insertedTasks}/${nodes.length}`,
      );
    }

    // IDs zurücklesen (auto_increment) und über (parentId, sortOrder) den Knoten zuordnen.
    const parentNodeIndices = [...new Set(levelIndices.map((i) => nodes[i]!.parentIndex))];
    const parentDbIdToNodeIndex = new Map<number | null, number>();
    for (const parentIndex of parentNodeIndices) {
      parentDbIdToNodeIndex.set(
        parentIndex === null ? null : (taskIds[parentIndex] ?? null),
        parentIndex ?? -1,
      );
    }
    const nonNullParentIds = parentNodeIndices
      .filter((i): i is number => i !== null)
      .map((i) => taskIds[i]!);
    const hasNullParent = parentNodeIndices.includes(null);
    const condition = hasNullParent
      ? or(isNull(tasks.parentId), inArray(tasks.parentId, nonNullParentIds.length ? nonNullParentIds : [-1]))
      : inArray(tasks.parentId, nonNullParentIds.length ? nonNullParentIds : [-1]);
    const rows = await db
      .select({ id: tasks.id, parentId: tasks.parentId, sortOrder: tasks.sortOrder })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), condition));
    for (const row of rows) {
      const parentKey = row.parentId === null ? 'root' : String(parentDbIdToNodeIndex.get(row.parentId));
      const childNodeIndex = nodeIndexByParentSort.get(`${parentKey}:${row.sortOrder}`);
      if (childNodeIndex !== undefined) taskIds[childNodeIndex] = row.id;
    }
  };

  const byDepth = [0, 1, 2, 3].map((depth) =>
    nodes.map((_, index) => index).filter((index) => nodes[index]!.depth === depth),
  );
  for (const levelIndices of byDepth) {
    await insertLevel(levelIndices);
  }
  if (taskIds.some((id) => id === 0)) {
    throw new Error('Nicht alle Aufgaben-IDs konnten aufgelöst werden');
  }

  // 2) Ressourcen
  const personCount = Math.max(1, Math.round(options.resources * 0.8));
  const resourceRows = Array.from({ length: options.resources }, (_, index) => {
    const isPerson = index < personCount;
    const number = String(isPerson ? index + 1 : index - personCount + 1).padStart(2, '0');
    return {
      projectId,
      name: isPerson ? `Person ${number}` : `Maschine ${number}`,
      type: isPerson ? ('person' as const) : ('machine' as const),
      email: isPerson ? `person${number}@example.com` : null,
      capacityMinutesPerDay: isPerson ? 480 : 1440,
      color: RESOURCE_COLORS[index % RESOURCE_COLORS.length]!,
      isActive: true,
    };
  });
  const resourceIds: number[] = [];
  for (let offset = 0; offset < resourceRows.length; offset += TASK_CHUNK) {
    const chunk = resourceRows.slice(offset, offset + TASK_CHUNK);
    const created = await db.insert(resources).values(chunk).$returningId();
    resourceIds.push(...created.map((r) => r.id));
  }

  // 3) Zuteilungen (nur Nicht-Meilenstein-Blätter) + Tags (alle Blätter)
  const assignmentTargets = nodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => node.leaf && !node.isMilestone);
  const assignmentRows: Array<{
    taskId: number;
    resourceId: number;
    allocationPercent: number;
  }> = [];
  const tagRows: Array<{ taskId: number; tagId: number }> = [];
  const tagIds: number[] = [];
  for (let offset = 0; offset < TAG_SEEDS.length; offset += TASK_CHUNK) {
    const created = await db
      .insert(tags)
      .values(TAG_SEEDS.slice(offset, offset + TASK_CHUNK).map((tag) => ({ projectId, ...tag })))
      .$returningId();
    tagIds.push(...created.map((t) => t.id));
  }
  const leafNodes = nodes.map((node, index) => ({ node, index })).filter(({ node }) => node.leaf);
  for (const { index } of leafNodes) {
    const taskId = taskIds[index]!;
    const tagCount = Math.floor(rng() * 3); // 0–2 Tags
    const usedTags = new Set<number>();
    for (let t = 0; t < tagCount; t++) {
      const tagId = tagIds[Math.floor(rng() * tagIds.length)]!;
      if (usedTags.has(tagId)) continue;
      usedTags.add(tagId);
      tagRows.push({ taskId, tagId });
    }
  }
  for (const { index } of assignmentTargets) {
    const taskId = taskIds[index]!;
    const countRoll = rng();
    const count = countRoll < 0.25 ? 0 : countRoll < 0.75 ? 1 : 2;
    const usedResources = new Set<number>();
    for (let a = 0; a < count; a++) {
      const resourceId = resourceIds[Math.floor(rng() * resourceIds.length)]!;
      if (usedResources.has(resourceId)) continue;
      usedResources.add(resourceId);
      assignmentRows.push({
        taskId,
        resourceId,
        allocationPercent: (1 + Math.floor(rng() * 5)) * 20, // 20–100 %
      });
    }
  }

  // 4) Abhängigkeiten (azyklisch per Konstruktion: Vorgänger hat kleineren Index)
  const dependencyRows = buildDependencies(nodes, rng).map((edge) => ({
    projectId,
    predecessorId: taskIds[edge.predecessorIndex]!,
    successorId: taskIds[edge.successorIndex]!,
    type: 'FS' as const,
    lagMinutes: edge.lagMinutes,
  }));

  await insertChunks(dependencyRows, 500, (chunk) => db.insert(taskDependencies).values(chunk));
  await insertChunks(assignmentRows, 500, (chunk) => db.insert(assignments).values(chunk));
  await insertChunks(tagRows, 500, (chunk) => db.insert(taskTags).values(chunk));

  const durationMs = Math.round(performance.now() - startedAt);
  logger.info(
    {
      projectId,
      tasks: nodes.length,
      dependencies: dependencyRows.length,
      resources: resourceRows.length,
      assignments: assignmentRows.length,
      tags: tagRows.length,
      durationMs,
    },
    `Perf-Projekt angelegt: ID ${projectId} (${nodes.length} Aufgaben in ${durationMs} ms)`,
  );
  process.stdout.write(`Perf-Projekt-ID: ${projectId}\n`);
  await closeDatabase();
}

main().catch(async (err) => {
  logger.error({ err }, 'Perf-Seed fehlgeschlagen');
  process.exitCode = 1;
  await closeDatabase().catch(() => {});
});
