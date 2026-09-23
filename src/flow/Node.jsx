export default function Node({ n, registerRef, onDown, onEnter, onLeave, onMenu, onToggleDesc, onDesc, onToggleMeta, onAddMeta, onStartLink, onStartResize, onRenameStart, onRenameChange, onRenameCommit, onRenameCancel, stop }) {
  const hasDesc = n.hasDesc;
  const metaRows = n.meta || [];
  // The metadata list is a dropdown attached below the card (see .fe-meta-drop),
  // so it never changes the node height nor where the edges clip.
  const metaVisible = metaRows.length > 0 && n.metaOpen !== false;
  const metaCount = metaRows.length ? metaRows.length + ' metadata' : 'no metadata';
  const caret = metaRows.length === 0 ? '·' : n.metaOpen !== false ? '▾' : '▸';
  // Renaming does not replace the tool's identity: `n.n` (the technical stack
  // name) stays visible on the line below, next to the category.
  const renamed = !!n.label;

  return (
    <div
      ref={registerRef}
      data-node={n.id}
      className={'fe-node' + (n.h ? ' fe-node-fixed' : '') + (n.resizing ? ' fe-node-resizing' : '')}
      onMouseDown={onDown}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onContextMenu={onMenu}
      style={{ left: n.x, top: n.y, width: n.w || undefined, height: n.h || undefined, borderColor: n.stroke, boxShadow: n.shadow }}
    >
      <div className="fe-node-head">
        <div
          className="fe-node-icon"
          style={{ background: n.icon ? 'transparent' : n.dim, color: n.col }}
        >
          {n.icon ? <img src={n.icon} alt="" draggable={false} /> : n.k}
        </div>
        <div className="fe-node-info">
          {n.renaming ? (
            <input
              className="fe-node-rename"
              data-rename={n.id}
              value={n.renameDraft}
              onChange={(e) => onRenameChange(e.target.value)}
              onMouseDown={stop}
              onDoubleClick={stop}
              onBlur={() => onRenameCommit(n.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  onRenameCommit(n.id);
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  onRenameCancel();
                }
              }}
              placeholder={n.n}
              spellCheck={false}
            />
          ) : (
            <span
              className="fe-node-name"
              title={renamed ? n.label + ' · ' + n.n : n.n}
              onDoubleClick={(e) => {
                e.stopPropagation();
                onRenameStart(n.id);
              }}
            >
              {n.label || n.n}
            </span>
          )}
          <span className="fe-node-cat">
            {renamed && <span className="fe-node-stack" style={{ color: n.stackCol || n.col }}>{n.n}</span>}
            {renamed && <span className="fe-node-sep">·</span>}
            {n.c}
          </span>
        </div>
        <button
          className="fe-desc-toggle"
          title="Description"
          style={{ color: hasDesc ? n.accent : 'var(--mut2)' }}
          onMouseDown={(e) => { e.stopPropagation(); onToggleDesc(n.id, hasDesc); }}
        >
          ≡
        </button>
      </div>

      <div
        className="fe-node-body"
        // With a fixed height the body scrolls; without this the mouse wheel
        // would reach the plane and zoom instead of scrolling the node.
        onWheel={(e) => {
          if (n.h && e.currentTarget.scrollHeight > e.currentTarget.clientHeight) e.stopPropagation();
        }}
      >
        {hasDesc && (
          <div className="fe-node-desc">
            <textarea
              value={n.desc || ''}
              onChange={(e) => onDesc(n.id, e.target.value)}
              onMouseDown={stop}
              placeholder="Describe what this node does"
              rows={2}
            />
          </div>
        )}
      </div>

      <div className="fe-node-foot">
        <button
          className="fe-meta-toggle"
          title="Expand / collapse metadata"
          style={{ color: (n.meta || []).length ? 'var(--mut)' : 'var(--mut4)' }}
          onMouseDown={(e) => { e.stopPropagation(); onToggleMeta(n); }}
        >
          <span className="fe-meta-caret">{caret}</span>{metaCount}
        </button>
        <span className="fe-node-cxy">({n.cxy})</span>
        <button className="fe-meta-add" title="Add metadata" onMouseDown={(e) => { e.stopPropagation(); onAddMeta(n.id); }}>+</button>
      </div>

      {metaVisible && (
        <div
          className="fe-meta-drop"
          // A long list scrolls inside the panel; without this the wheel would
          // reach the plane and zoom instead.
          onWheel={(e) => {
            if (e.currentTarget.scrollHeight > e.currentTarget.clientHeight) e.stopPropagation();
          }}
        >
          <div className="fe-meta-head">
            <span>KEY</span>
            <span>VALUE</span>
            <span></span>
          </div>
          {metaRows.map((m, i) => (
            <div className="fe-meta-row" key={i}>
              <input
                className="fe-meta-key"
                value={m.k}
                onChange={(e) => n.onMetaKey(i, e.target.value)}
                onMouseDown={stop}
                placeholder="key"
              />
              <input
                className="fe-meta-val"
                value={m.v}
                onChange={(e) => n.onMetaVal(i, e.target.value)}
                onMouseDown={stop}
                placeholder="value"
              />
              <button className="fe-meta-remove" title="Remove" onMouseDown={(e) => { e.stopPropagation(); n.onMetaRemove(i); }}>✕</button>
            </div>
          ))}
        </div>
      )}

      <div className="fe-port" title="Point forward" onMouseDown={(e) => onStartLink(e, n.id)} />
      <div
        className="fe-node-resize"
        title="Resize (double click to reset)"
        onMouseDown={(e) => onStartResize(e, n)}
        onDoubleClick={(e) => { e.stopPropagation(); onStartResize(e, n, true); }}
      />
    </div>
  );
}
