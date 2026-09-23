import { GROUP_COLORS } from './constants.js';

// The box behind the nodes. It owns nothing: the count it shows is how many
// nodes are resting inside it right now, which is also the only definition of
// membership the editor has (see reconcileGroups in geometry.js).
export default function Group({ g, onDown, onMenu, onResize, onRenameStart, onRenameChange, onRenameCommit, onRenameCancel, onPalette, onColor, stop }) {
  return (
    <div
      data-group={g.id}
      className={'fe-group' + (g.selected ? ' fe-group-sel' : '') + (g.active ? ' fe-group-active' : '')}
      style={{
        left: g.x,
        top: g.y,
        width: g.w,
        height: g.h,
        borderColor: g.col,
        // The fill is the group's colour at a tenth of its strength: enough to
        // read as one region, faint enough for the cards to stay on top of it.
        background: g.col + (g.selected ? '20' : '14')
      }}
      onMouseDown={onDown}
      onContextMenu={onMenu}
    >
      <div className="fe-group-head">
        <button
          className="fe-group-swatch"
          title="Group colour"
          style={{ background: g.col }}
          onMouseDown={(e) => {
            e.stopPropagation();
            onPalette(g.id);
          }}
        />
        {g.renaming ? (
          <input
            className="fe-group-rename"
            data-grename={g.id}
            value={g.renameDraft}
            onChange={(e) => onRenameChange(e.target.value)}
            onMouseDown={stop}
            onDoubleClick={stop}
            onBlur={() => onRenameCommit(g.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                onRenameCommit(g.id);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                onRenameCancel();
              }
            }}
            spellCheck={false}
          />
        ) : (
          <span
            className="fe-group-name"
            style={{ color: g.ink }}
            title={g.name + ' — double click to rename'}
            onDoubleClick={(e) => {
              e.stopPropagation();
              onRenameStart(g.id);
            }}
          >
            {g.name}
          </span>
        )}
        <span className="fe-group-count">{g.count === 1 ? '1 node' : g.count + ' nodes'}</span>
      </div>

      {g.paletteOpen && (
        <div className="fe-group-palette" onMouseDown={stop}>
          {GROUP_COLORS.map((c) => (
            <button
              key={c}
              className={'fe-group-chip' + (c === g.col ? ' fe-group-chip-on' : '')}
              style={{ background: c }}
              title={c}
              onMouseDown={(e) => {
                e.stopPropagation();
                onColor(g.id, c);
              }}
            />
          ))}
        </div>
      )}

      <div className="fe-group-resize" title="Resize the group" onMouseDown={(e) => onResize(e, g)} />
    </div>
  );
}
