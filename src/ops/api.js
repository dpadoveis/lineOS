// The ops routes. Same conventions as src/flow/api.js: the session cookie
// travels with every request, and a non-OK response raises with the server's
// `detail`.
//
// The base is resolved from BASE_URL, exactly as src/flow/api.js does, and NOT
// hard-coded to '/api'. The SPA may be published under a subpath (LINEOS_BASE),
// and nginx then only proxies <subpath>/api/ -- an absolute '/api' 404s in that
// build while working fine in dev, so every screen in this module failed the
// moment it left the dev server.
import { getShareToken } from '../flow/api.js';

const BASE =
  import.meta.env.VITE_API_BASE ||
  (import.meta.env.BASE_URL || '/').replace(/\/+$/, '') + '/api';

async function call(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const shareToken = getShareToken();
  if (shareToken) headers['x-share-token'] = shareToken;
  const r = await fetch(BASE + path, {
    credentials: 'include',
    ...options,
    headers
  });
  if (!r.ok) {
    let detail = r.statusText;
    try {
      detail = (await r.json()).detail || detail;
    } catch (_) {
      /* a body that is not JSON leaves the status text */
    }
    const err = new Error(detail);
    err.status = r.status;
    throw err;
  }
  return r.status === 204 ? null : r.json();
}

export const listPipelines = () => call('/pipelines');
export const readPipeline = (slug) => call('/pipelines/' + encodeURIComponent(slug));
export const listInventory = ({ kind, unbound } = {}) => {
  const q = new URLSearchParams();
  if (kind) q.set('kind', kind);
  if (unbound) q.set('unbound', 'true');
  const suffix = q.toString();
  return call('/inventory' + (suffix ? '?' + suffix : ''));
};
export const bind = (slug, uid, body) =>
  call(`/pipelines/${encodeURIComponent(slug)}/bindings/${encodeURIComponent(uid)}`, {
    method: 'PUT',
    body: JSON.stringify(body)
  });
export const unbind = (slug, uid) =>
  call(`/pipelines/${encodeURIComponent(slug)}/bindings/${encodeURIComponent(uid)}`, {
    method: 'DELETE'
  });
export const listRuns = (slug, objectId) =>
  call(`/pipelines/${encodeURIComponent(slug)}/objects/${objectId}/runs`);
export const createPipeline = (name) =>
  call('/pipelines', {
    method: 'POST',
    body: JSON.stringify({ name })
  });
// Promoting an existing diagram. Same route, with the flow named -- it goes
// through `call` like everything else, so it inherits the resolved base path.
// A raw fetch('/api/...') here worked in dev and 404'd in the published build,
// when the SPA lives under a subpath.
export const promoteDiagram = (flowSlug, name) =>
  call('/pipelines', {
    method: 'POST',
    body: JSON.stringify({ flow: flowSlug, name })
  });
export const readSchema = (slug, id) =>
  call(`/pipelines/${encodeURIComponent(slug)}/objects/${id}/schema`);
export const readPreview = (slug, id, { limit = 50, orderBy, dir = 'desc', filters = [] } = {}) => {
  const q = new URLSearchParams();
  if (limit) q.set('limit', limit);
  if (orderBy) q.set('order_by', orderBy);
  if (dir) q.set('dir', dir);
  filters.forEach((f) => q.append('f', f));
  const suffix = q.toString();
  return call(
    `/pipelines/${encodeURIComponent(slug)}/objects/${id}/preview${suffix ? '?' + suffix : ''}`
  );
};
export const readStats = (slug, id) =>
  call(`/pipelines/${encodeURIComponent(slug)}/objects/${id}/stats`);
export const readHistory = (slug, id, days = 30) =>
  call(`/pipelines/${encodeURIComponent(slug)}/objects/${id}/history?days=${days}`);
export const deletePipeline = (slug) =>
  call(`/pipelines/${encodeURIComponent(slug)}`, {
    method: 'DELETE'
  });
export const syncEdges = (slug) =>
  call(`/pipelines/${encodeURIComponent(slug)}/sync-edges`, {
    method: 'POST'
  });
