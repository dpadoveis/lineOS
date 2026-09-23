// The ONE place that reads GET /api/pipelines/{slug}. The bar, the list and the
// canvas read what this returns and never the payload, so they cannot disagree
// about a count again. The traps it exists for (spec §4):
//
//   - health lives at node.binding.health.state -- one level, never
//     binding.binding (the first screen read one level too deep and reported
//     every node as "no data");
//   - binding === null is `unbound`, which is not `no_data` ("bound, never seen");
//   - graph.nodes are flat, not wrapped in {node: {...}} (that is the clipboard
//     format);
//   - graph.edges point at the numeric node id, not the uid.

export const STATES = ['broken', 'late', 'no_data', 'skipped', 'ok', 'unbound'];
const KNOWN = new Set(STATES);
const KIND = { airflow_dag: 'dag', cron_job: 'cron', table: 'dataset' };
const NEUTRAL = '#8b939e';

export const LAYERS = ['bronze', 'silver', 'gold', 'other'];
const RUN = new Set(['success', 'failed', 'running', 'skipped']);

// What the card's outline shows: the last run for a job, the last check for a
// table. Not the health state -- a `late` job's last run can be a success.
export function runStatus(node) {
  if (node.kind === 'dataset') {
    if (!node.lastCheck) return 'none';
    return node.lastCheck.ok ? 'success' : 'failed';
  }
  const o = node.lastRun && node.lastRun.outcome;
  return RUN.has(o) ? o : 'none';
}

function tableLayer(externalId) {
  const schema = String(externalId || '').split('.')[0];
  return LAYERS.includes(schema) && schema !== 'other' ? schema : 'other';
}

// A table's layer is its schema; a job's is that of the first table it writes.
export function layersOf(view) {
  const byUid = new Map(view.nodes.map((n) => [n.uid, n]));
  const layers = new Map();
  for (const n of view.nodes) {
    if (n.kind === 'dataset') layers.set(n.uid, tableLayer(n.externalId));
  }
  for (const n of view.nodes) {
    if (layers.has(n.uid)) continue;
    const out = view.edges.find((e) => e.source === n.uid && byUid.get(e.target) && byUid.get(e.target).kind === 'dataset');
    layers.set(n.uid, out ? tableLayer(byUid.get(out.target).externalId) : 'other');
  }
  return layers;
}

export function matches(node, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  return node.label.toLowerCase().includes(q) || String(node.externalId || '').toLowerCase().includes(q);
}

function stateOf(binding) {
  if (!binding) return 'unbound';
  const s = binding.health && binding.health.state;
  return KNOWN.has(s) && s !== 'unbound' ? s : 'no_data';
}

export function toPipelineView(detail) {
  const graph = detail.graph || {};
  const graphNodes = (graph.nodes || []).filter((g) => g && g.uid);
  const graphByUid = new Map(graphNodes.map((g) => [g.uid, g]));
  const uidById = new Map(graphNodes.map((g) => [g.id, g.uid]));

  const nodes = (detail.nodes || []).map((n) => {
    const g = graphByUid.get(n.uid) || {};
    const b = n.binding || null;
    const label = n.title || n.name || 'Node';
    const node = {
      uid: n.uid,
      kind: b ? KIND[b.object.kind] || 'dataset' : 'unbound',
      state: stateOf(b),
      label,
      externalId: b ? b.object.external_id : n.name || '',
      category: g.category || n.category || '',
      color: /^#[0-9a-f]{6}$/i.test(g.color || '') ? g.color : NEUTRAL,
      initials: g.initials || label.slice(0, 2).toUpperCase(),
      health: b && b.health ? { state: b.health.state, reason: b.health.reason, since: b.health.since } : null,
      lastRun: b ? b.last_run || null : null,
      lastCheck: b ? b.last_check || null : null,
      objectId: b ? b.object.id : null,
      attrs: b ? b.object.attrs || {} : {},
      expected: b ? b.expected || null : null,
      durationMedianMs: b ? b.duration_median_ms || null : null
    };
    return { ...node, run: runStatus(node) };
  });

  const present = new Set(nodes.map((n) => n.uid));
  const edges = [];
  let droppedEdges = 0;
  for (const e of graph.edges || []) {
    const source = uidById.get(e.from);
    const target = uidById.get(e.to);
    if (source && target && present.has(source) && present.has(target)) {
      edges.push({ id: String(e.id), source, target });
    } else {
      droppedEdges += 1;
    }
  }

  const counts = Object.fromEntries(STATES.map((s) => [s, 0]));
  nodes.forEach((n) => {
    counts[n.state] += 1;
  });

  return {
    meta: { name: detail.name, slug: detail.slug, flowSlug: detail.flow_slug },
    summary: {
      state: detail.state,
      collectedAgeS: detail.collected_age_s === undefined ? null : detail.collected_age_s,
      counts,
      pendingEdges: detail.pending_edges || 0
    },
    nodes,
    edges,
    dropped: { edges: droppedEdges },
    orphans: (detail.orphaned_bindings || []).map((o) => o.object.display_name)
  };
}

// Worst first, then by label. An at-risk node ranks right after `late`, whatever
// its own state: it is what stops next.
export function bySeverity(nodes, risk = new Map()) {
  const rank = (n) => {
    const i = STATES.indexOf(n.state);
    if (risk.has(n.uid) && i > STATES.indexOf('late')) return STATES.indexOf('late') + 0.5;
    return i;
  };
  return [...nodes].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
}
