export default function ContextMenu({ menu, items }) {
  if (!menu) return null;
  return (
    <div className="fe-context-menu" style={{ left: menu.x, top: menu.y }}>
      {items.map((mi, i) => (
        <button key={i} className="fe-context-item" onClick={mi.act}>
          <span className="fe-context-label" style={{ color: mi.col }}>{mi.label}</span>
          <span className="fe-context-hint">{mi.hint}</span>
        </button>
      ))}
    </div>
  );
}
