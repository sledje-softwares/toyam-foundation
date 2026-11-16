// Shrunk copies (D51): size rules, no upscaling, ordering, silent drop on failure. The image decoder is a
// fake standing in for expo-image-manipulator.
import { describe, expect, it } from 'vitest';
import { COPY_MAX_BYTES, COPY_QUALITY, COPY_WIDTHS, type CopyEngine, copyResize, makeCopies, wantsCopies } from './copies';

describe('copyResize', () => {
  it('scales the long edge down, keeping the aspect ratio', () => {
    expect(copyResize(2048, 1536, 1600)).toEqual({ width: 1600 });
    expect(copyResize(1536, 2048, 1600)).toEqual({ height: 1600 });
    expect(copyResize(2048, 1536, 384)).toEqual({ width: 384 });
    expect(copyResize(1000, 3000, 384)).toEqual({ height: 384 });
  });
  it('never enlarges: an image at or under the target keeps its size', () => {
    expect(copyResize(1600, 1200, 1600)).toBeNull();
    expect(copyResize(1000, 800, 1600)).toBeNull();
    expect(copyResize(300, 200, 384)).toBeNull();
  });
  it('unknown dimensions are kept, never guessed', () => {
    expect(copyResize(0, 0, 1600)).toBeNull();
  });
});

describe('wantsCopies', () => {
  it('images only: jpeg, png, heic, heif, webp', () => {
    for (const m of ['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp', 'IMAGE/JPEG; q=1']) expect(wantsCopies(m, 'photo')).toBe(true);
    for (const m of ['application/pdf', 'video/mp4', 'audio/mp4', 'image/gif']) expect(wantsCopies(m, 'photo')).toBe(false);
    expect(wantsCopies('image/jpeg', 'document')).toBe(false);
  });
});

/** Fake decoder: records every save and returns a deterministic file per call. */
function fakeEngine(src: { width: number; height: number }, over: { fail?: (edge: number) => boolean; size?: (edge: number) => number; openFails?: boolean } = {}) {
  const log: string[] = [];
  const removed: string[] = [];
  const adopted = new Map<string, string>();
  let n = 0;
  const engine: CopyEngine = {
    async open(uri) {
      log.push(`open ${uri}`);
      if (over.openFails) throw new Error('decode failed');
      return {
        width: src.width,
        height: src.height,
        async save(resize, quality) {
          const edge = resize ? ('width' in resize ? resize.width : resize.height) : Math.max(src.width, src.height);
          log.push(`save ${JSON.stringify(resize)} q=${quality}`);
          if (over.fail?.(edge)) throw new Error('encode failed');
          const w = resize && 'width' in resize ? resize.width : resize ? Math.round((src.width * resize.height) / src.height) : src.width;
          const h = resize && 'height' in resize ? resize.height : resize ? Math.round((src.height * resize.width) / src.width) : src.height;
          return { uri: `file:///cache/tmp${++n}-${edge}.jpg`, width: w, height: h };
        },
      };
    },
    async sha256(uri) {
      return (uri.length.toString(16) + 'c').repeat(64).slice(0, 64);
    },
    async fileSize(uri) {
      const edge = Number(/-(\d+)\.jpg$/.exec(uri)?.[1]);
      return over.size ? over.size(edge) : Math.round(edge * 120);
    },
    async adopt(uri, name) {
      adopted.set(name, uri);
      return `file:///sandbox/${name}`;
    },
    async remove(uri) {
      removed.push(uri);
    },
  };
  return { engine, log, removed, adopted };
}

const photo = { local_path: 'file:///sandbox/orig.jpg', mime_type: 'image/jpeg', evidence_type: 'photo' };

