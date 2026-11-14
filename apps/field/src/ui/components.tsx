// Presentational pieces for the offline experience. Text comes from src/ui-logic/offline.ts.
import type { ReactNode } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { colors, s } from '../theme';
import type { Tone } from '../ui-logic/offline';

export const amber = { bg: '#fff3d6', border: '#e8b84a', text: '#4a3500' };

const toneColor = (t: Tone) => (t === 'amber' ? '#8a5a00' : colors.muted);

export function Bar({ text, tone, onPress }: { text: string; tone: Tone; onPress?: () => void }) {
  const warm = tone === 'amber';
  return (
    <Pressable
      onPress={onPress} accessibilityRole="button" accessibilityLabel={text}
      style={{
        minHeight: 56, paddingHorizontal: 16, justifyContent: 'center',
        backgroundColor: warm ? amber.bg : colors.card, borderBottomWidth: 1, borderBottomColor: warm ? amber.border : colors.border,
      }}
    >
      <Text style={{ fontSize: 17, fontWeight: '600', color: warm ? amber.text : colors.text }}>{text}</Text>
    </Pressable>
  );
}

export function Banner({ title, text, action, onAction, onClose }: {
  title?: string; text: string; action?: string; onAction?: () => void; onClose?: () => void;
}) {
  return (
    <View style={{ backgroundColor: amber.bg, borderBottomWidth: 1, borderBottomColor: amber.border, padding: 16, gap: 8 }}>
      {title ? <Text style={{ fontSize: 17, fontWeight: '700', color: amber.text }}>{title}</Text> : null}
      <Text style={{ fontSize: 16, color: amber.text }}>{text}</Text>
      <View style={{ flexDirection: 'row', gap: 12 }}>
        {action ? <Btn label={action} onPress={onAction} compact /> : null}
        {onClose ? <Btn label="OK" onPress={onClose} compact secondary /> : null}
      </View>
    </View>
  );
}

export function Btn({ label, onPress, secondary, compact }: { label: string; onPress?: () => void; secondary?: boolean; compact?: boolean }) {
  return (
    <Pressable
      onPress={onPress} accessibilityRole="button"
      style={{
        minHeight: 56, borderRadius: 10, paddingHorizontal: 20, alignItems: 'center', justifyContent: 'center',
        backgroundColor: secondary ? colors.card : colors.primary, borderWidth: 1, borderColor: secondary ? colors.border : colors.primary,
        flex: compact ? undefined : 1,
      }}
    >
      <Text style={{ fontSize: 18, fontWeight: '700', color: secondary ? colors.text : colors.onPrimary }}>{label}</Text>
    </Pressable>
  );
}

export function Fresh({ text, tone }: { text: string; tone: Tone }) {
  return <Text style={{ fontSize: 14, color: toneColor(tone), marginTop: 4 }}>{text}</Text>;
}

export function Sheet({ visible, onClose, children }: { visible: boolean; onClose: () => void; children: ReactNode }) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' }} onPress={onClose} accessibilityLabel="Close" />
      <View style={{ backgroundColor: colors.card, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, maxHeight: '80%' }}>
        <ScrollView>{children}</ScrollView>
      </View>
    </Modal>
  );
}

export function ClockSheet({ view, onSend, onOutbox, onClose }: {
  view: { title: string; body: string; lastTry: string; primary: string; secondary: string } | null;
  onSend: () => void; onOutbox: () => void; onClose: () => void;
}) {
  return (
    <Sheet visible={view !== null} onClose={onClose}>
      {view ? (
        <View style={{ gap: 12 }}>
          <Text style={s.title}>{view.title}</Text>
          <Text style={s.text}>{view.body}</Text>
          <Text style={[s.muted, { fontWeight: '600' }]}>{view.lastTry}</Text>
          <View style={{ gap: 12, marginTop: 8 }}>
            <Btn label={view.primary} onPress={onSend} />
            <Btn label={view.secondary} onPress={onOutbox} secondary />
          </View>
        </View>
      ) : null}
    </Sheet>
  );
}

type Check = { title: string; freshness: { text: string; tone: Tone }; rows: { id: string; text: string; state: string; mark: string; caption: string | null }[] };

export function ChecklistSheet({ view, loading, onClose }: { view: Check | null; loading: boolean; onClose: () => void }) {
  return (
    <Sheet visible={view !== null} onClose={onClose}>
      {view ? (
        <View style={{ gap: 4 }}>
          <Text style={s.title}>{view.title}</Text>
          <Fresh text={view.freshness.text} tone={view.freshness.tone} />
          {loading ? <Text style={s.muted}>Loading…</Text> : null}
          {view.rows.map((r) => (
            <View key={r.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, borderBottomWidth: 1, borderBottomColor: colors.border }}>
              <Text style={{ width: 40, fontSize: 22, textAlign: 'center', color: r.state === 'done' ? '#1b7a3a' : colors.muted }}>{r.mark}</Text>
              <View style={{ flex: 1 }}>
                <Text style={s.text}>{r.text}</Text>
                {r.caption ? <Text style={s.muted}>{r.caption}</Text> : null}
              </View>
            </View>
          ))}
          <View style={{ marginTop: 16 }}><Btn label="Close" onPress={onClose} secondary /></View>
        </View>
      ) : null}
    </Sheet>
  );
}
