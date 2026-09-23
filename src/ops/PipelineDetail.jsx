import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { readPipeline } from './api.js';
import { toPipelineView, matches, bySeverity, layersOf } from './view.js';
import { atRisk } from './lineage.js';
import { pipelineHash } from '../app/route.js';
import { initialPanel, panelReducer } from './panel.js';
import { filtersActive, tableRows } from './overview.js';
import PipelineHeader from './PipelineHeader.jsx';
import BottomPanel from './panel/BottomPanel.jsx';
import PipelineCanvas from './canvas/PipelineCanvas.jsx';
import './detail.css';

// The pipeline screen: read-only. It fetches, keeps the selection and the
// filter, and hands every part the same view -- nothing below reads the payload.
const REFRESH_MS = 30000;

export default function PipelineDetail({ slug, uid, smtpReady }) {
  const [detail, setDetail] = useState(null);
  const [loadError, setLoadError] = useState(null); // first load failed: nothing to show
  const [refreshError, setRefreshError] = useState(null); // a later one failed: keep the last data
  const [panel, dispatch] = useReducer(panelReducer, uid, initialPanel);
  const [filter, setFilter] = useState(null);
  const [query, setQuery] = useState('');
  const [focus, setFocus] = useState(null); // {uid, seq}: a request to centre the canvas
  const hasData = useRef(false);
  const reloadRef = useRef(null);

  const reload = () => {
    return readPipeline(slug).then((d) => {
      setDetail(d);
      setRefreshError(null);
    });
  };
  reloadRef.current = reload;

  useEffect(() => {
    let alive = true;
    hasData.current = false;
    setDetail(null);
    setLoadError(null);
    setRefreshError(null);
    dispatch(uid ? { type: 'open', uid } : { type: 'activate', id: 'overview' });
    setFilter(null);
    setQuery('');
    const load = () =>
      readPipeline(slug)
        .then((d) => {
          if (!alive) return;
          hasData.current = true;
          setDetail(d);
          setRefreshError(null);
        })
        .catch((e) => {
          if (!alive) return;
          if (hasData.current) setRefreshError(e.message);
          else setLoadError(e.message);
        });
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [slug, uid]);

  const view = useMemo(() => (detail ? toPipelineView(detail) : null), [detail]);

  // Hooks stay above the early returns below: a hook called only once data has
  // arrived changes the hook count between renders, and React throws.
  const risk = useMemo(() => (view ? atRisk(view) : new Map()), [view]);
  const layers = useMemo(() => (view ? layersOf(view) : new Map()), [view]);

  // A deep link centres on its node once, when the first data arrives. It must
  // not re-select it afterwards, or the node could never be deselected.
  const focusedLink = useRef(false);
  useEffect(() => {
    focusedLink.current = false;
  }, [slug, uid]);
  useEffect(() => {
    if (uid && view && !focusedLink.current) {
      focusedLink.current = true;
      setFocus((f) => ({ uid, seq: (f ? f.seq : 0) + 1 }));
    }
  }, [uid, view]);

  // When the active tab changes from the panel, keep the hash in step.
  useEffect(() => {
    const activeUid = panel.active === 'overview' ? null : panel.active;
    history.replaceState(null, '', pipelineHash(slug, activeUid));
    if (activeUid && view) {
      const node = view.nodes.find((n) => n.uid === activeUid);
      if (node) {
        setFocus((f) => ({ uid: activeUid, seq: (f ? f.seq : 0) + 1 }));
      }
    }
  }, [panel.active, slug, view]);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === '/' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
        const searchInput = document.querySelector('[data-testid="ops-search"]');
        if (searchInput) {
          searchInput.focus();
          e.preventDefault();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  if (loadError) return <div className="ops-page ops-page--msg">{loadError}</div>;
  if (!view) return <div className="ops-page ops-page--msg">loading…</div>;

  const selected = panel.active === 'overview' ? null : panel.active;
  const tableOpts = { layer: panel.layer, query, sort: panel.sort, filters: panel.filters };
  // Whatever narrows the table also dims the canvas, so the two never disagree.
  const matchSet = filtersActive(tableOpts) ? new Set(tableRows(view, layers, risk, tableOpts).map((n) => n.uid)) : null;

  const select = (uid) => {
    uid ? dispatch({ type: 'open', uid }) : dispatch({ type: 'activate', id: 'overview' });
    setFocus((f) => ({ uid, seq: (f ? f.seq : 0) + 1 }));
    history.replaceState(null, '', pipelineHash(slug, uid));
  };

  const onSubmitQuery = () => {
    const filtered = tableRows(view, layers, risk, tableOpts);
    if (filtered.length > 0) {
      select(filtered[0].uid);
    }
  };

  return (
    <div className="ops-page" data-testid="ops-page">
      <PipelineHeader view={view} filter={filter} onFilter={setFilter} refreshError={refreshError}
        riskCount={risk.size} smtpReady={smtpReady} slug={slug} onReload={reloadRef.current} />
      <div className="ops-page-body ops-page-body--stack">
        <div className="ops-canvas-container">
          <PipelineCanvas view={view} selected={selected} filter={filter} focus={focus} onSelect={select}
            risk={risk} matchSet={matchSet} />
        </div>
        <BottomPanel view={view} layers={layers} risk={risk} query={query} onQuery={setQuery} onSubmitQuery={onSubmitQuery} panel={panel} dispatch={dispatch} slug={slug} onSelect={select} />
      </div>
    </div>
  );
}
