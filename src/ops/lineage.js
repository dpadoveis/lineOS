// What stays lit on the canvas. Lineage is everything upstream of a node plus
// everything downstream of it -- not its whole connected component: a sibling
// branch that shares an ancestor did not stop because this node did.

function reach(start, adjacency) {
  const seen = new Set();
  const stack = [start];
  while (stack.length) {
    const u = stack.pop();
    for (const v of adjacency.get(u) || []) {
      if (!seen.has(v)) {
        seen.add(v);
        stack.push(v);
      }
    }
  }
  return seen;
}

export function lineageOf(uid, edges) {
  if (!uid) return null;
  const out = new Map();
  const inc = new Map();
  for (const e of edges) {
    if (!out.has(e.source)) out.set(e.source, []);
    if (!inc.has(e.target)) inc.set(e.target, []);
    out.get(e.source).push(e.target);
    inc.get(e.target).push(e.source);
  }
  return new Set([uid, ...reach(uid, out), ...reach(uid, inc)]);
}

// Downstream of every broken or late node, naming which sources put it at risk.
// A derived reading, never a health state; a source is not at risk of itself.
export function atRisk(view) {
  const out = new Map();
  for (const e of view.edges) {
    if (!out.has(e.source)) out.set(e.source, []);
    out.get(e.source).push(e.target);
  }
  const sources = view.nodes.filter((n) => n.state === 'broken' || n.state === 'late').map((n) => n.uid);
  const sourceSet = new Set(sources);
  const risk = new Map();
  for (const s of sources) {
    for (const uid of reach(s, out)) {
      if (sourceSet.has(uid)) continue;
      if (!risk.has(uid)) risk.set(uid, []);
      risk.get(uid).push(s);
    }
  }
  return risk;
}

// null means "dim nothing". A selection wins over a state filter.
export function focusSet(view, { selected, filter }, risk = new Map()) {
  if (selected) return lineageOf(selected, view.edges);
  if (filter === 'at_risk') return new Set(risk.keys());
  if (filter) return new Set(view.nodes.filter((n) => n.state === filter).map((n) => n.uid));
  return null;
}
