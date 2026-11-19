// Pinch / pan / double-tap maths for the full-screen viewer (pure; the gestures use React Native's own
// PanResponder, so no native gesture library is needed).
export const MIN_SCALE = 1;
export const MAX_SCALE = 4;
export const DOUBLE_TAP_SCALE = 2.5;
export const DOUBLE_TAP_MS = 300;

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export interface Pt { x: number; y: number }

export const distance = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);

/** New scale from the pinch distance at the start and now. */
export function pinchScale(startScale: number, startDist: number, dist: number): number {
  if (startDist <= 0) return startScale;
  return clamp(startScale * (dist / startDist), MIN_SCALE, MAX_SCALE);
}

/**
 * Keeps the scaled image covering the frame: with the image scaled around the centre, the translation may
 * move it at most half of the overflow in each direction. At scale 1 there is no pan.
 */
export function clampPan(tx: number, ty: number, scale: number, width: number, height: number): { x: number; y: number } {
  const mx = Math.max(0, (width * scale - width) / 2);
  const my = Math.max(0, (height * scale - height) / 2);
  return { x: clamp(tx, -mx, mx), y: clamp(ty, -my, my) };
}

/** Double tap: zoom in from 1×, back to 1× otherwise. */
export const doubleTapScale = (scale: number): number => (scale > MIN_SCALE + 0.01 ? MIN_SCALE : DOUBLE_TAP_SCALE);

/** Two taps close in time and place count as a double tap. */
export function isDoubleTap(prev: { t: number; p: Pt } | null, t: number, p: Pt): boolean {
  return prev !== null && t - prev.t <= DOUBLE_TAP_MS && distance(prev.p, p) < 40;
}
