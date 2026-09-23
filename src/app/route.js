// Hash routing, with no dependency: the SPA is published under a subpath
// (/flow-editor/) and nginx knows no route other than index.html. With a hash,
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
  const bruto = (hash || '').replace(/^#\/?/, '');
  const partes = bruto.split('/').filter(Boolean);
  if (!partes.length) return { view: 'home' };
  if (partes[0] === 'new') return { view: 'editor', flowRef: null };
  if (partes[0] === 'flow' && partes[1]) return { view: 'editor', flowRef: decodeURIComponent(partes[1]) };
  if (partes[0] === 'share' && partes[1]) {
    // #/share/<token> or #/share/<token>/lineage/<slug>
    const token = decodeURIComponent(partes[1]);
    if (partes[2] === 'lineage' && partes[3]) {
      return { view: 'share', token, lineageSlug: decodeURIComponent(partes[3]) };
    }
    return { view: 'share', token };
  }
  // Support both 'lineage' and 'pipelines' prefix for backward compatibility
  const isLineageRoute = partes[0] === 'lineage' || partes[0] === 'pipelines';
  if (isLineageRoute && partes[1]) {
    const uid = partes[2] === 'node' && partes[3] ? decodeURIComponent(partes[3]) : null;
    return { view: 'pipeline', slug: decodeURIComponent(partes[1]), uid };
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
