// Picks the URI an image shows from (cache → phone's own files → download), moving on when one fails.
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ThreadFile } from '../../thread/model';
import { fileStore, forgetFile, initFileStore } from '../../thread/fileStore';
import { threadLoader } from '../../thread/runtime';
import { firstAvailable, sameSource, sourcePlan, withoutFailed, type Source, type Use } from '../../thread/sources';

export interface ImageUri {
  uri: string | null;
  /** A download is running. */
  loading: boolean;
  /** Call from the Image's onError: tries the next source. */
  onError: () => void;
}

export function useImageUri(f: ThreadFile, use: Use, online: boolean): ImageUri {
  const sig = `${use}|${f.key}|${f.evidenceId ?? ''}|${f.local?.original ?? ''}|${f.local?.w384 ?? ''}|${f.local?.w1600 ?? ''}|${f.copies.join(',')}|${f.sizeBytes ?? ''}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `sig` covers every field the plan reads
  const plan = useMemo(() => sourcePlan(f, use), [sig]);
  const [failed, setFailed] = useState<{ sig: string; list: Source[] }>({ sig, list: [] });
  const list = failed.sig === sig ? failed.list : [];
  useSyncExternalStore(fileStore.subscribe, fileStore.version);
  useEffect(() => { void initFileStore(); }, []);

  const choice = firstAvailable(withoutFailed(plan, list), fileStore.has, online);
  const fetchKey = choice?.fetch ? `${choice.fetch.evidenceId}|${choice.fetch.variant}` : null;

  useEffect(() => {
    const r = choice?.fetch;
    if (!r) return;
    let live = true;
    void threadLoader.fetch(r.evidenceId, r.variant, r.key).then((ok) => {
      if (!ok && live) setFailed((p) => ({ sig, list: [...(p.sig === sig ? p.list : []), r] }));
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one request per (id, variant)
  }, [fetchKey, sig]);

  let uri: string | null = null;
  if (choice?.show?.type === 'cache') uri = fileStore.uri(choice.show.key);
  else if (choice?.show?.type === 'local') uri = choice.show.uri;

  const onError = () => {
    if (!choice) return;
    if (choice.show?.type === 'cache') void forgetFile(choice.show.key);
    const from = choice.from;
    setFailed((p) => {
      const cur = p.sig === sig ? p.list : [];
      return cur.some((x) => sameSource(x, from)) ? p : { sig, list: [...cur, from] };
    });
  };
  return { uri, loading: !!choice?.fetch, onError };
}
