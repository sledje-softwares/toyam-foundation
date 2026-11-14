// In-app camera (5.4): single shots and bursts, torch, GPS (camera only, optional), device capture time.
// Shots are compressed, copied into the app sandbox (never the gallery) and hashed while the operator
// keeps shooting; "Send N" queues them with the composer's caption and category chip.
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Location from 'expo-location';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Image, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { drafts } from '../src/capture/draft';
import { buildNewItems, gpsFrom, type PreparedFile } from '../src/capture/item';
import { CaptureError, discardPrepared, prepareCameraShot } from '../src/capture/prepare';
import type { Gps } from '../src/outbox/types';
import { colors, s } from '../src/theme';
import { Banner, Btn } from '../src/ui/components';
import { useOffline } from '../src/ui/OutboxProvider';

type Shot = { key: string; state: 'preparing' } | { key: string; state: 'ready'; file: PreparedFile } | { key: string; state: 'error'; message: string };

const NO_GPS_TEXT = 'Photos are sent without location. You can allow location for this app in the phone settings.';

export default function Camera() {
  const { caseId, taskId } = useLocalSearchParams<{ caseId: string; taskId: string }>();
  const router = useRouter();
  const { outbox, storage, guardCapture } = useOffline();
  const [perm, requestPerm] = useCameraPermissions();
  const cam = useRef<CameraView>(null);
  const [torch, setTorch] = useState(false);
  const [shots, setShots] = useState<Shot[]>([]);
  const [gpsNote, setGpsNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const gps = useRef<Gps | null>(null);
  const prepared = useRef(new Map<string, PreparedFile>());
  const sent = useRef(false);
  const closed = useRef(false);

  // GPS: asked once, politely; refusal is fine, photos go without location.
  useEffect(() => {
    let sub: Location.LocationSubscription | null = null;
    let live = true;
    void (async () => {
      let p = await Location.getForegroundPermissionsAsync();
      if (p.status !== 'granted' && p.canAskAgain) p = await Location.requestForegroundPermissionsAsync();
      if (!live) return;
      if (p.status !== 'granted') {
        setGpsNote(NO_GPS_TEXT);
        return;
      }
      try {
        const last = await Location.getLastKnownPositionAsync();
        if (last) gps.current = gpsFrom(last.coords);
        sub = await Location.watchPositionAsync({ accuracy: Location.Accuracy.High, distanceInterval: 5 }, (pos) => {
          gps.current = gpsFrom(pos.coords);
        });
        if (!live) sub.remove();
      } catch {
        setGpsNote('Location is not available right now. Photos are sent without it.');
      }
    })();
    return () => {
      live = false;
      sub?.remove();
    };
  }, []);

  // Leaving without Send: remove the unsent shots from the sandbox.
  useEffect(() => {
    const files = prepared.current;
    return () => {
      closed.current = true;
      if (sent.current) return;
      for (const f of files.values()) void discardPrepared(f);
    };
  }, []);

  async function shoot() {
    if (!cam.current || !guardCapture()) return;
    const key = `${Date.now()}-${Math.random()}`;
    const capturedAt = new Date().toISOString(); // device clock at the shutter
    const at = gps.current;
    let pic;
    try {
      pic = await cam.current.takePictureAsync({ quality: 0.92, exif: true, shutterSound: false });
    } catch {
      return;
    }
    if (!pic) return;
    setShots((x) => [...x, { key, state: 'preparing' }]);
    try {
      const file = await prepareCameraShot({ uri: pic.uri, width: pic.width, height: pic.height, exif: pic.exif ?? null, capturedAt, gps: at });
      if (closed.current) {
        void discardPrepared(file); // screen closed while this shot was being saved
        return;
      }
      prepared.current.set(key, file);
      setShots((x) => x.map((sh) => (sh.key === key ? { key, state: 'ready', file } : sh)));
    } catch (e) {
      const message = e instanceof CaptureError ? e.message : 'This photo could not be saved. Please take it again.';
      setShots((x) => x.map((sh) => (sh.key === key ? { key, state: 'error', message } : sh)));
    }
  }

  function drop(key: string) {
    const f = prepared.current.get(key);
    prepared.current.delete(key);
    if (f) void discardPrepared(f);
    setShots((x) => x.filter((sh) => sh.key !== key));
  }

  const ready = shots.flatMap((sh) => (sh.state === 'ready' ? [sh.file] : []));
  const waiting = shots.some((sh) => sh.state === 'preparing');

  async function send() {
    if (!outbox || !caseId) return;
    const d = drafts.get(caseId);
    const built = buildNewItems({ caseId, taskId: taskId ?? null, text: d.text, categoryCode: d.categoryCode, files: ready });
    if (!built.ok) {
      Alert.alert('Not sent', built.message);
      return;
    }
    setBusy(true);
    try {
      for (const item of built.items) {
        await outbox.enqueue(item);
        for (const f of item.files) for (const [k, v] of prepared.current) if (v === f) prepared.current.delete(k);
      }
      sent.current = true;
      drafts.sent(caseId, true); // caption used; picked files stay in the composer
      router.back();
    } catch {
      Alert.alert('Not saved', 'The photos could not be saved on this phone. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  if (!perm) return <View style={[s.screen, { backgroundColor: '#000' }]} />;
  if (!perm.granted) {
    return (
      <SafeAreaView style={[s.screen, s.pad]}>
        <Stack.Screen options={{ title: 'Camera' }} />
        <Text style={s.title}>Camera</Text>
        <Text style={[s.text, { marginTop: 12 }]}>The app needs the camera to take photos for your cases. Photos stay inside the app and are not saved to your gallery.</Text>
        {perm.canAskAgain ? <Btn label="Allow camera" onPress={() => void requestPerm()} /> : (
          <Text style={[s.muted, { marginTop: 12 }]}>Camera access is turned off. Allow it for this app in the phone settings.</Text>
        )}
        <Btn label="Back" secondary onPress={() => router.back()} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#000' }} edges={['top', 'bottom']}>
      <Stack.Screen options={{ headerShown: false }} />
      {storage.banner ? <Banner text={storage.banner} /> : null}
      <CameraView ref={cam} style={{ flex: 1 }} facing="back" enableTorch={torch} animateShutter />
      {gpsNote ? <Text style={{ color: '#fff', fontSize: 15, padding: 8, backgroundColor: '#0008' }}>{gpsNote}</Text> : null}
      {shots.length > 0 ? (
        <ScrollView horizontal style={{ maxHeight: 84, backgroundColor: '#111' }} contentContainerStyle={{ padding: 8, gap: 8 }}>
          {shots.map((sh) => (
            <Pressable
              key={sh.key} onPress={() => (sh.state === 'error' ? Alert.alert('Photo not saved', sh.message, [{ text: 'Remove', onPress: () => drop(sh.key) }]) : Alert.alert('Remove this photo?', undefined, [{ text: 'Keep', style: 'cancel' }, { text: 'Remove', onPress: () => drop(sh.key) }]))}
              accessibilityRole="button" accessibilityLabel="Photo, tap to remove"
              style={{ width: 68, height: 68, borderRadius: 6, overflow: 'hidden', backgroundColor: '#333', alignItems: 'center', justifyContent: 'center' }}
            >
              {sh.state === 'ready' ? <Image source={{ uri: sh.file.local_path }} style={{ width: 68, height: 68 }} /> : null}
              {sh.state === 'preparing' ? <ActivityIndicator color="#fff" /> : null}
              {sh.state === 'error' ? <Text style={{ color: '#fff', fontSize: 24 }}>!</Text> : null}
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, backgroundColor: '#000' }}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" style={ctl}>
          <Text style={ctlText}>Close</Text>
        </Pressable>
        <Pressable onPress={() => setTorch((t) => !t)} accessibilityRole="button" accessibilityState={{ selected: torch }} accessibilityLabel="Torch" style={ctl}>
          <Text style={[ctlText, torch && { color: '#ffd54f' }]}>{torch ? 'Torch on' : 'Torch'}</Text>
        </Pressable>
        <Pressable onPress={() => void shoot()} accessibilityRole="button" accessibilityLabel="Take photo"
          style={{ width: 76, height: 76, borderRadius: 38, borderWidth: 5, borderColor: '#fff', backgroundColor: colors.primary }} />
        <Pressable onPress={() => void send()} disabled={ready.length === 0 || waiting || busy} accessibilityRole="button"
          style={[ctl, { backgroundColor: colors.primary, opacity: ready.length === 0 || waiting || busy ? 0.4 : 1 }]}>
          <Text style={ctlText}>{waiting ? 'Saving…' : `Send ${ready.length}`}</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const ctl = { minHeight: 56, minWidth: 64, paddingHorizontal: 10, borderRadius: 10, alignItems: 'center' as const, justifyContent: 'center' as const };
const ctlText = { color: '#fff', fontSize: 16, fontWeight: '700' as const };
