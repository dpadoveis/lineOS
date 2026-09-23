import { describe, expect, it } from 'vitest';
import fixture from '../../e2e/fixtures/sample-lineage.json';
import { LAYERS, STATES, bySeverity, layersOf, matches, runStatus, toPipelineView } from './view.js';

let nextObject = 100;
function bound(kind, externalId, state, extra = {}) {
  return {
    node_uid: 'ignored',
    object: { id: nextObject++, kind, source: 's', external_id: externalId, display_name: externalId,
      attrs: {}, first_seen_at: '2026-09-01T00:00:00Z', last_seen_at: '2026-09-22T00:00:00Z', watchers: 1 },
    rules: {},
    health: { state, reason: `${state} because`, since: null },
    last_run: null,
    last_check: null,
    ...extra
  };
}
const gnode = (id, uid, extra = {}) => ({ id, uid, name: 'Tool', label: null, category: 'Cat',
  initials: 'TL', color: '#7aa2f7', x: 0, y: 0, ...extra });

function detail(over = {}) {
  return {
    id: 1, slug: 'chain', name: 'Chain', flow_slug: 'chain-diagram', flow_version: 3,
    state: 'broken', collected_age_s: 120,
    nodes: [
      { uid: 'a', title: 'Bronze mirror', name: 'Cron', category: 'Scheduler',
        binding: bound('cron_job', 'run_job_c.sh', 'broken') },
      { uid: 'b', title: 'stg_table_a', name: 'Postgres', category: 'Database',
        binding: bound('table', 'bronze.stg_table_a', 'ok') },
      { uid: 'c', title: 'Silver DAG', name: 'Airflow', category: 'Orchestrator',
        binding: bound('airflow_dag', 'dag_silver_a', 'late') },
      { uid: 'd', title: 'Loose box', name: 'Box', category: 'Misc', binding: null }
    ],
    orphaned_bindings: [],
    graph: {
      kind: 'flow-graph', version: 1, groups: [],
      nodes: [gnode(1, 'a', { color: '#e0af68', initials: 'CR' }), gnode(2, 'b'), gnode(3, 'c'), gnode(4, 'd')],
      edges: [{ id: 1, from: 1, to: 2, label: null }, { id: 2, from: 2, to: 3, label: null }]
    },
    ...over
  };
}

