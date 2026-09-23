// The lineOS identity: the mark and the wordmark, as every screen shows them.
// One file, so the identity changes in one place.
//
// The mark is a lineage in three nodes -- bronze, silver, gold -- climbing
// along one edge. Its colours are the brand tokens in src/flow/theme.css, so
// it follows the theme; public/favicon.svg is the same drawing with the dark
// theme's values written in, since a favicon cannot read the page's CSS.
export function LogoMark({ size = 26 }) {
  return (
    <svg className="fe-logo" width={size} height={size} viewBox="0 0 44 44" aria-hidden="true">
      <rect className="fe-logo-tile" x="1" y="1" width="42" height="42" rx="10" />
      <polyline className="fe-logo-edge" points="10,31 22,22 34,13" />
      <circle className="fe-logo-bronze" cx="10" cy="31" r="4" />
      <circle className="fe-logo-silver" cx="22" cy="22" r="4" />
      <circle className="fe-logo-gold" cx="34" cy="13" r="4.6" />
    </svg>
  );
}

export default function Brand({ subtitle }) {
  return (
    <>
      <LogoMark />
      <div className="fe-title-block">
        <span className="fe-title">
          line<span className="fe-title-os">OS</span>
        </span>
        {subtitle && <span className="fe-subtitle">{subtitle}</span>}
      </div>
    </>
  );
}
