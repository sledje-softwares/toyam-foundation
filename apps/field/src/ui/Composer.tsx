// Thread composer (5.4 / 5.5): text, attach (camera / gallery / document), optional caption and a one-tap
// category chip. Send = outbox.enqueue() for each message; the thread shows it at once with 🕓.
// Gallery and document files are accepted exactly like camera files, with no mark and no block (D18).
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import { useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { attachState } from '../capture/context';
import { drafts } from '../capture/draft';
import { buildNewItems, MAX_FILES_PER_MESSAGE, MAX_TEXT, NO_TASK_TEXT, type PreparedFile } from '../capture/item';
import { CaptureError, discardPrepared, preparePicked, type Picked } from '../capture/prepare';
import { useCaptureContext } from '../capture/useCaptureContext';
import { colors, s } from '../theme';
import { Sheet } from './components';
import { useOffline } from './OutboxProvider';

const errorText = (e: unknown) => (e instanceof CaptureError ? e.message : 'This file could not be added. Please try again.');

export function Composer({ caseId, taskId }: { caseId: string; taskId?: string | null }) {
  const router = useRouter();
  const { outbox, guardCapture } = useOffline();
  const { ctx } = useCaptureContext(caseId, taskId);
  const draft = useSyncExternalStore((cb) => drafts.subscribe(cb), () => drafts.get(caseId));
  const [menu, setMenu] = useState(false);
  const [preparing, setPreparing] = useState(0);
  const [busy, setBusy] = useState(false);
  const attach = attachState(ctx, NO_TASK_TEXT);

  async function addPicked(list: Picked[]) {
    setPreparing((n) => n + list.length);
    const ok: PreparedFile[] = [];
    const errors = new Set<string>();
    for (const p of list) {
      try {
        ok.push(await preparePicked(p, 'gallery'));
      } catch (e) {
        errors.add(errorText(e));
      } finally {
        setPreparing((n) => n - 1);
      }
    }
    drafts.addFiles(caseId, ok);
    if (errors.size > 0) Alert.alert('Some files were not added', [...errors].join('\n'));
  }

  async function pickGallery() {
    setMenu(false);
    if (!guardCapture()) return;
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'], allowsMultipleSelection: true, selectionLimit: MAX_FILES_PER_MESSAGE, exif: true, quality: 1,
    });
    if (res.canceled) return;
    await addPicked(res.assets.map((a) => ({
      uri: a.uri, mimeType: a.mimeType, name: a.fileName, size: a.fileSize, width: a.width, height: a.height,
      exif: a.exif ?? null,
    })));
  }

  async function pickDocument() {
    setMenu(false);
    if (!guardCapture()) return;
    const res = await DocumentPicker.getDocumentAsync({ type: ['application/pdf', 'image/*'], multiple: true, copyToCacheDirectory: true });
    if (res.canceled) return;
    await addPicked(res.assets.map((a) => ({
      uri: a.uri, mimeType: a.mimeType, name: a.name, size: a.size, lastModified: a.lastModified,
    })));
  }

  function openCamera() {
    setMenu(false);
    if (attach.kind !== 'ready' || !guardCapture()) return;
    router.push({ pathname: '/camera', params: { caseId, taskId: attach.taskId } });
  }

  async function removeFile(f: PreparedFile) {
    drafts.removeFile(caseId, f.sha256);
    await discardPrepared(f);
  }

  async function send() {
    if (!outbox) {
      Alert.alert('One moment', 'The app is still starting. Please try again.');
      return;
    }
    const built = buildNewItems({
      caseId, taskId: attach.kind === 'ready' ? attach.taskId : null,
      text: draft.text, categoryCode: draft.files.length > 0 ? draft.categoryCode : null, files: draft.files,
    });
    if (!built.ok) {
      Alert.alert('Not sent', built.message);
      return;
    }
    setBusy(true);
    try {
      for (const item of built.items) {
        await outbox.enqueue(item);
        for (const f of item.files) drafts.removeFile(caseId, f.sha256); // queued: now owned by the outbox
      }
      drafts.sent(caseId);
    } catch {
      Alert.alert('Not saved', 'The message could not be saved on this phone. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  const canSend = !busy && preparing === 0 && (draft.text.trim().length > 0 || draft.files.length > 0);
  const chips = attach.kind === 'ready' ? ctx?.chips ?? [] : [];

  return (
    <View style={{ borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.card, paddingVertical: 8 }}>
      {attach.kind !== 'ready' ? <Text style={[s.muted, { paddingHorizontal: 16, paddingBottom: 6 }]}>{attach.text}</Text> : null}
      {chips.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 12, gap: 8 }}>
          {chips.map((c) => {
            const on = draft.categoryCode === c.code;
            return (
              <Pressable
                key={c.code}
                onPress={() => drafts.update(caseId, { categoryCode: on ? null : c.code })}
                accessibilityRole="button" accessibilityState={{ selected: on }} accessibilityLabel={`Category ${c.name}`}
                style={{
                  minHeight: 44, paddingHorizontal: 14, borderRadius: 22, justifyContent: 'center', borderWidth: 1,
                  borderColor: on ? colors.primary : colors.border, backgroundColor: on ? colors.primary : colors.card,
                }}
              >
                <Text style={{ fontSize: 16, color: on ? colors.onPrimary : colors.text }}>{c.name}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}
      {draft.files.length > 0 || preparing > 0 ? (
        <View style={{ paddingHorizontal: 16, paddingTop: 6 }}>
          {draft.files.map((f) => (
            <View key={f.sha256} style={{ flexDirection: 'row', alignItems: 'center', minHeight: 44 }}>
              <Text style={[s.text, { flex: 1 }]} numberOfLines={1}>{f.original_filename ?? (f.evidence_type === 'document' ? 'Document' : 'Photo')}</Text>
              <Pressable onPress={() => void removeFile(f)} accessibilityRole="button" accessibilityLabel="Remove this file" style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ fontSize: 22, color: colors.muted }}>×</Text>
              </Pressable>
            </View>
          ))}
          {preparing > 0 ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 }}>
              <ActivityIndicator color={colors.primary} />
              <Text style={s.muted}>Preparing {preparing} {preparing === 1 ? 'file' : 'files'}…</Text>
            </View>
          ) : null}
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: 8, paddingTop: 6, gap: 8 }}>
        {attach.kind === 'ready' ? (
          <Pressable onPress={() => setMenu(true)} accessibilityRole="button" accessibilityLabel="Add photo or file" style={round(false)}>
            <Text style={{ fontSize: 28, color: colors.primary }}>+</Text>
          </Pressable>
        ) : null}
        <TextInput
          style={[s.input, { flex: 1, maxHeight: 140, paddingVertical: 12 }]}
          multiline maxLength={MAX_TEXT}
          placeholder={draft.files.length > 0 ? 'Add a caption (optional)' : 'Message'}
          placeholderTextColor={colors.muted}
          value={draft.text}
          onChangeText={(text) => drafts.update(caseId, { text })}
        />
        <Pressable onPress={() => void send()} disabled={!canSend} accessibilityRole="button" accessibilityLabel="Send" style={round(true, !canSend)}>
          <Text style={{ fontSize: 16, fontWeight: '700', color: colors.onPrimary }}>Send</Text>
        </Pressable>
      </View>
      <Sheet visible={menu} onClose={() => setMenu(false)}>
        <MenuRow label="Camera" onPress={openCamera} />
        <MenuRow label="Photos from gallery" onPress={() => void pickGallery()} />
        <MenuRow label="Document (PDF)" onPress={() => void pickDocument()} />
        <MenuRow label="Cancel" onPress={() => setMenu(false)} muted />
      </Sheet>
    </View>
  );
}

function round(primary: boolean, disabled = false) {
  return {
    minWidth: 56, minHeight: 56, borderRadius: 28, paddingHorizontal: primary ? 14 : 0,
    alignItems: 'center' as const, justifyContent: 'center' as const,
    backgroundColor: primary ? colors.primary : colors.bg, opacity: disabled ? 0.4 : 1,
  };
}

function MenuRow({ label, onPress, muted }: { label: string; onPress: () => void; muted?: boolean }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={{ minHeight: 56, justifyContent: 'center', paddingHorizontal: 8 }}>
      <Text style={[s.text, muted && { color: colors.muted }]}>{label}</Text>
    </Pressable>
  );
}
