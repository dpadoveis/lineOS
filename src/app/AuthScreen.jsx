import { useState } from 'react';
import Brand from './Brand.jsx';

// Sign in / sign up. One screen, two modes: the difference is a single extra
// field and which endpoint gets called. `registration` (from /api/auth/me)
// decides whether sign-up is offered at all:
//   first_run -> the server has no account yet: only sign-up, for the admin;
//   open      -> both modes;
//   invite    -> sign-up only with a share link opened in this tab;
//   closed    -> sign-in only.
export default function AuthScreen({
  mode: initialMode,
  registration = 'open',
  hasInvite = false,
  onSignIn,
  onSignUp,
  themeIcon,
  onToggleTheme
}) {
  const firstRun = registration === 'first_run';
  const canRegister = firstRun || registration === 'open' || (registration === 'invite' && hasInvite);
  const [mode, setMode] = useState(firstRun || (initialMode === 'register' && canRegister) ? 'register' : 'login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const registering = mode === 'register';
  const ready = email.trim() && password && (!registering || name.trim());

  async function submit(e) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (registering) await onSignUp(name.trim(), email.trim(), password);
      else await onSignIn(email.trim(), password);
    } catch (err) {
      setError((err && err.message) || 'could not sign you in');
      setBusy(false);
    }
  }

  return (
    <div className="fe-auth">
      <button className="fe-auth-theme fe-icon-toggle" title="Toggle light / dark" onClick={onToggleTheme}>
        {themeIcon}
      </button>

      <form className="fe-auth-card" onSubmit={submit}>
        <div className="fe-auth-brand">
          <Brand subtitle="DESIGN · BUILD · OBSERVE" />
        </div>

        <h1 className="fe-auth-title">
          {firstRun ? 'Set up lineOS' : registering ? 'Create your account' : 'Sign in'}
        </h1>
        <p className="fe-auth-sub">
          {firstRun
            ? 'Nobody has signed up on this server yet. The account you create now is its admin.'
            : registering
              ? 'Your diagrams are private to your account, and you choose who to share each one with.'
              : 'Your diagrams and the ones shared with you are waiting on the other side.'}
        </p>

        {registering && (
          <label className="fe-field">
            <span className="fe-field-label">Name</span>
            <input
              className="fe-field-input"
              value={name}
              maxLength={120}
              autoComplete="name"
              onChange={(e) => setName(e.target.value)}
              placeholder="How your name shows on shared diagrams"
            />
          </label>
        )}

        <label className="fe-field">
          <span className="fe-field-label">Email</span>
          <input
            className="fe-field-input"
            type="email"
            value={email}
            maxLength={254}
            autoComplete="email"
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
          />
        </label>

        <label className="fe-field">
          <span className="fe-field-label">
            Password
            {registering && <span className="fe-field-hint">at least 8 characters</span>}
          </span>
          <input
            className="fe-field-input"
            type="password"
            value={password}
            maxLength={200}
            autoComplete={registering ? 'new-password' : 'current-password'}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
          />
        </label>

        {error && <div className="fe-modal-error">{error}</div>}

        <button type="submit" className="fe-btn fe-auth-submit" disabled={!ready || busy}>
          {busy ? 'Just a moment…' : firstRun ? 'Create admin account' : registering ? 'Create account' : 'Sign in'}
        </button>

        {canRegister && !firstRun && (
          <button
            type="button"
            className="fe-auth-switch"
            onClick={() => {
              setMode(registering ? 'login' : 'register');
              setError(null);
            }}
          >
            {registering ? 'I already have an account' : "I don't have an account yet"}
          </button>
        )}
        {!canRegister && (
          <p className="fe-auth-note">
            {registration === 'invite'
              ? 'New here? Accounts are by invitation: open a diagram someone shared with you, then sign up.'
              : 'Sign-up is closed on this server. Ask its admin for access.'}
          </p>
        )}
      </form>
    </div>
  );
}
