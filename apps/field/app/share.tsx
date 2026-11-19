// "Share → Toyam Field" (5.6): choose the case (open cases only, newest first) for the shared files. The files
// then go into that case's composer draft exactly like gallery picks (capture_source 'share', D18: no mark,
// no block): compression, SHA-256, size caps, then on Send the outbox with copies and device OCR. Caption and
// category chip are set in the composer. Thin screen; logic in src/share/intent.ts.
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { drafts } from '../src/capture/draft';
import type { PreparedFile } from '../src/capture/item';
import { CaptureError, preparePicked } from '../src/capture/prepare';
import { fetchCaseList } from '../src/cache/fetch';
import type { CaseRow } from '../src/lib/cases';
import { relativeTime } from '../src/lib/time';
import { clearInbox, clearInboxNotes, removeInboxFile } from '../src/share/inbox';
import { NO_OPEN_CASE, shareCaseChoices, shareHeading, toPicked } from '../src/share/intent';
import { colors, s } from '../src/theme';
import { Btn } from '../src/ui/components';
import { useOffline } from '../src/ui/OutboxProvider';
import { useShareInbox } from '../src/ui/ShareIntake';

export default function Share() {
  const router = useRouter();
  const inbox = useShareInbox();
  const { cache, guardCapture } = useOffline();
  const [cases, setCases] = useState<CaseRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const cached = await cache?.getList().catch(() => null);
      if (live && cached) setCases(cached.data);
      const fresh = await fetchCaseList();
      if (live && fresh) setCases(fresh);
      else if (live && !cached) setCases((c) => c ?? []);
    })();
    return () => { live = false; };
  }, [cache]);

  const files = inbox?.files ?? [];
  const notes = inbox?.rejected ?? [];
  const choices = shareCaseChoices(cases ?? []);

  function leave() {
    void clearInboxNotes();
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }

  function removeAll() {
    Alert.alert('Remove the shared files?', 'They have not been sent and will be deleted from this phone.', [
      { text: 'Keep', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => void clearInbox().then(leave) },
    ]);
  }

  async function choose(c: CaseRow) {
    if (busy || !guardCapture()) return;
    setBusy(c.case_id);
    const ok: PreparedFile[] = [];
    const errors = new Set<string>();
    for (const f of files) {
      try {
        ok.push(await preparePicked(toPicked(f), 'share'));
      } catch (e) {
        errors.add(e instanceof CaptureError ? e.message : 'A file could not be added. Share it again, or add it from the gallery.');
      }
      await removeInboxFile(f.local_path); // now in the outbox sandbox (or refused): the inbox copy goes
    }
    drafts.addFiles(c.case_id, ok);
    await clearInbox();
    setBusy(null);
    if (errors.size > 0) Alert.alert('Some files were not added', [...errors].join('\n'));
    router.replace({ pathname: '/case/[id]', params: { id: c.case_id } });
  }

  return (
    <SafeAreaView style={s.screen} edges={['bottom']}>
      <View style={{ padding: 16, gap: 6 }}>
        <Text style={s.title}>{inbox ? shareHeading(inbox) : 'Nothing to send'}</Text>
        {files.length > 0 ? <Text style={s.muted}>Choose the case. You can add a caption and a category before sending.</Text> : null}
      </View>
      {files.length > 0 ? (
        <ScrollView style={{ maxHeight: 132, marginHorizontal: 16 }} contentContainerStyle={{ gap: 2 }}>
          {files.map((f) => (
            <Text key={f.local_path} style={s.text} numberOfLines={1}>{f.name ?? (f.mime.startsWith('image/') ? 'Photo' : 'File')}</Text>
          ))}
        </ScrollView>
      ) : null}
      {notes.length > 0 ? (
        <View style={{ marginHorizontal: 16, marginTop: 8, padding: 12, borderRadius: 10, backgroundColor: '#fff3d6' }}>
          <Text style={[s.text, { fontWeight: '600' }]}>Not added</Text>
          {notes.slice(0, 5).map((n, i) => <Text key={i} style={s.muted}>{n.name}: {n.message}</Text>)}
          {notes.length > 5 ? <Text style={s.muted}>and {notes.length - 5} more</Text> : null}
        </View>
      ) : null}
      {files.length === 0 ? (
        <View style={{ padding: 16 }}><Btn label="OK" onPress={leave} /></View>
      ) : cases === null ? (
        <ActivityIndicator style={{ marginTop: 24 }} color={colors.primary} />
      ) : choices.length === 0 ? (
        <View style={{ padding: 16, gap: 12 }}>
          <Text style={[s.text, { fontWeight: '700' }]}>{NO_OPEN_CASE.title}</Text>
          <Text style={s.text}>{NO_OPEN_CASE.body}</Text>
          <Btn label={NO_OPEN_CASE.remove} onPress={removeAll} />
          <Btn label={NO_OPEN_CASE.keep} onPress={leave} secondary />
        </View>
      ) : (
        <FlatList
          data={choices}
          keyExtractor={(r) => r.case_id}
          ListHeaderComponent={<Text style={[s.label, { marginHorizontal: 16 }]}>Open cases</Text>}
          ListFooterComponent={
            <View style={{ padding: 16, gap: 8 }}>
              <Text style={s.muted}>Completed cases cannot take files. Ask the office for a new request.</Text>
              <Btn label="Remove the files" onPress={removeAll} secondary />
            </View>
          }
          renderItem={({ item }) => (
            <Pressable style={[s.card, busy && busy !== item.case_id ? { opacity: 0.5 } : null]} onPress={() => void choose(item)} disabled={!!busy} accessibilityRole="button">
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={[s.text, { fontWeight: '700', flex: 1 }]} numberOfLines={1}>{item.title ?? item.case_ref}</Text>
                {busy === item.case_id ? <ActivityIndicator color={colors.primary} /> : null}
              </View>
              <Text style={s.muted}>{item.case_ref} · {item.insurer_name}</Text>
              <Text style={s.muted}>{relativeTime(item.last_message_at)}</Text>
            </Pressable>
          )}
        />
      )}
    </SafeAreaView>
  );
}
