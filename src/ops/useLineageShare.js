import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../flow/api.js';
import { copyText } from './clipboard.js';

// Load and manage sharing state for a diagram by its slug.
// Mirrors the sharing logic from useFlowEditor, exposing the same interface
// that ShareMenu requires, plus lifecycle helpers.
// flowSlug opens the diagram (sharing is the diagram's); lineageSlug is where the
// link lands -- the two differ when a lineage was promoted under another name.
export function useLineageShare(flowSlug, lineageSlug) {
  const [flow, setFlow] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [sharingState, setSharingState] = useState(null);
  const [open, setOpen] = useState(false);

  const flowRef = useRef(null);

  // Load the flow by slug to get its id and permission.
  useEffect(() => {
    if (!flowSlug) return;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const f = await api.openFlow(flowSlug);
        setFlow(f);
        flowRef.current = f;
      } catch (err) {
        setError((err && err.message) || 'could not load the diagram');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [flowSlug]);

  // Load sharing state when flow changes or sharing panel opens.
  const loadShare = useCallback(async () => {
    if (!flowRef.current) return;
    setLoading(true);
    setError(null);
    try {
      const state = await api.sharingState(flowRef.current.id);
      setSharingState(state);
    } catch (err) {
      setError((err && err.message) || 'could not load the sharing state');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open && flowRef.current) {
      loadShare();
    }
  }, [open, loadShare]);

  const copyToClipboard = (text, msg) =>
    copyText(text).then((ok) => setNotice(ok ? msg : 'copy this link: ' + text));

  const shareUrl = (token, slug) =>
    window.location.origin + window.location.pathname.replace(/\/#.*/, '') + '#/share/' + encodeURIComponent(token) + (slug ? '/lineage/' + encodeURIComponent(slug) : '');

  const onShareUser = async (email, permission, onDone) => {
    if (!flowRef.current) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const s = await api.shareWithUser(flowRef.current.id, email, permission);
      if (onDone) onDone();
      setNotice(s.name + ' now has access (' + s.permission + ')');
      loadShare();
    } catch (err) {
      setError((err && err.message) || 'could not share it');
    } finally {
      setLoading(false);
    }
  };

  const onChangePermission = async (shareId, permission) => {
    if (!flowRef.current) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      await api.changeSharePermission(flowRef.current.id, shareId, permission);
      setNotice('permission updated');
      loadShare();
    } catch (err) {
      setError((err && err.message) || 'could not change the permission');
    } finally {
      setLoading(false);
    }
  };

  const onRevokeShare = async (shareId) => {
    if (!flowRef.current) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      await api.revokeShare(flowRef.current.id, shareId);
      setNotice('access removed');
      loadShare();
    } catch (err) {
      setError((err && err.message) || 'could not remove the access');
    } finally {
      setLoading(false);
    }
  };

  const onCreateLink = async (permission) => {
    if (!flowRef.current) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const link = await api.createShareLink(flowRef.current.id, permission);
      copyToClipboard(shareUrl(link.token, lineageSlug), 'link copied — it grants "' + permission + '"');
      loadShare();
    } catch (err) {
      setError((err && err.message) || 'could not create the link');
    } finally {
      setLoading(false);
    }
  };

  const onRevokeLink = async (linkId) => {
    if (!flowRef.current) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      await api.revokeShareLink(flowRef.current.id, linkId);
      setNotice('link revoked');
      loadShare();
    } catch (err) {
      setError((err && err.message) || 'could not revoke the link');
    } finally {
      setLoading(false);
    }
  };

  const onCopyLink = (token) => {
    copyToClipboard(shareUrl(token, lineageSlug), 'link copied');
  };

  const onSendEmail = async (to, permission, message) => {
    if (!flowRef.current) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      // The server substitutes {token}; see _share_url in routers/sharing.py.
      const base = window.location.origin + window.location.pathname.replace(/\/#.*/, '') + '#/share/{token}/lineage/' + encodeURIComponent(lineageSlug);
      const r = await api.shareByEmail(flowRef.current.id, to, permission, message, base);
      setLoading(false);
      if (r.sent) {
        setNotice('email sent to ' + r.to);
      } else {
        // No SMTP: the link exists and the user's mail client handles it.
        window.location.href = r.mailto;
      }
    } catch (err) {
      setError((err && err.message) || 'could not send the email');
      setLoading(false);
    }
  };

  return {
    flow,
    state: sharingState,
    loading,
    error,
    notice,
    onShareUser,
    onChangePermission,
    onRevokeShare,
    onCreateLink,
    onRevokeLink,
    onCopyLink,
    onSendEmail,
    open,
    toggle: () => setOpen(!open),
    close: () => setOpen(false),
    canManage: flow && flow.permission === 'full'
  };
}
