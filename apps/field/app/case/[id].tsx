import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { CaseHeader, Msg } from '../../src/cache/caseCache';
import { completeTask, fetchCaseList, fetchCaseOpenTasks, fetchChecklist, fetchHeader, fetchMessages } from '../../src/cache/fetch';
import { trimMessages } from '../../src/cache/logic';
import { relativeTime } from '../../src/lib/time';
import { colors, s } from '../../src/theme';
import { checklistView, clockSheetView, freshnessView, type ChecklistRow } from '../../src/ui-logic/offline';
import {
  OFFLINE_TEXT, OFFLINE_TITLE, taskDoneConfirm, taskDoneMenuItems, taskDoneOutcome, type OpenTaskRow,
} from '../../src/ui-logic/taskDone';
import { checklistMenuLabel } from '../../src/ui-logic/threadMenu';
import { ChecklistSheet, ClockSheet, Fresh, Sheet } from '../../src/ui/components';
import { Composer } from '../../src/ui/Composer';
import { useOffline } from '../../src/ui/OutboxProvider';
import { StatusStack } from '../../src/ui/StatusStack';

type Header = Pick<CaseHeader, 'case_ref' | 'title' | 'insurer_name'>;

// There is no dedicated thread-read function yet (docs/11 lists case_messages as the source), so this reads
// the table directly; RLS (p_msg_field_r) limits it to cases on which this operator holds a task and to
// messages with visibility = 'all'. Read-only placeholder: no composer, no mark-as-read, no files.
export default function Thread() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [header, setHeader] = useState<Header | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const { outbox, snapshot, now, syncedAt, markSynced, setActiveThread, cache } = useOffline();
  const [clockId, setClockId] = useState<string | null>(null);
  const [checkOpen, setCheckOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [rows, setRows] = useState<ChecklistRow[]>([]);
  const [openTasks, setOpenTasks] = useState<OpenTaskRow[] | null>(null);
  const [completing, setCompleting] = useState(false);
  const [contextKey, setContextKey] = useState(0);

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
      const [h, m, c] = await Promise.all([cache.getHeader(id), cache.getMessages(id), cache.getChecklist(id)]);
      if (h) setHeader((cur) => cur ?? h.data);
      if (m) setMsgs((cur) => (cur.length > 0 ? cur : m.data));
      if (c) setRows((cur) => (cur.length > 0 ? cur : c.data));
    })();
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
    const fresh = await fetchMessages(id);
    if (!fresh) setError('Could not load the messages.');
    else {
      setError(null);
      const kept = trimMessages(fresh);
      setMsgs(kept);
      void cache?.putMessages(id, kept);
    }
    void loadChecklist();
    const open = await fetchCaseOpenTasks(id);
    if (open) setOpenTasks(open);
  }, [id, cache, markSynced, loadChecklist]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch on mount
  useEffect(() => { void load(); }, [load]);

  const waiting = snapshot.items.filter((i) => i.case_id === id && ['queued', 'uploading', 'held'].includes(i.state));
  const clockItem = waiting.find((i) => i.client_message_id === clockId) ?? null;
  const check = checklistView(rows, snapshot.items.filter((i) => i.case_id === id), snapshot.online, syncedAt[`checklist:${id}`] ?? null, now);
  const doneItems = taskDoneMenuItems(openTasks, snapshot.online);

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
      <FlatList
        data={msgs}
        ListFooterComponent={
          <View>
            {waiting.map((w) => (
              <Pressable key={w.client_message_id} style={s.card} onPress={() => setClockId(w.client_message_id)} accessibilityRole="button" accessibilityLabel="Saved on this phone, tap for details">
                <Text style={s.text}>{w.caption ?? (w.files.length > 0 ? `${w.files.length} ${w.files.length === 1 ? 'file' : 'files'}` : 'Message')}</Text>
                <Text style={s.muted}>🕓 Saved on this phone</Text>
              </Pressable>
            ))}
          </View>
        }
        keyExtractor={(m) => m.id}
        renderItem={({ item }) => (
          <View style={[s.card, item.kind === 'system' && { backgroundColor: colors.bg }]}>
            {item.kind === 'request' ? <Text style={[s.muted, { fontWeight: '700' }]}>Request from the office</Text> : null}
            <Text style={s.text}>
              {item.withdrawn_at ? 'Message withdrawn' : item.body ?? (item.kind === 'media' ? 'Attachment' : item.kind === 'voice' ? 'Voice note' : '')}
            </Text>
            <Text style={s.muted}>{relativeTime(item.created_at)}</Text>
          </View>
        )}
        ListEmptyComponent={<Text style={[s.muted, { textAlign: 'center', marginTop: 40 }]}>No messages yet.</Text>}
      />
      <ClockSheet
        view={clockItem ? clockSheetView(clockItem, now) : null}
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
      </Sheet>
      <ChecklistSheet view={checkOpen ? check : null} loading={false} onClose={() => setCheckOpen(false)} />
      {id ? <Composer caseId={id} refreshKey={contextKey} /> : null}
    </SafeAreaView>
  );
}
