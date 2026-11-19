// Receives "Share → Toyam Field" intents (5.6; thin, untested; logic in src/share/intent.ts). Mounted once in
// the root layout, also while signed out: a share is copied into the share inbox at once and the share screen
// opens as soon as the operator is signed in (and not in a remote sign-out drain). "Keep for now" leaves the
// files in the inbox; the case list shows a banner until a case is chosen or they are removed.
import { ShareIntentModule } from 'expo-share-intent';
import { useRouter, useSegments } from 'expo-router';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { useAuth } from '../auth';
import { inboxSnapshot, loadInbox, receiveShare, subscribeInbox } from '../share/inbox';
import { useOffline } from './OutboxProvider';

export function useShareInbox() {
  return useSyncExternalStore(subscribeInbox, inboxSnapshot);
}

export function ShareIntake() {
  const router = useRouter();
  const segments = useSegments();
  const { session } = useAuth();
  const { drain } = useOffline();
  const inbox = useShareInbox();
  const shown = useRef<string | null>(null);

  useEffect(() => {
    void loadInbox();
    const mod = ShareIntentModule;
    if (!mod) return; // a build without the module: no share target
    const sub = mod.addListener('onChange', (event) => {
      void receiveShare((event as { value?: unknown } | undefined)?.value).finally(() => {
        void Promise.resolve(mod.clearShareIntent('')).catch(() => {});
      });
    });
    const ask = () => {
      try {
        mod.getShareIntent(''); // replays the intent that started / resumed the app as onChange
      } catch {
        // nothing pending
      }
    };
    ask();
    const app = AppState.addEventListener('change', (st) => { if (st === 'active') ask(); });
    return () => {
      sub.remove();
      app.remove();
    };
  }, []);

  // open the share screen once per new share (or per sign-in) while files / notes wait
  const where = segments[0] as string | undefined;
  const waiting = !!inbox && (inbox.files.length > 0 || inbox.rejected.length > 0);
  const sig = waiting && inbox ? `${session?.user.id ?? ''}:${inbox.received_at}:${inbox.files.length}` : null;
  useEffect(() => {
    if (where === 'share') {
      shown.current = sig; // changes made on the share screen itself do not reopen it
      return;
    }
    if (!session || drain || !sig || where === 'sign-in' || shown.current === sig) return;
    shown.current = sig;
    router.push('/share');
  }, [session, drain, sig, where, router]);

  return null;
}
