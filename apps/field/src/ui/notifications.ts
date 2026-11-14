// Local notifications only (no push setup). Permission is asked politely, once.
import * as Notifications from 'expo-notifications';
import { AndroidImportance } from 'expo-notifications';
import { Alert } from 'react-native';
import { secretStore } from '../lib/secretStore';

const ASKED_KEY = 'toyam.field.notif_asked';
const CHANNEL = 'outbox';

export function setupNotifications(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
  });
  void Notifications.setNotificationChannelAsync(CHANNEL, { name: 'Sending files', importance: AndroidImportance.DEFAULT });
}

/** Explains first, then asks the system once. Never asks again, whatever the answer. */
export async function askNotificationPermissionOnce(): Promise<void> {
  try {
    if (await secretStore.getItem(ASKED_KEY)) return;
    await secretStore.setItem(ASKED_KEY, '1');
    const current = await Notifications.getPermissionsAsync();
    if (current.granted) return;
    await new Promise<void>((resolve) => {
      Alert.alert(
        'Tell you when files are sent?',
        'We can show a small message when your saved files have reached the office. You can say no and the app will still work the same.',
        [
          { text: 'Not now', style: 'cancel', onPress: () => resolve() },
          { text: 'Yes, tell me', onPress: () => void Notifications.requestPermissionsAsync().finally(resolve) },
        ],
        { cancelable: true, onDismiss: () => resolve() },
      );
    });
  } catch {
    // notifications are a convenience; never block the app
  }
}

export async function notifyLocal(title: string, body: string, caseId: string | null): Promise<void> {
  try {
    await Notifications.scheduleNotificationAsync({
      content: { title, body, data: { case_id: caseId } },
      trigger: { channelId: CHANNEL },
    });
  } catch {
    // ignore
  }
}

/** Tapping a notification opens the case it names. */
export function onNotificationTap(open: (caseId: string) => void): () => void {
  const sub = Notifications.addNotificationResponseReceivedListener((r) => {
    const id = (r.notification.request.content.data as { case_id?: string | null } | undefined)?.case_id;
    if (id) open(id);
  });
  return () => sub.remove();
}
