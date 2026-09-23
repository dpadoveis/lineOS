import { LAYERS, STATES, bySeverity, matches } from './view.js';

// The Overview tab's numbers and rows, derived from the view only.

export function layerSummary(view, layers, risk) {
  return LAYERS.map((layer) => {
    const nodes = view.nodes.filter((n) => layers.get(n.uid) === layer);
    const counts = Object.fromEntries(STATES.map((s) => [s, 0]));
    nodes.forEach((n) => {
      counts[n.state] += 1;
    });
    return { layer, total: nodes.length, counts, atRisk: nodes.filter((n) => risk.has(n.uid)).length };
  }).filter((s) => s.total > 0);
}

const VALUE = {
  name: (n) => n.label.toLowerCase(),
  layer: (n, layers) => LAYERS.indexOf(layers.get(n.uid)),
  health: (n) => STATES.indexOf(n.state),
  lastRun: (n) => (n.lastRun && n.lastRun.started_at ? Date.parse(n.lastRun.started_at) : null),
  rows: (n) => (n.lastCheck && n.lastCheck.row_count != null ? n.lastCheck.row_count : null)
};

// A node with an error: its last run failed, or its last check did.
export function hasError(node) {
  return node.run === 'failed' || !!(node.lastCheck && node.lastCheck.ok === false);
}

// True when anything narrows the table (and so dims the canvas).
export function filtersActive({ layer, query, filters }) {
  const f = filters || {};
  return !!(layer || String(query || '').trim() || (f.kinds && f.kinds.length) || f.state || f.riskOnly || f.errorsOnly);
}

export function tableRows(view, layers, risk, { layer, query, sort, filters }) {
  const f = filters || {};
  const rows = view.nodes.filter(
    (n) =>
      (!layer || layers.get(n.uid) === layer) &&
      matches(n, query) &&
      (!f.kinds || !f.kinds.length || f.kinds.includes(n.kind)) &&
      (!f.state || n.state === f.state) &&
      (!f.riskOnly || risk.has(n.uid)) &&
      (!f.errorsOnly || hasError(n))
  );
  if (!VALUE[sort.key]) return bySeverity(rows, risk);
  const get = VALUE[sort.key];
  const sign = sort.dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const va = get(a, layers);
    const vb = get(b, layers);
    if (va === null && vb === null) return a.label.localeCompare(b.label);
    if (va === null) return 1; // missing values last, whichever the direction
    if (vb === null) return -1;
    if (va < vb) return -sign;
    if (va > vb) return sign;
    return a.label.localeCompare(b.label);
  });
}

export function oneHop(uid, edges) {
  return {
    upstream: edges.filter((e) => e.target === uid).map((e) => e.source),
    downstream: edges.filter((e) => e.source === uid).map((e) => e.target)
  };
}
