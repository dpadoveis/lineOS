import { describe, expect, it } from 'vitest';
import { atRisk, focusSet, lineageOf } from './lineage.js';

const E = (pairs) => pairs.map(([s, t], i) => ({ id: String(i), source: s, target: t }));

describe('lineageOf', () => {
  it('is upstream plus downstream, not the whole component', () => {
    // a -> b -> c, and x -> b : from c, x is upstream (x -> b -> c).
    // d hangs off a sibling branch: a -> d. From c, d is neither.
    const edges = E([['a', 'b'], ['b', 'c'], ['x', 'b'], ['a', 'd']]);
    expect([...lineageOf('c', edges)].sort()).toEqual(['a', 'b', 'c', 'x']);
    expect([...lineageOf('b', edges)].sort()).toEqual(['a', 'b', 'c', 'x']);
    expect([...lineageOf('d', edges)].sort()).toEqual(['a', 'd']);
  });

  it('terminates on a cycle', () => {
    const edges = E([['a', 'b'], ['b', 'a'], ['b', 'c']]);
    expect([...lineageOf('a', edges)].sort()).toEqual(['a', 'b', 'c']);
  });

  it('returns null for no selection', () => {
    expect(lineageOf(null, [])).toBe(null);
  });
});

describe('focusSet', () => {
  const view = {
    nodes: [{ uid: 'a', state: 'broken' }, { uid: 'b', state: 'ok' }, { uid: 'c', state: 'broken' }],
    edges: E([['a', 'b']])
  };
  it('lights nothing up when nothing is chosen', () => {
    expect(focusSet(view, { selected: null, filter: null })).toBe(null);
  });
  it('a filter lights the nodes in that state', () => {
    expect([...focusSet(view, { selected: null, filter: 'broken' })].sort()).toEqual(['a', 'c']);
  });
  it('a selection wins over a filter', () => {
    expect([...focusSet(view, { selected: 'b', filter: 'broken' })].sort()).toEqual(['a', 'b']);
  });
});

describe('atRisk', () => {
  const V = (states, pairs) => ({
    nodes: Object.entries(states).map(([uid, state]) => ({ uid, state })),
    edges: pairs.map(([s, t], i) => ({ id: String(i), source: s, target: t }))
  });
  it('marks everything downstream of a broken or late node, naming the sources', () => {
    const r = atRisk(V({ a: 'broken', b: 'ok', c: 'ok', x: 'late', y: 'ok' }, [['a', 'b'], ['b', 'c'], ['x', 'c'], ['x', 'y']]));
    expect(r.get('b')).toEqual(['a']);
    expect(r.get('c').sort()).toEqual(['a', 'x']);
    expect(r.get('y')).toEqual(['x']);
    expect(r.has('a')).toBe(false);
    expect(r.has('x')).toBe(false);
  });
  it('terminates on a cycle and never marks a source as its own risk', () => {
    const r = atRisk(V({ a: 'broken', b: 'ok' }, [['a', 'b'], ['b', 'a']]));
    expect([...r.keys()]).toEqual(['b']);
  });
  it('is empty when nothing is broken or late', () => {
    expect(atRisk(V({ a: 'ok', b: 'no_data' }, [['a', 'b']])).size).toBe(0);
  });
  it('focusSet lights the at-risk nodes for the at_risk filter', () => {
    const view = V({ a: 'broken', b: 'ok' }, [['a', 'b']]);
    expect([...focusSet(view, { selected: null, filter: 'at_risk' }, atRisk(view))]).toEqual(['b']);
  });
});
