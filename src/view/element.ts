// <ray-color-view> — the playground's viewport as a web component, with the
// declarative two-way children:
//
//   <ray-color-view controls mode="circle" count="7" fov="30" camera-z="-9">
//     <ray-color-light hex="#ffaa00" yaw="40" pitch="10" dist="4" intensity="1.2"></ray-color-light>
//     <ray-color-shape kind="circle" a="0 0 -1" rho="0.93" rotate="0"></ray-color-shape>
//   </ray-color-view>
//
// Two-way: editing a child's attributes moves the scene; dragging the
// on-screen controls writes the child's attributes back (on gesture end, like
// a range input's change). `input` fires continuously while dragging,
// `change` once on release, `palettechange` whenever the sampled colors move.

import type { Light, Scene, RGB } from '../engine.js';
import { toSRGB8, isHexColor } from '../engine.js';
import { ViewCore, type GlFactory, type InputKind, type SampleMode, type SpacingName, type ShapeInit, type SurfaceShape } from './core.js';
import { VIEW_STYLES } from './styles.js';
import type { BloomFactory } from '../bloom.js';

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);
// shape anchors get more digits: 3 decimals moved them by up to ~1e-3 rad,
// enough to shift sampled colors after a round trip through the markup
const fmtDir = (n: number) => String(Math.round(n * 1e6) / 1e6);
const vec3 = (v: ArrayLike<number>) => `${fmtDir(v[0])} ${fmtDir(v[1])} ${fmtDir(v[2])}`;

/** Three numbers, normalized: shape anchors are unit directions. */
function parseDir(s: string | null): [number, number, number] | null {
  if (!s) return null;
  const p = s.trim().split(/[\s,]+/).map(parseFloat);
  if (p.length !== 3 || !p.every(Number.isFinite)) return null;
  const len = Math.hypot(p[0], p[1], p[2]);
  return len > 0 ? [p[0] / len, p[1] / len, p[2] / len] : null;
}

function numAttr(el: Element, name: string, fallback: number) {
  const n = parseFloat(el.getAttribute(name) ?? '');
  return Number.isFinite(n) ? n : fallback;
}

// invalid hex makes the engine throw, so a typo in markup falls back instead
function hexAttr(el: Element, name: string, fallback: string) {
  const v = el.getAttribute(name)?.trim();
  return v && isHexColor(v) ? (v[0] === '#' ? v : '#' + v) : fallback;
}

// server-side rendering imports this module without a DOM; the classes only
// need a real HTMLElement once a browser registers them
const ElementBase = (typeof HTMLElement === 'undefined' ? class {} : HTMLElement) as typeof HTMLElement;

const LIGHT_TYPES = new Set(['point', 'area', 'directional', 'spot']);

/** Attribute bag for one light. All state lives in attributes. */
export class RayColorLightElement extends ElementBase {
  toLight(): Light {
    const type = this.getAttribute('type') ?? 'directional';
    return {
      type: (LIGHT_TYPES.has(type) ? type : 'directional') as Light['type'],
      hex: hexAttr(this, 'hex', '#ffffff'),
      yaw: numAttr(this, 'yaw', 0),
      pitch: numAttr(this, 'pitch', 0),
      dist: numAttr(this, 'dist', 4),
      intensity: numAttr(this, 'intensity', 1),
      angle: numAttr(this, 'angle', 30),
      size: numAttr(this, 'size', 0.15),
    };
  }

  reflect(l: Light) {
    this.setAttribute('type', l.type);
    this.setAttribute('hex', l.hex);
    this.setAttribute('yaw', fmt(l.yaw));
    this.setAttribute('pitch', fmt(l.pitch));
    this.setAttribute('dist', fmt(l.dist));
    this.setAttribute('intensity', fmt(l.intensity));
    this.setAttribute('angle', fmt(l.angle));
    this.setAttribute('size', fmt(l.size));
  }
}

/** Attribute bag for the sampling shape. */
export class RayColorShapeElement extends ElementBase {
  toShape(): ShapeInit | null {
    const kind = this.getAttribute('kind');
    if (kind !== 'line' && kind !== 'circle') return null;
    const a = parseDir(this.getAttribute('a'));
    if (!a) return null;
    return {
      kind,
      a,
      b: parseDir(this.getAttribute('b')) ?? a,
      rho: numAttr(this, 'rho', 0),
      rotate: numAttr(this, 'rotate', 0),
    };
  }

