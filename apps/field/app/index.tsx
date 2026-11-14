import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../src/auth';
import { splitCases, type CaseRow, type CaseTab } from '../src/lib/cases';
import { supabase } from '../src/lib/supabase';
import { relativeTime } from '../src/lib/time';
import { colors, s } from '../src/theme';

export default function Cases() {
  const router = useRouter();
  const { signOut } = useAuth();
  const [rows, setRows] = useState<CaseRow[]>([]);
  const [tab, setTab] = useState<CaseTab>('open');
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    const { data, error: e } = await supabase.rpc('field_case_list');
    if (e) setError('Could not load your cases. Pull down to try again.');
    else {
      setError(null);
      setRows((data ?? []) as CaseRow[]);
    }
    setRefreshing(false);
  }, []);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const split = splitCases(rows);
  const list = split[tab];

  return (
    <SafeAreaView style={s.screen} edges={['bottom']}>
      <View style={{ flexDirection: 'row', padding: 16, gap: 12 }}>
        {(['open', 'completed'] as const).map((t) => (
          <Pressable
            key={t} onPress={() => setTab(t)} accessibilityRole="tab" accessibilityState={{ selected: tab === t }}
            style={{
              flex: 1, minHeight: 56, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
              backgroundColor: tab === t ? colors.primary : colors.card, borderWidth: 1, borderColor: colors.border,
            }}
          >
            <Text style={{ fontSize: 18, fontWeight: '700', color: tab === t ? colors.onPrimary : colors.text }}>
              {t === 'open' ? 'Open' : 'Completed'} ({split[t].length})
            </Text>
          </Pressable>
        ))}
      </View>
      {error ? <Text style={[s.error, { marginHorizontal: 16 }]}>{error}</Text> : null}
      <FlatList
        data={list}
        keyExtractor={(r) => r.case_id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} />}
        ListEmptyComponent={
          <Text style={[s.muted, { textAlign: 'center', marginTop: 40 }]}>
            {refreshing ? '' : tab === 'open' ? 'No open cases right now.' : 'No completed cases yet.'}
          </Text>
        }
        renderItem={({ item }) => (
          <Pressable style={s.card} onPress={() => router.push({ pathname: '/case/[id]', params: { id: item.case_id } })}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text style={[s.text, { fontWeight: '700', flex: 1 }]} numberOfLines={1}>{item.title ?? item.case_ref}</Text>
              {item.unread_count > 0 ? (
                <View style={{ backgroundColor: colors.badge, borderRadius: 14, minWidth: 28, height: 28, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 }}>
                  <Text style={{ color: '#fff', fontWeight: '700' }}>{item.unread_count}</Text>
                </View>
              ) : null}
            </View>
            <Text style={s.muted}>{item.case_ref} · {item.insurer_name}</Text>
            {item.last_message_preview ? (
              <Text style={[s.text, { marginTop: 6 }]} numberOfLines={2}>{item.last_message_preview}</Text>
            ) : null}
            <Text style={s.muted}>{relativeTime(item.last_message_at)}</Text>
          </Pressable>
        )}
      />
      <Pressable onPress={() => void signOut()} style={{ minHeight: 56, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={[s.muted, { textDecorationLine: 'underline' }]}>Sign out</Text>
      </Pressable>
    </SafeAreaView>
  );
}
