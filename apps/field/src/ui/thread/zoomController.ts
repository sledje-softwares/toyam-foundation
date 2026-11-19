// Gesture state of one viewer page (pinch, pan, double tap) on React Native's PanResponder + Animated.
// Created once per page (useState initialiser); maths in src/thread/zoom.ts.
import { Animated, PanResponder, type GestureResponderEvent, type PanResponderInstance } from 'react-native';
import { clampPan, distance, doubleTapScale, isDoubleTap, MIN_SCALE, pinchScale, type Pt } from '../../thread/zoom';

const touches = (e: GestureResponderEvent): Pt[] => e.nativeEvent.touches.map((t) => ({ x: t.pageX, y: t.pageY }));

export class ZoomController {
  readonly scale = new Animated.Value(1);
  readonly tx = new Animated.Value(0);
  readonly ty = new Animated.Value(0);
  readonly responder: PanResponderInstance;
  private onZoom: (zoomed: boolean) => void = () => {};
  private width = 1;
  private height = 1;
  private s = 1;
  private x = 0;
  private y = 0;
  private startScale = 1;
  private startDist = 0;
  private startX = 0;
  private startY = 0;
  private lastTap: { t: number; p: Pt } | null = null;

  constructor() {
    this.responder = PanResponder.create({
      // pinches always; one-finger drags only while zoomed (otherwise the list pages)
      onStartShouldSetPanResponder: (e) => e.nativeEvent.touches.length >= 2,
      onMoveShouldSetPanResponder: (e, g) => e.nativeEvent.touches.length >= 2 || (this.s > MIN_SCALE && (Math.abs(g.dx) > 2 || Math.abs(g.dy) > 2)),
      onPanResponderGrant: (e) => {
        const t = touches(e);
        this.startScale = this.s;
        this.startDist = t[0] && t[1] ? distance(t[0], t[1]) : 0;
        this.startX = this.x;
        this.startY = this.y;
      },
      onPanResponderMove: (e, g) => {
        const t = touches(e);
        if (t[0] && t[1]) {
          if (this.startDist === 0) { this.startDist = distance(t[0], t[1]); this.startScale = this.s; }
          this.apply(pinchScale(this.startScale, this.startDist, distance(t[0], t[1])), this.x, this.y);
        } else if (this.s > MIN_SCALE) {
          this.apply(this.s, this.startX + g.dx, this.startY + g.dy);
        }
      },
      onPanResponderRelease: () => {
        if (this.s <= MIN_SCALE + 0.01) this.apply(MIN_SCALE, 0, 0);
        this.startDist = 0;
        this.onZoom(this.s > MIN_SCALE);
      },
      onPanResponderTerminationRequest: () => this.s <= MIN_SCALE,
    });
  }

  setOnZoom(fn: (zoomed: boolean) => void): void {
    this.onZoom = fn;
  }

  setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.apply(this.s, this.x, this.y);
  }

  /** Pressable onPress: two taps close together toggle 1× / 2.5×. */
  tap(e: GestureResponderEvent): void {
    const p = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY };
    const now = Date.now();
    if (isDoubleTap(this.lastTap, now, p)) {
      this.lastTap = null;
      const next = doubleTapScale(this.s);
      this.apply(next, 0, 0);
      this.onZoom(next > MIN_SCALE);
    } else {
      this.lastTap = { t: now, p };
    }
  }

  private apply(s: number, x: number, y: number): void {
    const p = clampPan(x, y, s, this.width, this.height);
    this.s = s;
    this.x = p.x;
    this.y = p.y;
    this.scale.setValue(s);
    this.tx.setValue(p.x);
    this.ty.setValue(p.y);
  }
}
