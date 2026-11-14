import 'react-native-get-random-values';
import { createClient } from '@supabase/supabase-js';
import { AppState } from 'react-native';
import { LargeSecureStore } from './largeSecureStore';

// Anon / publishable key only. Never put a service-role key in this app (CLAUDE.md rule 4).
const url = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

export const supabase = createClient(url, anonKey, {
  auth: {
    storage: new LargeSecureStore(),
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

// Refresh tokens only while the app is in the foreground.
AppState.addEventListener('change', (s) => {
  if (s === 'active') void supabase.auth.startAutoRefresh();
  else void supabase.auth.stopAutoRefresh();
});
