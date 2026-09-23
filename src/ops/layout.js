// Left-to-right layered layout with elkjs, computed in the browser: the graph's
// stored x/y belong to the drawing, not to this view (spec §5.2).
//
// Nodes nobody connects to (tables nothing declares a producer for) are kept
// out of the layered graph -- laid out, they pile into column 0 and make the map
// unreadable. They get a grid below it, shown only when the canvas expands them.
//
// elkjs is imported lazily from here only, so the editor's bundle never
// carries it.

import { LAYERS, layersOf } from './view.js';

export const NODE_W = 264; // bigger than the editor's 232 card, for legibility zoomed out
export const NODE_H = 112;
const GAP = 48;
const GRID_COLUMNS = 6;

let enginePromise = null;
function engine() {
  if (!enginePromise) {
    enginePromise = import('elkjs/lib/elk.bundled.js').then((m) => new (m.default || m)());
  }
  return enginePromise;
}

export async function layout(view) {
  const linked = new Set();
  view.edges.forEach((e) => {
    linked.add(e.source);
    linked.add(e.target);
  });
  const main = view.nodes.filter((n) => linked.has(n.uid));
  const unconnected = view.nodes.filter((n) => !linked.has(n.uid)).map((n) => n.uid);
  const positions = {};
  let bottom = 0;
  const layers = layersOf(view);

  if (main.length) {
    const elk = await engine();
    const edges = view.edges
      .filter((e) => e.source !== e.target)
      .map((e) => ({ id: 'e' + e.id, sources: [e.source], targets: [e.target] }));
    const graph = (partitioned) => ({
      id: 'root',
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': 'RIGHT',
        'elk.edgeRouting': 'ORTHOGONAL',
        'elk.layered.spacing.nodeNodeBetweenLayers': '96',
        'elk.spacing.nodeNode': '32',
        ...(partitioned ? { 'elk.partitioning.activate': 'true' } : {})
      },
      children: main.map((n) => ({
        id: n.uid,
        width: NODE_W,
        height: NODE_H,
        ...(partitioned ? { layoutOptions: { 'elk.partitioning.partition': String(LAYERS.indexOf(layers.get(n.uid))) } } : {})
      })),
      // Self-loops carry no layering information; they are still drawn.
      edges
    });
    // A back edge across partitions must not blank the map: retry once without
    // partitioning if elk rejects the partitioned graph.
    let result;
    try {
      result = await elk.layout(graph(true));
    } catch {
      result = await elk.layout(graph(false));
    }
    for (const c of result.children) {
      positions[c.id] = { x: c.x, y: c.y };
      bottom = Math.max(bottom, c.y + NODE_H);
    }
  }

  const top = main.length ? bottom + 2 * GAP : 0;
  unconnected.forEach((uid, i) => {
    positions[uid] = {
      x: (i % GRID_COLUMNS) * (NODE_W + GAP),
      y: top + Math.floor(i / GRID_COLUMNS) * (NODE_H + GAP)
    };
  });

  const bands = [];
  for (const layer of LAYERS) {
    const xs = main.filter((n) => layers.get(n.uid) === layer).map((n) => positions[n.uid]);
    if (!xs.length) continue;
    bands.push({
      layer,
      x0: Math.min(...xs.map((p) => p.x)) - GAP / 2,
      x1: Math.max(...xs.map((p) => p.x)) + NODE_W + GAP / 2,
      y0: Math.min(...xs.map((p) => p.y)) - GAP,
      y1: Math.max(...xs.map((p) => p.y)) + NODE_H + GAP / 2
    });
  }
  return { positions, unconnected, bands };
}
