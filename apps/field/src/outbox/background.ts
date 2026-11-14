// Android background sending (thin, untested). Imported once at module scope (app/_layout.tsx):
// TaskManager tasks must be defined before React mounts. expo-background-task schedules a
// WorkManager job; each run drains what it can and returns.
import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { getOutbox } from './runtime';

export const OUTBOX_TASK = 'toyam-outbox-send';

TaskManager.defineTask(OUTBOX_TASK, async () => {
  try {
    const outbox = await getOutbox();
    await outbox.run();
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

/** Call after sign-in. 15 min is the Android minimum interval. */
export async function registerOutboxBackgroundTask(): Promise<void> {
  const status = await BackgroundTask.getStatusAsync();
  if (status !== BackgroundTask.BackgroundTaskStatus.Available) return;
  if (await TaskManager.isTaskRegisteredAsync(OUTBOX_TASK)) return;
  await BackgroundTask.registerTaskAsync(OUTBOX_TASK, { minimumInterval: 15 });
}

export async function unregisterOutboxBackgroundTask(): Promise<void> {
  if (await TaskManager.isTaskRegisteredAsync(OUTBOX_TASK)) await BackgroundTask.unregisterTaskAsync(OUTBOX_TASK);
}