  reflect(s: { kind: string; a: ArrayLike<number>; b: ArrayLike<number>; rho: number; rotate: number }) {
    this.setAttribute('kind', s.kind);
    this.setAttribute('a', vec3(s.a));
    if (s.kind === 'line') this.setAttribute('b', vec3(s.b));
    else this.removeAttribute('b');
    if (s.kind === 'circle') this.setAttribute('rho', fmt(s.rho));
    else this.removeAttribute('rho');
    this.setAttribute('rotate', fmt(s.rotate));
  }
}

export interface PaletteColor { hex: string; rgb: [number, number, number] }

/** Events dispatched by <ray-color-view>, all bubbling and composed. */
export interface RayColorViewEventMap extends HTMLElementEventMap {
  /** Continuously while a control is dragged. */
  input: CustomEvent<{ kind: InputKind; colors: PaletteColor[] }>;
  /** Once per gesture, after the child attributes were updated. */
  change: CustomEvent<{ kind: InputKind; colors: PaletteColor[] }>;
  palettechange: CustomEvent<{ colors: PaletteColor[] }>;
  lightselect: CustomEvent<{ index: number | null }>;
  sampleselect: CustomEvent<{ index: number | null }>;
  viewupdate: CustomEvent<Record<string, never>>;
  /** The exact f64 frame has landed on the canvas. */
  settled: CustomEvent<Record<string, never>>;
}

const SCENE_ATTRS = ['fov', 'camera-z', 'sphere-radius', 'sphere-hex', 'wall-hex', 'indirect', 'area-quality', 'wall-reflect'] as const;
type SceneAttr = typeof SCENE_ATTRS[number];

const SCENE_DEFAULTS = (): Scene => ({
  cameraZ: -9.3,
  fov: 30,
  sphereRadius: 1.2,
  sphereHex: '#ffffff',
  wallHex: '#999999',
  indirect: 0.3,
  areaQuality: 6,
  wallReflect: { back: 0, left: 0, right: 0, top: 0, bottom: 0 },
});

/** One value for every wall, or five in back/left/right/top/bottom order. */
function parseWallReflect(s: string | null): Scene['wallReflect'] | null {
  if (!s) return null;
  const v = s.trim().split(/[\s,]+/).map(parseFloat);
  if (!v.every(Number.isFinite)) return null;
  if (v.length === 1) return { back: v[0], left: v[0], right: v[0], top: v[0], bottom: v[0] };
  if (v.length === 5) return { back: v[0], left: v[1], right: v[2], top: v[3], bottom: v[4] };
  return null;
}

/** Write one scene attribute into the scene; a missing or invalid value
 * restores that field's default. */
function applySceneAttr(el: Element, scene: Scene, name: SceneAttr) {
  const d = SCENE_DEFAULTS();
  switch (name) {
    case 'camera-z': scene.cameraZ = numAttr(el, name, d.cameraZ); break;
    case 'fov': scene.fov = numAttr(el, name, d.fov); break;
    case 'sphere-radius': scene.sphereRadius = numAttr(el, name, d.sphereRadius); break;
    case 'sphere-hex': scene.sphereHex = hexAttr(el, name, d.sphereHex); break;
    case 'wall-hex': scene.wallHex = hexAttr(el, name, d.wallHex); break;
    case 'indirect': scene.indirect = numAttr(el, name, d.indirect); break;
    case 'area-quality': scene.areaQuality = numAttr(el, name, d.areaQuality); break;
    case 'wall-reflect': scene.wallReflect = parseWallReflect(el.getAttribute(name)) ?? d.wallReflect; break;
  }
}

