import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState, FlatList, Pressable, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../../src/auth';
import type { CaseHeader, Msg, ThreadFiles } from '../../src/cache/caseCache';
import {
  completeTask, fetchCaseList, fetchCaseOpenTasks, fetchChecklist, fetchHeader, fetchMessages, fetchThreadFiles, markThreadRead,
} from '../../src/cache/fetch';
import { trimMessages } from '../../src/cache/logic';
import {
  confirmedIds, deliveryItems, mergeThread, newlyStored, readMark, stableOrder, trackDelivery, type ThreadFile, type ThreadRow,
} from '../../src/thread/model';
import { colors, s } from '../../src/theme';
import { checklistView, clockSheetView, freshnessView, type ChecklistRow } from '../../src/ui-logic/offline';
import {
  OFFLINE_TEXT, OFFLINE_TITLE, taskDoneConfirm, taskDoneMenuItems, taskDoneOutcome, type OpenTaskRow,
} from '../../src/ui-logic/taskDone';
import { checklistMenuLabel, threadOutboxLabel } from '../../src/ui-logic/threadMenu';
import { ChecklistSheet, ClockSheet, Fresh, Sheet } from '../../src/ui/components';
import { Composer } from '../../src/ui/Composer';
import { useOffline } from '../../src/ui/OutboxProvider';
import { StatusStack } from '../../src/ui/StatusStack';
import { Bubble } from '../../src/ui/thread/Bubble';
import { Viewer } from '../../src/ui/thread/Viewer';

type Header = Pick<CaseHeader, 'case_ref' | 'title' | 'insurer_name'>;

/** While the thread is open and online: messages, files and ticks are refreshed this often. */
const POLL_MS = 45_000;
/** After one of this case's items is stored (✓): fetch the server copy this soon (gap 6). */
const AFTER_DELIVERY_MS = 1_200;

