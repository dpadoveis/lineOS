import { STATES } from '../view.js';
import { filtersActive, hasError, layerSummary, tableRows } from '../overview.js';
import KindIcon from '../canvas/KindIcon.jsx';
import HealthBadge from '../HealthBadge.jsx';
import { durationText, freshnessLine, rowsText, since } from '../format.js';

const KINDS = [['dag', 'DAG'], ['cron', 'Cron'], ['dataset', 'Dataset']];

export default function OverviewTab({ view, layers, risk, query, onQuery, onSubmitQuery, panel, dispatch, onSelect }) {
  const summary = layerSummary(view, layers, risk);
  const opts = { layer: panel.layer, query, sort: panel.sort, filters: panel.filters };
  const rows = tableRows(view, layers, risk, opts);
  const narrowed = filtersActive(opts);
  const errorCount = view.nodes.filter(hasError).length;

  const handleSort = (key) => {
    dispatch({ type: 'sort', key });
  };

  const resetSort = () => {
    dispatch({ type: 'sort', key: 'severity' });
  };

  const handleLayerClick = (layer) => {
    if (panel.layer === layer) {
      dispatch({ type: 'layer', layer: null });
    } else {
      dispatch({ type: 'layer', layer });
    }
  };

  return (
    <div className="ops-overview">
      <div className="ops-toolbar" role="toolbar" aria-label="Filter nodes">
        <div className="ops-chips">
          <button type="button" className={'ops-chip' + (panel.layer === null ? ' ops-chip--on' : '')}
            onClick={() => handleLayerClick(null)}>All <b>{view.nodes.length}</b></button>
          {summary.map((s) => (
            <button key={s.layer} type="button" data-layer={s.layer}
              className={'ops-chip ops-chip--layer' + (panel.layer === s.layer ? ' ops-chip--on' : '')}
              onClick={() => handleLayerClick(s.layer)}
              title={STATES.filter((st) => s.counts[st]).map((st) => s.counts[st] + ' ' + st).join(' · ') + (s.atRisk ? ' · ' + s.atRisk + ' at risk' : '')}>
              {s.layer} <b>{s.total}</b>
              {(s.counts.broken > 0 || s.counts.late > 0) && <span className="ops-dot ops-dot--broken" />}
            </button>
          ))}
        </div>
        <span className="ops-toolbar-sep" />
        <div className="ops-chips">
          {KINDS.map(([kind, label]) => (
            <button key={kind} type="button" aria-pressed={panel.filters.kinds.includes(kind)}
              className={'ops-chip' + (panel.filters.kinds.includes(kind) ? ' ops-chip--on' : '')}
              onClick={() => dispatch({ type: 'kind', kind })}>
              <KindIcon kind={kind} size={12} /> {label}
            </button>
          ))}
        </div>
        <span className="ops-toolbar-sep" />
        <select className="ops-select" value={panel.filters.state || ''} aria-label="Filter by health"
          onChange={(e) => dispatch({ type: 'state', state: e.target.value || null })}>
          <option value="">Any health</option>
          {STATES.map((st) => <option key={st} value={st}>{st.replace('_', ' ')}</option>)}
        </select>
        <button type="button" aria-pressed={panel.filters.riskOnly}
          className={'ops-chip' + (panel.filters.riskOnly ? ' ops-chip--on' : '')}
          onClick={() => dispatch({ type: 'risk' })}>At risk <b>{risk.size}</b></button>
        <button type="button" aria-pressed={panel.filters.errorsOnly}
          className={'ops-chip' + (panel.filters.errorsOnly ? ' ops-chip--on' : '')}
          onClick={() => dispatch({ type: 'errors' })}>Errors <b>{errorCount}</b></button>
        {narrowed && (
          <button type="button" className="ops-chip ops-chip--clear" onClick={() => { dispatch({ type: 'clear' }); onQuery(''); }}>
            Clear
          </button>
        )}
        <span className="ops-toolbar-spacer" />
        <span className="ops-toolbar-count">{rows.length} of {view.nodes.length}</span>
        <input
          className="ops-search"
          type="search"
          placeholder="Search nodes  /"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onSubmitQuery(); if (e.key === 'Escape') onQuery(''); }}
          data-testid="ops-search"
        />
      </div>

      <div className="ops-table-wrap">
        <table className="ops-table">
          <thead>
            <tr>
              <th>
                <button
                  type="button"
                  className="ops-table-header-btn"
                  onClick={() => handleSort('name')}
                >
                  Name {panel.sort.key === 'name' && (panel.sort.dir === 'asc' ? '▲' : '▼')}
                </button>
              </th>
              <th>
                <button
                  type="button"
                  className="ops-table-header-btn"
                  onClick={() => handleSort('layer')}
                >
                  Layer {panel.sort.key === 'layer' && (panel.sort.dir === 'asc' ? '▲' : '▼')}
                </button>
              </th>
              <th>
                <button
                  type="button"
                  className="ops-table-header-btn"
                  onClick={() => handleSort('health')}
                >
                  Health {panel.sort.key === 'health' && (panel.sort.dir === 'asc' ? '▲' : '▼')}
                </button>
              </th>
              <th>
                <button
                  type="button"
                  className="ops-table-header-btn"
                  onClick={() => handleSort('lastRun')}
                >
                  Last run / check {panel.sort.key === 'lastRun' && (panel.sort.dir === 'asc' ? '▲' : '▼')}
                </button>
              </th>
              <th>Freshness</th>
              <th>
                <button
                  type="button"
                  className="ops-table-header-btn"
                  onClick={() => handleSort('rows')}
                >
                  Rows {panel.sort.key === 'rows' && (panel.sort.dir === 'asc' ? '▲' : '▼')}
                </button>
              </th>
              <th>At risk</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan="7" className="ops-table-empty">
                  No node matches.
                </td>
              </tr>
            ) : (
              rows.map((node) => (
                <tr
                  key={node.uid}
                  className={`ops-table-row ${panel.active === node.uid ? 'ops-table-row--active' : ''}`}
                  onClick={() => onSelect(node.uid)}
                >
                  <td>
                    <span className="ops-table-icon">
                      <KindIcon kind={node.kind} size={16} />
                    </span>
                    <span className="ops-table-label">{node.label}</span>
                    <span className="ops-table-id">{node.externalId}</span>
                  </td>
                  <td>{layers.get(node.uid)}</td>
                  <td>
                    <HealthBadge state={node.state} reason={node.health ? node.health.reason : ''} />
                  </td>
                  <td>
                    {node.lastRun ? (
                      <>
                        <div>{node.lastRun.outcome}</div>
                        <div className="ops-table-sub">{new Date(node.lastRun.started_at).toLocaleString()}</div>
                      </>
                    ) : node.lastCheck ? (
                      <>
                        <div>{node.lastCheck.ok ? 'ok' : 'failed'}</div>
                        <div className="ops-table-sub">{since(node.lastCheck.checked_at)}</div>
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="ops-table-freshness">{freshnessLine(node)}</td>
                  <td>{rowsText(node.lastCheck ? node.lastCheck.row_count : null) || '—'}</td>
                  <td>
                    {risk.has(node.uid) ? risk.get(node.uid).map((src) => {
                      const srcNode = view.nodes.find((n) => n.uid === src);
                      return srcNode ? <div key={src}>{srcNode.label}</div> : null;
                    }) : '—'}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {panel.sort.key !== 'severity' && (
        <div className="ops-overview-footer">
          <button
            type="button"
            className="ops-reset-sort-btn"
            onClick={resetSort}
          >
            Severity
          </button>
        </div>
      )}
    </div>
  );
}
