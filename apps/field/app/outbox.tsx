import { Stack } from 'expo-router';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, s } from '../src/theme';
import { outboxView } from '../src/ui-logic/offline';
import { Btn } from '../src/ui/components';
import { useOffline } from '../src/ui/OutboxProvider';
import { StatusStack } from '../src/ui/StatusStack';

export default function Outbox() {
  const { outbox, snapshot, names, now } = useOffline();
  const v = outboxView(snapshot.items, names, now);

  // Nothing is removed without the confirmation (default: Keep).
  function askRemove(messageId: string, fileId: string) {
    Alert.alert(v.remove.action, undefined, [
      { text: v.remove.cancel, style: 'cancel' },
      {
        text: v.remove.action,
        onPress: () => Alert.alert(v.remove.body, undefined, [
          { text: v.remove.cancel, style: 'cancel' },
          { text: v.remove.confirm, style: 'destructive', onPress: () => void outbox?.removeFile(messageId, fileId) },
        ], { cancelable: true }),
      },
    ]);
  }

  return (
    <SafeAreaView style={s.screen} edges={['bottom']}>
      <Stack.Screen options={{ title: v.title }} />
      <StatusStack />
      <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
        {v.empty ? null : <Text style={[s.text, { padding: 16, fontWeight: '600' }]}>{v.summary}</Text>}
        {v.cards.map((c) => (
          <View key={c.caseId} style={[s.card, { gap: 8 }]}>
            <Text style={[s.text, { fontWeight: '700' }]}>{c.title}</Text>
            {c.showProgress ? (
              <>
                <Text style={s.text}>{c.progressText}</Text>
                <View style={{ height: 10, backgroundColor: colors.border, borderRadius: 5, overflow: 'hidden' }}>
                  <View style={{ height: 10, width: `${Math.round(c.progress * 100)}%`, backgroundColor: colors.primary }} />
                </View>
              </>
            ) : (
              <Text style={[s.text, { color: '#4a3500' }]}>{c.heldText}</Text>
            )}
            <Text style={s.muted}>{c.lastTry}</Text>
            {c.files.map((f) => (
              <Pressable
                key={f.fileId} onLongPress={() => askRemove(f.messageId, f.fileId)} accessibilityHint="Press and hold to remove from phone"
                style={{ minHeight: 48, justifyContent: 'center' }}
              >
                <Text style={s.muted}>{f.label}</Text>
              </Pressable>
            ))}
            <Text style={[s.muted, { fontSize: 14 }]}>{v.removeHint}</Text>
            <View style={{ flexDirection: 'row' }}>
              <Btn label={c.sendNowLabel} onPress={() => void outbox?.sendNow(c.caseId)} />
            </View>
          </View>
        ))}
        {v.empty ? <Text style={[s.text, { textAlign: 'center', marginTop: 40 }]}>{v.summary}</Text> : null}
      </ScrollView>
    </SafeAreaView>
  );
}