// Thread = server messages (case_messages under RLS p_msg_field_r: this operator's cases, visibility 'all')
// with their files (evidence under RLS) merged with this case's outbox items by client_message_id
// (src/thread/model.ts). The thread is marked read whenever it is shown online (gap 9).
export default function Thread() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { session } = useAuth();
  const me = session?.user.id ?? null;
  const [header, setHeader] = useState<Header | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [files, setFiles] = useState<ThreadFiles>({ files: [], staff_last_read_at: null });
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const { outbox, snapshot, now, syncedAt, markSynced, setActiveThread, cache, delivery, confirmDelivered } = useOffline();
  const [clockId, setClockId] = useState<string | null>(null);
  const [checkOpen, setCheckOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [rows, setRows] = useState<ChecklistRow[]>([]);
  const [openTasks, setOpenTasks] = useState<OpenTaskRow[] | null>(null);
  const [completing, setCompleting] = useState(false);
  const [contextKey, setContextKey] = useState(0);
  const [viewer, setViewer] = useState<{ images: ThreadFile[]; start: number; n: number } | null>(null);
  const { width } = useWindowDimensions();

  // the thread is open: no "all sent" notification for it
  useEffect(() => {
    setActiveThread(id ?? null);
    return () => setActiveThread(null);
  }, [id, setActiveThread]);

  // cache first (works offline and after a restart), then refresh when online
  const loadChecklist = useCallback(async () => {
    if (!id) return;
    const fresh = await fetchChecklist(id);
    if (!fresh) return;
    setRows(fresh);
    void cache?.putChecklist(id, fresh);
    markSynced(`checklist:${id}`);
  }, [id, cache, markSynced]);

  useEffect(() => {
    if (!id || !cache) return;
    void (async () => {
      const [h, m, c, f] = await Promise.all([cache.getHeader(id), cache.getMessages(id), cache.getChecklist(id), cache.getFiles(id)]);
      if (h) setHeader((cur) => cur ?? h.data);
      if (m) {
        setMsgs((cur) => (cur.length > 0 ? cur : m.data));
        // offline too: what is on screen is read (the cached case list drops its badge)
        const mark = readMark(m.data);
        if (mark) void cache.markRead(id, mark);
      }
      if (c) setRows((cur) => (cur.length > 0 ? cur : c.data));
      if (f) setFiles((cur) => (cur.files.length > 0 ? cur : f.data));
    })();
  }, [id, cache]);

  // messages + files + ticks; marks the thread read first so nothing fetched afterwards counts as unread
  const loading = useRef(false);
  const loadThread = useCallback(async () => {
    if (!id || loading.current) return;
    loading.current = true;
    try {
      await markThreadRead(id);
      const [fresh, f] = await Promise.all([fetchMessages(id), fetchThreadFiles(id)]);
      if (!fresh) {
        setError('Could not load the messages.');
        return;
      }
      setError(null);
      const kept = trimMessages(fresh);
      setMsgs(kept);
      void cache?.putMessages(id, kept);
      const mark = readMark(kept);
      if (mark) void cache?.markRead(id, mark);
      if (f) {
        setFiles(f);
        void cache?.putFiles(id, f, kept);
      }
    } finally {
      loading.current = false;
    }
  }, [id, cache]);

  const load = useCallback(async () => {
    if (!id) return;
    const list = await fetchCaseList();
    const row = list?.find((r) => r.case_id === id);
    if (row) {
      const base = { case_ref: row.case_ref, title: row.title, insurer_name: row.insurer_name };
      const h = await fetchHeader(id, base);
      setHeader(h ?? base);
      if (h) { void cache?.putHeader(id, h); markSynced(id); }
    }
    await loadThread();
    void loadChecklist();
    const open = await fetchCaseOpenTasks(id);
    if (open) setOpenTasks(open);
  }, [id, cache, markSynced, loadChecklist, loadThread]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch on mount
  useEffect(() => { void load(); }, [load]);

  // refresh while open and online (new office messages, ✓✓ after labelling, blue ✓✓) and when the app comes back
  const online = snapshot.online;
  useEffect(() => {
    if (!online) return;
    const t = setInterval(() => { void loadThread(); }, POLL_MS);
    const sub = AppState.addEventListener('change', (st) => { if (st === 'active') void loadThread(); });
    return () => { clearInterval(t); sub.remove(); };
  }, [online, loadThread]);

  // gap 6: a sent item never leaves the screen. The provider keeps stored items the outbox has dropped (also
  // across leaving this screen and restarts) until a fetch here confirms them; tracking the live snapshot
  // again in render closes the one-render gap before the provider's effect runs.
  const caseItems = useMemo(() => snapshot.items.filter((i) => i.case_id === id), [snapshot.items, id]);
  const tracked = useMemo(() => trackDelivery(delivery, snapshot.items, new Set()), [delivery, snapshot.items]);
  const [storedSeen, setStoredSeen] = useState<{ stored: ReadonlySet<string> }>({ stored: new Set() });
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!newlyStored(storedSeen, caseItems)) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- remembers which items were already stored
    setStoredSeen({ stored: new Set(caseItems.filter((i) => i.message_id !== null).map((i) => i.client_message_id)) });
    if (!refetchTimer.current) {
      refetchTimer.current = setTimeout(() => { refetchTimer.current = null; void loadThread(); }, AFTER_DELIVERY_MS);
    }
  }, [caseItems, storedSeen, loadThread]);
  useEffect(() => () => { if (refetchTimer.current) clearTimeout(refetchTimer.current); }, []);

  const send = { online, paused: snapshot.paused, next_retry_at: snapshot.next_retry_at };
  const thread = useMemo(
    () => mergeThread({ server: msgs, files: files.files, outbox: deliveryItems(tracked, id), me, staffLastReadAt: files.staff_last_read_at, send, now }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `send` is rebuilt from these snapshot fields
    [msgs, files, tracked, me, online, snapshot.paused, snapshot.next_retry_at, now],
  );
  // rows already on screen keep their order through the outbox → server hand-over (no jumps)
  const [order, setOrder] = useState<string[]>([]);
  const ordered = useMemo(() => {
    const byKey = new Map(thread.map((r) => [r.key, r] as const));
    return stableOrder(order, thread).map((k) => byKey.get(k)).filter((r): r is ThreadRow => !!r);
  }, [order, thread]);
  useEffect(() => {
    const keys = ordered.map((r) => r.key);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- remembers the display order
    if (keys.length !== order.length || keys.some((k, i) => k !== order[i])) setOrder(keys);
  }, [ordered, order]);
  const listData = useMemo(() => [...ordered].reverse(), [ordered]); // inverted list: newest at the bottom
  // the state text ("Sent", "Processed", …) shows on items still on the phone and on the newest own message
  const lastOwnKey = useMemo(() => listData.find((r) => r.mine && r.kind !== 'system')?.key ?? null, [listData]);

  // server copies fetched with all their files: the provider stops keeping those items
  useEffect(() => {
    const ids = confirmedIds(thread);
    if (ids.length > 0) confirmDelivered(ids);
  }, [thread, confirmDelivered]);

  const waiting = caseItems.filter((i) => ['queued', 'uploading', 'held'].includes(i.state));
  const clockItem = waiting.find((i) => i.client_message_id === clockId) ?? null;
  const clockReason = thread.find((r) => r.clientMessageId === clockId)?.status ?? null;
  const check = checklistView(rows, caseItems, snapshot.online, syncedAt[`checklist:${id}`] ?? null, now);
  const doneItems = taskDoneMenuItems(openTasks, snapshot.online);
  // a bubble is at most 84 % of the screen; minus its padding and border
  const gridWidth = Math.floor(width * 0.84) - 22;

  const openImage = useCallback((row: ThreadRow, index: number) => setViewer((v) => ({ images: row.images, start: index, n: (v?.n ?? 0) + 1 })), []);
  const openPending = useCallback((cid: string) => setClockId(cid), []);
  const retry = useCallback(() => { void outbox?.sendNow(id); }, [outbox, id]);

  // "Mark task done": online only (never queued), confirmed first; afterwards the thread, the composer's task and the
  // cached case list are refreshed so the case shows under Completed when nothing is left open.
  async function finishTask(taskId: string) {
    setCompleting(true);
    const error = await completeTask(taskId);
    const left = await fetchCaseOpenTasks(id ?? '');
    setCompleting(false);
    const outcome = taskDoneOutcome(error, left?.length ?? 0);
    if (outcome.kind === 'done') {
      if (left) setOpenTasks(left);
      setContextKey((k) => k + 1);
      void load();
      const list = await fetchCaseList();
      if (list) void cache?.putList(list);
    }
    Alert.alert(outcome.title, outcome.text);
  }

  function askTaskDone(taskId: string) {
    setMenuOpen(false);
    if (completing) return;
    if (!snapshot.online) {
      Alert.alert(OFFLINE_TITLE, OFFLINE_TEXT);
      return;
    }
    const t = openTasks?.find((x) => x.id === taskId);
    if (!t) return;
    const waitingFiles = waiting.reduce((n, w) => n + w.files.length, 0);
    const c = taskDoneConfirm(t, { waitingFiles, checklist: rows });
    Alert.alert(c.title, c.body, [
      { text: c.cancel, style: 'cancel' },
      { text: c.confirm, onPress: () => { void finishTask(taskId); } },
    ]);
  }

  return (
    <SafeAreaView style={s.screen} edges={['bottom']}>
      <StatusStack />
      <Stack.Screen options={{
        title: header?.case_ref ?? 'Case',
        headerRight: () => (
          <Pressable onPress={() => setMenuOpen(true)} accessibilityRole="button" accessibilityLabel="Menu" style={{ minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ fontSize: 28, color: colors.text }}>⋮</Text>
          </Pressable>
        ),
      }} />
      <View style={{ padding: 16 }}>
        <Text style={s.title}>{header?.title ?? header?.case_ref ?? ''}</Text>
        {header ? <Text style={s.muted}>{header.insurer_name}</Text> : null}
        <Fresh {...freshnessView(syncedAt[id ?? ''], now)} />
      </View>
      {error ? <Text style={[s.error, { marginHorizontal: 16 }]}>{error}</Text> : null}
      {listData.length === 0 ? (
        <View style={{ flex: 1 }}><Text style={[s.muted, { textAlign: 'center', marginTop: 40 }]}>No messages yet.</Text></View>
      ) : (
        <FlatList
          data={listData}
          inverted
          keyExtractor={(r) => r.key}
          // long threads: only rows near the screen are mounted; thumbnails decode at tile size
          initialNumToRender={10} maxToRenderPerBatch={6} windowSize={7} removeClippedSubviews
          contentContainerStyle={{ paddingVertical: 8 }}
          renderItem={({ item }) => (
            <Bubble row={item} width={gridWidth} online={online} now={now} onOpenImage={openImage} onPending={openPending} onRetry={retry}
              showLabel={!item.fromServer || item.key === lastOwnKey} />
          )}
        />
      )}
      <ClockSheet
        view={clockItem ? clockSheetView(clockItem, now, clockReason) : null}
        onSend={() => { void outbox?.sendNow(id); setClockId(null); }}
        onOutbox={() => { setClockId(null); router.push('/outbox'); }}
        onClose={() => setClockId(null)}
      />
      <Sheet visible={menuOpen} onClose={() => setMenuOpen(false)}>
        <Pressable
          onPress={() => { setMenuOpen(false); setCheckOpen(true); void loadChecklist(); }}
          accessibilityRole="button" style={{ minHeight: 56, justifyContent: 'center' }}
        >
          <Text style={[s.text, { fontWeight: '600' }]}>{checklistMenuLabel(rows)}</Text>
        </Pressable>
        {doneItems.map((d) => (
          <Pressable
            key={d.taskId} onPress={() => askTaskDone(d.taskId)} disabled={completing}
            accessibilityRole="button" accessibilityState={{ disabled: completing }}
            style={{ minHeight: 56, justifyContent: 'center', borderTopWidth: 1, borderTopColor: colors.border }}
          >
            <Text style={[s.text, { fontWeight: '600', color: completing ? colors.muted : colors.text }]}>
              {completing ? 'Marking done…' : d.label}
            </Text>
          </Pressable>
        ))}
        <Pressable
          onPress={() => { setMenuOpen(false); router.push('/outbox'); }}
          accessibilityRole="button" style={{ minHeight: 56, justifyContent: 'center', borderTopWidth: 1, borderTopColor: colors.border }}
        >
          <Text style={[s.text, { fontWeight: '600' }]}>{threadOutboxLabel(snapshot.items)}</Text>
        </Pressable>
      </Sheet>
      <ChecklistSheet view={checkOpen ? check : null} loading={false} onClose={() => setCheckOpen(false)} />
      {viewer ? <Viewer key={viewer.n} images={viewer.images} start={viewer.start} online={online} onClose={() => setViewer(null)} /> : null}
      {id ? <Composer caseId={id} refreshKey={contextKey} /> : null}
    </SafeAreaView>
  );
}
