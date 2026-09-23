import { scheduleText, isUnusual } from '../job.js';
import { durationText, since } from '../format.js';
import { oneHop } from '../overview.js';
import './panel.css';

export default function JobOverview({ node, view, onSelect }) {
  const attrs = node.attrs || {};
  const expected = node.expected || null;
  const lastRun = node.lastRun || null;
  const medianMs = node.durationMedianMs;

  const hop = oneHop(node.uid, view.edges);
  const isUnusualDuration = isUnusual(lastRun, medianMs);

  const getUnusualText = () => {
    if (!isUnusualDuration || !lastRun || !medianMs) return null;
    const multiple = Math.round((lastRun.duration_ms / medianMs) * 10) / 10;
    return `unusual duration — ${multiple}× the median of ${durationText(medianMs)}`;
  };

  return (
    <div className="ops-job-overview">
      {attrs.description && (
        <div className="ops-job-section">
          <h4 className="ops-job-subsection-title">About</h4>
          <div className="ops-job-description">{attrs.description}</div>
        </div>
      )}

      {attrs.doc && (
        <div className="ops-job-section">
          <div className="ops-job-doc">{attrs.doc}</div>
        </div>
      )}

      {attrs.schedule !== undefined && attrs.schedule !== null && (
        <div className="ops-job-section">
          <h4 className="ops-job-subsection-title">Schedule</h4>
          <div className="ops-job-schedule">
            <div className="ops-job-schedule-text">{scheduleText(attrs.schedule)}</div>
            <div className="ops-job-schedule-expr">{attrs.schedule}</div>
            {expected && (
              <div className="ops-job-schedule-window">
                next {new Date(expected.next_at).toLocaleString()} · late after {new Date(expected.late_after).toLocaleString()}
              </div>
            )}
            {attrs.is_paused && <div className="ops-job-chip ops-job-chip--paused">paused</div>}
          </div>
        </div>
      )}

      {lastRun && (
        <div className="ops-job-section">
          <h4 className="ops-job-subsection-title">Last run</h4>
          <div className="ops-job-last-run">
            <div className="ops-job-status-item">
              <span className="ops-job-status-label">Outcome:</span>
              <span className="ops-job-status-value">{lastRun.outcome}</span>
            </div>
            <div className="ops-job-status-item">
              <span className="ops-job-status-label">Started:</span>
              <span className="ops-job-status-value">{new Date(lastRun.started_at).toLocaleString()}</span>
            </div>
            {lastRun.duration_ms && (
              <div className="ops-job-status-item">
                <span className="ops-job-status-label">Duration:</span>
                <span className="ops-job-status-value">{durationText(lastRun.duration_ms)}</span>
              </div>
            )}
            {lastRun.exit_code && (
              <div className="ops-job-status-item">
                <span className="ops-job-status-label">Exit code:</span>
                <span className="ops-job-status-value">{lastRun.exit_code}</span>
              </div>
            )}
            {isUnusualDuration && (
              <div className="ops-job-chip ops-job-chip--unusual">{getUnusualText()}</div>
            )}
          </div>
        </div>
      )}

      {node.kind === 'dag' && (
        <div className="ops-job-section">
          <h4 className="ops-job-subsection-title">DAG</h4>
          <div className="ops-job-metadata">
            {attrs.owner && (
              <div className="ops-job-metadata-item">
                <span className="ops-job-metadata-label">Owner:</span>
                <span className="ops-job-metadata-value">{attrs.owner}</span>
              </div>
            )}
            {attrs.tags && attrs.tags.length > 0 && (
              <div className="ops-job-metadata-item">
                <span className="ops-job-metadata-label">Tags:</span>
                <div className="ops-job-tags">
                  {attrs.tags.map((tag) => (
                    <span key={tag} className="ops-job-tag">
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {attrs.file && (
              <div className="ops-job-metadata-item">
                <span className="ops-job-metadata-label">File:</span>
                <span className="ops-job-file">{attrs.file}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {node.kind === 'cron' && (
        <div className="ops-job-section">
          <h4 className="ops-job-subsection-title">Cron</h4>
          <div className="ops-job-cron">
            {attrs.script && (
              <div className="ops-job-cron-item">
                <div className="ops-job-cron-label">Script:</div>
                <div className="ops-job-cron-value">{attrs.script}</div>
              </div>
            )}
            {attrs.log && (
              <div className="ops-job-cron-item">
                <div className="ops-job-cron-label">Log:</div>
                <div className="ops-job-cron-value">{attrs.log}</div>
              </div>
            )}
            {attrs.command && (
              <div className="ops-job-cron-item">
                <div className="ops-job-cron-label">Command:</div>
                <div className="ops-job-cron-value">{attrs.command}</div>
              </div>
            )}
          </div>
        </div>
      )}

      {(hop.upstream.length > 0 || hop.downstream.length > 0) && (
        <div className="ops-job-section">
          <h4 className="ops-job-subsection-title">Lineage</h4>
          <div className="ops-node-lineage">
            {hop.upstream.length > 0 && (
              <div className="ops-node-lineage-group">
                <div className="ops-node-lineage-label">
                  {node.kind === 'dataset' ? 'Produced by' : 'Reads from'}
                </div>
                {hop.upstream.map((uid) => {
                  const n = view.nodes.find((x) => x.uid === uid);
                  return n ? (
                    <button
                      key={uid}
                      type="button"
                      className="ops-node-lineage-link"
                      onClick={() => onSelect(uid)}
                    >
                      {n.label}
                    </button>
                  ) : null;
                })}
              </div>
            )}
            {hop.downstream.length > 0 && (
              <div className="ops-node-lineage-group">
                <div className="ops-node-lineage-label">
                  {node.kind === 'dataset' ? 'Consumed by' : 'Writes to'}
                </div>
                {hop.downstream.map((uid) => {
                  const n = view.nodes.find((x) => x.uid === uid);
                  return n ? (
                    <button
                      key={uid}
                      type="button"
                      className="ops-node-lineage-link"
                      onClick={() => onSelect(uid)}
                    >
                      {n.label}
                    </button>
                  ) : null;
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
