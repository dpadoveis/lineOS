import { Suspense, lazy, useEffect, useState } from 'react';
import FlowEditor from './flow/FlowEditor.jsx';
import * as api from './flow/api.js';
import AuthScreen from './app/AuthScreen.jsx';
import { LogoMark } from './app/Brand.jsx';
import Home from './app/Home.jsx';
import { applyTheme, storedTheme } from './app/theme.js';
import { goHome, useRoute } from './app/route.js';
import { useSession } from './app/useSession.js';
// Lazy: React Flow and elkjs only load when a pipeline is opened, so the
// editor's bundle does not carry them.
const PipelineDetail = lazy(() => import('./ops/PipelineDetail.jsx'));
import './ops/ops.css';
import './app/app.css';

// Three screens, picked by the hash route (see app/route.js):
//
//   no session                -> AuthScreen (sign in or sign up)
//   #/                        -> Home, with the account's recent diagrams
//   #/lineage                 -> Home, with the lineage tab active
//   #/flow/<ref> | #/new      -> the editor
//   #/share/<token>           -> the editor, opened from a received link -- the
//                               only path that needs no account, because that is
//                               the point of a link.
//   #/lineage/<slug>          -> PipelineDetail
//   #/pipelines (old)         -> redirects to #/lineage
export default function App() {
  const route = useRoute();
  const session = useSession();
  const [theme, setTheme] = useState(storedTheme);
  // Resolving the shared link: {status: 'loading'|'ok'|'error'}.
  const [link, setLink] = useState(null);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // The editor has its own theme button and writes to the same key; coming
  // back to the home, we re-read whatever it stored.
  useEffect(() => {
    setTheme(storedTheme());
  }, [route]);

  useEffect(() => {
    if (route.view !== 'share') {
      api.setShareToken(null);
      setLink(null);
      return undefined;
    }
    let alive = true;
    api.setShareToken(route.token);
    setLink({ status: 'loading' });
    api
      .openShareLink(route.token)
      .then((r) => alive && setLink({ status: 'ok', ...r }))
      .catch((err) =>
        alive && setLink({ status: 'error', message: (err && err.message) || 'invalid link' })
      );
    return () => {
      alive = false;
    };
  }, [route.view, route.token]);

  const toggleTheme = () => setTheme(applyTheme(theme === 'light' ? 'dark' : 'light'));
  const themeIcon = theme === 'light' ? '☾' : '☀';

  if (session.loading) return <Splash text="loading…" />;

  if (route.view === 'share') {
    if (route.lineageSlug) {
      // Opening a lineage/pipeline through a share link
      api.setShareToken(route.token);
      return (
        <Suspense fallback={<div className="ops-screen">loading…</div>}>
          <PipelineDetail slug={route.lineageSlug} uid={null} smtpReady={session.smtpReady} />
        </Suspense>
      );
    }
    // Opening a flow editor through a share link
    if (!link || link.status === 'loading') return <Splash text="opening the shared diagram…" />;
    if (link.status === 'error') {
      return (
        <Splash
          text={link.message}
          action={session.user ? { label: 'Go to your diagrams', onClick: goHome } : null}
        />
      );
    }
    return (
      <FlowEditor
        // The key forces a fresh editor when the diagram changes: the hook
        // loads the document on mount.
        key={'share-' + link.flow_id}
        flowRef={String(link.flow_id)}
        session={session.user}
        smtpReady={session.smtpReady}
        onHome={session.user ? goHome : null}
      />
    );
  }

  if (!session.user) {
    return (
      <AuthScreen
        registration={session.registration}
        hasInvite={api.hasInvite()}
        onSignIn={session.signIn}
        onSignUp={session.signUp}
        themeIcon={themeIcon}
        onToggleTheme={toggleTheme}
      />
    );
  }

  if (route.view === 'editor') {
    return (
      <FlowEditor
        key={'flow-' + (route.flowRef || 'new')}
        flowRef={route.flowRef}
        session={session.user}
        smtpReady={session.smtpReady}
        onHome={goHome}
      />
    );
  }

  if (route.view === 'pipeline') {
    return (
      <Suspense fallback={<div className="ops-screen">loading…</div>}>
        <PipelineDetail slug={route.slug} uid={route.uid} smtpReady={session.smtpReady} />
      </Suspense>
    );
  }

  return (
    <Home
      user={session.user}
      onSignOut={session.signOut}
      themeIcon={themeIcon}
      onToggleTheme={toggleTheme}
      view={route.viewProp || 'diagrams'}
    />
  );
}

function Splash({ text, action }) {
  return (
    <div className="fe-splash">
      <LogoMark size={36} />
      <span className="fe-splash-text">{text}</span>
      {action && (
        <button className="fe-btn" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}
