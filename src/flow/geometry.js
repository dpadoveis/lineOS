import {
  EDGE_STYLE,
  GROUP_HEAD,
  GROUP_MAX_HEIGHT,
  GROUP_MAX_WIDTH,
  GROUP_MIN_HEIGHT,
  GROUP_MIN_WIDTH,
  GROUP_PAD,
  META_GAP,
  META_HEAD_HEIGHT,
  META_ROW_HEIGHT,
  NODE_WIDTH
} from './constants.js';

export function nextId(list) {
  return list.reduce((m, i) => Math.max(m, i.id), 0) + 1;
}

// A node's identity that survives editing. `nextId` above is max(id)+1, which
// is reused after a deletion -- fine for arrows inside one document, wrong for
// an operational binding that has to mean the same node next week.
export function newUid() {
  if (globalThis.crypto && globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
  return 'n-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// Node width: the explicit one, when the user has resized it; otherwise the
// catalog default.
export function nodeWidth(n) {
  return n.w || NODE_WIDTH;
}

export function nodeHeight(n, heights) {
  // An explicit (resized) height wins: the measured DOM agrees with it, and it
  // also applies off-screen (PNG export, organize).
  if (n.h) return n.h;
  if (heights[n.id]) return heights[n.id];
  // The metadata panel is attached below the card, not inside it, so it does
  // not enter this estimate — see metaPanelHeight().
  return 90 + (n.desc !== null && n.desc !== undefined ? 62 : 0);
}

// Height of the metadata dropdown hanging below the node, gap included; 0 when
// there is nothing to show. Used to keep the panel clear of whatever the
// automatic layout puts underneath, and to size the PNG export.
export function metaPanelHeight(n) {
  const rows = (n.meta || []).length;
  if (!rows || n.metaOpen === false) return 0;
  return META_GAP + META_HEAD_HEIGHT + rows * META_ROW_HEIGHT;
}

export function nodeCenter(n, heights) {
  return { x: n.x + nodeWidth(n) / 2, y: n.y + nodeHeight(n, heights) / 2 };
}

export function clipToBorder(a, b, hgt, wid) {
  const dx = b.x - a.x, dy = b.y - a.y;
  if (!dx && !dy) return a;
  const hw = (wid || NODE_WIDTH) / 2 + 9, hh = hgt / 2 + 9;
  const tx = dx ? hw / Math.abs(dx) : Infinity;
  const ty = dy ? hh / Math.abs(dy) : Infinity;
  const t = Math.min(tx, ty, 1);
  return { x: a.x + dx * t, y: a.y + dy * t };
}

export function controlPoints(s, t) {
  const dx = t.x - s.x;
  const c = Math.max(60, Math.abs(dx) * 0.45) * (dx < 0 ? -1 : 1);
  return [{ x: s.x + c, y: s.y }, { x: t.x - c, y: t.y }];
}

// A straight segment, used by the rubber band while it points at open plane:
// the bezier's endpoints are always horizontal, so its arrowhead would keep
// pointing sideways however the mouse moves. A line's head points AT the
// cursor, which is the whole feedback of the gesture.
export function straightPath(s, t) {
  return 'M' + s.x + ',' + s.y + ' L' + t.x + ',' + t.y;
}

export function pathFor(s, t) {
  if (EDGE_STYLE === 'straight') return 'M' + s.x + ',' + s.y + ' L' + t.x + ',' + t.y;
  const c = controlPoints(s, t);
  return 'M' + s.x + ',' + s.y + ' C' + c[0].x + ',' + c[0].y + ' ' + c[1].x + ',' + c[1].y + ' ' + t.x + ',' + t.y;
}

export function midPoint(s, t) {
  if (EDGE_STYLE === 'straight') return { x: (s.x + t.x) / 2, y: (s.y + t.y) / 2 };
  const c = controlPoints(s, t);
  return { x: (s.x + 3 * c[0].x + 3 * c[1].x + t.x) / 8, y: (s.y + 3 * c[0].y + 3 * c[1].y + t.y) / 8 };
}

export function shade(hex, f) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  const r = Math.round(((n >> 16) & 255) * f), g = Math.round(((n >> 8) & 255) * f), b = Math.round((n & 255) * f);
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
}

export function snapValue(v) {
  return Math.round(v / 24) * 24;
}

// ── Groups ──────────────────────────────────────────────────────────
// The box holds no list of members: belonging to a group is a fact about
// POSITION, recomputed whenever a drag ends. So dragging a node out of the box
// takes it out of the group, and dropping one inside puts it in, with no
// bookkeeping on either side.

export function clampGroupWidth(v) {
  return Math.round(Math.max(GROUP_MIN_WIDTH, Math.min(GROUP_MAX_WIDTH, v)));
}
export function clampGroupHeight(v) {
  return Math.round(Math.max(GROUP_MIN_HEIGHT, Math.min(GROUP_MAX_HEIGHT, v)));
}

export function groupContains(g, p) {
  return p.x >= g.x && p.x <= g.x + g.w && p.y >= g.y && p.y <= g.y + g.h;
}

// The topmost box under the point. Later boxes are drawn over earlier ones, so
// the search runs backwards and overlapping groups resolve the way they look.
export function groupForPoint(groups, p) {
  for (let i = groups.length - 1; i >= 0; i--) {
    if (groupContains(groups[i], p)) return groups[i];
  }
  return null;
}

// The group a node belongs to at rest: the one holding its CENTRE. The centre
// (rather than the whole card) means a node half out of the box still has an
// unambiguous answer, and the user sees the same thing the code decides.
export function groupForNode(groups, n, heights) {
  const g = groupForPoint(groups, nodeCenter(n, heights));
  return g ? g.id : null;
}

// Rewrites `g` on every node from geometry alone. Returns the SAME array when
// nothing moved between boxes, so React skips the re-render and the undo
// history gains no empty step.
export function reconcileGroups(nodes, groups, heights) {
  let changed = false;
  const out = nodes.map((n) => {
    const g = groupForNode(groups, n, heights);
    if ((n.g || null) === g) return n;
    changed = true;
    return { ...n, g };
  });
  return changed ? out : nodes;
}

// The rectangle enclosing a set of nodes, padded, with room at the top for the
// title bar. Used both to draw a box around a selection and to shrink one back
// onto what it holds.
export function boundsForGroup(list, heights) {
  if (!list.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  list.forEach((n) => {
    x0 = Math.min(x0, n.x);
    y0 = Math.min(y0, n.y);
    x1 = Math.max(x1, n.x + nodeWidth(n));
    // The metadata panel hangs below the card: it is part of what the eye sees
    // inside the box, so it is part of what the box has to cover.
    y1 = Math.max(y1, n.y + nodeHeight(n, heights) + metaPanelHeight(n));
  });
  const x = snapValue(x0 - GROUP_PAD);
  const y = snapValue(y0 - GROUP_PAD - GROUP_HEAD);
  return {
    x,
    y,
    w: clampGroupWidth(snapValue(x1 + GROUP_PAD) - x),
    h: clampGroupHeight(snapValue(y1 + GROUP_PAD) - y)
  };
}
