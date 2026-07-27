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

import type { Light, Scene, RGB } from '../engine';
import { toSRGB8 } from '../engine';
import { ViewCore, type GlFactory, type SampleMode, type SpacingName, type ShapeInit, type SurfaceShape } from './core';
import { VIEW_STYLES } from './styles';

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);
const vec3 = (v: ArrayLike<number>) => `${fmt(v[0])} ${fmt(v[1])} ${fmt(v[2])}`;

function parseVec3(s: string | null): [number, number, number] | null {
  if (!s) return null;
  const parts = s.trim().split(/[\s,]+/).map(parseFloat);
  return parts.length === 3 && parts.every(Number.isFinite) ? [parts[0], parts[1], parts[2]] : null;
}

function numAttr(el: Element, name: string, fallback: number) {
  const n = parseFloat(el.getAttribute(name) ?? '');
  return Number.isFinite(n) ? n : fallback;
}

const LIGHT_TYPES = new Set(['point', 'area', 'directional', 'spot']);

/** Attribute bag for one light. All state lives in attributes. */
export class RayColorLightElement extends HTMLElement {
  toLight(): Light {
    const type = this.getAttribute('type') ?? 'directional';
    return {
      type: (LIGHT_TYPES.has(type) ? type : 'directional') as Light['type'],
      hex: this.getAttribute('hex') ?? '#ffffff',
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
export class RayColorShapeElement extends HTMLElement {
  toShape(): ShapeInit | null {
    const kind = this.getAttribute('kind');
    if (kind !== 'line' && kind !== 'circle') return null;
    const a = parseVec3(this.getAttribute('a'));
    if (!a) return null;
    return {
      kind,
      a,
      b: parseVec3(this.getAttribute('b')) ?? a,
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

const SCENE_ATTRS = ['fov', 'camera-z', 'sphere-radius', 'sphere-hex', 'wall-hex', 'indirect', 'area-quality', 'wall-reflect'] as const;

const DEFAULT_LIGHTS = (): Light[] => [
  { type: 'directional', yaw: -150, pitch: 48, dist: 2, hex: '#ff0000', intensity: 0.95, angle: 30, size: 0.15 },
  { type: 'directional', yaw: -125, pitch: -40, dist: 2, hex: '#fff700', intensity: 0.3, angle: 30, size: 0.4 },
  { type: 'directional', yaw: -39, pitch: -35, dist: 2, hex: '#00ffb3', intensity: 0.2, angle: 30, size: 0.15 },
];

export class RayColorViewElement extends HTMLElement {
  static observedAttributes = ['mode', 'count', 'spacing', 'controls', ...SCENE_ATTRS];

  private core: ViewCore | null = null;
  private glFactory: GlFactory | null;
  private childObserver: MutationObserver | null = null;
  private applyingAttrs = false;

  constructor(glFactory: GlFactory | null = null) {
    super();
    this.glFactory = glFactory;
  }

  // ------------------------------------------------------------ lifecycle

  connectedCallback() {
    if (this.core) return;
    const shadow = this.shadowRoot ?? this.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = VIEW_STYLES;
    shadow.appendChild(style);

    const scene: Scene = {
      cameraZ: numAttr(this, 'camera-z', -9),
      fov: numAttr(this, 'fov', 30),
      sphereRadius: numAttr(this, 'sphere-radius', 1.2),
      sphereHex: this.getAttribute('sphere-hex') ?? '#ffffff',
      wallHex: this.getAttribute('wall-hex') ?? '#999999',
      indirect: numAttr(this, 'indirect', 0.3),
      areaQuality: numAttr(this, 'area-quality', 6),
      wallReflect: (() => {
        const r = numAttr(this, 'wall-reflect', 0);
        return { back: r, left: r, right: r, top: r, bottom: r };
      })(),
    };

    const lightEls = this.lightChildren();
    const lights = lightEls.length ? lightEls.map(el => el.toLight()) : DEFAULT_LIGHTS();

    const renderer = this.getAttribute('renderer');
    const core = new ViewCore(shadow, {
      scene,
      lights,
      glFactory: renderer === 'software' ? null : this.glFactory,
      controls: this.hasAttribute('controls'),
      mode: (this.getAttribute('mode') as SampleMode) || 'circle',
      count: numAttr(this, 'count', 7),
      spacing: (this.getAttribute('spacing') as SpacingName) || 'linear',
    });
    this.core = core;

    const shapeInit = this.shapeChild()?.toShape();
    if (shapeInit) core.shape = shapeInit;

    this.connectCoreEvents();

    // DOM → view: edited child attributes (devtools, frameworks) re-apply
    this.childObserver = new MutationObserver(records => {
      if (!this.core) return;
      const relevant = records.some(r => r.target !== this && (r.type === 'childList' || r.type === 'attributes'));
      if (relevant) this.syncFromChildren();
    });
    this.childObserver.observe(this, { subtree: true, childList: true, attributes: true });

    this.emit('palettechange', { colors: this.colors() });
  }

  disconnectedCallback() {
    this.childObserver?.disconnect();
    this.childObserver = null;
    this.core?.dispose();
    this.core = null;
  }

  attributeChangedCallback(name: string, _old: string | null, value: string | null) {
    if (!this.core || this.applyingAttrs) return;
    const core = this.core;
    if (name === 'mode') core.mode = (value as SampleMode) || 'circle';
    else if (name === 'count') core.count = numAttr(this, 'count', core.count);
    else if (name === 'spacing') core.spacing = (value as SpacingName) || 'linear';
    else if (name === 'controls') core.controls = value !== null;
    else if ((SCENE_ATTRS as readonly string[]).includes(name)) {
      const s = core.scene;
      s.cameraZ = numAttr(this, 'camera-z', s.cameraZ);
      s.fov = numAttr(this, 'fov', s.fov);
      s.sphereRadius = numAttr(this, 'sphere-radius', s.sphereRadius);
      s.sphereHex = this.getAttribute('sphere-hex') ?? s.sphereHex;
      s.wallHex = this.getAttribute('wall-hex') ?? s.wallHex;
      s.indirect = numAttr(this, 'indirect', s.indirect);
      s.areaQuality = numAttr(this, 'area-quality', s.areaQuality);
      if (this.hasAttribute('wall-reflect')) {
        const r = numAttr(this, 'wall-reflect', 0);
        s.wallReflect = { back: r, left: r, right: r, top: r, bottom: r };
      }
      core.update();
    }
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
      glFactory: this.getAttribute('renderer') === 'software' ? null : this.glFactory,
      controls: this.hasAttribute('controls'),
      mode: keep.mode,
      count: keep.count,
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
    if (!this.core || !s) return;
    Object.assign(this.core.scene, s);
    this.core.update();
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
  }
  get selectedLight() { return this.core?.selectedLight ?? -1; }

  /** Discrete mode/count/spacing changes reflect immediately (unlike drags,
   * which reflect on release). */
  private reflectSimpleAttr(name: string, value: string) {
    this.applyingAttrs = true;
    this.setAttribute(name, value);
    this.applyingAttrs = false;
  }

  colors(): { hex: string; rgb: [number, number, number] }[] {
    const cols = this.core?.colors() ?? [];
    return Array.from(cols, (c: ArrayLike<number>) => ({
      hex: '#' + [c[0], c[1], c[2]].map(v => toSRGB8(v).toString(16).padStart(2, '0')).join(''),
      rgb: [c[0], c[1], c[2]] as [number, number, number],
    }));
  }

  /** Raw linear-RGB triples, full precision (same buffers the engine wrote). */
  rawColors(): ArrayLike<number>[] { return this.core?.colors() ?? []; }
  sampleDirs(): Float64Array[] { return this.core?.sampleDirs() ?? []; }
  setSampleDirs(dirs: ArrayLike<number>[]) { this.core?.setSampleDirs(dirs); }
  shade(dir: ArrayLike<number>): RGB | null { return this.core ? this.core.engine.shade(dir) : null; }

  update() { this.core?.update(); }
  exportImage(): HTMLCanvasElement | null { return this.core?.exportImage() ?? null; }
  ensureSettledCanvas() { this.core?.ensureSettledCanvas(); }
  selectLight(i: number) { this.core?.selectLight(i); }
  deleteSelection() { this.core?.deleteSelection(); }
  clearSampleSelection() { this.core?.clearSampleSelection(); }
  selectSampleAt(i: number) { this.core?.selectSampleAt(i); }
  get selectedSampleIndex() { return this.core?.selectedSampleIndex ?? -1; }
}

/** Register the elements. glFactory carries the WebGL2 preview constructor —
 * the software-only entry passes null and ships no shader code. */
export function defineRayColorView(glFactory: GlFactory | null) {
  if (customElements.get('ray-color-view')) return;
  customElements.define('ray-color-light', RayColorLightElement);
  customElements.define('ray-color-shape', RayColorShapeElement);
  customElements.define('ray-color-view', class extends RayColorViewElement {
    constructor() { super(glFactory); }
  });
}
