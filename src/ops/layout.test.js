import { describe, expect, it } from 'vitest';
import { NODE_H, layout } from './layout.js';

const N = (...uids) => uids.map((uid) => ({ uid }));
const E = (pairs) => pairs.map(([s, t], i) => ({ id: String(i), source: s, target: t }));

describe('layout', () => {
  it('puts a producer left of its consumer', async () => {
    const { positions } = await layout({ nodes: N('a', 'b', 'c'), edges: E([['a', 'b'], ['b', 'c']]) });
    expect(positions.a.x).toBeLessThan(positions.b.x);
    expect(positions.b.x).toBeLessThan(positions.c.x);
  });

  it('terminates on a cycle and places every node', async () => {
    const { positions } = await layout({ nodes: N('a', 'b', 'c'), edges: E([['a', 'b'], ['b', 'a'], ['b', 'c']]) });
    expect(Object.keys(positions).sort()).toEqual(['a', 'b', 'c']);
  });

  it('keeps a self-loop from breaking the layout', async () => {
    const { positions } = await layout({ nodes: N('a', 'b'), edges: E([['a', 'a'], ['a', 'b']]) });
    expect(positions.a.x).toBeLessThan(positions.b.x);
  });

  it('sends nodes with no edge to `unconnected`, below the graph', async () => {
    const { positions, unconnected } = await layout({ nodes: N('a', 'b', 'lone1', 'lone2'), edges: E([['a', 'b']]) });
    expect(unconnected).toEqual(['lone1', 'lone2']);
    const graphBottom = Math.max(positions.a.y, positions.b.y) + NODE_H;
    expect(positions.lone1.y).toBeGreaterThan(graphBottom);
  });

  it('with no edges at all, everything is unconnected and starts at the top', async () => {
    const { positions, unconnected } = await layout({ nodes: N('a', 'b'), edges: [] });
    expect(unconnected).toEqual(['a', 'b']);
    expect(positions.a.y).toBe(0);
  });
});

describe('layer bands', () => {
  const T = (uid, externalId, kind = 'dataset') => ({ uid, kind, externalId });
  it('returns one band per layer, left to right in LAYERS order', async () => {
    const view = {
      nodes: [T('b', 'bronze.stg'), T('s', 'silver.table_a'), T('g', 'gold.table_a'), T('j', 'dag_x', 'dag')],
      edges: [{ id: '1', source: 'b', target: 'j' }, { id: '2', source: 'j', target: 's' }, { id: '3', source: 's', target: 'g' }]
    };
    const { bands } = await layout(view);
    expect(bands.map((b) => b.layer)).toEqual(['bronze', 'silver', 'gold']);
    expect(bands[0].x1).toBeLessThanOrEqual(bands[1].x0);
    expect(bands[1].x1).toBeLessThanOrEqual(bands[2].x0);
  });
  it('survives an edge pointing back to an earlier layer', async () => {
    const view = {
      nodes: [T('b', 'bronze.stg'), T('s', 'silver.t')],
      edges: [{ id: '1', source: 'b', target: 's' }, { id: '2', source: 's', target: 'b' }]
    };
    const { positions } = await layout(view);
    expect(Object.keys(positions).sort()).toEqual(['b', 's']);
  });
});
