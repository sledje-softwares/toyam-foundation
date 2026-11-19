// App-wide image loader for the thread (thin wiring, untested). evidence-view is called with the signed-in
// operator's JWT (supabase-js functions.invoke); RLS decides what comes back (rule 4). No service-role key.
import { supabase } from '../lib/supabase';
import { downloadFile } from './fileStore';
import { createLoader, type ViewLink } from './loader';

export const threadLoader = createLoader({
  async links(ids, variant) {
    const { data, error } = await supabase.functions.invoke('evidence-view', {
      body: { evidence_ids: ids, variant, disposition: 'inline' },
    });
    if (error) throw error instanceof Error ? error : new Error('evidence-view failed');
    const files = (data as { files?: unknown } | null)?.files;
    if (!Array.isArray(files)) return [];
    return (files as Record<string, unknown>[]).map((f): ViewLink => ({
      id: String(f.id),
      url: typeof f.url === 'string' ? f.url : undefined,
      sha256: typeof f.sha256 === 'string' ? f.sha256 : null,
      error: typeof f.error === 'string' ? f.error : undefined,
    }));
  },
  download: downloadFile,
});