function sceneAttrValues(sc: Scene): Record<SceneAttr, string> {
  const w = sc.wallReflect;
  const walls = [w.back, w.left, w.right, w.top, w.bottom];
  return {
    'fov': fmt(sc.fov),
    'camera-z': fmt(sc.cameraZ),
    'sphere-radius': fmt(sc.sphereRadius),
    'sphere-hex': sc.sphereHex,
    'wall-hex': sc.wallHex,
    'indirect': fmt(sc.indirect),
    'area-quality': fmt(sc.areaQuality),
    'wall-reflect': walls.every(v => v === walls[0]) ? fmt(walls[0]) : walls.map(fmt).join(' '),
  };
}

const SAMPLE_MODES = new Set(['points', 'line', 'circle']);
const parseMode = (v: string | null): SampleMode => (v && SAMPLE_MODES.has(v) ? v : 'circle') as SampleMode;

const DEFAULT_LIGHTS = (): Light[] => [
  { type: 'directional', yaw: -150, pitch: 48, dist: 2, hex: '#ff0000', intensity: 0.95, angle: 30, size: 0.15 },
  { type: 'directional', yaw: -125, pitch: -40, dist: 2, hex: '#fff700', intensity: 0.3, angle: 30, size: 0.4 },
  { type: 'directional', yaw: -39, pitch: -35, dist: 2, hex: '#00ffb3', intensity: 0.2, angle: 30, size: 0.15 },
];

export class RayColorViewElement extends ElementBase {
  static observedAttributes = ['mode', 'count', 'spacing', 'controls', 'renderer', 'bloom', 'bloom-threshold', ...SCENE_ATTRS];

  private core: ViewCore | null = null;
  private childObserver: MutationObserver | null = null;
  private applyingAttrs = false;
  // live state kept across a disconnect, so re-inserting the element resumes
  // where it left off instead of rebuilding from attributes
  // property writes that arrive before there's a core to apply them to
  private pending: { scene?: Partial<Scene>; shape?: ShapeInit | null; dirs?: ArrayLike<number>[] } = {};
  private saved: { scene: Scene; lights: Light[]; shape: SurfaceShape | null; dirs: Float64Array[] | null } | null = null;

  // ------------------------------------------------------------ lifecycle

  connectedCallback() {
    // a move (remove + insert in the same task) keeps the running core
    if (this.core) return;
    const shadow = this.shadowRoot ?? this.attachShadow({ mode: 'open' });
    if (!shadow.querySelector('style')) {
      const style = document.createElement('style');
      style.textContent = VIEW_STYLES;
      shadow.appendChild(style);
    }

    this.upgradeProperties();
    const saved = this.saved;
    this.saved = null;
    const pending = this.pending;
    this.pending = {};
    let scene = saved?.scene;
    if (!scene) {
      scene = SCENE_DEFAULTS();
      for (const name of SCENE_ATTRS) applySceneAttr(this, scene, name);
    }

    // declarative children stay the source of truth; without them, a
    // reconnect resumes the lights it had
    if (pending.scene) Object.assign(scene, pending.scene);

    const lightEls = this.lightChildren();
    const lights = lightEls.length ? lightEls.map(el => el.toLight()) : saved?.lights ?? DEFAULT_LIGHTS();

    const renderer = this.getAttribute('renderer');
    const core = new ViewCore(shadow, {
      scene,
      lights,
      glFactory: renderer === 'software' ? null : registeredGlFactory,
      controls: this.hasAttribute('controls'),
      mode: parseMode(this.getAttribute('mode')),
      count: numAttr(this, 'count', 7),
      bloomFactory: registeredBloomFactory,
      bloom: this.bloomAttr(),
      bloomThreshold: numAttr(this, 'bloom-threshold', 0.8),
      spacing: (this.getAttribute('spacing') as SpacingName) || 'linear',
    });
    this.core = core;

    const shapeInit = this.shapeChild()?.toShape();
    if (pending.shape !== undefined) core.shape = pending.shape;
    else if (shapeInit) core.shape = shapeInit;
    else if (saved?.shape) core.shape = saved.shape;
    const dirs = pending.dirs ?? saved?.dirs;
    if (dirs) core.setSampleDirs(dirs);

    this.connectCoreEvents();

    // DOM → view: edited child attributes (devtools, frameworks) re-apply
    this.childObserver = new MutationObserver(records => {
      if (!this.core) return;
      const relevant = records.some(r => r.target !== this && (r.type === 'childList' || r.type === 'attributes'));
      if (relevant) this.syncFromChildren();
    });
    this.childObserver.observe(this, { subtree: true, childList: true, attributes: true });

    if (pending.scene) this.reflectScene();
    this.emit('palettechange', { colors: this.colors() });
  }

