import { useCallback, useEffect, useState } from 'react';
import * as api from '../flow/api.js';

// Who is signed in, and who may sign up. GET /api/auth/me answers 200 with
// `user: null` when there is no session, so a first visit is never treated as
// an error anywhere. `registration` is first_run | open | invite | closed.
export function useSession() {
  const [state, setState] = useState({
    loading: true,
    user: null,
    smtpReady: false,
    registration: 'open',
    error: null
  });

  const fromServer = (s) => ({
    loading: false,
    user: s.user,
    smtpReady: !!s.smtp_ready,
    registration: s.registration || 'open',
    error: null
  });

  const load = useCallback(async () => {
    try {
      setState(fromServer(await api.session()));
    } catch (err) {
      setState({
        loading: false,
        user: null,
        smtpReady: false,
        registration: 'open',
        error: (err && err.message) || 'could not reach the server'
      });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const apply = (s) => setState(fromServer(s));

  return {
    ...state,
    reload: load,
    signIn: async (email, password) => apply(await api.login(email, password)),
    signUp: async (name, email, password) => apply(await api.register(name, email, password)),
    signOut: async () => {
      await api.logout();
      setState((s) => ({ ...s, user: null }));
    }
  };
}
