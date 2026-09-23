// Hash routing, with no dependency: the SPA may be published under a subpath
// (LINEOS_BASE) and nginx knows no route other than index.html. With a hash,
// a shared link never depends on server configuration.
//
//   #/                      the home, with the recent diagrams
//   #/flow/<id|slug>        the editor, on a stored diagram
//   #/new                   the editor, on a blank document
//   #/share/<token>         a share link someone received
//   #/lineage               the home, with the data lineage tab active
//   #/lineage/<slug>        the lineage detail
//   #/lineage/<slug>/node/<uid>  the same, with one node selected
//   #/pipelines (old)       redirects to #/lineage for backward compatibility
import { useEffect, useState } from 'react';

export function parseHash(hash) {
  const raw = (hash || '').replace(/^#\/?/, '');
  const parts = raw.split('/').filter(Boolean);
  if (!parts.length) return { view: 'home' };
  if (parts[0] === 'new') return { view: 'editor', flowRef: null };
  if (parts[0] === 'flow' && parts[1]) return { view: 'editor', flowRef: decodeURIComponent(parts[1]) };
  if (parts[0] === 'share' && parts[1]) {
    // #/share/<token> or #/share/<token>/lineage/<slug>
    const token = decodeURIComponent(parts[1]);
    if (parts[2] === 'lineage' && parts[3]) {
      return { view: 'share', token, lineageSlug: decodeURIComponent(parts[3]) };
    }
    return { view: 'share', token };
  }
  // Support both 'lineage' and 'pipelines' prefix for backward compatibility
  const isLineageRoute = parts[0] === 'lineage' || parts[0] === 'pipelines';
  if (isLineageRoute && parts[1]) {
    const uid = parts[2] === 'node' && parts[3] ? decodeURIComponent(parts[3]) : null;
    return { view: 'pipeline', slug: decodeURIComponent(parts[1]), uid };
  }
  if (isLineageRoute) return { view: 'home', viewProp: 'lineage' };
  return { view: 'home' };
}

export const go = (path) => {
  window.location.hash = path;
};

export const goHome = () => go('/');
export const goFlow = (ref) => go(ref ? '/flow/' + encodeURIComponent(ref) : '/');
export const goNew = () => go('/new');
export const goLineage = () => go('/lineage');
export const goPipelines = () => go('/lineage');
export const goPipeline = (slug) => go('/lineage/' + encodeURIComponent(slug));

// The hash of a pipeline, optionally deep-linked to one node.
export const pipelineHash = (slug, uid) =>
  '#/lineage/' + encodeURIComponent(slug) + (uid ? '/node/' + encodeURIComponent(uid) : '');

export function useRoute() {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const aoMudar = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', aoMudar);
    return () => window.removeEventListener('hashchange', aoMudar);
  }, []);
  return route;
}
