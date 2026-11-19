// One thread row: own messages on the right with ticks, office / system messages on the left.
import { memo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { relativeTime } from '../../lib/time';
import { rowFallbackText, rowMeta, type ThreadRow } from '../../thread/model';
import { colors } from '../../theme';
import { FileChips, ImageGrid } from './Attachments';

const BLUE = '#1e88e5';

export const Bubble = memo(function Bubble({ row, width, online, now, onOpenImage, onPending, onRetry, showLabel }: {
  row: ThreadRow;
  /** Content width of the bubble (for the grid). */
  width: number;
  online: boolean;
  now: Date;
  onOpenImage: (row: ThreadRow, index: number) => void;
  onPending: (clientMessageId: string) => void;
  /** "Retry" on a stuck item: send now (resets the backoff, retries held files). */
  onRetry: () => void;
  /** Show the state text next to the tick (items on the phone and the newest own message). */
  showLabel: boolean;
}) {
  const meta = rowMeta(row);
  const system = row.kind === 'system';
  const text = row.text ?? rowFallbackText(row);
  const body = (
    <View
      style={{
        alignSelf: system ? 'center' : row.mine ? 'flex-end' : 'flex-start',
        maxWidth: system ? '92%' : '84%',
        marginHorizontal: 12, marginTop: 8, padding: 10, borderRadius: 12,
        backgroundColor: system ? colors.bg : row.mine ? '#e3efff' : colors.card,
        borderWidth: 1, borderColor: system ? 'transparent' : colors.border,
      }}
    >
      {row.kind === 'request' ? <Text style={{ fontSize: 14, fontWeight: '700', color: colors.muted }}>Request from the office</Text> : null}
      {row.images.length > 0 ? (
        <ImageGrid images={row.images} width={width} online={online} onOpen={(i) => onOpenImage(row, i)} />
      ) : null}
      <FileChips files={row.others} />
      {text ? (
        <Text style={{ fontSize: system ? 15 : 17, color: system ? colors.muted : colors.text, marginTop: row.fileCount > 0 ? 6 : 0, fontStyle: row.withdrawn ? 'italic' : 'normal' }}>
          {text}
        </Text>
      ) : null}
      {row.status ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 }}>
          <Text style={{ flex: 1, fontSize: 14, color: '#8a5a00' }}>{row.status}</Text>
          {row.retry ? (
            <Pressable onPress={onRetry} accessibilityRole="button" accessibilityLabel="Retry sending"
              style={{ minHeight: 40, minWidth: 72, paddingHorizontal: 12, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary }}>
              <Text style={{ color: colors.onPrimary, fontSize: 15, fontWeight: '700' }}>Retry</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 6, marginTop: 4 }}>
        {meta.count ? <Text style={{ fontSize: 13, color: colors.muted }}>{meta.count}</Text> : null}
        <Text style={{ fontSize: 13, color: colors.muted }}>{relativeTime(row.at, now)}</Text>
        {showLabel && meta.label ? <Text style={{ fontSize: 13, color: meta.blue ? BLUE : colors.muted }}>{meta.label}</Text> : null}
        {meta.tick ? (
          <Text style={{ fontSize: 14, fontWeight: '700', color: meta.blue ? BLUE : colors.muted }} accessibilityLabel={tickLabel(row.tick)}>
            {meta.tick}
          </Text>
        ) : null}
      </View>
    </View>
  );
  if (!row.pending || !row.clientMessageId) return body;
  const id = row.clientMessageId;
  return (
    <Pressable onPress={() => onPending(id)} accessibilityRole="button" accessibilityLabel="Saved on this phone, tap for details">
      {body}
    </Pressable>
  );
});

function tickLabel(t: ThreadRow['tick']): string {
  switch (t) {
    case 'clock': return 'Saved on this phone';
    case 'stored': return 'Stored';
    case 'processed': return 'Processed';
    case 'seen': return 'Seen by the office';
    default: return '';
  }
}
