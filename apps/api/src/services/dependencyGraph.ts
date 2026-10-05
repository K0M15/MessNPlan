import { eq } from 'drizzle-orm';
import type { DependencyType } from '@projectplaner/shared';
import { db } from '../db/client.js';
import { taskDependencies } from '../db/schema.js';

export interface DepEdge {
  id: number;
  predecessorId: number;
  successorId: number;
  type: DependencyType;
  lagMinutes: number;
}

export async function loadProjectEdges(projectId: number): Promise<DepEdge[]> {
  const rows = await db
    .select({
      id: taskDependencies.id,
      predecessorId: taskDependencies.predecessorId,
      successorId: taskDependencies.successorId,
      type: taskDependencies.type,
      lagMinutes: taskDependencies.lagMinutes,
    })
    .from(taskDependencies)
    .where(eq(taskDependencies.projectId, projectId));
  return rows as DepEdge[];
}

/**
 * Ein Zyklus entsteht genau dann, wenn der neue Nachfolger den neuen Vorgänger
 * bereits erreicht (Pfad successor → ... → predecessor existiert).
 */
export function wouldCreateCycle(
  edges: DepEdge[],
  predecessorId: number,
  successorId: number,
): boolean {
  if (predecessorId === successorId) return true;
  const adjacency = new Map<number, number[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.predecessorId) ?? [];
    list.push(edge.successorId);
    adjacency.set(edge.predecessorId, list);
  }

  const stack = [successorId];
  const seen = new Set<number>([successorId]);
  while (stack.length > 0) {
    const current = stack.pop() as number;
    if (current === predecessorId) return true;
    for (const next of adjacency.get(current) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return false;
}

export interface TopoResult {
  order: number[];
  cyclic: Set<number>;
}

export interface GraphEdge {
  predecessorId: number;
  successorId: number;
}

/** Kahn-Topologie; übrig bleibende Knoten sind Teil von Zyklen. */
export function topologicalOrder(nodeIds: number[], edges: GraphEdge[]): TopoResult {
  const indegree = new Map<number, number>();
  const adjacency = new Map<number, number[]>();
  for (const id of nodeIds) {
    indegree.set(id, 0);
    adjacency.set(id, []);
  }
  for (const edge of edges) {
    const list = adjacency.get(edge.predecessorId);
    if (!list || !indegree.has(edge.successorId)) continue;
    list.push(edge.successorId);
    indegree.set(edge.successorId, (indegree.get(edge.successorId) ?? 0) + 1);
  }

  const queue = [...indegree.entries()].filter(([, deg]) => deg === 0).map(([id]) => id);
  const order: number[] = [];
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head] as number;
    order.push(id);
    for (const next of adjacency.get(id) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }

  const ordered = new Set(order);
  const cyclic = new Set<number>();
  for (const id of nodeIds) {
    if (!ordered.has(id)) cyclic.add(id);
  }
  return { order, cyclic };
}
