import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { barView } from '../ui-logic/offline';
import { Banner, Bar } from './components';
import { useOffline } from './OutboxProvider';

/** Offline bar (1), gentle 6 h prompt (7) and low-storage banner (8), stacked under the app bar. */
export function StatusStack({ storage = false }: { storage?: boolean }) {
  const router = useRouter();
  const o = useOffline();
  const bar = barView(o.snapshot);
  return (
    <View>
      {bar.visible ? <Bar text={bar.text} tone={bar.tone} onPress={() => router.push('/outbox')} /> : null}
      {o.prompt ? (
        <Banner
          title={o.prompt.title} text={o.prompt.body} action={o.prompt.button}
          onAction={() => { void o.outbox?.sendNow(); o.dismissPrompt(); }} onClose={o.dismissPrompt}
        />
      ) : null}
      {storage && o.storage.banner ? <Banner text={o.storage.banner} /> : null}
    </View>
  );
}
