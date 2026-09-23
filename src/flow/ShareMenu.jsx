import { useEffect, useState } from 'react';

// The Share dropdown, anchored to the Share button in the header.
//
// It opens on the three options the feature is about -- share with a user,
// share a link, send by email -- and each of them leads to a panel that carries
// the same permission picker: view, can edit, or full control. The level is
// never implicit: nothing is shared until one is chosen, and `view` is the
// default everywhere.

const LEVELS = [
  { value: 'view', label: 'Can view', hint: 'opens the diagram, changes nothing' },
  { value: 'edit', label: 'Can edit', hint: 'edits and saves versions' },
  { value: 'full', label: 'Full control', hint: 'also shares and deletes it' }
];

function PermissionSelect({ value, onChange, id }) {
  return (
    <select className="fe-select" id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      {LEVELS.map((n) => (
        <option key={n.value} value={n.value}>
          {n.label}
        </option>
      ))}
    </select>
  );
}

const levelLabel = (v) => (LEVELS.find((n) => n.value === v) || LEVELS[0]).label;

export default function ShareMenu({
  flow,
  state,
  loading,
  error,
  notice,
  smtpReady,
  onClose,
  onShareUser,
  onChangePermission,
  onRevokeShare,
  onCreateLink,
  onRevokeLink,
  onCopyLink,
  onSendEmail
}) {
  const [screen, setScreen] = useState('menu');
  const [email, setEmail] = useState('');
  const [userLevel, setUserLevel] = useState('view');
  const [linkLevel, setLinkLevel] = useState('view');
  const [recipient, setRecipient] = useState('');
  const [emailLevel, setEmailLevel] = useState('view');
  const [message, setMessage] = useState('');

  useEffect(() => {
    const aoTeclar = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', aoTeclar);
    return () => window.removeEventListener('keydown', aoTeclar);
  }, [onClose]);

  // With no stored flow there is nothing to share: the invitation is to save first.
  if (!flow) {
    return (
      <div className="fe-share-menu" onMouseDown={(e) => e.stopPropagation()}>
        <div className="fe-share-empty">
          Save this diagram first — sharing needs a flow that exists on the server.
        </div>
      </div>
    );
  }

  const shares = (state && state.shares) || [];
  const links = (state && state.links) || [];

  const voltar = (
    <button className="fe-share-back" onClick={() => setScreen('menu')}>
      ← Share options
    </button>
  );

  return (
    <div className="fe-share-menu" onMouseDown={(e) => e.stopPropagation()}>
      {screen === 'menu' && (
        <>
          <button className="fe-menu-item" onClick={() => setScreen('user')}>
            <span className="fe-menu-item-title">
              <span className="fe-menu-item-mark">☺</span>Share with a user
            </span>
            <span className="fe-menu-item-sub">
              {shares.length ? shares.length + ' already have access' : 'by their account email'}
            </span>
          </button>
          <button className="fe-menu-item" onClick={() => setScreen('link')}>
            <span className="fe-menu-item-title">
              <span className="fe-menu-item-mark">⛓</span>Share a link
            </span>
            <span className="fe-menu-item-sub">
              {links.length ? links.length + ' active link(s)' : 'anyone holding it gets in'}
            </span>
          </button>
          <button className="fe-menu-item" onClick={() => setScreen('email')}>
            <span className="fe-menu-item-title">
              <span className="fe-menu-item-mark">✉</span>Send by email
            </span>
            <span className="fe-menu-item-sub">
              {smtpReady ? 'sent by the server' : 'opens your mail client'}
            </span>
          </button>
        </>
      )}

      {screen === 'user' && (
        <div className="fe-share-panel">
          {voltar}
          <form
            className="fe-share-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (email.trim()) onShareUser(email.trim(), userLevel, () => setEmail(''));
            }}
          >
            <label className="fe-field">
              <span className="fe-field-label">Account email</span>
              <input
                className="fe-field-input"
                type="email"
                value={email}
                placeholder="teammate@company.com"
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <div className="fe-share-row">
              <PermissionSelect value={userLevel} onChange={setUserLevel} />
              <button type="submit" className="fe-btn" disabled={!email.trim() || loading}>
                Share
              </button>
            </div>
            <span className="fe-field-hint">
              {(LEVELS.find((n) => n.value === userLevel) || LEVELS[0]).hint}
            </span>
          </form>

          <div className="fe-share-list">
            {!shares.length && <div className="fe-share-empty">Nobody else has access yet.</div>}
            {shares.map((s) => (
              <div key={s.id} className="fe-share-item">
                <span className="fe-share-who">
                  <span className="fe-share-name">{s.name}</span>
                  <span className="fe-share-mail">{s.email}</span>
                </span>
                <PermissionSelect value={s.permission} onChange={(v) => onChangePermission(s.id, v)} />
                <button
                  className="fe-mini-btn fe-mini-danger"
                  title="Remove access"
                  onClick={() => onRevokeShare(s.id)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {screen === 'link' && (
        <div className="fe-share-panel">
          {voltar}
          <div className="fe-share-form">
            <span className="fe-field-label">New link</span>
            <div className="fe-share-row">
              <PermissionSelect value={linkLevel} onChange={setLinkLevel} />
              <button className="fe-btn" disabled={loading} onClick={() => onCreateLink(linkLevel)}>
                Create &amp; copy
              </button>
            </div>
            <span className="fe-field-hint">
              Whoever opens the link gets {levelLabel(linkLevel).toLowerCase()} — with or without an
              account.
            </span>
          </div>

          <div className="fe-share-list">
            {!links.length && <div className="fe-share-empty">No active link.</div>}
            {links.map((l) => (
              <div key={l.id} className="fe-share-item">
                <span className="fe-share-who">
                  <span className="fe-share-name">{levelLabel(l.permission)}</span>
                  <span className="fe-share-mail">
                    {l.label || 'link'} · {new Date(l.created_at).toLocaleDateString()}
                  </span>
                </span>
                {l.token && (
                  <button className="fe-mini-btn" title="Copy again" onClick={() => onCopyLink(l.token)}>
                    ⧉
                  </button>
                )}
                <button
                  className="fe-mini-btn fe-mini-danger"
                  title="Revoke this link"
                  onClick={() => onRevokeLink(l.id)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {screen === 'email' && (
        <div className="fe-share-panel">
          {voltar}
          <form
            className="fe-share-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (recipient.trim()) onSendEmail(recipient.trim(), emailLevel, message.trim());
            }}
          >
            <label className="fe-field">
              <span className="fe-field-label">Send to</span>
              <input
                className="fe-field-input"
                type="email"
                value={recipient}
                placeholder="someone@company.com"
                onChange={(e) => setRecipient(e.target.value)}
              />
            </label>
            <label className="fe-field">
              <span className="fe-field-label">
                Message <span className="fe-field-hint">optional</span>
              </span>
              <textarea
                className="fe-field-input fe-field-area"
                value={message}
                maxLength={2000}
                rows={2}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Have a look at the ingestion layer…"
              />
            </label>
            <div className="fe-share-row">
              <PermissionSelect value={emailLevel} onChange={setEmailLevel} />
              <button type="submit" className="fe-btn" disabled={!recipient.trim() || loading}>
                Send
              </button>
            </div>
            <span className="fe-field-hint">
              {smtpReady
                ? 'The server sends it with a ' + levelLabel(emailLevel).toLowerCase() + ' link.'
                : 'No SMTP here yet — this opens your own mail client with the link ready.'}
            </span>
          </form>
        </div>
      )}

      {error && <div className="fe-modal-error">{error}</div>}
      {notice && <div className="fe-share-notice">{notice}</div>}
    </div>
  );
}