describe('toPipelineView', () => {
  it('reads health exactly one level deep: node.binding.health.state', () => {
    const v = toPipelineView(detail());
    const s = Object.fromEntries(v.nodes.map((n) => [n.uid, n.state]));
    expect(s).toEqual({ a: 'broken', b: 'ok', c: 'late', d: 'unbound' });
  });

  it('counts an unbound node as unbound, never as no_data', () => {
    const v = toPipelineView(detail());
    expect(v.summary.counts.unbound).toBe(1);
    expect(v.summary.counts.no_data).toBe(0);
  });

  it('a bound node without health is no_data', () => {
    const d = detail();
    d.nodes[1].binding.health = null;
    expect(toPipelineView(d).nodes[1].state).toBe('no_data');
  });

  it('an unknown state from the server falls back to no_data, not to a missing count', () => {
    const d = detail();
    d.nodes[1].binding.health.state = 'weird';
    const v = toPipelineView(d);
    expect(v.nodes[1].state).toBe('no_data');
    expect(Object.values(v.summary.counts).reduce((a, b) => a + b, 0)).toBe(4);
  });

  it('maps the object kind to the card kind', () => {
    const k = Object.fromEntries(toPipelineView(detail()).nodes.map((n) => [n.uid, n.kind]));
    expect(k).toEqual({ a: 'cron', b: 'dataset', c: 'dag', d: 'unbound' });
  });

  it('takes colour and initials from the graph node, for the editor card', () => {
    const a = toPipelineView(detail()).nodes[0];
    expect(a.color).toBe('#e0af68');
    expect(a.initials).toBe('CR');
  });

  it('falls back to a neutral colour when the graph colour is not #rrggbb', () => {
    const d = detail();
    d.graph.nodes[0].color = 'tomato';
    expect(toPipelineView(d).nodes[0].color).toBe('#8b939e');
  });

  it('maps edges from numeric node ids to uids', () => {
    expect(toPipelineView(detail()).edges).toEqual([
      { id: '1', source: 'a', target: 'b' },
      { id: '2', source: 'b', target: 'c' }
    ]);
  });

  it('drops and counts an edge whose endpoint has no uid, without throwing', () => {
    const d = detail();
    d.graph.edges.push({ id: 3, from: 1, to: 99, label: null });
    const v = toPipelineView(d);
    expect(v.edges).toHaveLength(2);
    expect(v.dropped.edges).toBe(1);
  });

  it('keeps a null collection age null', () => {
    expect(toPipelineView(detail({ collected_age_s: null })).summary.collectedAgeS).toBe(null);
  });

  it('exposes objectId, lastRun and lastCheck for the drawer and the card', () => {
    const d = detail();
    d.nodes[0].binding.last_run = { run_key: 'r', started_at: '2026-09-22T01:00:00Z', duration_ms: 1000 };
    const a = toPipelineView(d).nodes[0];
    expect(a.objectId).toBe(d.nodes[0].binding.object.id);
    expect(a.lastRun.run_key).toBe('r');
    expect(a.lastCheck).toBe(null);
    expect(toPipelineView(d).nodes[3].objectId).toBe(null);
  });

  it('lists orphaned bindings by display name', () => {
    const d = detail({ orphaned_bindings: [{ node_uid: 'gone', object: { display_name: 'dag_gold_a' } }] });
    expect(toPipelineView(d).orphans).toEqual(['dag_gold_a']);
  });

  it('carries the header meta', () => {
    expect(toPipelineView(detail()).meta).toEqual({ name: 'Chain', slug: 'chain', flowSlug: 'chain-diagram' });
  });
});

describe('bySeverity', () => {
  it('orders broken, late, no_data, skipped, ok, unbound, then by label', () => {
    const order = bySeverity(toPipelineView(detail()).nodes).map((n) => n.uid);
    expect(order).toEqual(['a', 'c', 'b', 'd']);
  });
});

describe('runStatus', () => {
  it('is the last run outcome for jobs', () => {
    expect(runStatus({ kind: 'dag', lastRun: { outcome: 'failed' }, lastCheck: null })).toBe('failed');
    expect(runStatus({ kind: 'cron', lastRun: { outcome: 'running' }, lastCheck: null })).toBe('running');
    expect(runStatus({ kind: 'cron', lastRun: { outcome: 'unknown' }, lastCheck: null })).toBe('none');
  });
  it('is the last check for datasets', () => {
    expect(runStatus({ kind: 'dataset', lastRun: null, lastCheck: { ok: true } })).toBe('success');
    expect(runStatus({ kind: 'dataset', lastRun: null, lastCheck: { ok: false } })).toBe('failed');
  });
  it('is none when nothing was collected', () => {
    expect(runStatus({ kind: 'dag', lastRun: null, lastCheck: null })).toBe('none');
    expect(runStatus({ kind: 'unbound', lastRun: null, lastCheck: null })).toBe('none');
  });
  it('is exposed on every view node', () => {
    const d = detail();
    d.nodes[0].binding.last_run = { outcome: 'failed', started_at: '2026-09-22T01:00:00Z' };
    expect(toPipelineView(d).nodes[0].run).toBe('failed');
  });
});

describe('layersOf', () => {
  it('takes a table layer from its schema and a job layer from the first table it writes', () => {
    // detail(): a (cron) -> b (bronze.stg_table_a) -> c (dag), d unbound
    const layers = layersOf(toPipelineView(detail()));
    expect(layers.get('b')).toBe('bronze');
    expect(layers.get('a')).toBe('bronze');
    expect(layers.get('c')).toBe('other'); // writes nothing
    expect(layers.get('d')).toBe('other');
    expect(LAYERS).toEqual(['bronze', 'silver', 'gold', 'other']);
  });
});

