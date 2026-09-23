import { useEffect, useRef } from 'react';

// Version history, hanging off the document name in the header. Replaces the
// old side panel: the history belongs to the document, so it opens from the
// document's own name rather than from a separate toolbar button.
//
// Versions are immutable — "restore" never rewrites one, it inserts a new
// version holding the old content (see AGENT.md).

const shortDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString().slice(0, 5);
};

const kb = (b) => (b < 1024 ? b + ' B' : Math.round(b / 1024) + ' KB');

export default function HistoryMenu({
  versions,
  flow,
  viewing,
  onClose,
  onView,
  onRestore,
  onRename,
  onSaveAsNew,
  onRemoveAsset,
  assetUrl
}) {
  const { items, arquivos, carregando } = versions;
  const rootRef = useRef(null);

  // Closes on any click outside the dropdown, the way a menu is expected to
  // behave. The header button itself stops propagation, so it still toggles.
  useEffect(() => {
    const onDocDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) onClose();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDocDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div className="fe-history-menu" ref={rootRef} onMouseDown={(e) => e.stopPropagation()}>
      <div className="fe-history-head">
        <span className="fe-history-title">{flow ? flow.name : 'Unsaved flow'}</span>
        {flow && (
          <button className="fe-mini-btn" onClick={onRename} title="Rename">
            ✎
          </button>
        )}
      </div>

      {!flow && (
        <div className="fe-history-cta">
          <span className="fe-history-cta-text">
            This flow only exists in this tab. Save it to start its history.
          </span>
          <button className="fe-btn" onClick={onSaveAsNew}>
            Save to the server
          </button>
        </div>
      )}

      {flow && (
        <div className="fe-history-body">
          <div className="fe-history-section">VERSIONS</div>
          {carregando && <div className="fe-panel-empty">loading…</div>}
          {!carregando && !items.length && <div className="fe-panel-empty">no versions yet</div>}

          {!carregando &&
            items.map((v) => (
              <div
                key={v.version}
                className={
                  'fe-item' +
                  (viewing === v.version || (!viewing && flow.version === v.version)
                    ? ' fe-item-on'
                    : '')
                }
              >
                <button
                  className="fe-item-main"
                  onClick={() => onView(v.version)}
                  title="Load in the editor"
                >
                  <span className="fe-item-name">
                    version {v.version}
                    {flow.version === v.version && <span className="fe-item-tag">current</span>}
                  </span>
                  <span className="fe-item-meta">
                    {v.node_count} nodes · {v.edge_count} edges · {shortDate(v.created_at)}
                    {v.author ? ' · ' + v.author : ''}
                  </span>
                  {v.note && <span className="fe-item-desc">{v.note}</span>}
                </button>
                <div className="fe-item-actions">
                  <button
                    className="fe-mini-btn"
                    onClick={() => onRestore(v.version)}
                    title="Restore as a new version"
                  >
                    ↺
                  </button>
                </div>
              </div>
            ))}

          {!carregando && !!(arquivos || []).length && (
            <>
              <div className="fe-history-section">ATTACHMENTS</div>
              {arquivos.map((a) => (
                <div key={a.id} className="fe-item">
                  <a
                    className="fe-item-main"
                    href={assetUrl(a.id)}
                    target="_blank"
                    rel="noreferrer"
                    title="Download"
                  >
                    <span className="fe-item-name">{a.filename}</span>
                    <span className="fe-item-meta">
                      {a.kind} · {kb(a.size_bytes)} ·{' '}
                      {a.flow_version ? 'v' + a.flow_version + ' · ' : ''}
                      {shortDate(a.created_at)}
                    </span>
                  </a>
                  <div className="fe-item-actions">
                    <button
                      className="fe-mini-btn fe-mini-danger"
                      onClick={() => onRemoveAsset(a.id)}
                      title="Remove attachment"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
