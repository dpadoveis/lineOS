import { useCallback, useEffect, useState } from 'react';
import * as api from '../flow/api.js';

// Who is signed in. GET /api/auth/me answers 200 with `user: null` when there
// is no session, so a first visit is never treated as an error anywhere.
export function useSession() {
  const [state, setState] = useState({ loading: true, user: null, smtpReady: false, error: null });

  const load = useCallback(async () => {
    try {
      const s = await api.session();
      setState({ loading: false, user: s.user, smtpReady: !!s.smtp_ready, error: null });
    } catch (err) {
      setState({
        loading: false,
        user: null,
        smtpReady: false,
        error: (err && err.message) || 'could not reach the server'
      });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const aplicar = (s) =>
    setState({ loading: false, user: s.user, smtpReady: !!s.smtp_ready, error: null });

  return {
    ...state,
    reload: load,
    signIn: async (email, password) => aplicar(await api.login(email, password)),
    signUp: async (name, email, password) => aplicar(await api.register(name, email, password)),
    signOut: async () => {
      await api.logout();
      setState((s) => ({ ...s, user: null }));
    }
  };
}
