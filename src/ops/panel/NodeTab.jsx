import { useEffect, useState } from 'react';
import { listRuns } from '../api.js';
import { oneHop } from '../overview.js';
import KindIcon from '../canvas/KindIcon.jsx';
import HealthBadge from '../HealthBadge.jsx';
import { durationText, rowsText, since } from '../format.js';
import DatasetPreview from './DatasetPreview.jsx';
import DatasetSchema from './DatasetSchema.jsx';
import DatasetStats from './DatasetStats.jsx';
import DatasetHistory from './DatasetHistory.jsx';
import JobOverview from './JobOverview.jsx';
import JobRuns from './JobRuns.jsx';
import JobTasks from './JobTasks.jsx';
import './panel.css';

export default function NodeTab({ node, view, layers, risk, panel, dispatch, slug, onSelect }) {
  const [runs, setRuns] = useState(null);
  const [runsError, setRunsError] = useState(null);
  const [datasetTab, setDatasetTab] = useState('preview');
  const [mountedTabs, setMountedTabs] = useState(new Set());
  const [jobTab, setJobTab] = useState('overview');
  const [jobMountedTabs, setJobMountedTabs] = useState(new Set());
  const wantsRuns = !!node.objectId && (node.kind === 'dag' || node.kind === 'cron');
  const isDataset = node.kind === 'dataset' && !!node.objectId;
  const isJob = (node.kind === 'dag' || node.kind === 'cron') && !!node.objectId;

  useEffect(() => {
    setRuns(null);
    setRunsError(null);
    if (!wantsRuns) return;
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
  }, [slug, node.uid, node.objectId, wantsRuns]);

  const hop = oneHop(node.uid, view.edges);
  const lineage = risk.has(node.uid) ? risk.get(node.uid) : [];

  const handleBreadcrumbOverview = () => {
    dispatch({ type: 'activate', id: 'overview' });
  };

  const handleBreadcrumbLayer = () => {
    const layer = layers.get(node.uid);
    dispatch({ type: 'layer', layer });
  };

  const handleDatasetTabClick = (tab) => {
    setDatasetTab(tab);
    setMountedTabs((prev) => new Set([...prev, tab]));
  };

  const handleJobTabClick = (tab) => {
    setJobTab(tab);
    setJobMountedTabs((prev) => new Set([...prev, tab]));
  };

  const kindMap = { dag: 'DAG', cron: 'Cron', dataset: 'Dataset', unbound: 'Unbound' };
  const layer = layers.get(node.uid) || 'other';

  return (
    <div className="ops-node-tab">
      <div className="ops-breadcrumb">
        <button type="button" className="ops-breadcrumb-link" onClick={handleBreadcrumbOverview}>
          Overview
        </button>
        <span className="ops-breadcrumb-sep">›</span>
        <button type="button" className="ops-breadcrumb-link" onClick={handleBreadcrumbLayer}>
          {layer}
        </button>
        <span className="ops-breadcrumb-sep">›</span>
        <span className="ops-breadcrumb-label">{node.label}</span>
      </div>

      <div className="ops-node-header">
        <span className="ops-node-icon">
          <KindIcon kind={node.kind} size={24} />
        </span>
        <div className="ops-node-info">
          <div className="ops-node-title">{node.label}</div>
          <div className="ops-node-kind">{kindMap[node.kind] || 'Node'}</div>
          <div className="ops-node-id">{node.externalId}</div>
        </div>
        <div className="ops-node-health">
          <HealthBadge state={node.state} reason={node.health ? node.health.reason : ''} />
          {node.health && node.health.since && (
            <div className="ops-node-health-since">{since(node.health.since)}</div>
          )}
        </div>
        {lineage.length > 0 && (
          <div className="ops-node-at-risk">
            <div className="ops-node-at-risk-label">at risk from:</div>
            {lineage.map((src) => {
              const srcNode = view.nodes.find((n) => n.uid === src);
              return srcNode ? (
                <div key={src} className="ops-node-at-risk-src">
                  {srcNode.label}
                </div>
              ) : null;
            })}
          </div>
        )}
      </div>

      <div className="ops-node-body">
        <div className="ops-node-column">
          <h3 className="ops-node-section-title">Status</h3>
          {wantsRuns && node.lastRun ? (
            <div className="ops-node-status-run">
              <div className="ops-node-status-item">
                <span className="ops-node-status-label">Outcome:</span>
                <span className="ops-node-status-value">{node.lastRun.outcome}</span>
              </div>
              <div className="ops-node-status-item">
                <span className="ops-node-status-label">Started:</span>
                <span className="ops-node-status-value">
                  {new Date(node.lastRun.started_at).toLocaleString()}
                </span>
              </div>
              {node.lastRun.duration_ms && (
                <div className="ops-node-status-item">
                  <span className="ops-node-status-label">Duration:</span>
                  <span className="ops-node-status-value">{durationText(node.lastRun.duration_ms)}</span>
                </div>
              )}
              {node.lastRun.exit_code && (
                <div className="ops-node-status-item">
                  <span className="ops-node-status-label">Exit code:</span>
                  <span className="ops-node-status-value">{node.lastRun.exit_code}</span>
                </div>
              )}
            </div>
          ) : node.lastCheck ? (
            <div className="ops-node-status-check">
              <div className="ops-node-status-item">
                <span className="ops-node-status-label">Rows:</span>
                <span className="ops-node-status-value">{rowsText(node.lastCheck.row_count) || '—'}</span>
              </div>
              {node.lastCheck.max_ts && (
                <div className="ops-node-status-item">
                  <span className="ops-node-status-label">Newest row:</span>
                  <span className="ops-node-status-value">{since(node.lastCheck.max_ts)}</span>
                </div>
              )}
              <div className="ops-node-status-item">
                <span className="ops-node-status-label">Checked:</span>
                <span className="ops-node-status-value">{since(node.lastCheck.checked_at)}</span>
              </div>
              {node.lastCheck.error && (
                <div className="ops-node-status-item">
                  <span className="ops-node-status-label">Error:</span>
                  <span className="ops-node-status-value">{node.lastCheck.error}</span>
                </div>
              )}
            </div>
          ) : (
            <div className="ops-node-status-none">No data collected yet.</div>
          )}
        </div>

        <div className="ops-node-column">
          <h3 className="ops-node-section-title">Lineage</h3>
          <div className="ops-node-lineage">
            <div className="ops-node-lineage-group">
              <div className="ops-node-lineage-label">
                {node.kind === 'dataset' ? 'Produced by' : 'Reads from'}
              </div>
              {hop.upstream.length > 0 ? (
                hop.upstream.map((uid) => {
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
                })
              ) : (
                <div className="ops-node-lineage-none">none</div>
              )}
            </div>
            <div className="ops-node-lineage-group">
              <div className="ops-node-lineage-label">
                {node.kind === 'dataset' ? 'Consumed by' : 'Writes to'}
              </div>
              {hop.downstream.length > 0 ? (
                hop.downstream.map((uid) => {
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
                })
              ) : (
                <div className="ops-node-lineage-none">none</div>
              )}
            </div>
          </div>
        </div>
      </div>

      {isJob && (
        <div className="ops-job-section">
          <div className="ops-job-tabs">
            {['overview', 'runs'].map((tab) => (
              <button
                key={tab}
                type="button"
                className={`ops-job-tab ${jobTab === tab ? 'ops-job-tab--active' : ''}`}
                onClick={() => handleJobTabClick(tab)}
              >
                {tab === 'overview' ? 'Overview' : 'Runs'}
              </button>
            ))}
            {node.kind === 'dag' && (
              <button
                key="tasks"
                type="button"
                className={`ops-job-tab ${jobTab === 'tasks' ? 'ops-job-tab--active' : ''}`}
                onClick={() => handleJobTabClick('tasks')}
              >
                Tasks
              </button>
            )}
          </div>
          <div className="ops-job-body">
            {jobMountedTabs.has('overview') && (
              <div className={jobTab === 'overview' ? '' : 'ops-job-tab-hidden'}>
                <JobOverview node={node} view={view} onSelect={onSelect} />
              </div>
            )}
            {jobMountedTabs.has('runs') && (
              <div className={jobTab === 'runs' ? '' : 'ops-job-tab-hidden'}>
                <JobRuns slug={slug} node={node} runs={runs} runsError={runsError} />
              </div>
            )}
            {jobMountedTabs.has('tasks') && node.kind === 'dag' && (
              <div className={jobTab === 'tasks' ? '' : 'ops-job-tab-hidden'}>
                <JobTasks node={node} view={view} onSelect={onSelect} />
              </div>
            )}
          </div>
        </div>
      )}

      {isDataset && (
        <div className="ops-dataset-section">
          <div className="ops-dataset-tabs">
            {['preview', 'schema', 'stats', 'history'].map((tab) => (
              <button
                key={tab}
                type="button"
                className={`ops-dataset-tab ${datasetTab === tab ? 'ops-dataset-tab--active' : ''}`}
                onClick={() => handleDatasetTabClick(tab)}
              >
                {tab === 'preview' ? 'Preview' : tab === 'schema' ? 'Schema' : tab === 'stats' ? 'Stats' : 'History'}
              </button>
            ))}
          </div>
          <div className="ops-dataset-body">
            {mountedTabs.has('preview') && (
              <div className={datasetTab === 'preview' ? '' : 'ops-dataset-tab-hidden'}>
                <DatasetPreview slug={slug} objectId={node.objectId} />
              </div>
            )}
            {mountedTabs.has('schema') && (
              <div className={datasetTab === 'schema' ? '' : 'ops-dataset-tab-hidden'}>
                <DatasetSchema slug={slug} objectId={node.objectId} />
              </div>
            )}
            {mountedTabs.has('stats') && (
              <div className={datasetTab === 'stats' ? '' : 'ops-dataset-tab-hidden'}>
                <DatasetStats slug={slug} objectId={node.objectId} />
              </div>
            )}
            {mountedTabs.has('history') && (
              <div className={datasetTab === 'history' ? '' : 'ops-dataset-tab-hidden'}>
                <DatasetHistory slug={slug} objectId={node.objectId} />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
