/**
 * The browser painter of Aadhaar masking (D55, shared/report/aadhaar.ts): decodes the photo fetched for the report
 * (upright, EXIF orientation applied), paints the rectangles solid black and re-encodes a JPEG. A canvas writes no
 * EXIF / location metadata. Only this in-memory copy changes; the evidence file and its copies are never touched.
 */
import type { Box, Painter, Size } from "@shared/report/aadhaar.ts";
import type { ReportImage } from "@shared/report/bind.ts";

const QUALITY = 0.9;

type Canvas2D = {
  fillStyle: string | CanvasGradient | CanvasPattern;
  fillRect(x: number, y: number, w: number, h: number): void;
  drawImage(img: ImageBitmap, x: number, y: number): void;
};

async function encode(bmp: ImageBitmap, rects: Box[]): Promise<Uint8Array> {
  const { width, height } = bmp;
  const paint = (ctx: Canvas2D) => {
    ctx.fillStyle = "#ffffff"; // transparent PNG areas would turn black in a JPEG
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bmp, 0, 0);
    ctx.fillStyle = "#000000";
    for (const r of rects) ctx.fillRect(r.x, r.y, r.w, r.h);
  };
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    paint(ctx);
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: QUALITY });
    return new Uint8Array(await blob.arrayBuffer());
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  paint(ctx);
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", QUALITY));
  if (!blob) throw new Error("the image could not be encoded");
  return new Uint8Array(await blob.arrayBuffer());
}

export const paintMask: Painter = async (image: ReportImage, rectsFor: (decoded: Size) => Box[]): Promise<ReportImage> => {
  const blob = new Blob([image.bytes as Uint8Array<ArrayBuffer>], { type: image.mime });
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(blob, { imageOrientation: "from-image" });
  } catch {
    bmp = await createImageBitmap(blob); // older engines reject "from-image"; their default applies EXIF too
  }
  try {
    const rects = rectsFor({ width: bmp.width, height: bmp.height });
    if (rects.length === 0) return image;
    const bytes = await encode(bmp, rects);
    return { bytes, mime: "image/jpeg", width: bmp.width, height: bmp.height };
  } finally {
    bmp.close();
  }
};
