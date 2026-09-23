// Client for the flows API. No dependencies: the native fetch.
//
// The API always sits at `<SPA base>/api`, so the same build works at the root
// (dev, through the Vite proxy) and under the subpath published by nginx
// (<subpath>/api, served by the frontend container's nginx).
// VITE_API_BASE overrides it, in case the API lives on another origin.
const BASE =
  import.meta.env.VITE_API_BASE ||
  (import.meta.env.BASE_URL || '/').replace(/\/+$/, '') + '/api';

// Short messages for the status bar, which is where the user sees the error.
const MESSAGES = {
  401: 'sign in to continue',
  429: 'too many attempts — wait a minute and try again',
  403: 'you do not have permission for that',
  404: 'flow not found on the server',
  409: 'version conflict — reload the flow',
  410: 'the flow is in the trash',
  413: 'flow too large for the server',
  415: 'file type not accepted',
  422: 'the server rejected the flow (invalid format)',
  500: 'internal server error'
};

export class ApiError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

// The share-link token in use, when the tab was opened through #/share/<token>.
// It travels on every request: it is what grants access to someone who is
// neither owner nor invited -- including someone with no account at all.
let shareToken = null;
// The last link token this tab opened. Unlike shareToken it survives leaving
// the shared view: it is the invitation a sign-up carries when the server
// only lets invited people in (REGISTRATION=invite).
let inviteToken = null;

export function setShareToken(token) {
  shareToken = token || null;
  if (token) inviteToken = token;
}

export const getShareToken = () => shareToken;
export const hasInvite = () => !!inviteToken;

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (shareToken) headers['x-share-token'] = shareToken;
  let r;
  try {
    // credentials: the session cookie is httpOnly and has to travel along.
    r = await fetch(BASE + path, { credentials: 'same-origin', ...options, headers: headers });
  } catch (err) {
    throw new ApiError(0, 'server unavailable — is the API up?');
  }
  if (r.status === 204) return null;

  let body = null;
  const contentType = r.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      body = await r.json();
    } catch (err) {
      body = null;
    }
  }
  if (!r.ok) {
    const detail = body && body.detail;
    // A 409 on save carries the server's version, used to tell the user.
    const text =
      (detail && typeof detail === 'object' && detail.message) ||
      (typeof detail === 'string' && r.status !== 422 ? detail : null) ||
      MESSAGES[r.status] ||
      'could not reach the server';
    throw new ApiError(r.status, text, detail);
  }
  return body;
}

const json = (method, body) => ({
  method: method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
});

export const listFlows = (q, trashed) => {
  const p = new URLSearchParams();
  if (q) p.set('q', q);
  if (trashed) p.set('trashed', 'true');
  const qs = p.toString();
  return request('/flows' + (qs ? '?' + qs : ''));
};

export const createFlow = (name, graph, description, note) =>
  request('/flows', json('POST', { name, graph, description: description || null, note: note || null }));

export const openFlow = (id) => request('/flows/' + id);

export const renameFlow = (id, fields) => request('/flows/' + id, json('PATCH', fields));

export const saveVersion = (id, graph, base_version, note) =>
  request('/flows/' + id + '/versions', json('PUT', { graph, base_version, note: note || null }));

export const saveDraft = (id, graph) =>
  request('/flows/' + id + '/draft', json('PUT', { graph }));

export const listVersions = (id) => request('/flows/' + id + '/versions');

export const openVersion = (id, number) => request('/flows/' + id + '/versions/' + number);

export const restoreVersion = (id, number) =>
  request('/flows/' + id + '/versions/' + number + '/restore', { method: 'POST' });

export const deleteFlow = (id, purge) =>
  request('/flows/' + id + (purge ? '?purge=true' : ''), { method: 'DELETE' });

export const restoreFlow = (id) => request('/flows/' + id + '/restore', { method: 'POST' });

export const listFiles = (id) => request('/flows/' + id + '/files');

export function uploadFile(id, blob, filename, kind) {
  const fd = new FormData();
  fd.append('file', blob, filename);
  fd.append('kind', kind || 'attachment');
  return request('/flows/' + id + '/files', { method: 'POST', body: fd });
}

export const deleteFile = (assetId) => request('/files/' + assetId, { method: 'DELETE' });

export const fileUrl = (assetId) => BASE + '/files/' + assetId;

// ── Custom tools ─────────────────────────────────────────────────────

export const listTools = () => request('/tools');

export const createTool = (tool) => request('/tools', json('POST', tool));

export const updateTool = (id, fields) => request('/tools/' + id, json('PATCH', fields));

export const deleteTool = (id) => request('/tools/' + id, { method: 'DELETE' });

// Which diagrams hold a node made from a tool -- what the editor asks before
// offering to delete it. Works for a built-in too, which has no row and so no
// id: it is looked up by name.
export const toolUsage = (slug, names) => {
  const p = new URLSearchParams();
  if (slug) p.set('slug', slug);
  (names || []).forEach((n) => p.append('name', n));
  return request('/tools/usage?' + p.toString());
};

// ── Accounts ─────────────────────────────────────────────────────────

export const register = (name, email, password) =>
  request('/auth/register', json('POST', { name, email, password, invite: inviteToken }));

export const login = (email, password) => request('/auth/login', json('POST', { email, password }));

export const logout = () => request('/auth/logout', { method: 'POST' });

// 200 with `user: null` when nobody is signed in -- a first visit is not an error.
export const session = () => request('/auth/me');

// Changes one's own password. Closes every other session and renews this tab's.
export const changePassword = (current_password, new_password) =>
  request('/auth/password', json('POST', { current_password, new_password }));

export const searchUsers = (q) => request('/users?q=' + encodeURIComponent(q));

// ── Sharing ──────────────────────────────────────────────────────────

export const sharingState = (flowId) => request('/shares/' + flowId);

export const shareWithUser = (flowId, email, permission) =>
  request('/shares/' + flowId + '/users', json('POST', { email, permission }));

export const changeSharePermission = (flowId, shareId, permission) =>
  request('/shares/' + flowId + '/users/' + shareId, json('PATCH', { permission }));

export const revokeShare = (flowId, shareId) =>
  request('/shares/' + flowId + '/users/' + shareId, { method: 'DELETE' });

export const createShareLink = (flowId, permission, expiresDays) =>
  request(
    '/shares/' + flowId + '/links',
    json('POST', { permission, expires_days: expiresDays || null })
  );

export const revokeShareLink = (flowId, linkId) =>
  request('/shares/' + flowId + '/links/' + linkId, { method: 'DELETE' });

export const shareByEmail = (flowId, to, permission, message, baseUrl) =>
  request(
    '/shares/' + flowId + '/email',
    json('POST', { to, permission, message: message || null, base_url: baseUrl || null })
  );

// Resolves a pasted link: says which flow it is, and at what permission.
export const openShareLink = (token) => request('/shares/open/' + encodeURIComponent(token));
