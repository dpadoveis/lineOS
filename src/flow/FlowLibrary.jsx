const shortDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString().slice(0, 5);
};

// The library of flows stored on the server. It is also the trash: `trash`
// switches between the active flows and the ones removed (soft delete).
export default function FlowLibrary({
  library,
  openId,
  onClose,
  onSearch,
  onToggleTrash,
  onOpen,
  onNew,
  onRename,
  onRemove,
  onRestore
}) {
  const { items, loading, query, trash } = library;

  return (
    <aside className="fe-panel" onMouseDown={(e) => e.stopPropagation()}>
      <div className="fe-panel-head">
        <span className="fe-panel-title">{trash ? 'TRASH' : 'FLOWS ON THE SERVER'}</span>
        <button className="fe-panel-close" onClick={onClose} title="Close">✕</button>
      </div>

      <div className="fe-panel-tools">
        <input
          className="fe-panel-search"
          value={query}
          placeholder="search by name or description…"
          onChange={(e) => onSearch(e.target.value)}
        />
        <button className="fe-ghost-btn" onClick={onNew}>New</button>
        <button className="fe-ghost-btn" onClick={onToggleTrash}>
          {trash ? 'Active' : 'Trash'}
        </button>
      </div>

      <div className="fe-panel-body">
        {loading && <div className="fe-panel-empty">loading…</div>}
        {!loading && !items.length && (
          <div className="fe-panel-empty">
            {trash ? 'the trash is empty' : 'no flow saved yet'}
          </div>
        )}
        {!loading &&
          items.map((f) => (
            <div key={f.id} className={'fe-item' + (f.id === openId ? ' fe-item-on' : '')}>
              <button
                className="fe-item-main"
                onClick={() => (trash ? onRestore(f.id) : onOpen(f.id))}
                title={trash ? 'Restore from the trash' : 'Open in the editor'}
              >
                <span className="fe-item-name">
                  {f.name}
                  {f.has_draft && <span className="fe-item-tag" title="unsaved draft">draft</span>}
                </span>
                <span className="fe-item-meta">
                  v{f.current_version} · {f.node_count} nodes · {f.edge_count} edges ·{' '}
                  {shortDate(trash ? f.deleted_at : f.updated_at)}
                </span>
                {f.description && <span className="fe-item-desc">{f.description}</span>}
              </button>
              <div className="fe-item-actions">
                {trash ? (
                  <>
                    <button className="fe-mini-btn" onClick={() => onRestore(f.id)} title="Restore">
                      ↺
                    </button>
                    <button
                      className="fe-mini-btn fe-mini-danger"
                      onClick={() => onRemove(f.id, true)}
                      title="Delete permanently"
                    >
                      ✕
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className="fe-mini-btn"
                      onClick={() => onRename(f.id, f.name)}
                      title="Rename"
                    >
                      ✎
                    </button>
                    <button
                      className="fe-mini-btn fe-mini-danger"
                      onClick={() => onRemove(f.id, false)}
                      title="Move to the trash"
                    >
                      🗑
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
      </div>
    </aside>
  );
}
