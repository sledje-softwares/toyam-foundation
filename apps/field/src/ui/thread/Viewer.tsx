// Full-screen image viewer: swipe between a message's images, pinch or double-tap to zoom, drag to pan.
// Gestures use React Native's PanResponder (no native gesture library, so no rebuild); maths in thread/zoom.ts.
// Below the photo (D54): its categories, the reading's description and its comments with "Add comment"
// (FileInfoPanel); "Hide" gives the photo the whole screen. The keyboard lifts the panel (KeyboardAvoidingView).
import { useEffect, useState } from 'react';
import {
  ActivityIndicator, Animated, FlatList, Image, KeyboardAvoidingView, Modal, Pressable, StatusBar, Text, useWindowDimensions, View,
  type GestureResponderEvent, type ListRenderItemInfo,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { chipLabel, type ThreadFile } from '../../thread/model';
import type { FileInfoView } from '../../ui-logic/fileInfo';
import { FileInfoPanel, type CommentActions } from './FileInfo';
import { useImageUri } from './useImageUri';
import { ZoomController } from './zoomController';

function ZoomImage({ f, width, height, online, onZoom }: {
  f: ThreadFile; width: number; height: number; online: boolean; onZoom: (zoomed: boolean) => void;
}) {
  const img = useImageUri(f, 'full', online);
  const [z] = useState(() => new ZoomController());
  useEffect(() => { z.setSize(width, height); }, [z, width, height]);
  useEffect(() => { z.setOnZoom(onZoom); }, [z, onZoom]);
  const { scale, tx, ty } = z;
  const onTap = (e: GestureResponderEvent) => z.tap(e);
  const responder = z.responder;

  return (
    <View style={{ width, height, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }} {...responder.panHandlers}>
      {img.uri ? (
        <Pressable onPress={onTap} accessibilityLabel={f.name} accessibilityHint="Double tap to zoom">
          <Animated.View style={{ transform: [{ translateX: tx }, { translateY: ty }, { scale }] }}>
            {/* resizeMethod "resize" decodes at screen size, never the full original */}
            <Image source={{ uri: img.uri }} style={{ width, height }} resizeMode="contain" resizeMethod="resize" onError={img.onError} fadeDuration={0} />
          </Animated.View>
        </Pressable>
      ) : img.loading ? (
        <ActivityIndicator color="#fff" size="large" />
      ) : (
        <Text style={{ color: '#fff', fontSize: 16, textAlign: 'center', paddingHorizontal: 24 }}>
          {online ? 'This photo cannot be shown.' : 'This photo is not on the phone yet. It will show when you have signal.'}
        </Text>
      )}
    </View>
  );
}

/**
 * Mount while open (give it a new `key` per opening); `images` are the message's images (live: they follow the
 * thread's refreshes), `start` the tapped one. `info` builds the panel of a file; `actions` queue / retry / remove comments.
 */
export function Viewer({ images, start, online, onClose, info, actions }: {
  images: readonly ThreadFile[]; start: number; online: boolean; onClose: () => void;
  info: (f: ThreadFile) => FileInfoView; actions: CommentActions;
}) {
  const { width, height } = useWindowDimensions();
  const [index, setIndex] = useState(start);
  const [zoomed, setZoomed] = useState(false);
  const [showInfo, setShowInfo] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // the photo gets what the header and the panel leave (measured: it shrinks while the keyboard is up)
  const [pageH, setPageH] = useState(0);
  const visible = images.length > 0;
  const current = images[Math.min(index, images.length - 1)] ?? null;
  const view = current ? info(current) : null;

  return (
    <Modal visible={visible} onRequestClose={onClose} animationType="fade" statusBarTranslucent>
      <StatusBar barStyle="light-content" />
      {/* padding: lifts the panel above the keyboard (0 when the window already resized) */}
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: '#000' }}>
        <SafeAreaView style={{ flex: 1, backgroundColor: '#000' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 56, paddingHorizontal: 8 }}>
            <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" style={{ minWidth: 56, minHeight: 56, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ color: '#fff', fontSize: 28 }}>×</Text>
            </Pressable>
            <Text style={{ color: '#fff', fontSize: 16, flex: 1 }} numberOfLines={1}>{current ? chipLabel(current) : ''}</Text>
            {images.length > 1 ? <Text style={{ color: '#fff', fontSize: 16, paddingHorizontal: 12 }}>{Math.min(index, images.length - 1) + 1} of {images.length}</Text> : null}
          </View>
          <View style={{ flex: 1 }} onLayout={(e) => setPageH(Math.round(e.nativeEvent.layout.height))}>
            {visible && pageH > 0 ? (
              <FlatList
                data={images}
                horizontal pagingEnabled showsHorizontalScrollIndicator={false}
                scrollEnabled={!zoomed}
                initialScrollIndex={Math.min(start, images.length - 1)}
                getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
                // only the page on screen and its neighbours hold a decoded image
                windowSize={3} initialNumToRender={1} maxToRenderPerBatch={1} removeClippedSubviews
                keyboardShouldPersistTaps="handled"
                keyExtractor={(f) => f.key}
                onMomentumScrollEnd={(e) => { setIndex(Math.round(e.nativeEvent.contentOffset.x / width)); setZoomed(false); }}
                renderItem={({ item }: ListRenderItemInfo<ThreadFile>) => (
                  <ZoomImage f={item} width={width} height={pageH} online={online} onZoom={setZoomed} />
                )}
              />
            ) : null}
          </View>
          {current && view ? (
            showInfo ? (
              <FileInfoPanel
                key={current.key} file={current} view={view} dark draft={drafts[current.key] ?? ''}
                onDraft={(t) => setDrafts((d) => ({ ...d, [current.key]: t }))} actions={actions}
                maxHeight={Math.round(height * 0.3)} onHide={() => setShowInfo(false)}
              />
            ) : (
              <Pressable
                onPress={() => setShowInfo(true)} accessibilityRole="button" accessibilityLabel="Show details and comments"
                style={{ minHeight: 52, paddingHorizontal: 16, justifyContent: 'center', backgroundColor: '#0d1117' }}
              >
                <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600' }}>
                  Details and comments{view.count > 0 ? ` (${view.count})` : ''}
                </Text>
              </Pressable>
            )
          ) : null}
        </SafeAreaView>
      </KeyboardAvoidingView>
    </Modal>
  );
}
