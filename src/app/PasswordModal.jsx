import { useEffect, useRef, useState } from 'react';

// Changing one's own password. It asks for the current one even with an open
// session: without that, one tab forgotten on another computer would be enough
// to take the account over. On a change, the server closes every other session.
export default function PasswordModal({ onCancel, onSubmit }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const primeiro = useRef(null);

  useEffect(() => {
    if (primeiro.current) primeiro.current.focus();
  }, []);

  useEffect(() => {
    const aoTeclar = (e) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', aoTeclar);
    return () => window.removeEventListener('keydown', aoTeclar);
  }, [onCancel]);

  const tooShort = next.length > 0 && next.length < 8;
  const mismatch = confirmation.length > 0 && next !== confirmation;
  const ready = current && next.length >= 8 && next === confirmation && !saving;

  async function enviar(e) {
    e.preventDefault();
    if (!ready) return;
    setSaving(true);
    setError(null);
    try {
      await onSubmit(current, next);
    } catch (err) {
      setError((err && err.message) || 'could not change your password');
      setSaving(false);
    }
  }

  return (
    <div className="fe-modal-backdrop" onMouseDown={onCancel}>
      <form className="fe-modal" onMouseDown={(e) => e.stopPropagation()} onSubmit={enviar}>
        <div className="fe-modal-head">
          <div className="fe-modal-titles">
            <span className="fe-modal-title">Change password</span>
            <span className="fe-modal-sub">
              Every other session signed in to this account is signed out.
            </span>
          </div>
          <button type="button" className="fe-panel-close" onClick={onCancel} title="Close">
            ✕
          </button>
        </div>

        <div className="fe-modal-body">
          <label className="fe-field">
            <span className="fe-field-label">Current password</span>
            <input
              ref={primeiro}
              className="fe-field-input"
              type="password"
              value={current}
              maxLength={200}
              autoComplete="current-password"
              onChange={(e) => setCurrent(e.target.value)}
            />
          </label>

          <label className="fe-field">
            <span className="fe-field-label">
              New password
              <span className="fe-field-hint">at least 8 characters</span>
            </span>
            <input
              className="fe-field-input"
              type="password"
              value={next}
              maxLength={200}
              autoComplete="new-password"
              onChange={(e) => setNext(e.target.value)}
            />
          </label>

          <label className="fe-field">
            <span className="fe-field-label">Repeat the new password</span>
            <input
              className="fe-field-input"
              type="password"
              value={confirmation}
              maxLength={200}
              autoComplete="new-password"
              onChange={(e) => setConfirmation(e.target.value)}
            />
          </label>

          {tooShort && <div className="fe-modal-error">The new password is too short.</div>}
          {mismatch && <div className="fe-modal-error">The two new passwords do not match.</div>}
          {error && <div className="fe-modal-error">{error}</div>}
        </div>

        <div className="fe-modal-foot">
          <button type="button" className="fe-ghost-btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="fe-btn" disabled={!ready}>
            {saving ? 'Saving…' : 'Change password'}
          </button>
        </div>
      </form>
    </div>
  );
}
