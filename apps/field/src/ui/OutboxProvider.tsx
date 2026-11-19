// Wires the outbox to the app: device registration, background task, notifications, gentle prompt,
// storage check, guarded sign-out and drain mode (docs/11 "Offline experience" 6-10).
import { useRouter } from 'expo-router';
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';
import { Alert, AppState } from 'react-native';
import { useAuth } from '../auth';
import type { CaseCache } from '../cache/caseCache';
import { newTasksForHeld, type OpenTask } from '../cache/logic';
import { getCache } from '../cache/runtime';
import { secretStore } from '../lib/secretStore';
import { supabase } from '../lib/supabase';
import { registerOutboxBackgroundTask, unregisterOutboxBackgroundTask } from '../outbox/background';
import { ensureRegisteredDevice, forgetDevice, loadDevice } from '../outbox/device';
import { drainServer } from '../outbox/drainServer';
import type { Outbox, OutboxSnapshot } from '../outbox';
import { randomBytes } from '../outbox/runtime';
import { freeDiskBytes } from '../outbox/transport';
import { useOutbox } from '../outbox/useOutbox';
import { outboxTotals } from '../outbox';
import { drainView, promptView, signOutView, storageView, type CaseName, type DrainPhase } from '../ui-logic/offline';
import {
  askNotificationPermissionOnce, notifyLocal, onNotificationTap, setupNotifications, showSendingProgress,
} from './notifications';
import { allSentContent } from '../ui-logic/offline';
import { sendingNotificationText } from '../ui-logic/threadMenu';
import { clearCaptureContext } from '../capture/useCaptureContext';
import { clearInbox } from '../share/inbox';

interface DrainState {
  phase: DrainPhase;
  startTotal: number;
  closedSent: number | undefined;
}

interface Ctx {
  outbox: Outbox | null;
  snapshot: OutboxSnapshot;
  now: Date;
  storage: ReturnType<typeof storageView>;
  prompt: ReturnType<typeof promptView>;
  dismissPrompt: () => void;
  names: Record<string, CaseName | undefined>;
  rememberNames: (n: Record<string, CaseName>) => void;
  syncedAt: Record<string, string>;
  markSynced: (key: string) => void;
  setActiveThread: (caseId: string | null) => void;
  /** Read cache (null until opened). Survives restarts; cleared with the outbox on wipe. */
  cache: CaseCache | null;
  /** After a case refresh: re-sends held files once per new open task (retryHeld). */
  applyOpenTasks: (open: OpenTask[]) => Promise<void>;
  /** Camera guard: shows the low-storage dialog and returns false when capture should not start. */
  guardCapture: () => boolean;
  requestSignOut: () => Promise<void>;
  drain: DrainState | null;
  finishDrain: () => void;
}

const C = createContext<Ctx | null>(null);

export function useOffline(): Ctx {
  const v = useContext(C);
  if (!v) throw new Error('useOffline outside OutboxProvider');
  return v;
}

const baseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

