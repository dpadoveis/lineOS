import { useEffect, useRef, useState } from 'react';
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  ViewportPortal,
  useReactFlow
} from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import './canvas.css';
import OpsNode from './OpsNode.jsx';
import { NODE_H, NODE_W, layout } from '../layout.js';
import { focusSet, lineageOf } from '../lineage.js';
import { ACCENT } from '../../flow/constants.js';
import { shade } from '../../flow/geometry.js';

const nodeTypes = { ops: OpsNode };
// The editor's selected-edge colour, used for the lit lineage.
const LINEAGE = '#f5d896';
// Minimap fills: the badge text colours of ops.css.
const MINIMAP = { ok: '#6dddb8', skipped: '#8fd5b8', late: '#ffc93a', broken: '#ff6b5b', no_data: '#999999', unbound: '#5c6572' };

function Canvas({ view, selected, filter, focus, onSelect, risk, matchSet }) {
  const rf = useReactFlow();
  const [placed, setPlaced] = useState(null);
  const [showUnconnected, setShowUnconnected] = useState(false);

  // Re-layout only when the graph's shape changes, not on every 30 s refresh.
  const shape = view.nodes.map((n) => n.uid).join('|') + '#' + view.edges.map((e) => e.id).join('|');
  useEffect(() => {
    let alive = true;
    layout(view).then((r) => alive && setPlaced(r));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape]);

  // The edges through a ref: the 30 s refresh hands a new array each time, and
  // re-framing on every refresh would yank the view away from the user.
  const edgesRef = useRef(view.edges);
  edgesRef.current = view.edges;

  // Selecting a node frames its whole lineage -- everything upstream and
  // downstream -- not just the node, so the flow it belongs to is on screen.
  useEffect(() => {
    if (!focus || !placed) return;
    const p = placed.positions[focus.uid];
    if (!p) return;
    if (placed.unconnected.includes(focus.uid)) setShowUnconnected(true);
    const flow = [...(lineageOf(focus.uid, edgesRef.current) || [])].filter((uid) => placed.positions[uid]);
    requestAnimationFrame(() => {
      if (flow.length > 1) {
        rf.fitView({ nodes: flow.map((id) => ({ id })), padding: 0.15, duration: 450, maxZoom: 1.1 });
      } else {
        rf.setCenter(p.x + NODE_W / 2, p.y + NODE_H / 2, { zoom: 1, duration: 400 });
      }
    });
  }, [focus, placed, rf]);

  if (!view.nodes.length) return <div className="ops-canvas ops-canvas-wait">No nodes in this pipeline.</div>;
  if (!placed) return <div className="ops-canvas ops-canvas-wait">laying out…</div>;

  const light = document.documentElement.getAttribute('data-theme') === 'light';
  const accent = light ? shade(ACCENT, 0.62) : ACCENT;
  const lit = focusSet(view, { selected, filter }, risk);
  let finalLit = lit;
  if (matchSet && !selected) {
    finalLit = lit ? new Set([...lit].filter((uid) => matchSet.has(uid))) : matchSet;
  }
  const hidden = new Set(showUnconnected ? [] : placed.unconnected);
  const now = Date.now();
  const labelOf = (uid) => (view.nodes.find((x) => x.uid === uid) || { label: uid }).label;

  const nodes = view.nodes
    .filter((n) => !hidden.has(n.uid) && placed.positions[n.uid])
    .map((n) => ({
      id: n.uid,
      type: 'ops',
      position: placed.positions[n.uid],
      data: {
        node: n,
        dimmed: !!finalLit && !finalLit.has(n.uid),
        lit: !!selected && n.uid !== selected && !!lit && lit.has(n.uid),
        now,
        risk: risk.has(n.uid) ? risk.get(n.uid).map((s) => labelOf(s)) : null
      },
      selected: n.uid === selected,
      draggable: false,
      connectable: false
    }));

  const edges = view.edges.map((e) => {
    const inLit = !!lit && lit.has(e.source) && lit.has(e.target);
    const onLineage = inLit && !!selected;
    const stroke = onLineage ? LINEAGE : accent;
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      type: 'smoothstep',
      focusable: false,
      zIndex: onLineage ? 1 : 0,
      style: { stroke, strokeWidth: onLineage ? 3 : 1.7, opacity: lit && !inLit ? 0.06 : 1 },
      markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: onLineage ? 18 : 14, height: onLineage ? 18 : 14 }
    };
  });

  return (
    <div className="ops-canvas" data-testid="ops-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        edgesFocusable={false}
        fitView
        fitViewOptions={{ padding: 0.1 }}
        minZoom={0.1}
        maxZoom={2}
        onNodeClick={(_, node) => onSelect(node.id)}
        onPaneClick={() => onSelect(null)}
      >
        <ViewportPortal>
          {placed.bands.map((b) => (
            <div key={b.layer} className={'ops-band ops-band--' + b.layer}
              style={{ transform: `translate(${b.x0}px, ${b.y0}px)`, width: b.x1 - b.x0, height: b.y1 - b.y0 }}>
              <span className="ops-band-label">{b.layer}</span>
            </div>
          ))}
        </ViewportPortal>
        <Background gap={24} size={1} color="var(--grid)" />
        <Controls showInteractive={false} position="bottom-right" />
        <MiniMap
          position="bottom-left"
          pannable
          zoomable
          nodeColor={(n) => MINIMAP[n.data.node.state] || MINIMAP.no_data}
          maskColor="var(--scrim)"
        />
        {placed.unconnected.length > 0 && (
          <Panel position="top-right">
            <button
              type="button"
              className="fe-btn"
              onClick={() => {
                setShowUnconnected((v) => !v);
                requestAnimationFrame(() => rf.fitView({ padding: 0.1, duration: 300 }));
              }}
            >
              {showUnconnected ? 'Hide' : 'Show'} unconnected ({placed.unconnected.length})
            </button>
          </Panel>
        )}
      </ReactFlow>
    </div>
  );
}

export default function PipelineCanvas(props) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
