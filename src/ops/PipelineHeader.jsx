import { useEffect, useRef, useState } from 'react';
import HealthBadge from './HealthBadge.jsx';
import { STATES } from './view.js';
import { ageText } from './format.js';
import { goFlow, goLineage } from '../app/route.js';
import { useLineageShare } from './useLineageShare.js';
import { syncEdges } from './api.js';
import ShareMenu from '../flow/ShareMenu.jsx';
import { LogoMark } from '../app/Brand.jsx';

// The only bar on the screen (spec §5.6), built from the editor's own header
// classes. The collection age is always visible: a stopped monitor showing
// green is worse than no monitor (parent spec §10).
export const STALE_AFTER_S = 15 * 60; // three missed five-minute collector cycles

const LABEL = { broken: 'broken', late: 'late', no_data: 'no data', skipped: 'skipped', ok: 'ok', unbound: 'unbound' };

export default function PipelineHeader({ view, filter, onFilter, refreshError, riskCount, smtpReady, slug, onReload }) {
  const { meta, summary, orphans, dropped } = view;
  const age = summary.collectedAgeS;
  const stale = age === null || age > STALE_AFTER_S;
  const warnings = [];
  if (refreshError) warnings.push(`Refresh failed (${refreshError}); showing the last data received.`);
  if (orphans.length) warnings.push(`${orphans.length} binding(s) point at a node no longer in the diagram: ${orphans.join(', ')}`);
  if (dropped.edges) warnings.push(`${dropped.edges} edge(s) point at a node without a uid and are not drawn.`);

  const share = useLineageShare(meta.flowSlug, meta.slug);
  const shareAnchorRef = useRef(null);

  const [syncLoading, setSyncLoading] = useState(false);
  const [syncError, setSyncError] = useState(null);
  const [syncSuccess, setSyncSuccess] = useState(null);
  // Read only after its useState above: reading syncError earlier threw a
  // ReferenceError on every render and left the whole screen blank.
  if (syncError) warnings.push(`Sync failed (${syncError}).`);
  // Syncing writes a diagram version, so it needs edit -- not full control.
  const canEdit = !!(share.flow && (share.flow.permission === 'edit' || share.flow.permission === 'full'));

  const handleSyncEdges = () => {
    const count = summary.pendingEdges;
    if (!window.confirm(`Add ${count} edge${count !== 1 ? 's' : ''} to the diagram? This saves a new version; nothing is removed.`)) {
      return;
    }
    setSyncLoading(true);
    setSyncError(null);
    setSyncSuccess(null);
    syncEdges(slug)
      .then((result) => {
        setSyncLoading(false);
        setSyncSuccess(`Added ${result.added} edge${result.added !== 1 ? 's' : ''}.`);
        if (onReload) {
          onReload().catch((e) => {
            setSyncError(e.message);
          });
        }
        setTimeout(() => setSyncSuccess(null), 3000);
      })
      .catch((e) => {
        setSyncLoading(false);
        setSyncError(e.message);
      });
  };

  // Close share menu on outside click.
  useEffect(() => {
    if (!share.open) return;
    const handleClick = (e) => {
      if (shareAnchorRef.current && !shareAnchorRef.current.contains(e.target)) {
        share.close();
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [share.open]);

  return (
    <header className="fe-header ops-bar" data-testid="ops-bar">
      <button type="button" className="fe-btn" onClick={goLineage} title="Back to data lineage">
        ←
      </button>
      <LogoMark />
      <div className="fe-title-block">
        <span className="fe-title">{meta.name}</span>
        <span className="fe-subtitle">DATA LINEAGE</span>
      </div>
      <HealthBadge state={summary.state} />
      <div className="ops-bar-counts">
        {STATES.filter((s) => summary.counts[s] > 0).map((s) => (
          <button
            key={s}
            type="button"
            className={'fe-btn ops-count' + (filter === s ? ' ops-count--on' : '')}
            aria-pressed={filter === s}
            data-state={s}
            onClick={() => onFilter(filter === s ? null : s)}
          >
            <span className={'ops-dot ops-dot--' + s} />
            {summary.counts[s]} {LABEL[s]}
          </button>
        ))}
      </div>
      {riskCount > 0 && (
        <button type="button" className={'fe-btn ops-count' + (filter === 'at_risk' ? ' ops-count--on' : '')}
          aria-pressed={filter === 'at_risk'} data-state="at_risk"
          onClick={() => onFilter(filter === 'at_risk' ? null : 'at_risk')}>
          <span className="ops-dot ops-dot--at_risk" />
          {riskCount} at risk
        </button>
      )}
      <span className="ops-bar-spacer" />
      {warnings.length > 0 && (
        <span className="ops-bar-warn" title={warnings.join('\n')} data-testid="ops-warnings">
          ⚠ {warnings.length}
        </span>
      )}
      <span className={'ops-bar-age' + (stale ? ' ops-bar-age--stale' : '')} data-testid="ops-collected">
        {age === null ? 'never collected' : 'collected ' + ageText(age)}
      </span>
      {summary.pendingEdges > 0 && (
        <button
          type="button"
          className="fe-btn"
          onClick={handleSyncEdges}
          disabled={syncLoading || !canEdit}
          title={
            canEdit
              ? `${summary.pendingEdges} edge${summary.pendingEdges !== 1 ? 's' : ''} declared in the inventory are not on the map yet`
              : 'Syncing saves a new version of the diagram: it needs edit access'
          }
          data-testid="sync-edges-btn"
        >
          {syncLoading ? 'Syncing…' : `Sync edges (${summary.pendingEdges})`}
        </button>
      )}
      {syncSuccess && (
        <span className="ops-bar-success" title={syncSuccess} data-testid="sync-success">
          ✓ {syncSuccess}
        </span>
      )}
      <div ref={shareAnchorRef} style={{ position: 'relative' }}>
        <button
          type="button"
          className="fe-btn"
          onClick={share.toggle}
          disabled={!share.canManage}
          title={share.canManage ? 'Share this diagram' : 'Only someone with full control of the diagram can share it'}
        >
          Share
        </button>
        {share.open && (
          <ShareMenu
            flow={share.flow}
            state={share.state}
            loading={share.loading}
            error={share.error}
            notice={share.notice}
            smtpReady={!!smtpReady}
            onClose={share.close}
            onShareUser={share.onShareUser}
            onChangePermission={share.onChangePermission}
            onRevokeShare={share.onRevokeShare}
            onCreateLink={share.onCreateLink}
            onRevokeLink={share.onRevokeLink}
            onCopyLink={share.onCopyLink}
            onSendEmail={share.onSendEmail}
          />
        )}
      </div>
      <button type="button" className="fe-btn" onClick={() => goFlow(meta.flowSlug)} title="Open the diagram in the full editor">
        Editor
      </button>
    </header>
  );
}