  /** A framework (or plain script) may set properties on the element before
   * the class is defined; those land as own fields shadowing the accessors.
   * Re-run them through the setters. */
  private upgradeProperties() {
    for (const prop of ['scene', 'shape', 'mode', 'count', 'spacing'] as const) {
      if (!Object.prototype.hasOwnProperty.call(this, prop)) continue;
      const value = (this as Record<string, unknown>)[prop];
      delete (this as Record<string, unknown>)[prop];
      (this as Record<string, unknown>)[prop] = value;
    }
  }

  disconnectedCallback() {
    // defer: a reorder or reparent reconnects within the same task, and the
    // core (engine, GL context, samples) should survive that untouched
    queueMicrotask(() => {
      if (this.isConnected || !this.core) return;
      const core = this.core;
      this.saved = {
        scene: core.scene,
        lights: core.lights,
        shape: core.shape,
        dirs: core.mode === 'points' ? core.sampleDirs() : null,
      };
      this.childObserver?.disconnect();
      this.childObserver = null;
      core.dispose();
      this.core = null;
    });
  }

  attributeChangedCallback(name: string, _old: string | null, value: string | null) {
    if (!this.core || this.applyingAttrs) return;
    const core = this.core;
    if (name === 'mode') core.mode = parseMode(value);
    else if (name === 'count') core.count = numAttr(this, 'count', core.count);
    else if (name === 'spacing') core.spacing = (value as SpacingName) || 'linear';
    else if (name === 'controls') core.controls = value !== null;
    else if (name === 'renderer') this.rebuild(core.lights);
    else if (name === 'bloom') core.bloom = this.bloomAttr();
    else if (name === 'bloom-threshold') core.bloomThreshold = numAttr(this, 'bloom-threshold', 0.8);
    else if ((SCENE_ATTRS as readonly string[]).includes(name)) {
      applySceneAttr(this, core.scene, name as SceneAttr);
      core.update();
    }
  }

  /** `bloom` alone turns the glow on at strength 1; a number sets it. */
  private bloomAttr() {
    return this.hasAttribute('bloom') ? numAttr(this, 'bloom', 1) : 0;
  }

  // ------------------------------------------------------------ two-way sync

  private lightChildren(): RayColorLightElement[] {
    return Array.from(this.querySelectorAll<RayColorLightElement>('ray-color-light'));
  }

  private shapeChild(): RayColorShapeElement | null {
    return this.querySelector<RayColorShapeElement>('ray-color-shape');
  }

  /** DOM → view. Light count changes need a new engine, so those rebuild. */
  private syncFromChildren() {
    const core = this.core!;
    const lightEls = this.lightChildren();
    if (lightEls.length && lightEls.length !== core.lights.length) {
      this.rebuild(lightEls.map(el => el.toLight()));
      return;
    }
    if (lightEls.length) {
      lightEls.forEach((el, i) => Object.assign(core.lights[i], el.toLight()));
    }
    const shapeInit = this.shapeChild()?.toShape();
    if (shapeInit) core.shape = shapeInit;
    core.update();
  }

  /** view → DOM, after a gesture ends. Skipped entirely when the page never
   * opted into declarative children. Observer records are swallowed so the
   * reflection can't echo back into syncFromChildren. */
  private reflectToChildren() {
    const core = this.core!;
    this.applyingAttrs = true;
    try {
      const lightEls = this.lightChildren();
      if (lightEls.length === core.lights.length) {
        lightEls.forEach((el, i) => el.reflect(core.lights[i]));
      }
      const shapeEl = this.shapeChild();
      if (shapeEl && core.shape) shapeEl.reflect(core.shape);
    } finally {
      this.childObserver?.takeRecords();
      this.applyingAttrs = false;
    }
  }

