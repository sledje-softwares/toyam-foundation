// Info panel of one file (D54): category chips, the reading's description, the file's comments and "Add comment".
// Used under the photo in the full-screen viewer (dark) and in the file sheet for PDFs / audio / video (light).
// Everything shown comes from fileInfoView (src/ui-logic/fileInfo.ts); this file only lays it out.
import { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { COMMENT_MAX } from '../../comments/types';
import { chipLabel, KIND_ICON, type ThreadFile } from '../../thread/model';
import { colors } from '../../theme';
import { COMMENT_PLACEHOLDER, READING_TEXT, type FileInfoView, type InfoComment } from '../../ui-logic/fileInfo';

const AMBER = '#8a5a00';
const AMBER_DARK = '#ffcc66';

export interface CommentActions {
  /** Queues the comment; resolves to an error text, or null when it was saved (the draft is then cleared). */
  onSend: (f: ThreadFile, body: string) => Promise<string | null>;
  onRetry: () => void;
  onRemove: (clientCommentId: string) => void;
}

function palette(dark: boolean) {
  return dark
    ? { text: '#fff', muted: '#c3cad3', chip: 'rgba(255,255,255,0.16)', ownChip: 'rgba(31,95,191,0.75)', input: '#1c232c', border: '#3a4552', amber: AMBER_DARK, bg: '#0d1117' }
    : { text: colors.text, muted: colors.muted, chip: '#eef1f5', ownChip: '#dbe8fb', input: colors.card, border: colors.border, amber: AMBER, bg: colors.card };
}

function CommentItem({ c, dark, onRetry, onRemove }: { c: InfoComment; dark: boolean; onRetry: () => void; onRemove: (id: string) => void }) {
  const p = palette(dark);
  return (
    <View style={{ paddingVertical: 8, borderTopWidth: 1, borderTopColor: p.border }}>
      <Text style={{ fontSize: 14, color: p.muted, fontWeight: '600' }}>{c.author}{c.time ? ` · ${c.time}` : ''}</Text>
      <Text style={{ fontSize: 16, color: p.text, marginTop: 2 }}>{c.body}</Text>
      {c.status ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
          <Text style={{ flexShrink: 1, fontSize: 14, color: c.stuck ? p.amber : p.muted }}>{c.status}</Text>
          {c.retry ? <SmallBtn label="Retry" onPress={onRetry} dark={dark} primary /> : null}
          {c.removable && c.stuck && c.clientCommentId ? (
            <SmallBtn label="Remove" onPress={() => onRemove(c.clientCommentId as string)} dark={dark} />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function SmallBtn({ label, onPress, dark, primary }: { label: string; onPress: () => void; dark: boolean; primary?: boolean }) {
  const p = palette(dark);
  return (
    <Pressable
      onPress={onPress} accessibilityRole="button" accessibilityLabel={label}
      style={{
        minHeight: 40, minWidth: 72, paddingHorizontal: 12, borderRadius: 20, alignItems: 'center', justifyContent: 'center',
        backgroundColor: primary ? colors.primary : 'transparent', borderWidth: primary ? 0 : 1, borderColor: p.border,
      }}
    >
      <Text style={{ color: primary ? colors.onPrimary : p.text, fontSize: 15, fontWeight: '700' }}>{label}</Text>
    </Pressable>
  );
}

/** Chips, description, comments (scrolls inside `maxHeight`) and the comment input below them. */
export function FileInfoPanel({ file, view, dark, draft, onDraft, actions, maxHeight, onHide }: {
  file: ThreadFile; view: FileInfoView; dark: boolean; draft: string; onDraft: (s: string) => void; actions: CommentActions;
  maxHeight: number; onHide?: () => void;
}) {
  const p = palette(dark);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canSend = draft.trim() !== '' && !busy;

  async function send() {
    if (!canSend) return;
    setBusy(true);
    const e = await actions.onSend(file, draft);
    setBusy(false);
    setError(e);
    if (!e) onDraft('');
  }

  return (
    <View style={{ backgroundColor: p.bg, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8 }}>
      <ScrollView style={{ maxHeight }} keyboardShouldPersistTaps="handled">
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
          <View style={{ flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {view.chips.map((c) => (
              <View key={c.key} style={{ borderRadius: 14, paddingHorizontal: 10, paddingVertical: 4, backgroundColor: c.own ? p.ownChip : p.chip }}
                accessibilityLabel={c.own ? `Your tag: ${c.text}` : c.text}>
                <Text style={{ fontSize: 14, color: p.text, fontWeight: '600' }}>{c.own ? `🏷 ${c.text}` : c.text}</Text>
              </View>
            ))}
            {view.reading ? <Text style={{ fontSize: 14, color: p.muted, fontStyle: 'italic', paddingVertical: 4 }}>{READING_TEXT}</Text> : null}
          </View>
          {onHide ? (
            <Pressable onPress={onHide} accessibilityRole="button" accessibilityLabel="Hide details" style={{ minHeight: 40, minWidth: 56, alignItems: 'flex-end', justifyContent: 'center' }}>
              <Text style={{ fontSize: 15, color: p.muted, fontWeight: '600' }}>Hide</Text>
            </Pressable>
          ) : null}
        </View>
        {view.description ? <Text style={{ fontSize: 16, color: p.text, marginTop: 8 }}>{view.description}</Text> : null}
        <Text style={{ fontSize: 15, color: p.muted, fontWeight: '700', marginTop: 12, marginBottom: 2 }}>
          {view.comments.length > 0 ? `Comments (${view.comments.length})` : 'Comments'}
        </Text>
        {view.comments.length === 0 && view.canComment ? <Text style={{ fontSize: 15, color: p.muted }}>No comments yet.</Text> : null}
        {view.comments.map((c) => <CommentItem key={c.key} c={c} dark={dark} onRetry={actions.onRetry} onRemove={actions.onRemove} />)}
      </ScrollView>
      {view.canComment ? (
        <View style={{ marginTop: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8 }}>
            <TextInput
              value={draft} onChangeText={(t) => { onDraft(t); if (error) setError(null); }}
              placeholder={COMMENT_PLACEHOLDER} placeholderTextColor={p.muted} multiline maxLength={COMMENT_MAX}
              accessibilityLabel="Add comment"
              style={{
                flex: 1, minHeight: 48, maxHeight: 120, borderWidth: 1, borderColor: p.border, borderRadius: 10, paddingHorizontal: 12,
                paddingVertical: 10, fontSize: 16, color: p.text, backgroundColor: p.input,
              }}
            />
            <Pressable
              onPress={() => void send()} disabled={!canSend} accessibilityRole="button" accessibilityLabel="Send comment"
              accessibilityState={{ disabled: !canSend }}
              style={{ minHeight: 48, minWidth: 72, paddingHorizontal: 14, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: canSend ? colors.primary : p.border }}
            >
              {busy ? <ActivityIndicator color={colors.onPrimary} /> : <Text style={{ color: colors.onPrimary, fontSize: 16, fontWeight: '700' }}>Send</Text>}
            </Pressable>
          </View>
          {error ? <Text style={{ fontSize: 14, color: p.amber, marginTop: 4 }}>{error}</Text> : null}
        </View>
      ) : view.cannotCommentText ? (
        <Text style={{ fontSize: 15, color: p.muted, marginTop: 8 }}>{view.cannotCommentText}</Text>
      ) : null}
    </View>
  );
}

/** PDFs, documents, audio and video: tap the chip → this sheet with the same info and comments. */
export function FileInfoSheet({ file, view, actions, onClose, maxHeight }: {
  file: ThreadFile | null; view: FileInfoView | null; actions: CommentActions; onClose: () => void; maxHeight: number;
}) {
  const [draft, setDraft] = useState('');
  return (
    <Modal visible={file !== null && view !== null} transparent animationType="slide" onRequestClose={onClose}>
      {/* padding: lifts the sheet above the keyboard (0 when the window already resized) */}
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' }} onPress={onClose} accessibilityLabel="Close" />
        {file && view ? (
          <View style={{ backgroundColor: colors.card, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingTop: 12, paddingBottom: 16 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16 }}>
              <Text style={{ fontSize: 22 }}>{KIND_ICON[file.kind]}</Text>
              <Text style={{ flex: 1, fontSize: 17, fontWeight: '700', color: colors.text }} numberOfLines={2}>{chipLabel(file)}</Text>
              <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" style={{ minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ fontSize: 26, color: colors.text }}>×</Text>
              </Pressable>
            </View>
            <FileInfoPanel file={file} view={view} dark={false} draft={draft} onDraft={setDraft} actions={actions} maxHeight={maxHeight} />
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </Modal>
  );
}