describe('makeCopies', () => {
  it('makes 1600 first and 384 second at quality 0.8, named by file id and width', async () => {
    const { engine, log } = fakeEngine({ width: 2048, height: 1536 });
    const copies = await makeCopies(engine, photo, 'f1');
    expect(COPY_WIDTHS).toEqual([1600, 384]);
    expect(copies.map((c) => c.width)).toEqual([1600, 384]);
    expect(copies.map((c) => c.local_path)).toEqual(['file:///sandbox/copy-f1-w1600.jpg', 'file:///sandbox/copy-f1-w384.jpg']);
    expect(log.filter((l) => l.startsWith('save'))).toEqual([`save {"width":1600} q=${COPY_QUALITY}`, `save {"width":384} q=${COPY_QUALITY}`]);
    expect(COPY_QUALITY).toBe(0.8);
    expect(copies[0]).toMatchObject({ pixel_width: 1600, pixel_height: 1200, storage_path: null, attempts: 0 });
    expect(copies[1]).toMatchObject({ pixel_width: 384, pixel_height: 288 });
    expect(copies[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it('a portrait image is limited on its height (long edge)', async () => {
    const { engine, log } = fakeEngine({ width: 1536, height: 2048 });
    await makeCopies(engine, photo, 'f1');
    expect(log.filter((l) => l.startsWith('save'))).toEqual([`save {"height":1600} q=0.8`, `save {"height":384} q=0.8`]);
  });
  it('never upscales: a small image keeps its own size in both copies', async () => {
    const { engine, log } = fakeEngine({ width: 300, height: 200 });
    const copies = await makeCopies(engine, photo, 'f1');
    expect(log.filter((l) => l.startsWith('save'))).toEqual(['save null q=0.8', 'save null q=0.8']);
    expect(copies.map((c) => [c.pixel_width, c.pixel_height])).toEqual([[300, 200], [300, 200]]);
  });
  it('between the targets: 1600 keeps the size, 384 shrinks', async () => {
    const { engine, log } = fakeEngine({ width: 1000, height: 800 });
    const copies = await makeCopies(engine, photo, 'f1');
    expect(log.filter((l) => l.startsWith('save'))).toEqual(['save null q=0.8', 'save {"width":384} q=0.8']);
    expect(copies[0]!.pixel_width).toBe(1000);
    expect(copies[1]!.pixel_width).toBe(384);
  });
  it('non-images make no copies and never open the decoder', async () => {
    const { engine, log } = fakeEngine({ width: 100, height: 100 });
    expect(await makeCopies(engine, { ...photo, mime_type: 'application/pdf', evidence_type: 'document' }, 'f1')).toEqual([]);
    expect(await makeCopies(engine, { ...photo, mime_type: 'video/mp4', evidence_type: 'video' }, 'f1')).toEqual([]);
    expect(log).toEqual([]);
  });
  it('a failing copy is dropped silently; the other one is kept', async () => {
    const { engine, removed } = fakeEngine({ width: 2048, height: 1536 }, { fail: (edge) => edge === 1600 });
    const copies = await makeCopies(engine, photo, 'f1');
    expect(copies.map((c) => c.width)).toEqual([384]);
    expect(removed.length).toBeGreaterThan(0);
  });
  it('a decoder that cannot open the image gives no copies (and no error)', async () => {
    const { engine } = fakeEngine({ width: 2048, height: 1536 }, { openFails: true });
    expect(await makeCopies(engine, photo, 'f1')).toEqual([]);
  });
  it('a copy over the 3 MB cap or empty is dropped', async () => {
    const big = fakeEngine({ width: 2048, height: 1536 }, { size: (edge) => (edge === 1600 ? COPY_MAX_BYTES + 1 : 20_000) });
    expect((await makeCopies(big.engine, photo, 'f1')).map((c) => c.width)).toEqual([384]);
    const empty = fakeEngine({ width: 2048, height: 1536 }, { size: () => 0 });
    expect(await makeCopies(empty.engine, photo, 'f1')).toEqual([]);
    const atCap = fakeEngine({ width: 2048, height: 1536 }, { size: () => COPY_MAX_BYTES });
    expect((await makeCopies(atCap.engine, photo, 'f1')).length).toBe(2);
  });
  it('temp files are always removed', async () => {
    const { engine, removed } = fakeEngine({ width: 2048, height: 1536 });
    await makeCopies(engine, photo, 'f1');
    expect(removed.length).toBe(2);
  });
});