  /** Recreate the core (new engine) with a different light set, keeping the
   * sampling state. */
  private rebuild(lights: Light[]) {
    const core = this.core!;
    const keep = {
      mode: core.mode,
      count: core.count,
      spacing: core.spacing,
      shape: core.shape,
      dirs: core.mode === 'points' ? core.sampleDirs() : null,
      scene: core.scene,
    };
    const shadow = this.shadowRoot!;
    core.dispose();
    const next = new ViewCore(shadow, {
      scene: keep.scene,
      lights,
      glFactory: this.getAttribute('renderer') === 'software' ? null : registeredGlFactory,
      controls: this.hasAttribute('controls'),
      mode: keep.mode,
      count: keep.count,
      bloomFactory: registeredBloomFactory,
      bloom: core.bloom,
      bloomThreshold: core.bloomThreshold,
      spacing: keep.spacing,
    });
    this.core = next;
    if (keep.shape) next.shape = keep.shape;
    if (keep.dirs) next.setSampleDirs(keep.dirs);
    this.connectCoreEvents();
    next.update();
  }

  private connectCoreEvents() {
    const core = this.core!;
    core.onInput = kind => this.emit('input', { kind, colors: this.colors() });
    core.onChange = kind => {
      this.reflectToChildren();
      this.emit('change', { kind, colors: this.colors() });
    };
    core.onPalette = () => this.emit('palettechange', { colors: this.colors() });
    core.onLightSelect = index => this.emit('lightselect', { index });
    core.onSampleSelect = index => this.emit('sampleselect', { index });
    core.onUpdate = () => this.emit('viewupdate', {});
    core.onSettled = () => this.emit('settled', {});
  }

  private emit(type: string, detail: unknown) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  // ------------------------------------------------------------ public API

  get engine() { return this.core?.engine ?? null; }
  get canvas() { return this.core?.canvas ?? null; }
  get scene(): Scene | null { return this.core?.scene ?? null; }
  set scene(s: Partial<Scene> | null) {
    if (!s) return;
    if (!this.core) {
      this.pending.scene = { ...this.pending.scene, ...s };
      return;
    }
    Object.assign(this.core.scene, s);
    this.core.update();
    this.reflectScene();
  }

  /** scene → attributes, so outerHTML carries scene edits made in code. */
  private reflectScene() {
    const values = sceneAttrValues(this.core!.scene);
    const defaults = sceneAttrValues(SCENE_DEFAULTS());
    this.applyingAttrs = true;
    try {
      for (const name of SCENE_ATTRS) {
        // leave defaults implicit unless the markup already spells them out
        if (values[name] === defaults[name] && !this.hasAttribute(name)) continue;
        this.setAttribute(name, values[name]);
      }
    } finally {
      this.applyingAttrs = false;
    }
  }
  get lights(): Light[] { return this.core?.lights ?? []; }
  get mode(): SampleMode { return this.core?.mode ?? 'circle'; }
  set mode(m: SampleMode) {
    if (this.core) this.core.mode = m;
    this.reflectSimpleAttr('mode', m);
  }
  get count(): number { return this.core?.count ?? 7; }
  set count(n: number) {
    if (this.core) this.core.count = n;
    this.reflectSimpleAttr('count', String(this.core?.count ?? n));
  }
  get spacing(): SpacingName { return this.core?.spacing ?? 'linear'; }
  set spacing(s: SpacingName) {
    if (this.core) this.core.spacing = s;
    this.reflectSimpleAttr('spacing', s);
  }
  get shape(): SurfaceShape | null { return this.core?.shape ?? null; }
  set shape(s: ShapeInit | null) {
    if (this.core) this.core.shape = s;
    else this.pending.shape = s;
  }
  get selectedLight() { return this.core?.selectedLight ?? -1; }
  /** Display-only glow strength (0 = off); sampled colors never include it. */
  get bloom(): number { return this.core?.bloom ?? this.bloomAttr(); }
  set bloom(strength: number) {
    if (this.core) this.core.bloom = strength;
    if (strength > 0) this.reflectSimpleAttr('bloom', String(strength));
    else {
      this.applyingAttrs = true;
      this.removeAttribute('bloom');
      this.applyingAttrs = false;
    }
  }
  get bloomThreshold(): number { return this.core?.bloomThreshold ?? numAttr(this, 'bloom-threshold', 0.8); }
  set bloomThreshold(t: number) {
    if (this.core) this.core.bloomThreshold = t;
    this.reflectSimpleAttr('bloom-threshold', String(t));
  }

