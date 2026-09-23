import { useEffect, useState } from 'react';
import { listRuns } from '../api.js';
import { durationBars } from '../job.js';
import { durationText } from '../format.js';
import './panel.css';

const OUTCOMES = {
  success: '#6dddb8',
  failed: '#ff6b5b',
  running: '#7aa2f7',
  skipped: '#8fd5b8',
};

export default function JobRuns({ slug, node }) {
  const [runs, setRuns] = useState(null);
  const [runsError, setRunsError] = useState(null);

  useEffect(() => {
    setRuns(null);
    setRunsError(null);
    if (!node.objectId) return;
    let alive = true;
    listRuns(slug, node.objectId)
      .then((r) => {
        if (alive) setRuns(r.items);
      })
      .catch((e) => {
        if (alive) setRunsError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [slug, node.uid, node.objectId]);

  if (runsError) {
    return <div className="ops-node-runs-error">{runsError}</div>;
  }

  if (runs === null) {
    return <div className="ops-node-runs-loading">loading runs…</div>;
  }

  if (runs.length === 0) {
    return <div className="ops-node-runs-empty">No run collected yet.</div>;
  }

  const bars = durationBars(runs, 400, 40);
  const medianMs = node.durationMedianMs;

  return (
    <div className="ops-job-runs">
      {bars.length > 0 && (
        <div className="ops-job-runs-chart">
          <svg width="100%" height="60" viewBox="0 0 400 60" preserveAspectRatio="xMidYMid meet">
            <defs>
              <pattern id="median-line" patternUnits="userSpaceOnUse" width="4" height="4">
                <line x1="0" y1="0" x2="4" y2="0" stroke="var(--mut2)" strokeWidth="1" strokeDasharray="2,2" />
              </pattern>
            </defs>
            {medianMs && (
              <line
                x1={`${(medianMs / Math.max(...runs.map((r) => r.duration_ms || 0))) * 400}px`}
                y1="0"
                x2={`${(medianMs / Math.max(...runs.map((r) => r.duration_ms || 0))) * 400}px`}
                y2="40"
                stroke="var(--mut2)"
                strokeWidth="2"
                strokeDasharray="2,2"
              />
            )}
            {bars.map((bar, i) => (
              <rect
                key={i}
                x={bar.x}
                y={bar.y}
                width={bar.w}
                height={bar.h}
                fill={OUTCOMES[bar.outcome] || '#999'}
                title={`${runs[i].started_at}: ${durationText(runs[i].duration_ms)}`}
              />
            ))}
          </svg>
        </div>
      )}

      <table className="ops-node-runs-table">
        <thead>
          <tr>
            <th>started</th>
            <th>outcome</th>
            <th>duration</th>
            <th>facts</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.run_key} className={`ops-node-runs-row--${r.outcome}`}>
              <td>{new Date(r.started_at).toLocaleString()}</td>
              <td>
                {r.outcome}
                {r.exit_code ? ` (exit ${r.exit_code})` : ''}
              </td>
              <td>{durationText(r.duration_ms) || '—'}</td>
              <td>
                {Object.entries(r.facts || {})
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(' · ') || '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
