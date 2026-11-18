import type { Session } from '@supabase/supabase-js';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { parseLoginId } from './lib/login';
import { supabase } from './lib/supabase';

type AuthState = {
  session: Session | null;
  loading: boolean;
  /** Returns an error message for the screen, or null on success. */
  /** `login` is an email or a mobile number (see parseLoginId). */
  signIn: (login: string, password: string) => Promise<string | null>;
  signOut: () => Promise<void>;
};

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  const signIn = useCallback(async (login: string, password: string) => {
    const id = parseLoginId(login);
    if (!id) return 'Enter your email or your 10-digit mobile number.';
    if (!password) return 'Enter your password.';
    // K4: FIELD_SIGN_IN = email_password (hosted) or mobile_password (local seed); both are auth + password.
    const { data, error } = await supabase.auth.signInWithPassword(
      id.kind === 'email' ? { email: id.email, password } : { phone: id.phone, password },
    );
    if (error || !data.user) {
      return id.kind === 'email'
        ? 'The email or password is not right. Please try again.'
        : 'The mobile number or password is not right. Please try again.';
    }
    const { data: profile } = await supabase.from('profiles').select('role, is_active').eq('id', data.user.id).maybeSingle();
    if (!profile || profile.role !== 'field' || profile.is_active === false) {
      await supabase.auth.signOut();
      return 'This app is for field operators only. Please use the office website.';
    }
    return null;
  }, []);

  const value = useMemo(() => ({ session, loading, signIn, signOut }), [session, loading, signIn, signOut]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
