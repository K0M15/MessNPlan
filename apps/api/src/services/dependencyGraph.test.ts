import { describe, expect, it } from 'vitest';
import { topologicalOrder, wouldCreateCycle, type DepEdge } from './dependencyGraph.js';

function edge(predecessorId: number, successorId: number): DepEdge {
  return { id: predecessorId * 100 + successorId, predecessorId, successorId, type: 'FS', lagMinutes: 0 };
}

describe('dependencyGraph', () => {
  it('erkennt einen Zyklus', () => {
    const edges = [edge(1, 2), edge(2, 3)];
    expect(wouldCreateCycle(edges, 3, 1)).toBe(true);
    expect(wouldCreateCycle(edges, 1, 3)).toBe(false);
    expect(wouldCreateCycle(edges, 1, 1)).toBe(true);
  });

  it('liefert eine topologische Reihenfolge', () => {
    const edges = [edge(1, 2), edge(2, 3), edge(1, 3)];
    const result = topologicalOrder([1, 2, 3], edges);
    expect(result.cyclic.size).toBe(0);
    expect(result.order.indexOf(1)).toBeLessThan(result.order.indexOf(2));
    expect(result.order.indexOf(2)).toBeLessThan(result.order.indexOf(3));
  });

  it('markiert Knoten in Zyklen', () => {
    const edges = [edge(1, 2), edge(2, 3), edge(3, 2), edge(4, 1)];
    const result = topologicalOrder([1, 2, 3, 4], edges);
    expect(result.order).toEqual([4, 1]);
    expect([...result.cyclic].sort()).toEqual([2, 3]);
  });
});
