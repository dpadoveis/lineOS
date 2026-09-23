import { GROUP_COLOR, GROUP_MIN_HEIGHT, GROUP_MIN_WIDTH } from './constants.js';
import { clampGroupHeight, clampGroupWidth, newUid, nextId, snapValue } from './geometry.js';

export function nodePayload(n) {
  return {
    kind: 'flow-node',
    version: 1,
    node: {
      name: n.n,
      // The nickname the user gave (null while the node still uses the stack
      // name). `name` stays the tool's name, and the editor prints it below
      // the nickname.
      label: n.label || null,
      category: n.c,
      initials: n.k,
      color: n.col,
      x: Math.round(n.x),
      y: Math.round(-n.y),
      // Explicit size, when the node was resized by hand; null returns to the
      // default (232 wide, height dictated by the content).
      width: n.w ? Math.round(n.w) : null,
      height: n.h ? Math.round(n.h) : null,
      description: n.desc || null,
      metadata: (n.meta || []).reduce((a, m) => {
        if (m.k) a[m.k] = m.v;
        return a;
      }, {}),
      // Slug of the custom tool this node came from (null for the built-in
      // catalog). Only the icon is resolved through it at draw time: name,
      // colour and initials are already copied above, so a tool deleted from
      // the catalog degrades to the initials without breaking the graph.
      tool: n.tool || null,
      // Id of the group whose box holds this node, or null. It is derived from
      // the coordinates (see reconcileGroups), and travels only so that
      // reopening the flow does not have to re-measure every card to know it.
      group: n.g || null,
      // Stable across versions; see newUid in geometry.js.
      uid: n.uid || null
    }
  };
}

// A group box. `y` is inverted like a node's, so the whole document shares one
// axis convention.
export function groupPayload(g) {
  return {
    id: g.id,
    name: g.name || 'Group',
    x: Math.round(g.x),
    y: Math.round(-g.y),
    width: Math.round(g.w),
    height: Math.round(g.h),
    color: g.col || GROUP_COLOR
  };
}

export function flowPayload(nodes, edges, groups) {
  return {
    kind: 'flow-graph',
    version: 1,
    nodes: nodes.map((n) => Object.assign({ id: n.id }, nodePayload(n).node)),
    edges: edges.map((e) => ({ id: e.id, from: e.from, to: e.to, label: e.label || null })),
    groups: (groups || []).map(groupPayload)
  };
}

export function nodeFromPayload(payload, nodes, at) {
  const d = payload && payload.node;
  if (!d) return null;
  const id = nextId(nodes);
  const meta = Object.keys(d.metadata || {}).map((k) => ({ k, v: String(d.metadata[k]) }));
  return {
    id,
    n: d.name || 'Node',
    label: d.label || null,
    c: d.category || 'CUSTOM',
    k: d.initials || 'ND',
    col: d.color || '#9aa4b0',
    x: snapValue(at ? at.x : (d.x || 0) + 48),
    y: snapValue(at ? at.y : -(d.y || 0) + 48),
    w: d.width || null,
    h: d.height || null,
    desc: d.description || null,
    meta,
    tool: d.tool || null,
    // Membership is not pasted: where the node LANDS is what decides, and the
    // editor settles that right after inserting it.
    g: null,
    uid: newUid()
  };
}

export function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 400);
}

export function isFlowGraph(p) {
  return !!p && p.kind === 'flow-graph' && p.version === 1 && Array.isArray(p.nodes) && Array.isArray(p.edges);
}

// The inverse of flowPayload: rebuilds the editor's state from the format
// stored on the server (or from a pasted flow.json). It undoes the y-axis
// inversion, converts metadata (an object) back into the ordered meta:[{k,v}]
// array, and preserves the original ids, so the arrows keep pointing right.
export function flowFromPayload(p) {
  if (!isFlowGraph(p)) return null;
  const nodes = p.nodes.map((d, i) => ({
    id: Number.isInteger(d.id) && d.id > 0 ? d.id : i + 1,
    n: d.name || 'Node',
    label: d.label || null,
    c: d.category || 'CUSTOM',
    k: d.initials || 'ND',
    col: d.color || '#9aa4b0',
    x: snapValue(d.x || 0),
    y: snapValue(-(d.y || 0)),
    w: d.width || null,
    h: d.height || null,
    desc: d.description || null,
    meta: Object.keys(d.metadata || {}).map((k) => ({ k, v: String(d.metadata[k]) })),
    tool: d.tool || null,
    g: Number.isInteger(d.group) && d.group > 0 ? d.group : null,
    uid: d.uid || newUid()
  }));
  // `groups` arrived with this feature: a flow saved before it simply has none.
  const groups = (Array.isArray(p.groups) ? p.groups : []).map((d, i) => ({
    id: Number.isInteger(d.id) && d.id > 0 ? d.id : i + 1,
    name: d.name || 'Group',
    x: snapValue(d.x || 0),
    y: snapValue(-(d.y || 0)),
    w: clampGroupWidth(d.width || GROUP_MIN_WIDTH),
    h: clampGroupHeight(d.height || GROUP_MIN_HEIGHT),
    col: d.color || GROUP_COLOR
  }));
  const boxes = new Set(groups.map((g) => g.id));
  nodes.forEach((n) => {
    if (n.g !== null && !boxes.has(n.g)) n.g = null;
  });
  const known = new Set(nodes.map((n) => n.id));
  const edges = p.edges
    .filter((e) => known.has(e.from) && known.has(e.to))
    .map((e, i) => ({
      id: Number.isInteger(e.id) && e.id > 0 ? e.id : i + 1,
      from: e.from,
      to: e.to,
      label: e.label === undefined ? null : e.label
    }));
  return { nodes, edges, groups };
}
