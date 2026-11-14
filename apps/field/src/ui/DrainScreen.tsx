import { useEffect } from 'react';
import { ActivityIndicator, BackHandler, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, s } from '../theme';
import { drainView } from '../ui-logic/offline';
import { Btn } from './components';
import { useOffline } from './OutboxProvider';

/** Full-screen, non-dismissable page after the operator's access was removed (spec 10). */
export function DrainScreen() {
  const { drain, snapshot, finishDrain } = useOffline();
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, []);
  // after the wipe, return to sign-in by itself
  const done = drain?.phase === 'done';
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(finishDrain, 8000);
    return () => clearTimeout(t);
  }, [done, finishDrain]);
  if (!drain) return null;
  const v = drainView(snapshot.items, drain.startTotal, drain.phase, drain.closedSent);
  return (
    <SafeAreaView style={[s.screen, { justifyContent: 'center', padding: 24, gap: 16 }]}>
      <Text style={s.title}>{v.title}</Text>
      {done ? (
        <>
          <Text style={s.text}>{v.doneText}</Text>
          <Btn label="OK" onPress={finishDrain} />
        </>
      ) : (
        <>
          <Text style={s.text}>{v.body}</Text>
          <Text style={[s.text, { fontWeight: '700' }]}>{v.progress}</Text>
          <View style={{ height: 10, backgroundColor: colors.border, borderRadius: 5, overflow: 'hidden' }}>
            <View style={{ height: 10, width: `${Math.round(v.fraction * 100)}%`, backgroundColor: colors.primary }} />
          </View>
          <ActivityIndicator color={colors.primary} />
        </>
      )}
    </SafeAreaView>
  );
}
