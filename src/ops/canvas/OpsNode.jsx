import { Handle, Position, useStore } from '@xyflow/react';
import HealthBadge from '../HealthBadge.jsx';
import KindIcon from './KindIcon.jsx';
import { freshnessLine } from '../format.js';
import '../../flow/FlowEditor.css';

// The ops card. Border = last run (or last check); badge = health; ring =
// selection. Below zoom 0.6 it collapses to icon + name + status dot so the
// whole map stays legible at fit-to-screen (spec §2).
const KIND_LABEL = { dag: 'DAG', cron: 'CRON', dataset: 'DATASET', unbound: 'UNBOUND' };
const compactSelector = (s) => s.transform[2] < 0.6;

export default function OpsNode({ data }) {
  const { node, dimmed, lit, now, risk } = data;
  const compact = useStore(compactSelector);
  const reason = node.health ? node.health.reason : '';
  const cls = ['ops-card', 'ops-card--run-' + node.run, 'ops-card--' + node.state];
  if (dimmed) cls.push('ops-card--dim');
  if (lit) cls.push('ops-card--lit');
  if (compact) cls.push('ops-card--compact');
  return (
    <div className={cls.join(' ')} data-testid="ops-node" data-uid={node.uid} data-state={node.state}
      data-run={node.run} data-risk={risk ? 'yes' : 'no'} title={reason}>
      <Handle type="target" position={Position.Left} isConnectable={false} className="ops-handle" />
      {compact ? (
        <div className="ops-card-compact">
          <span className="ops-card-icon" style={{ background: node.color + '1f', color: node.color }}>
            <KindIcon kind={node.kind} size={26} />
          </span>
          <span className="ops-card-compact-name">{node.label}</span>
          <span className={'ops-dot ops-dot--' + node.state} />
        </div>
      ) : (
        <>
          <div className="ops-card-top">
            <span className="ops-card-kind">{KIND_LABEL[node.kind]}</span>
            {risk && <span className="ops-card-risk" title={'Downstream of ' + risk.join(', ')}>at risk</span>}
          </div>
          <div className="ops-card-head">
            <span className="ops-card-icon" style={{ background: node.color + '1f', color: node.color }}>
              <KindIcon kind={node.kind} size={18} />
            </span>
            <div className="fe-node-info">
              <span className="ops-card-name">{node.label}</span>
              <span className="fe-node-cat">{node.externalId}</span>
            </div>
          </div>
          <div className="ops-card-foot">
            <HealthBadge state={node.state} reason={reason} />
            <span className="ops-card-fresh">{freshnessLine(node, now)}</span>
          </div>
        </>
      )}
      <Handle type="source" position={Position.Right} isConnectable={false} className="ops-handle" />
    </div>
  );
}
