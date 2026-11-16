// Native adapter for the shrunk copies (D51; untested here, the logic is in ./copies.ts).
//
// Orientation and metadata: `ImageManipulator.manipulate(uri)` decodes the image through Expo's image
// loader, which honours the EXIF orientation of the source, so the bitmap it renders is upright and
// the re-encode (`saveAsync`, Android `Bitmap.compress`) writes the pixels only: no EXIF, GPS or
// thumbnail survives in a copy. Both points rest on the platform behaviour and are to be confirmed on
// a device with a photo shot in portrait (see apps/field/src/outbox/README.md).
import { File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { adoptIntoSandbox, OUTBOX_DIR } from '../outbox/transport';
import { type CopyEngine } from './copies';
import { sha256OfFile } from './hash';

const digest = (uri: string): Promise<string> => new File(uri).digest('SHA-256');

export const copyEngine: CopyEngine = {
  async open(uri) {
    const base = await ImageManipulator.manipulate(uri).renderAsync();
    return {
      width: base.width,
      height: base.height,
      async save(resize, quality) {
        // no resize = the decoded image as is (never enlarged)
        const ref = resize ? await ImageManipulator.manipulate(uri).resize(resize).renderAsync() : base;
        return ref.saveAsync({ compress: quality, format: SaveFormat.JPEG });
      },
    };
  },
  sha256: (uri) => sha256OfFile(uri, digest),
  fileSize: async (uri) => new File(uri).size,
  adopt: adoptIntoSandbox,
  async remove(uri) {
    // our own temp output (cache) and sandbox files only
    if (!uri.startsWith(Paths.cache.uri) && !uri.startsWith(OUTBOX_DIR)) return;
    try {
      const f = new File(uri);
      if (f.exists) f.delete();
    } catch {
      // temp files are cleaned by the system anyway
    }
  },
};
