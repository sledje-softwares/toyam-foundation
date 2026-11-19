import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { fetchCaseList, fetchOpenTasks } from '../src/cache/fetch';
import { splitCases, type CaseRow, type CaseTab } from '../src/lib/cases';
import { relativeTime } from '../src/lib/time';
import { applyLocalReads } from '../src/thread/model';
import { colors, s } from '../src/theme';
import { caseListMenuItems, type CaseListMenuKey } from '../src/ui-logic/caseListMenu';
import { outboxMenuLabel } from '../src/ui-logic/offline';
import { Sheet } from '../src/ui/components';
import { useShareInbox } from '../src/ui/ShareIntake';
import { inboxBanner } from '../src/share/intent';
import { useOffline } from '../src/ui/OutboxProvider';
import { StatusStack } from '../src/ui/StatusStack';

export default function Cases() {
  const router = useRouter();
  const { snapshot, requestSignOut, rememberNames, cache, applyOpenTasks } = useOffline();
  const outboxLabel = outboxMenuLabel(snapshot.items);
  const shareLabel = inboxBanner(useShareInbox());
  const [rows, setRows] = useState<CaseRow[]>([]);
  const [tab, setTab] = useState<CaseTab>('open');
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  // gap 9: threads read on this phone (also offline) show no badge for what was already on screen
  const [reads, setReads] = useState<Record<string, string>>({});
  const menuItems = caseListMenuItems(snapshot.items);

  // ⋮ menu: Outbox, Sign out (the D43 sign-out check in requestSignOut is unchanged; only moved here)
  const onMenu = (key: CaseListMenuKey) => {
    setMenuOpen(false);
    if (key === 'outbox') router.push('/outbox');
    else void requestSignOut();
  };

  const names = useCallback((list: CaseRow[]) => rememberNames(Object.fromEntries(list.map((r) => [r.case_id, { case_ref: r.case_ref, title: r.title }]))), [rememberNames]);

  // cache first: the stored list shows at once (and offline), then the refresh replaces it
  const shown = useRef(false);
  useEffect(() => {
    if (!cache || shown.current) return;
    shown.current = true;
    void cache.getList().then((c) => {
      if (!c) return;
      setRows((cur) => (cur.length > 0 ? cur : c.data));
      names(c.data);
    });
  }, [cache, names]);

  const load = useCallback(async () => {
    setRefreshing(true);
    if (cache) void cache.getReads().then(setReads, () => {});
    const list = await fetchCaseList();
    if (!list) setError((e) => e ?? 'Could not load your cases. Pull down to try again.');
    else {
      setError(null);
      setRows(list);
      names(list);
      void cache?.putList(list);
      const open = await fetchOpenTasks();
      if (open) void applyOpenTasks(open);
    }
    setRefreshing(false);
  }, [names, cache, applyOpenTasks]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const split = splitCases(applyLocalReads(rows, reads));
  const list = split[tab];

  return (
    <SafeAreaView style={s.screen} edges={['bottom']}>
      <Stack.Screen options={{
        headerRight: () => (
          <Pressable onPress={() => setMenuOpen(true)} accessibilityRole="button" accessibilityLabel="Menu" style={{ minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ fontSize: 28, color: colors.text }}>⋮</Text>
          </Pressable>
        ),
      }} />
      <StatusStack storage />
      {shareLabel ? (
        <Pressable onPress={() => router.push('/share')} accessibilityRole="button" style={{ minHeight: 56, justifyContent: 'center', paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: '#fff3d6' }}>
          <Text style={[s.text, { fontWeight: '600' }]}>{shareLabel}</Text>
        </Pressable>
      ) : null}
      {outboxLabel ? (
        <Pressable onPress={() => router.push('/outbox')} accessibilityRole="button" style={{ minHeight: 56, justifyContent: 'center', paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.card }}>
          <Text style={[s.text, { fontWeight: '600' }]}>{outboxLabel}</Text>
        </Pressable>
      ) : null}
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
      {error && rows.length === 0 ? <Text style={[s.error, { marginHorizontal: 16 }]}>{error}</Text> : null}
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
      <Sheet visible={menuOpen} onClose={() => setMenuOpen(false)}>
        {menuItems.map((m, i) => (
          <Pressable
            key={m.key} onPress={() => onMenu(m.key)} accessibilityRole="button"
            style={{ minHeight: 56, justifyContent: 'center', ...(i > 0 ? { borderTopWidth: 1, borderTopColor: colors.border } : {}) }}
          >
            <Text style={[s.text, { fontWeight: '600' }]}>{m.label}</Text>
          </Pressable>
        ))}
      </Sheet>
    </SafeAreaView>
  );
}
