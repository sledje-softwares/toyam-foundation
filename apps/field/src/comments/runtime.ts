// App-wide comment queue (thin wiring, untested). add_evidence_comment runs with the signed-in operator's JWT
// (rule 4); comments are not sent in drain mode (field-drain has no comment call) and are wiped at sign-out.
import 'react-native-get-random-values';
import { openDatabaseAsync } from 'expo-sqlite';
import { supabase } from '../lib/supabase';
import { currentlyOnline, watchConnectivity } from '../outbox/netinfo';
import { newUuid } from '../outbox/runtime';
import { CommentQueue } from './queue';
import { commentServer } from './server';
import { openSqliteCommentStore } from './sqliteStore';

let instance: Promise<CommentQueue> | null = null;

export function getCommentQueue(): Promise<CommentQueue> {
  if (!instance) {
    instance = (async () => {
      const store = await openSqliteCommentStore(() => openDatabaseAsync('comments.db'));
      const q = new CommentQueue({ store, server: commentServer(supabase), uuid: newUuid, log: (m) => console.log(m) });
      await q.init();
      q.setOnline(await currentlyOnline());
      watchConnectivity((online) => q.setOnline(online));
      return q;
    })();
  }
  return instance;
}
