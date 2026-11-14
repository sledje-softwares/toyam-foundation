import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { supabase } from '../../src/lib/supabase';
import { relativeTime } from '../../src/lib/time';
import { colors, s } from '../../src/theme';

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
    else setMsgs((data ?? []) as Msg[]);
  }, [id]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch on mount
  useEffect(() => { void load(); }, [load]);

  return (
    <SafeAreaView style={s.screen} edges={['bottom']}>
      <Stack.Screen options={{ title: header?.case_ref ?? 'Case' }} />
      <View style={{ padding: 16 }}>
        <Text style={s.title}>{header?.title ?? header?.case_ref ?? ''}</Text>
        {header ? <Text style={s.muted}>{header.insurer_name}</Text> : null}
        <Text style={[s.muted, { marginTop: 8 }]}>Messages are read-only in this version.</Text>
      </View>
      {error ? <Text style={[s.error, { marginHorizontal: 16 }]}>{error}</Text> : null}
      <FlatList
        data={msgs}
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
    </SafeAreaView>
  );
}
