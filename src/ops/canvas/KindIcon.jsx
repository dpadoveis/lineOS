// Kind icons, inline SVG in currentColor so both themes work with no icon
// dependency. DAG: three linked nodes. Cron: a clock. Dataset: a cylinder.
// Unbound: a dashed square.
export default function KindIcon({ kind, size = 18 }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };
  if (kind === 'dag') {
    return (
      <svg {...common}>
        <circle cx="5" cy="6" r="2.5" /><circle cx="5" cy="18" r="2.5" /><circle cx="19" cy="12" r="2.5" />
        <path d="M7.5 6.8 16.6 11M7.5 17.2 16.6 13" />
      </svg>
    );
  }
  if (kind === 'cron') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3.5 2" />
      </svg>
    );
  }
  if (kind === 'dataset') {
    return (
      <svg {...common}>
        <ellipse cx="12" cy="5.5" rx="7.5" ry="2.8" />
        <path d="M4.5 5.5v13c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-13M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8" />
      </svg>
    );
  }
  return (
    <svg {...common} strokeDasharray="3 3">
      <rect x="4" y="4" width="16" height="16" rx="3" />
    </svg>
  );
}