export function OutboxProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { session } = useAuth();
  const { outbox, snapshot } = useOutbox();
  const [now, setNow] = useState(() => new Date());
  const [freeBytes, setFreeBytes] = useState<number | null>(null);
  const [banner, setBanner] = useState<NonNullable<ReturnType<typeof promptView>> | null>(null);
  const [names, setNames] = useState<Record<string, CaseName | undefined>>({});
  const [syncedAt, setSynced] = useState<Record<string, string>>({});
  const [drainState, setDrain] = useState<DrainState | null>(null);
  const [cache, setCache] = useState<CaseCache | null>(null);
  const cacheRef = useRef<CaseCache | null>(null);
  useEffect(() => { cacheRef.current = cache; }, [cache]);
  const activeThread = useRef<string | null>(null);
  const snapRef = useRef(snapshot);
  useEffect(() => { snapRef.current = snapshot; }, [snapshot]);

  // clock + free space, once a minute
  useEffect(() => {
    const tick = () => {
      setNow(new Date());
      freeDiskBytes().then(setFreeBytes, () => {});
    };
    tick();
    const t = setInterval(tick, 60_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => { setupNotifications(); }, []);

  // open the read cache; freshness labels start from the stored synced_at
  useEffect(() => {
    let live = true;
    void getCache().then(async (c) => {
      const stored = await c.syncedAt();
      if (!live) return;
      setCache(c);
      setSynced((p) => ({ ...stored, ...p }));
    }, () => {});
    return () => { live = false; };
  }, []);

  // "Sending k of n files": one silent ongoing notification, removed when nothing is sending (all_sent shows its own)
  const sendingText = sendingNotificationText(snapshot.sending);
  useEffect(() => { void showSendingProgress(sendingText); }, [sendingText]);
  useEffect(() => onNotificationTap((id) => router.push({ pathname: '/case/[id]', params: { id } })), [router]);

  // after sign-in: register the device, start background sending, ask for notifications once
  const userId = session?.user.id ?? null;
  useEffect(() => {
    if (!userId || !outbox) return;
    let live = true;
    void (async () => {
      try {
        const d = await ensureRegisteredDevice(secretStore, supabase, randomBytes);
        if (live) outbox.setDeviceId(d.device_id);
      } catch {
        // registration is retried at the next sign-in; sending still works
      }
      try { await registerOutboxBackgroundTask(); } catch { /* not available on this device */ }
      await askNotificationPermissionOnce();
    })();
    return () => { live = false; };
  }, [userId, outbox]);

  // outbox events: all_sent (6), auth_blocked / drain_closed / reactivated (10)
  useEffect(() => {
    if (!outbox) return;
    return outbox.onEvent((e) => {
      if (e.type === 'all_sent') {
        const visible = AppState.currentState === 'active' && activeThread.current !== null && activeThread.current === e.case_id;
        if (!visible) {
          const n = allSentContent(e.count);
          void notifyLocal(n.title, n.body, e.case_id);
        }
      } else if (e.type === 'auth_blocked') {
        void startDrain(outbox);
      } else if (e.type === 'drain_closed') {
        void closeDrain(outbox);
      } else if (e.type === 'reactivated') {
        setDrain(null);
        void supabase.auth.refreshSession().catch(() => {});
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- startDrain / closeDrain only use refs and setters
  }, [outbox]);

  // a drain that was running when the app restarted shows the page too
  const drain = useMemo<DrainState | null>(
    () => drainState ?? (snapshot.mode === 'drain' ? { phase: 'draining', startTotal: 0, closedSent: undefined } : null),
    [drainState, snapshot.mode],
  );

  async function drainClient() {
    const d = await loadDevice(secretStore);
    if (!d) return null;
    return drainServer({ baseUrl, anonKey, deviceId: d.device_id, secret: d.secret, fetch: (u, i) => fetch(u, i) });
  }

  async function startDrain(o: Outbox) {
    setDrain((p) => p ?? { phase: 'checking', startTotal: outboxTotals(snapRef.current.items).files, closedSent: undefined });
    try {
      const server = await drainClient();
      if (!server) return void (await closeDrain(o));
      const st = await server.status();
      if (st.state === 'active') { setDrain(null); return; }
      if (st.state === 'closed') return void (await closeDrain(o));
      o.useServer(server, 'drain');
      setDrain((p) => ({ phase: 'draining', startTotal: p?.startTotal ?? 0, closedSent: undefined }));
      void o.sendNow();
    } catch {
      // keep the page up; it retries at the next outbox event
    }
  }

  async function closeDrain(o: Outbox) {
    if (closing.current) return;
    closing.current = true;
    const left = outboxTotals(snapRef.current.items).files; // everything still on the phone is discarded
    const sent = Math.max(0, drainStartRef.current - left);
    try { await (await drainClient())?.finish(left); } catch { /* wipe anyway */ }
    await o.wipe();
    await cacheRef.current?.clear().catch(() => {});
    clearCaptureContext();
    await clearInbox().catch(() => {}); // files shared to the app but never sent
    await forgetDevice(secretStore);
    await unregisterOutboxBackgroundTask().catch(() => {});
    await supabase.auth.signOut({ scope: 'local' }).catch(() => {});
    setDrain({ phase: 'done', startTotal: sent + left, closedSent: sent });
  }

  const closing = useRef(false);
  const drainStartRef = useRef(0);
  useEffect(() => { if (drain) drainStartRef.current = Math.max(drainStartRef.current, drain.startTotal); }, [drain]);

  // finished drain (nothing left to send) closes by itself
  useEffect(() => {
    if (!outbox || !drain || drain.phase !== 'draining') return;
    if (drainView(snapshot.items, drain.startTotal, 'draining').done) void closeDrain(outbox);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- closeDrain only reads refs
  }, [outbox, drain, snapshot.items]);

  const prompt = useMemo(() => promptView(snapshot.items, now, snapshot), [snapshot, now]);

  // gentle prompt (7): one local notification + banner, then markPrompted
  useEffect(() => {
    if (!outbox || !prompt) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reacting to a timed condition
    setBanner(prompt);
    void notifyLocal(prompt.title, prompt.body, null);
    void outbox.markPrompted();
  }, [outbox, prompt]);

  const storage = useMemo(() => storageView(freeBytes, snapshot.items), [freeBytes, snapshot.items]);

  const guardCapture = useCallback(() => {
    const d = storage.cameraDialog;
    if (!d) return true;
    Alert.alert('Phone storage', d.body, [
      { text: d.primary, onPress: () => router.push('/outbox') },
      { text: d.secondary, style: 'cancel' },
    ]);
    return false;
  }, [storage, router]);

  const requestSignOut = useCallback(async () => {
    const v = signOutView(snapRef.current.items);
    if (!v.allowed) {
      Alert.alert(v.title, v.body, [
        { text: 'Send now', onPress: () => void outbox?.sendNow() },
        { text: v.openOutbox, onPress: () => router.push('/outbox') },
        { text: v.stay, style: 'cancel' },
      ]);
      return;
    }
    if (outbox) await outbox.wipe();
    await cache?.clear().catch(() => {});
    clearCaptureContext();
    await clearInbox().catch(() => {}); // files shared to the app but never sent to a case
    await forgetDevice(secretStore).catch(() => {});
    await unregisterOutboxBackgroundTask().catch(() => {});
    await supabase.auth.signOut();
  }, [outbox, router, cache]);

  const rememberNames = useCallback((n: Record<string, CaseName>) => setNames((p) => ({ ...p, ...n })), []);
  const markSynced = useCallback((k: string) => setSynced((p) => ({ ...p, [k]: new Date().toISOString() })), []);
  const setActiveThread = useCallback((id: string | null) => { activeThread.current = id; }, []);
  const finishDrain = useCallback(() => { closing.current = false; setDrain(null); }, []);
  const applyOpenTasks = useCallback(async (open: OpenTask[]) => {
    if (!outbox || !cache) return;
    const held = new Set(snapRef.current.items.filter((i) => i.state === 'held').map((i) => i.case_id));
    const known = await cache.getKnownTasks();
    for (const r of newTasksForHeld(open, known, held)) await outbox.retryHeld(r.caseId, r.taskId);
    await cache.putKnownTasks(open.map((t) => t.task_id));
  }, [outbox, cache]);
  const dismissPrompt = useCallback(() => setBanner(null), []);

  const value: Ctx = {
    outbox, snapshot, now, storage, prompt: snapshot.items.length === 0 ? null : banner,
    dismissPrompt, names,
    rememberNames, syncedAt, markSynced, setActiveThread, cache, applyOpenTasks, guardCapture, requestSignOut, drain, finishDrain,
  };
  return <C.Provider value={value}>{children}</C.Provider>;
}
