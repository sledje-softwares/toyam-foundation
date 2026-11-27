// Thumbnails grid and file chips of one thread message (docs/11 "Thread attachments").
import { memo } from 'react';
import { ActivityIndicator, Image, Pressable, Text, View } from 'react-native';
import { chipLabel, gridLayout, KIND_ICON, LABEL, type FileState, type ThreadFile } from '../../thread/model';
import { colors } from '../../theme';
import { commentBadge } from '../../ui-logic/fileInfo';
import { useImageUri } from './useImageUri';

const GAP = 4;

const STATE_TEXT: Record<Exclude<FileState, null>, string> = {
  waiting: 'Waiting',
  sending: 'Sending',
  sent: 'Sent ✓',
  held: 'Waiting for the office',
  duplicate: LABEL.duplicate,
};

function StateBadge({ state, progress }: { state: FileState; progress: number | null }) {
  if (state === null) return null;
  const mark = state === 'sent' ? '✓' : state === 'sending' ? `${Math.round((progress ?? 0) * 100)}%`
    : state === 'held' ? '⏸' : state === 'duplicate' ? 'Sent earlier' : '🕓';
  return (
    <View style={{ position: 'absolute', right: 4, bottom: 4, backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 10, paddingHorizontal: 6, paddingVertical: 2 }}>
      <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>{mark}</Text>
    </View>
  );
}

/** 💬 n in the top-left corner of a thumbnail whose file has comments (D54). */
function CommentBadge({ f }: { f: ThreadFile }) {
  const text = commentBadge(f);
  if (!text) return null;
  return (
    <View style={{ position: 'absolute', left: 4, top: 4, backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 10, paddingHorizontal: 6, paddingVertical: 2 }}>
      <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>{text}</Text>
    </View>
  );
}

const Tile = memo(function Tile({ f, size, online, more, onPress }: {
  f: ThreadFile; size: number; online: boolean; more: number; onPress: () => void;
}) {
  const img = useImageUri(f, 'thumb', online);
  const comments = f.comments.length;
  return (
    <Pressable
      onPress={onPress} accessibilityRole="imagebutton"
      accessibilityLabel={more > 0 ? `${more} more photos` : `${f.name}${f.state ? `, ${STATE_TEXT[f.state]}` : ''}${comments > 0 ? `, ${comments} ${comments === 1 ? 'comment' : 'comments'}` : ''}`}
      style={{ width: size, height: size, borderRadius: 8, overflow: 'hidden', backgroundColor: '#dfe3e8' }}
    >
      {img.uri ? (
        // resizeMethod "resize": Android decodes at tile size, never the full photo (memory on long threads)
        <Image source={{ uri: img.uri }} style={{ width: size, height: size }} resizeMode="cover" resizeMethod="resize" onError={img.onError} fadeDuration={0} />
      ) : (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          {img.loading ? <ActivityIndicator color={colors.muted} /> : <Text style={{ fontSize: 28 }}>{KIND_ICON.image}</Text>}
        </View>
      )}
      {f.state === 'sending' ? (
        <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 4, backgroundColor: 'rgba(0,0,0,0.25)' }}>
          <View style={{ width: `${Math.round((f.progress ?? 0) * 100)}%`, height: 4, backgroundColor: colors.primary }} />
        </View>
      ) : null}
      {more > 0 ? (
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ color: '#fff', fontSize: 26, fontWeight: '700' }}>+{more}</Text>
        </View>
      ) : (
        <>
          <CommentBadge f={f} />
          <StateBadge state={f.state} progress={f.progress} />
        </>
      )}
    </Pressable>
  );
});

/** Up to 6 tiles; the 6th shows "+N" when there are more. Tap → viewer at that image. */
export function ImageGrid({ images, width, online, onOpen }: {
  images: readonly ThreadFile[]; width: number; online: boolean; onOpen: (index: number) => void;
}) {
  const g = gridLayout(images.length);
  if (g.columns === 0) return null;
  const size = Math.floor((width - GAP * (g.columns - 1)) / g.columns);
  const tileSize = g.columns === 1 ? Math.min(width, 240) : size;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: GAP, marginTop: 6 }}>
      {g.shown.map((i) => {
        const f = images[i];
        if (!f) return null;
        const more = i === g.shown.length - 1 ? g.more : 0;
        return <Tile key={f.key} f={f} size={tileSize} online={online} more={more} onPress={() => onOpen(i)} />;
      })}
    </View>
  );
}

/**
 * PDFs, documents, audio and video: icon, name and size, plus the sending state while on the phone.
 * Tap → the file's details and comments (D54) when `onOpen` is given.
 */
export function FileChips({ files, onOpen }: { files: readonly ThreadFile[]; onOpen?: (f: ThreadFile) => void }) {
  if (files.length === 0) return null;
  return (
    <View style={{ gap: 6, marginTop: 6 }}>
      {files.map((f) => (
        <Pressable
          key={f.key} disabled={!onOpen} onPress={() => onOpen?.(f)} accessibilityRole={onOpen ? 'button' : undefined}
          accessibilityLabel={`${chipLabel(f)}${f.state ? `, ${STATE_TEXT[f.state]}` : ''}${f.comments.length > 0 ? `, ${f.comments.length} comments` : ''}`}
          accessibilityHint={onOpen ? 'Shows details and comments' : undefined}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48, paddingHorizontal: 10, borderRadius: 8, backgroundColor: 'rgba(0,0,0,0.05)' }}
        >
          <Text style={{ fontSize: 22 }}>{KIND_ICON[f.kind]}</Text>
          <Text style={{ flex: 1, fontSize: 16, color: colors.text }} numberOfLines={1}>{chipLabel(f)}</Text>
          {f.state ? (
            <Text style={{ fontSize: 13, color: colors.muted }}>
              {f.state === 'sending' ? `${Math.round((f.progress ?? 0) * 100)}%` : STATE_TEXT[f.state]}
            </Text>
          ) : commentBadge(f) ? (
            <Text style={{ fontSize: 13, color: colors.muted }}>{commentBadge(f)}</Text>
          ) : null}
        </Pressable>
      ))}
    </View>
  );
}
