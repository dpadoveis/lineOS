function Marker({ id, color }) {
  return (
    <marker id={id} viewBox="0 0 10 10" refX={9} refY={5} markerWidth={6.5} markerHeight={6.5} orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill={color} />
    </marker>
  );
}

export default function EdgeSvg({ paths, pendingPath, accent }) {
  return (
    <svg
      width={12000}
      height={12000}
      viewBox="-6000 -6000 12000 12000"
      style={{ position: 'absolute', left: '-6000px', top: '-6000px', overflow: 'visible', pointerEvents: 'none' }}
    >
      <defs>
        <Marker id="dcArrow" color={accent} />
      </defs>
      <g style={{ pointerEvents: 'auto' }}>
        {paths.map((p) => (
          <g
            key={p.id}
            style={{ cursor: 'pointer' }}
            onMouseDown={p.onMouseDown}
            onDoubleClick={p.onDoubleClick}
            onContextMenu={p.onContextMenu}
          >
            <path d={p.d} stroke="transparent" strokeWidth={18} fill="none" />
            <path d={p.d} stroke={p.selected ? '#f5d896' : accent} strokeWidth={p.selected ? 2.6 : 1.7} fill="none" markerEnd="url(#dcArrow)" />
          </g>
        ))}
        {pendingPath && (
          <path
            d={pendingPath.d}
            stroke={accent}
            strokeWidth={1.7}
            strokeDasharray="6 5"
            fill="none"
            markerEnd="url(#dcArrow)"
          />
        )}
      </g>
    </svg>
  );
}
