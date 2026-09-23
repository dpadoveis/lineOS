import { NODE_WIDTH } from './constants.js';
import { metaPanelHeight, nodeWidth, snapValue } from './geometry.js';

// Assigns each node a column (layer) by longest path from sources, reserves
// dummy slots in intermediate layers for edges that skip layers, then runs a
// few barycenter passes to reduce crossings before packing each column
// vertically -- so organized nodes never overlap each other or a passing edge.
export function organizeLayout(nodes, edges, nh) {
  if (!nodes.length) return { positions: {}, layerCount: 0 };

  const has = {};
  nodes.forEach((n) => (has[n.id] = true));
  const validEdges = edges.filter((e) => has[e.from] && has[e.to]);

  const layer = {};
  nodes.forEach((n) => (layer[n.id] = 0));
  for (let p = 0; p < nodes.length + 1; p++) {
    let moved = false;
    validEdges.forEach((e) => {
      if (layer[e.to] < layer[e.from] + 1 && layer[e.from] + 1 <= nodes.length) {
        layer[e.to] = layer[e.from] + 1;
        moved = true;
      }
    });
    if (!moved) break;
  }

  const cols = {};
  const push = (L, it) => {
    (cols[L] = cols[L] || []).push(it);
  };
  // The reserved height includes the metadata panel hanging below the card:
  // without it, the neighbour underneath would climb over it.
  nodes.forEach((n) =>
    push(layer[n.id], { key: 'n' + n.id, node: n, h: nh(n) + metaPanelHeight(n), w: nodeWidth(n), y0: n.y })
  );

  const adj = {};
  const link = (a, b) => {
    (adj[a] = adj[a] || []).push(b);
    (adj[b] = adj[b] || []).push(a);
  };
  validEdges.forEach((e) => {
    const a = layer[e.from], b = layer[e.to];
    const lo = Math.min(a, b), hi = Math.max(a, b);
    let prev = 'n' + (a < b ? e.from : e.to);
    for (let L = lo + 1; L < hi; L++) {
      const key = 'd' + e.id + '_' + L;
      push(L, { key, h: 34, y0: (nodes.find((n) => n.id === e.from).y + nodes.find((n) => n.id === e.to).y) / 2 });
      link(prev, key);
      prev = key;
    }
    link(prev, 'n' + (a < b ? e.to : e.from));
  });

  const keys = Object.keys(cols).map(Number).sort((x, y) => x - y);
  keys.forEach((L) => cols[L].sort((a, b) => a.y0 - b.y0));
  const pos = {};
  const reindex = () => keys.forEach((L) => cols[L].forEach((it, i) => (pos[it.key] = i)));
  reindex();
  for (let pass = 0; pass < 4; pass++) {
    const seq = pass % 2 ? keys.slice().reverse() : keys;
    seq.forEach((L) => {
      cols[L].forEach((it) => {
        const ns = (adj[it.key] || []).map((k) => pos[k]).filter((v) => v !== undefined);
        it.bary = ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : pos[it.key];
      });
      cols[L].sort((a, b) => a.bary - b.bary);
      reindex();
    });
  }

  // Each column is as wide as the widest node it holds: with resized nodes, a
  // fixed width would leave neighbours overlapping.
  const gapX = 150, gapY = 52;
  const colWidths = keys.map((L) => cols[L].reduce((m, it) => Math.max(m, it.w || NODE_WIDTH), NODE_WIDTH));
  const totalW = colWidths.reduce((a, w) => a + w + gapX, -gapX);
  const positions = {};
  let x = -totalW / 2;
  keys.forEach((L, ci) => {
    const col = cols[L];
    const total = col.reduce((s, it) => s + it.h + gapY, -gapY);
    let y = -total / 2;
    // Columns centred against each other: the narrowest node lines up with the
    // middle of the band, as happened when they all had the same width.
    col.forEach((it) => {
      if (it.node) positions[it.node.id] = { x: snapValue(x + (colWidths[ci] - (it.w || NODE_WIDTH)) / 2), y: snapValue(y) };
      y += it.h + gapY;
    });
    x += colWidths[ci] + gapX;
  });

  return { positions, layerCount: keys.length };
}