  /** Discrete mode/count/spacing changes reflect immediately (unlike drags,
   * which reflect on release). */
  private reflectSimpleAttr(name: string, value: string) {
    this.applyingAttrs = true;
    this.setAttribute(name, value);
    this.applyingAttrs = false;
  }

  colors(): PaletteColor[] {
    const cols = this.core?.colors() ?? [];
    return Array.from(cols, (c: ArrayLike<number>) => ({
      hex: '#' + [c[0], c[1], c[2]].map(v => toSRGB8(v).toString(16).padStart(2, '0')).join(''),
      rgb: [c[0], c[1], c[2]] as [number, number, number],
    }));
  }

  /** Raw linear-RGB triples, full precision (same buffers the engine wrote). */
  rawColors(): ArrayLike<number>[] { return this.core?.colors() ?? []; }
  sampleDirs(): Float64Array[] { return this.core?.sampleDirs() ?? []; }
  setSampleDirs(dirs: ArrayLike<number>[]) {
    if (this.core) this.core.setSampleDirs(dirs);
    else this.pending.dirs = dirs;
  }
  shade(dir: ArrayLike<number>): RGB | null { return this.core ? this.core.engine.shade(dir) : null; }

  update() { this.core?.update(); }
  /** The settled frame with the sample dots; `bloom: true` adds the glow. */
  exportImage(opts?: { bloom?: boolean }): HTMLCanvasElement | null { return this.core?.exportImage(opts) ?? null; }
  ensureSettledCanvas() { this.core?.ensureSettledCanvas(); }
  selectLight(i: number) { this.core?.selectLight(i); }
  deleteSelection() { this.core?.deleteSelection(); }
  clearSampleSelection() { this.core?.clearSampleSelection(); }
  selectSampleAt(i: number) { this.core?.selectSampleAt(i); }
  get selectedSampleIndex() { return this.core?.selectedSampleIndex ?? -1; }
}

export interface RayColorViewElement {
  addEventListener<K extends keyof RayColorViewEventMap>(type: K, listener: (this: RayColorViewElement, ev: RayColorViewEventMap[K]) => unknown, options?: boolean | AddEventListenerOptions): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
  removeEventListener<K extends keyof RayColorViewEventMap>(type: K, listener: (this: RayColorViewElement, ev: RayColorViewEventMap[K]) => unknown, options?: boolean | EventListenerOptions): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void;
}

declare global {
  interface HTMLElementTagNameMap {
    'ray-color-view': RayColorViewElement;
    'ray-color-light': RayColorLightElement;
    'ray-color-shape': RayColorShapeElement;
  }
}

// Set by whichever entry registers the elements. Read when a view connects,
// so importing ray-color/view after ray-color/view/software still gives views
// connected from then on the WebGL2 preview.
let registeredGlFactory: GlFactory | null = null;
let registeredBloomFactory: BloomFactory | null = null;

/** Register the elements. glFactory carries the WebGL2 preview constructor;
 * bloomFactory the display-only glow. The software-only entry passes null
 * for both and ships no shader code. Safe to call
 * repeatedly and from both entries: a factory, once given, is kept, and tags
 * some other code already defined are left alone. */
export function defineRayColorView(glFactory: GlFactory | null, bloomFactory: BloomFactory | null = null) {
  if (typeof customElements === 'undefined') return;
  if (glFactory) registeredGlFactory = glFactory;
  if (bloomFactory) registeredBloomFactory = bloomFactory;
  const define = (tag: string, ctor: CustomElementConstructor) => {
    const existing = customElements.get(tag);
    if (!existing) customElements.define(tag, ctor);
    else if (existing !== ctor) console.warn(`ray-color: <${tag}> is already defined by other code (another copy of ray-color?); keeping that definition`);
  };
  define('ray-color-light', RayColorLightElement);
  define('ray-color-shape', RayColorShapeElement);
  define('ray-color-view', RayColorViewElement);
}
