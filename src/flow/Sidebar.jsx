// Tool sidebar. Collapsible and resizable from its own edge -- there is no
// toolbar button for it any more, so the collapse control lives here and the
// collapsed state leaves a rail behind to bring it back.

const DEFAULT_WIDTH = 290;

export default function Sidebar({
  // On a flow shared as 'view' the sidebar becomes a legend: the tools stay
  // visible, but dropping one on the plane would be refused.
  readOnly,
  open,
  width,
  onToggle,
  onResize,
  q,
  onSearch,
  onClearSearch,
  results,
  totalCount,
  onNewTool,
  onEditTool,
  // With an empty catalog the button would open a modal with an empty
  // dropdown, so it says that instead.
  hasTools,
  onRemoveTool
}) {
  if (!open) {
    return (
      <aside className="fe-rail">
        <button className="fe-rail-btn" onClick={onToggle} title="Show tools">
          <span className="fe-rail-icon">⌗</span>
          <span className="fe-rail-label">TOOLS</span>
        </button>
      </aside>
    );
  }

  const hasQuery = q.trim().length > 0;
  const noResults = results.length === 0;

  // Drag on the edge. Listeners go on the document so the pointer can leave the
  // handle mid-drag without the resize sticking or stopping.
  function startResize(e) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    const move = (ev) => onResize(startWidth + (ev.clientX - startX));
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.classList.remove('fe-resizing');
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    document.body.classList.add('fe-resizing');
  }

  return (
    <aside className="fe-sidebar" style={{ width: width }}>
      <div className="fe-sidebar-head">
        <div className="fe-sidebar-head-row">
          <span className="fe-sidebar-label">TOOLS</span>
          <div className="fe-sidebar-head-actions">
            <span className="fe-sidebar-count">{results.length} of {totalCount}</span>
            <button className="fe-mini-btn" onClick={onToggle} title="Collapse the sidebar">
              ‹
            </button>
          </div>
        </div>
        <div className="fe-search">
          <span className="fe-search-icon">⌕</span>
          <input
            className="fe-search-input"
            value={q}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="airflow, kafka, dbt…"
          />
          {hasQuery && (
            <button className="fe-clear-btn" onClick={onClearSearch}>✕</button>
          )}
        </div>
      </div>

      <div className="fe-tool-list">
        {results.map((t) => (
          <div
            key={t.custom ? 'c' + t.id : 'b' + t.n}
            className={'fe-tool-row' + (readOnly ? ' fe-tool-row-off' : '')}
            role="button"
            tabIndex={0}
            onClick={readOnly ? undefined : t.add}
            title={readOnly ? 'view only — you cannot add tools to this diagram' : undefined}
            onKeyDown={(e) => {
              if (!readOnly && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault();
                t.add();
              }
            }}
          >
            <div
              className="fe-tool-icon"
              style={{ background: t.icon ? 'transparent' : t.dim, color: t.col }}
            >
              {t.icon ? <img src={t.icon} alt="" /> : t.k}
            </div>
            <div className="fe-tool-info">
              <span className="fe-tool-name">{t.n}</span>
              <span className="fe-tool-cat">{t.c}</span>
            </div>
            {t.custom ? (
              <button
                className="fe-tool-remove"
                title="Remove from the catalog"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemoveTool(t);
                }}
              >
                ✕
              </button>
            ) : (
              <span className="fe-tool-plus">+</span>
            )}
          </div>
        ))}

        {noResults && (
          <div className="fe-empty-results">
            <span className="fe-empty-results-title">No tool found</span>
            <span className="fe-empty-results-sub">
              Try "orchestration", "stream" or "sql" — or register the one you are missing.
            </span>
            <button className="fe-btn fe-empty-results-btn" onClick={onNewTool}>
              <span className="fe-btn-accent-mark">+</span>New tool
            </button>
          </div>
        )}
      </div>

      <div className="fe-sidebar-foot">
        <button className="fe-new-tool-btn" onClick={onNewTool} disabled={readOnly}>
          <span className="fe-btn-accent-mark">+</span>New tool
        </button>
        <button
          className="fe-new-tool-btn"
          onClick={onEditTool}
          disabled={readOnly || !hasTools}
          title={
            hasTools
              ? 'Change the name, category, colour or icon of any tool — or delete one'
              : 'The catalog is empty'
          }
        >
          <span className="fe-btn-accent-mark">✎</span>Edit tool
        </button>
        <span className="fe-hint">Drag the <span style={{ color: 'var(--accent)' }}>●</span> on the right of a node onto another one to draw an arrow.</span>
        <span className="fe-hint">Double click an edge to label it (input, output…).</span>
        <span className="fe-hint">Double click a node name to rename it (F2); the stack name stays below.</span>
        <span className="fe-hint">Drag the bottom-right corner to resize a node; double click it to reset.</span>
        <span className="fe-hint">Ctrl+click to select several nodes, then right click (or Ctrl+G) to box them into a group.</span>
        <span className="fe-hint">Drag the group by its bar to move everything inside; drag a node out of the box to leave the group.</span>
        <span className="fe-hint">Right click: rename, reset size, duplicate, copy metadata, paste.</span>
      </div>

      <div
        className="fe-sidebar-resizer"
        title="Drag to resize · double click to reset"
        onMouseDown={startResize}
        onDoubleClick={() => onResize(DEFAULT_WIDTH)}
      />
    </aside>
  );
}
