const dataCurta = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString().slice(0, 5);
};

// The library of flows stored on the server. It is also the trash: `trash`
// switches between the active flows and the ones removed (soft delete).
export default function FlowLibrary({
  library,
  abertoId,
  onFechar,
  onBuscar,
  onAlternarLixeira,
  onAbrir,
  onNovo,
  onRenomear,
  onRemover,
  onRestaurar
}) {
  const { items, carregando, busca, lixeira } = library;

  return (
    <aside className="fe-panel" onMouseDown={(e) => e.stopPropagation()}>
      <div className="fe-panel-head">
        <span className="fe-panel-title">{lixeira ? 'TRASH' : 'FLOWS ON THE SERVER'}</span>
        <button className="fe-panel-close" onClick={onFechar} title="Close">✕</button>
      </div>

      <div className="fe-panel-tools">
        <input
          className="fe-panel-search"
          value={busca}
          placeholder="search by name or description…"
          onChange={(e) => onBuscar(e.target.value)}
        />
        <button className="fe-ghost-btn" onClick={onNovo}>New</button>
        <button className="fe-ghost-btn" onClick={onAlternarLixeira}>
          {lixeira ? 'Active' : 'Trash'}
        </button>
      </div>

      <div className="fe-panel-body">
        {carregando && <div className="fe-panel-empty">loading…</div>}
        {!carregando && !items.length && (
          <div className="fe-panel-empty">
            {lixeira ? 'the trash is empty' : 'no flow saved yet'}
          </div>
        )}
        {!carregando &&
          items.map((f) => (
            <div key={f.id} className={'fe-item' + (f.id === abertoId ? ' fe-item-on' : '')}>
              <button
                className="fe-item-main"
                onClick={() => (lixeira ? onRestaurar(f.id) : onAbrir(f.id))}
                title={lixeira ? 'Restore from the trash' : 'Open in the editor'}
              >
                <span className="fe-item-name">
                  {f.name}
                  {f.has_draft && <span className="fe-item-tag" title="unsaved draft">draft</span>}
                </span>
                <span className="fe-item-meta">
                  v{f.current_version} · {f.node_count} nodes · {f.edge_count} edges ·{' '}
                  {dataCurta(lixeira ? f.deleted_at : f.updated_at)}
                </span>
                {f.description && <span className="fe-item-desc">{f.description}</span>}
              </button>
              <div className="fe-item-actions">
                {lixeira ? (
                  <>
                    <button className="fe-mini-btn" onClick={() => onRestaurar(f.id)} title="Restore">
                      ↺
                    </button>
                    <button
                      className="fe-mini-btn fe-mini-danger"
                      onClick={() => onRemover(f.id, true)}
                      title="Delete permanently"
                    >
                      ✕
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className="fe-mini-btn"
                      onClick={() => onRenomear(f.id, f.name)}
                      title="Rename"
                    >
                      ✎
                    </button>
                    <button
                      className="fe-mini-btn fe-mini-danger"
                      onClick={() => onRemover(f.id, false)}
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