describe('matches', () => {
  const n = { label: 'Silver DAG', externalId: 'dag_silver_a' };
  it('is case-insensitive over label and external id', () => {
    expect(matches(n, 'silver')).toBe(true);
    expect(matches(n, 'TABLE_A')).toBe(true);
    expect(matches(n, 'gold')).toBe(false);
  });
  it('an empty query matches everything', () => {
    expect(matches(n, '')).toBe(true);
    expect(matches(n, '   ')).toBe(true);
  });
});

describe('bySeverity with risk', () => {
  it('puts at-risk nodes right after late', () => {
    const v = toPipelineView(detail()); // a broken, b ok, c late, d unbound
    const order = bySeverity(v.nodes, new Map([['b', ['a']]])).map((n) => n.uid);
    expect(order).toEqual(['a', 'c', 'b', 'd']);
    const risky = bySeverity(v.nodes, new Map([['d', ['a']]])).map((n) => n.uid);
    expect(risky).toEqual(['a', 'c', 'd', 'b']);
  });
});

describe('node attrs, expected and durationMedianMs', () => {
  it('maps attrs from the binding object', () => {
    const d = detail();
    d.nodes[0].binding.object.attrs = { description: 'test', schedule: '0 * * * *' };
    const v = toPipelineView(d);
    expect(v.nodes[0].attrs).toEqual({ description: 'test', schedule: '0 * * * *' });
  });

  it('defaults attrs to empty object when not present', () => {
    const v = toPipelineView(detail());
    expect(v.nodes[0].attrs).toEqual({});
  });

  it('maps expected from the binding', () => {
    const d = detail();
    d.nodes[0].binding.expected = { next_at: '2026-09-23T05:00:00Z', late_after: '2026-09-23T06:00:00Z' };
    const v = toPipelineView(d);
    expect(v.nodes[0].expected).toEqual({ next_at: '2026-09-23T05:00:00Z', late_after: '2026-09-23T06:00:00Z' });
  });

  it('defaults expected to null when not present', () => {
    const v = toPipelineView(detail());
    expect(v.nodes[0].expected).toBe(null);
  });

  it('maps durationMedianMs from the binding', () => {
    const d = detail();
    d.nodes[0].binding.duration_median_ms = 5000;
    const v = toPipelineView(d);
    expect(v.nodes[0].durationMedianMs).toBe(5000);
  });

  it('defaults durationMedianMs to null when not present', () => {
    const v = toPipelineView(detail());
    expect(v.nodes[0].durationMedianMs).toBe(null);
  });
});

describe('the real map (fixture)', () => {
  const v = toPipelineView(fixture);

  it('has no binding nested inside a binding -- the level the first screen got wrong', () => {
    expect(fixture.nodes.every((n) => !n.binding || !('binding' in n.binding))).toBe(true);
  });

  it('counts per state equal a count taken straight from the payload', () => {
    const expected = {};
    for (const n of fixture.nodes) {
      const s = n.binding ? (n.binding.health ? n.binding.health.state : 'no_data') : 'unbound';
      expected[s] = (expected[s] || 0) + 1;
    }
    for (const s of STATES) expect(v.summary.counts[s]).toBe(expected[s] || 0);
    expect(Object.values(v.summary.counts).reduce((a, b) => a + b, 0)).toBe(fixture.nodes.length);
  });

  it('accounts for every declared edge: drawn or dropped', () => {
    expect(v.edges.length + v.dropped.edges).toBe(fixture.graph.edges.length);
  });
});

describe('pending edges', () => {
  it('exposes pending_edges as summary.pendingEdges, 0 when absent', () => {
    expect(toPipelineView(detail({ pending_edges: 15 })).summary.pendingEdges).toBe(15);
    expect(toPipelineView(detail()).summary.pendingEdges).toBe(0);
  });
});
