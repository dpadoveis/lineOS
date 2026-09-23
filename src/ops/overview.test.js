import { describe, expect, it } from 'vitest';
import { filtersActive, hasError, layerSummary, oneHop, tableRows } from './overview.js';

const N = (uid, state, externalId, extra = {}) => ({
  uid, state, kind: externalId.includes('.') ? 'dataset' : 'dag', label: uid.toUpperCase(), externalId,
  lastRun: null, lastCheck: null, ...extra
});
const view = {
  nodes: [
    N('b1', 'ok', 'bronze.stg_a', { lastCheck: { row_count: 10 } }),
    N('b2', 'no_data', 'bronze.stg_b', { lastCheck: { row_count: 500 } }),
    N('j', 'broken', 'dag_silver', { lastRun: { started_at: '2026-09-22T02:00:00Z' } }),
    N('s', 'ok', 'silver.table_a', { lastCheck: { row_count: 19456 } }),
    N('g', 'ok', 'gold.table_a')
  ],
  edges: [{ id: '1', source: 'b1', target: 'j' }, { id: '2', source: 'b2', target: 'j' },
    { id: '3', source: 'j', target: 's' }, { id: '4', source: 's', target: 'g' }]
};
const layers = new Map([['b1', 'bronze'], ['b2', 'bronze'], ['j', 'silver'], ['s', 'silver'], ['g', 'gold']]);
const risk = new Map([['s', ['j']], ['g', ['j']]]);

describe('layerSummary', () => {
  it('counts per layer, in LAYERS order, skipping empty layers', () => {
    const s = layerSummary(view, layers, risk);
    expect(s.map((x) => x.layer)).toEqual(['bronze', 'silver', 'gold']);
    expect(s[0]).toMatchObject({ total: 2, atRisk: 0 });
    expect(s[0].counts).toMatchObject({ ok: 1, no_data: 1 });
    expect(s[1]).toMatchObject({ total: 2, atRisk: 1 });
    expect(s[1].counts).toMatchObject({ broken: 1, ok: 1 });
  });
});

describe('tableRows', () => {
  const opts = (o) => ({ layer: null, query: '', sort: { key: 'severity', dir: 'asc' }, ...o });
  it('defaults to severity order with at-risk after late', () => {
    expect(tableRows(view, layers, risk, opts()).map((n) => n.uid)).toEqual(['j', 'g', 's', 'b2', 'b1']);
  });
  it('filters by layer and by query', () => {
    expect(tableRows(view, layers, risk, opts({ layer: 'bronze' })).map((n) => n.uid)).toEqual(['b2', 'b1']);
    expect(tableRows(view, layers, risk, opts({ query: 'table_a' })).map((n) => n.uid)).toEqual(['s']);
  });
  it('sorts by rows, missing values last in both directions', () => {
    const asc = tableRows(view, layers, risk, opts({ sort: { key: 'rows', dir: 'asc' } })).map((n) => n.uid);
    expect(asc).toEqual(['b1', 'b2', 's', 'g', 'j']); // missing rows last, by label
    const desc = tableRows(view, layers, risk, opts({ sort: { key: 'rows', dir: 'desc' } })).map((n) => n.uid);
    expect(desc).toEqual(['s', 'b2', 'b1', 'g', 'j']);
  });
  it('sorts by name and by layer', () => {
    expect(tableRows(view, layers, risk, opts({ sort: { key: 'name', dir: 'asc' } })).map((n) => n.uid))
      .toEqual(['b1', 'b2', 'g', 'j', 's']);
    expect(tableRows(view, layers, risk, opts({ sort: { key: 'layer', dir: 'asc' } }))[0].uid).toMatch(/^b/);
  });
});

describe('oneHop', () => {
  it('lists direct producers and consumers only', () => {
    expect(oneHop('j', view.edges)).toEqual({ upstream: ['b1', 'b2'], downstream: ['s'] });
    expect(oneHop('g', view.edges)).toEqual({ upstream: ['s'], downstream: [] });
  });
});

describe('filters', () => {
  const opts = (f, o = {}) => ({ layer: null, query: '', sort: { key: 'name', dir: 'asc' },
    filters: { kinds: [], state: null, riskOnly: false, errorsOnly: false, ...f }, ...o });
  const ids = (o) => tableRows(view, layers, risk, o).map((n) => n.uid);
  it('by kind', () => {
    expect(ids(opts({ kinds: ['dag'] }))).toEqual(['j']);
    expect(ids(opts({ kinds: ['dag', 'dataset'] }))).toHaveLength(5);
  });
  it('by state, at risk, and errors', () => {
    expect(ids(opts({ state: 'ok' }))).toEqual(['b1', 'g', 's']);
    expect(ids(opts({ riskOnly: true }))).toEqual(['g', 's']);
    const withErr = { ...view, nodes: view.nodes.map((n) => (n.uid === 'j' ? { ...n, run: 'failed' } : n)) };
    expect(tableRows(withErr, layers, risk, opts({ errorsOnly: true })).map((n) => n.uid)).toEqual(['j']);
  });
  it('hasError: failed run or failed check', () => {
    expect(hasError({ run: 'failed', lastCheck: null })).toBe(true);
    expect(hasError({ run: 'none', lastCheck: { ok: false } })).toBe(true);
    expect(hasError({ run: 'success', lastCheck: { ok: true } })).toBe(false);
  });
  it('filtersActive', () => {
    expect(filtersActive(opts({}))).toBe(false);
    expect(filtersActive(opts({ riskOnly: true }))).toBe(true);
    expect(filtersActive(opts({}, { query: ' x ' }))).toBe(true);
    expect(filtersActive(opts({}, { layer: 'gold' }))).toBe(true);
  });
});
