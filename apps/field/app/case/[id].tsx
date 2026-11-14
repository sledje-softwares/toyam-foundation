import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { supabase } from '../../src/lib/supabase';
import { relativeTime } from '../../src/lib/time';
import { colors, s } from '../../src/theme';
import { checklistView, clockSheetView, freshnessView, type ChecklistRow } from '../../src/ui-logic/offline';
import { Btn, ChecklistSheet, ClockSheet, Fresh } from '../../src/ui/components';
import { useOffline } from '../../src/ui/OutboxProvider';
import { StatusStack } from '../../src/ui/StatusStack';

type Msg = {
  id: string;
  kind: 'text' | 'media' | 'voice' | 'system' | 'request';
  body: string | null;
  sender_id: string | null;
  created_at: string;
  withdrawn_at: string | null;
};

type Header = { case_ref: string; title: string | null; insurer_name: string };

// There is no dedicated thread-read function yet (docs/11 lists case_messages as the source), so this reads
// the table directly; RLS (p_msg_field_r) limits it to cases on which this operator holds a task and to
// messages with visibility = 'all'. Read-only placeholder: no composer, no mark-as-read, no files.
export default function Thread() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [header, setHeader] = useState<Header | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const { outbox, snapshot, now, syncedAt, markSynced, setActiveThread } = useOffline();
  const [clockId, setClockId] = useState<string | null>(null);
  const [checkOpen, setCheckOpen] = useState(false);
  const [rows, setRows] = useState<ChecklistRow[]>([]);

  // the thread is open: no "all sent" notification for it
  useEffect(() => {
    setActiveThread(id ?? null);
    return () => setActiveThread(null);
  }, [id, setActiveThread]);

  // Checklist (D41): read-only, RLS limits it to this operator's tasks.
  const loadChecklist = useCallback(async () => {
    if (!id) return;
    const [list, cats] = await Promise.all([
      supabase.from('v_case_checklist').select('checklist_item_id, description, category_id, status, evidence_count, position').eq('case_id', id).order('position'),
      supabase.from('evidence_categories').select('id, code'),
    ]);
    if (list.error) return;
    const code = new Map((cats.data ?? []).map((c: { id: string; code: string }) => [c.id, c.code]));
    setRows((list.data ?? []).map((r) => ({
      checklist_item_id: String(r.checklist_item_id), description: r.description ?? '', status: String(r.status),
      evidence_count: Number(r.evidence_count ?? 0), category_code: r.category_id ? code.get(r.category_id) ?? null : null,
    })));
    markSynced(`checklist:${id}`);
  }, [id, markSynced]);

  const load = useCallback(async () => {
    if (!id) return;
    const list = await supabase.rpc('field_case_list');
    const row = (list.data ?? []).find((r: { case_id: string }) => r.case_id === id);
    if (row) setHeader({ case_ref: row.case_ref, title: row.title, insurer_name: row.insurer_name });
    const { data, error: e } = await supabase
      .from('case_messages')
      .select('id, kind, body, sender_id, created_at, withdrawn_at')
      .eq('case_id', id)
      .order('created_at', { ascending: true });
    if (e) setError('Could not load the messages.');
    else { setMsgs((data ?? []) as Msg[]); markSynced(id); }
  }, [id, markSynced]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch on mount
  useEffect(() => { void load(); }, [load]);

  const waiting = snapshot.items.filter((i) => i.case_id === id && ['queued', 'uploading', 'held'].includes(i.state));
  const clockItem = waiting.find((i) => i.client_message_id === clockId) ?? null;
  const check = checklistView(rows, snapshot.items.filter((i) => i.case_id === id), snapshot.online, syncedAt[`checklist:${id}`] ?? null, now);

  return (
    <SafeAreaView style={s.screen} edges={['bottom']}>
      <StatusStack />
      <Stack.Screen options={{ title: header?.case_ref ?? 'Case' }} />
      <View style={{ padding: 16 }}>
        <Text style={s.title}>{header?.title ?? header?.case_ref ?? ''}</Text>
        {header ? <Text style={s.muted}>{header.insurer_name}</Text> : null}
        <Fresh {...freshnessView(syncedAt[id ?? ''], now)} />
        <View style={{ flexDirection: 'row', marginTop: 12 }}>
          <Btn label="Checklist" secondary onPress={() => { setCheckOpen(true); void loadChecklist(); }} />
        </View>
        <Text style={[s.muted, { marginTop: 8 }]}>Messages are read-only in this version.</Text>
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
      <ChecklistSheet view={checkOpen ? check : null} loading={false} onClose={() => setCheckOpen(false)} />
    </SafeAreaView>
  );
}
