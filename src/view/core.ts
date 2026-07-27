// The interactive viewport, extracted from the playground: render pipeline
// (progressive f64 CPU frames, optionally fronted by the WebGL2 preview),
// light markers with intensity/distance grips and orbit-ring gizmos, sample
// points, and the line/circle shape editor with its rotation grips.
//
// Framework-free: ViewCore builds its DOM into whatever root it's given
// (the custom element hands it a shadow root). All outward communication is
// via the assignable on* callbacks; all inward via properties and update().

import {
  createEngine,
  toSRGB8,
  MAX_LIGHT_DISTANCE,
  DEFAULT_PASS_SCALES,
  slerp,
  circleDir,
  circleBasis,
  rotateDirs,
  sampleLineDirs,
  sampleCircleDirs,
  distributions,
  positionToAngles,
  type Engine,
  type Light,
  type Scene,
} from '../engine';
import type { GlPreview } from '../gl-preview';
import { LIGHT_TYPE_ICONS } from './icons';

export type SampleMode = 'points' | 'line' | 'circle';
export type SpacingName = keyof typeof distributions;
export type HandleRole = 'a' | 'b' | 'r' | 'rot' | 'crot';

export interface SurfaceShape {
  kind: 'line' | 'circle';
  a: Float64Array;   // line start / circle center (unit direction)
  b: Float64Array;   // line end (unit direction)
  rho: number;       // circle angular radius (radians)
  rotate: number;    // circle sample rotation around the ring (degrees) —
                     // line rotation bakes straight into a/b instead
}

/** Plain-object form accepted by the shape setter (and used by presets). */
export interface ShapeInit {
  kind: 'line' | 'circle';
  a: ArrayLike<number>;
  b?: ArrayLike<number>;
  rho?: number;
  rotate?: number;
}

interface Sample {
  // Float64 to match the renderer's precision exactly — float32 rounding
  // shows up as off-by-one channel values after sRGB encoding
  dir: Float64Array; // unit direction from sphere center (surface anchor)
  color: Float64Array;
  marker: HTMLElement;
}

/** What a continuous interaction is editing — the payload of input/change. */
export type InputKind = 'light' | 'light-intensity' | 'light-dist' | 'light-color' | 'light-type' | 'shape' | 'sample' | 'samples-rotate';

const LIGHT_TYPES: Light['type'][] = ['point', 'area', 'directional', 'spot'];

export type GlFactory = (
  width: number,
  height: number,
  opts?: { canvas?: HTMLCanvasElement; preserveDrawingBuffer?: boolean },
) => GlPreview | null;

export interface ViewCoreOptions {
  scene: Scene;
  lights: Light[];
  /** Inject createGlPreview for the GPU interaction preview; omit (or null)
   * for the software-only build — the shader never enters the bundle. */
  glFactory?: GlFactory | null;
  controls?: boolean;
  mode?: SampleMode;
  count?: number;
  spacing?: SpacingName;
}

const clampDot = (d: number) => Math.max(-1, Math.min(1, d));
const wrap180 = (deg: number) => (((deg % 360) + 540) % 360) - 180;
const angDelta = (a: number, b: number) => ((a - b + 540) % 360) - 180;

const SETTLE_MS = 160;
const SURFACE_DEG_PER_RADIUS = 90;
const YAW_TILT_S = Math.sin(10 * Math.PI / 180);
const YAW_TILT_C = Math.cos(10 * Math.PI / 180);

// asymptotic (x / (x + 1)): any intensity has a radius, dragging never snap-clamps
const INT_R0 = 16;   // ring radius at intensity 0
const INT_R1 = 36;   // additional radius as intensity -> inf
const INT_MAX = 19;  // hard ceiling when dragging the grip outward
const BEAD_F = 0.5;

const NS = 'http://www.w3.org/2000/svg';

// circle rotation satellite: angular offset from the center, and the radius
// below which it would collide with the ring and steps aside
const CROT_ARC = 0.16;
const CROT_MIN_RHO = 0.24;

export class ViewCore {
  readonly scene: Scene;
  readonly lights: Light[];

  // DOM — all inside the given root
  readonly viewport: HTMLDivElement;
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly gizmoSvg: SVGSVGElement;
  private readonly shapeSvg: SVGSVGElement;
  private readonly lightLayer: HTMLDivElement;
  private readonly sampleLayer: HTMLDivElement;
  private readonly shapeHandles: HTMLDivElement;
  private readonly samplesRotWidget: HTMLDivElement;

  private _engine: Engine;
  private lightPositions: Float32Array;
  private imageData: ImageData;
  private glPreview: GlPreview | null = null;
  private readonly glFactory: GlFactory | null;

  private _mode: SampleMode;
  private _count: number;
  private _spacing: SpacingName;
  private _controls: boolean;
  private _shape: SurfaceShape | null = null;
  private shapeColors: Float64Array[] = [];
  private samples: Sample[] = [];
  private selectedSample: Sample | null = null;
  private _selectedLight = -1;
  private samplesRotSpin = 0; // cosmetic: the knob keeps the accumulated turn

  // render pipeline
  private renderInProgress = false;
  private pendingRender = false;
  private settleTimer: number | undefined;
  private renderGen = 0;

  private resizeObserver: ResizeObserver;
  private disposed = false;
  private readonly colorInput: HTMLInputElement;
  private colorLight = -1; // which light the open color picker edits

  // outward hooks — the element (or any host) assigns these
  onInput: ((kind: InputKind) => void) | null = null;
  onChange: ((kind: InputKind) => void) | null = null;
  onPalette: (() => void) | null = null;
  onLightSelect: ((index: number | null) => void) | null = null;
  onSampleSelect: ((index: number | null) => void) | null = null;
  onUpdate: (() => void) | null = null;
  onSettled: (() => void) | null = null;

  constructor(root: HTMLElement | ShadowRoot, opts: ViewCoreOptions) {
    this.scene = opts.scene;
    this.lights = opts.lights;
    this.glFactory = opts.glFactory ?? null;
    this._controls = opts.controls ?? true;
    this._mode = opts.mode ?? 'circle';
    this._count = opts.count ?? 7;
    this._spacing = opts.spacing ?? 'linear';

    this.viewport = document.createElement('div');
    this.viewport.className = 'viewport';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'render-canvas';
    this.gizmoSvg = document.createElementNS(NS, 'svg') as SVGSVGElement;
    this.gizmoSvg.setAttribute('class', 'gizmo');
    this.gizmoSvg.setAttribute('aria-hidden', 'true');
    this.shapeSvg = document.createElementNS(NS, 'svg') as SVGSVGElement;
    this.shapeSvg.setAttribute('class', 'shape-svg');
    this.shapeSvg.setAttribute('aria-hidden', 'true');
    this.lightLayer = document.createElement('div');
    this.lightLayer.className = 'light-layer';
    this.sampleLayer = document.createElement('div');
    this.sampleLayer.className = 'sample-layer';
    this.shapeHandles = document.createElement('div');
    this.shapeHandles.className = 'shape-handles';
    this.viewport.append(this.canvas, this.gizmoSvg, this.shapeSvg, this.lightLayer, this.sampleLayer, this.shapeHandles);
    root.appendChild(this.viewport);

    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    this.ctx = ctx;
    // Backing store matches the displayed CSS size (1 rendered pixel = 1 CSS
    // px), so the render isn't upscaled. Kept in sync by the ResizeObserver.
    this.canvas.width = this.canvas.height = this.displaySize();
    this.imageData = ctx.createImageData(this.canvas.width, this.canvas.height);

    this._engine = createEngine(this.canvas.width, this.canvas.height, this.scene, this.lights);
    this.lightPositions = this._engine.lightPositions;

    if (this.glFactory) {
      // WebGL2 preview: instant f32 frames while interacting; the f64 CPU
      // render (the one palettes sample from, bit-for-bit) lands once
      // interaction settles. Null without WebGL2 — falls back to CPU-only.
      this.glPreview = this.glFactory(this.canvas.width, this.canvas.height);
      if (this.glPreview) {
        this.glPreview.canvas.classList.add('gl-canvas');
        this.glPreview.canvas.setAttribute('aria-hidden', 'true');
        this.canvas.insertAdjacentElement('afterend', this.glPreview.canvas);
        this.glPreview.canvas.addEventListener('webglcontextlost', () => {
          this.glPreview!.canvas.remove();
          this.glPreview = null;
          this.requestRender();
        });
      }
    }

    // One persistent color input outside the marker layer (which is wiped on
    // every update): the native picker stays anchored and alive while its
    // input events stream through re-renders
    this.colorInput = document.createElement('input');
    this.colorInput.type = 'color';
    this.colorInput.className = 'light-color-input';
    this.colorInput.tabIndex = -1;
    this.viewport.appendChild(this.colorInput);
    this.colorInput.addEventListener('input', () => {
      if (this.colorLight < 0) return;
      this.lights[this.colorLight].hex = this.colorInput.value;
      this.onInput?.('light-color');
      this.update();
    });
    this.colorInput.addEventListener('change', () => this.onChange?.('light-color'));

    this.samplesRotWidget = document.createElement('div');
    this.samplesRotWidget.className = 'marker samples-rot';
    this.samplesRotWidget.title = 'Drag to rotate the points around their center';
    this.samplesRotWidget.addEventListener('pointerdown', e => this.beginSamplesRotDrag(e));
    this.samplesRotWidget.toggleAttribute('hidden', true);
    this.sampleLayer.appendChild(this.samplesRotWidget);

    this.attachInteractions();
    this.applyControlsClass();

    // The engine's buffers are sized at creation, so a layout change means a
    // new engine — same scene/lights refs, so nothing else needs rewiring
    let resizeTimer: number | undefined;
    this.resizeObserver = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        if (this.disposed) return;
        const size = this.displaySize();
        if (size === this.canvas.width) return;
        this.canvas.width = this.canvas.height = size;
        this.imageData = this.ctx.createImageData(size, size);
        this._engine = createEngine(size, size, this.scene, this.lights);
        this.lightPositions = this._engine.lightPositions;
        this.glPreview?.resize(size, size);
        this.update();
      }, 150);
    });
    this.resizeObserver.observe(this.viewport);

    this.setMode(this._mode); // applies mode defaults
    this.update();            // first commit + markers + frame
  }

  // ---------------------------------------------------------------- public surface

  get engine(): Engine { return this._engine; }
  get mode(): SampleMode { return this._mode; }
  set mode(next: SampleMode) { this.setMode(next); }
  get count(): number { return this._count; }
  set count(next: number) {
    this._count = Math.min(32, Math.max(2, Math.round(next) || 2));
    this.refreshShape();
  }
  get spacing(): SpacingName { return this._spacing; }
  set spacing(next: SpacingName) {
    this._spacing = next in distributions ? next : 'linear';
    this.refreshShape();
  }
  get controls(): boolean { return this._controls; }
  set controls(on: boolean) {
    this._controls = on;
    this.applyControlsClass();
  }
  get shape(): SurfaceShape | null { return this._shape; }
  set shape(s: ShapeInit | null) {
    this._shape = s === null ? null : {
      kind: s.kind,
      a: Float64Array.from(s.a as ArrayLike<number>),
      b: Float64Array.from((s.b ?? s.a) as ArrayLike<number>),
      rho: s.rho ?? 0,
      rotate: s.rotate ?? 0,
    };
    this.refreshShape();
  }
  get selectedLight(): number { return this._selectedLight; }
  get selectedSampleIndex(): number { return this.selectedSample ? this.samples.indexOf(this.selectedSample) : -1; }

  /** Active palette as linear-RGB triples (points or shape, per mode). */
  colors(): ArrayLike<number>[] {
    return this._mode === 'points' ? this.samples.map(s => s.color) : this.shapeColors;
  }

  /** Surface anchors behind the palette — for reproducing it via the library. */
  sampleDirs(): Float64Array[] {
    return this._mode === 'points' ? this.samples.map(s => new Float64Array(s.dir)) : this.shapeSampleDirs();
  }

  /** Replace the loose sample points (points mode). */
  setSampleDirs(dirs: ArrayLike<number>[]) {
    this.sampleLayer.querySelectorAll('.sample-marker').forEach(m => m.remove());
    this.samples = [];
    this.selectedSample = null;
    for (const d of dirs) this.createSampleAt(Float64Array.from(d as ArrayLike<number>), false);
    this.updateSamplesRotWidget();
    this.emitPalette();
  }

  /** Select a light's editing gizmos (or -1 to clear). Emits onLightSelect. */
  selectLight(i: number) {
    const next = i >= 0 && i < this.lights.length ? i : -1;
    if (next === this._selectedLight) return;
    this._selectedLight = next;
    this.updateLightMarkers();
    this.onLightSelect?.(next >= 0 ? next : null);
  }

  /** Backspace behavior: drop the selected point, or the whole shape. */
  deleteSelection() {
    if (this._mode === 'points') this.deleteSelectedSample();
    else this.deleteShape();
  }

  /** Re-commit scene/lights and repaint everything. Call after mutating the
   * scene or lights objects from outside. */
  update() {
    this._engine.commit();
    this.samples.forEach(sample => {
      const color = this._engine.shade(sample.dir);
      sample.color[0] = color.r;
      sample.color[1] = color.g;
      sample.color[2] = color.b;
      this.updateSampleMarker(sample);
    });
    this.recomputeShapeColors(); // the shape re-lights with the scene, like points do
    this.updateShapeOverlay();
    this.updateSamplesRotWidget();
    this.emitPalette();
    this.updateLightMarkers();
    this.onUpdate?.();
    this.requestRender();
  }

  /** The settled f64 render with the sample dots painted on — export-ready.
   * Forces a synchronous CPU frame if the GL preview is covering the canvas. */
  exportImage(): HTMLCanvasElement {
    this.ensureSettledCanvas();
    const out = document.createElement('canvas');
    out.width = this.canvas.width;
    out.height = this.canvas.height;
    const octx = out.getContext('2d')!;
    octx.drawImage(this.canvas, 0, 0);
    if (this._mode !== 'points' && this._shape) {
      this.shapeSampleDirs().forEach((d, i) => {
        const p = this.projectDirPct(d);
        const col = this.shapeColors[i];
        octx.globalAlpha = this.dirIsBehind(d) ? 0.3 : 1; // faded through the sphere, like on screen
        octx.beginPath();
        octx.arc(p.sx, p.sy, 4, 0, Math.PI * 2);
        octx.lineWidth = 3; // dark separator ring outside the white one, as on screen
        octx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
        octx.stroke();
        octx.fillStyle = col ? `rgb(${toSRGB8(col[0])}, ${toSRGB8(col[1])}, ${toSRGB8(col[2])})` : '#fff';
        octx.fill();
        octx.lineWidth = 1.5;
        octx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
        octx.stroke();
      });
      octx.globalAlpha = 1;
    }
    return out;
  }

  dispose() {
    this.disposed = true;
    this.resizeObserver.disconnect();
    clearTimeout(this.settleTimer);
    this.glPreview?.dispose();
    this.viewport.remove();
  }

  // ---------------------------------------------------------------- rendering

  private displaySize() {
    return Math.max(64, Math.round(this.canvas.clientWidth)) || 400;
  }

  requestRender() {
    if (this.glPreview) {
      // GPU frame now; full-precision CPU frame once edits stop coming
      this.renderGen++;
      this.glPreview.draw(this.scene, this.lights);
      if (!this.glPreview.canvas.classList.contains('gl-visible')) this.glPreview.canvas.classList.add('gl-visible');
      clearTimeout(this.settleTimer);
      this.settleTimer = window.setTimeout(() => this.cpuSettle(), SETTLE_MS);
      return;
    }
    this.cpuProgressiveRender();
  }

  // The settled CPU render skips the intermediate blits (the GL frame covers
  // the canvas until the final anti-aliased image is ready), so the
  // progressive ladder never flickers through — but still yields between passes.
  private async cpuSettle() {
    if (this.renderInProgress) {
      // A superseded settle may still be inside a blocking pass — try again
      // rather than dropping the final render on the floor
      this.settleTimer = window.setTimeout(() => this.cpuSettle(), SETTLE_MS);
      return;
    }
    this.renderInProgress = true;
    const gen = this.renderGen;
    this._engine.beginFrame();
    let done = true;
    for (let pass = 0; pass < DEFAULT_PASS_SCALES.length; pass++) {
      this._engine.renderPass(this.imageData.data, DEFAULT_PASS_SCALES[pass], pass === 0 ? 0 : DEFAULT_PASS_SCALES[pass - 1]);
      await new Promise(requestAnimationFrame);
      if (gen !== this.renderGen) { done = false; break; } // superseded mid-settle
    }
    if (done) {
      this._engine.refineEdges(this.imageData.data);
      this.ctx.putImageData(this.imageData, 0, 0);
      this.glPreview?.canvas.classList.remove('gl-visible');
      this.onSettled?.();
    }
    this.renderInProgress = false;
    // Superseded settles return without drawing; the timer set by the newer
    // requestRender rebounds into cpuSettle once edits stop.
  }

  /** Exports read the canvas, which can hold a stale frame while the GL
   * preview covers it. Force the settled f64 render synchronously — a one-off
   * hitch, in exchange for exports always being the exact CPU frame. */
  ensureSettledCanvas() {
    if (!this.glPreview || !this.glPreview.canvas.classList.contains('gl-visible')) return;
    clearTimeout(this.settleTimer);
    this.renderGen++; // aborts any in-flight async settle without drawing
    this._engine.beginFrame();
    this._engine.renderPass(this.imageData.data, 1);
    this._engine.refineEdges(this.imageData.data);
    this.ctx.putImageData(this.imageData, 0, 0);
    this.glPreview.canvas.classList.remove('gl-visible');
    this.onSettled?.();
  }

  private async cpuProgressiveRender() {
    if (this.renderInProgress) {
      this.pendingRender = true;
      return;
    }
    this.renderInProgress = true;
    this._engine.beginFrame();
    for (let pass = 0; pass < DEFAULT_PASS_SCALES.length; pass++) {
      this._engine.renderPass(this.imageData.data, DEFAULT_PASS_SCALES[pass], pass === 0 ? 0 : DEFAULT_PASS_SCALES[pass - 1]);
      this.ctx.putImageData(this.imageData, 0, 0);
      await new Promise(requestAnimationFrame);
    }
    // Settled (no follow-up render queued): anti-alias the geometric edges
    if (!this.pendingRender) {
      this._engine.refineEdges(this.imageData.data);
      this.ctx.putImageData(this.imageData, 0, 0);
      this.onSettled?.();
    }
    this.renderInProgress = false;
    if (this.pendingRender) {
      this.pendingRender = false;
      this.cpuProgressiveRender();
    }
  }

  // ---------------------------------------------------------------- projection helpers

  private eventToCanvasPixels(clientX: number, clientY: number, clamp = true) {
    const rect = this.canvas.getBoundingClientRect();
    // Exclude the canvas border from the mapping (rect includes it)
    const bx = (rect.width - this.canvas.clientWidth) / 2;
    const by = (rect.height - this.canvas.clientHeight) / 2;
    let x = (clientX - rect.left - bx) * (this.canvas.width / this.canvas.clientWidth);
    let y = (clientY - rect.top - by) * (this.canvas.height / this.canvas.clientHeight);
    if (clamp) {
      x = Math.min(this.canvas.width - 1, Math.max(0, x));
      y = Math.min(this.canvas.height - 1, Math.max(0, y));
    }
    return { x, y };
  }

  // Pull an off-canvas point back to the canvas edge ALONG its line toward the
  // canvas center — so edge-clamped markers sit exactly on their aim line
  private clampToCanvasAlongLine(px: number, py: number) {
    const w = this.canvas.width, h = this.canvas.height;
    const tx = w / 2, ty = h / 2;
    const dx = tx - px, dy = ty - py;
    let t = 0;
    if (px < 0) t = Math.max(t, -px / dx);
    else if (px > w) t = Math.max(t, (w - px) / dx);
    if (py < 0) t = Math.max(t, -py / dy);
    else if (py > h) t = Math.max(t, (h - py) / dy);
    return { x: px + dx * t, y: py + dy * t };
  }

  // Front/back test for a surface direction (same as sample markers)
  private dirIsBehind(d: ArrayLike<number>) {
    return this.scene.sphereRadius - d[2] * this.scene.cameraZ >= 0;
  }

  private projectDirPct(d: ArrayLike<number>) {
    const r = this.scene.sphereRadius;
    const p = this._engine.worldToScreen(d[0] * r, d[1] * r, d[2] * r);
    return { x: (p.x / this.canvas.width) * 100, y: (p.y / this.canvas.height) * 100, sx: p.x, sy: p.y };
  }

  // ---------------------------------------------------------------- light markers + gizmo

  private updateLightMarkers() {
    this.lightLayer.innerHTML = '';
    for (let i = 0; i < this.lights.length; i++) {
      const screenPos = this._engine.worldToScreen(this.lightPositions[i * 3], this.lightPositions[i * 3 + 1], this.lightPositions[i * 3 + 2]);
      if (screenPos.z <= 0) continue;
      const { x: cx, y: cy } = this.clampToCanvasAlongLine(screenPos.x, screenPos.y);
      const normalizedScale = Math.max(0, Math.min(1, (8 - screenPos.z) / 7.5));
      const marker = document.createElement('div');
      marker.className = `marker light-marker${this.lights[i].type === 'directional' ? ' light-marker--directional' : ''}`;
      marker.dataset.light = String(i);
      if (cx !== screenPos.x || cy !== screenPos.y) marker.classList.add('marker--offscreen');
      if (i === this._selectedLight) marker.classList.add('marker--selected');
      marker.style.left = `${(cx / this.canvas.width) * 100}%`;
      marker.style.top = `${(cy / this.canvas.height) * 100}%`;
      // Hollow ring = the light is behind the sphere
      if (this._engine.isLightOccluded(i)) {
        marker.classList.add('light-marker--occluded');
        marker.style.borderColor = this.lights[i].hex;
      } else {
        marker.style.backgroundColor = this.lights[i].hex;
      }
      marker.style.setProperty('--scale', normalizedScale.toString());
      this.lightLayer.appendChild(marker);
    }
    this.viewport.classList.toggle('light-editing', this._selectedLight >= 0);
    if (this._selectedLight >= 0) {
      const i = this._selectedLight;
      const sp = this._engine.worldToScreen(this.lightPositions[i * 3], this.lightPositions[i * 3 + 1], this.lightPositions[i * 3 + 2]);
      if (sp.z > 0) {
        const addGrip = (kind: string, x: number, y: number, round: boolean, title: string) => {
          const g = document.createElement('div');
          g.className = 'shape-handle light-grip' + (round ? ' shape-handle--grip' : '');
          g.dataset.grip = kind;
          g.title = title;
          g.style.left = `${(x / this.canvas.width) * 100}%`;
          g.style.top = `${(y / this.canvas.height) * 100}%`;
          g.style.transform = 'translate(-50%, -50%)';
          this.lightLayer.appendChild(g);
          return g;
        };
        // Edge-clamped lights keep their intensity ring: it rides the clamped
        // marker, with the whole control cluster aimed inward to stay reachable
        const { x: ax, y: ay } = this.clampToCanvasAlongLine(sp.x, sp.y);
        const clamped = ax !== sp.x || ay !== sp.y;
        const r = intensityRingRadius(this.lights[i].intensity);
        // the cluster sits opposite the aim line: pointing away from the sphere
        const c = this._engine.worldToScreen(0, 0, 0);
        const ga = clamped
          ? Math.atan2(this.canvas.height / 2 - ay, this.canvas.width / 2 - ax)
          : Math.atan2(ay - c.y, ax - c.x);
        const grip = addGrip('intensity', ax + Math.cos(ga) * r, ay + Math.sin(ga) * r, true, 'Intensity — drag to resize the ring');
        // little chevrons flanking the grip along its radial axis: the
        // drag-in/drag-out affordance
        grip.style.setProperty('--ga', `${(ga * 180 / Math.PI).toFixed(1)}deg`);
        for (const side of ['in', 'out'] as const) {
          const chev = document.createElement('span');
          chev.className = `light-chev light-chev--${side}`;
          grip.appendChild(chev);
        }
        this.addLightRingMenu(i, ax, ay, r, ga);
        // edge-clamped as a remote when the beam leaves the canvas
        const b = this.beadWorld(i);
        const bp = this._engine.worldToScreen(b.x, b.y, b.z);
        let bx = bp.x, by = bp.y;
        const beadOff = bx < 0 || bx > this.canvas.width || by < 0 || by > this.canvas.height;
        if (beadOff) ({ x: bx, y: by } = this.clampToCanvasAlongLine(bp.x, bp.y));
        const bead = addGrip('dist', bx, by, false, 'Distance — slide along the beam');
        if (beadOff) bead.classList.add('shape-handle--behind');
      }
    }
    this.updateGizmo();
  }

  // Circular menu riding the intensity ring: color swatch and light-type
  // button flanking the intensity grip, which always sits between them
  private addLightRingMenu(i: number, ax: number, ay: number, r: number, ga: number) {
    const light = this.lights[i];
    // small rings would stack the buttons onto the marker — keep a floor
    const cr = Math.max(r, 30);
    const spread = 50 * Math.PI / 180;
    const a1 = ga - spread;
    const a2 = ga + spread;
    const addCtrl = (cls: string, a: number, title: string) => {
      const c = document.createElement('div');
      c.className = 'light-ctrl ' + cls;
      c.title = title;
      c.style.left = `${((ax + Math.cos(a) * cr) / this.canvas.width) * 100}%`;
      c.style.top = `${((ay + Math.sin(a) * cr) / this.canvas.height) * 100}%`;
      c.addEventListener('pointerdown', e => e.stopPropagation());
      this.lightLayer.appendChild(c);
      return c;
    };

    const swatch = addCtrl('light-ctrl--color', a1, 'Light color — click to pick');
    swatch.style.backgroundColor = light.hex;
    swatch.addEventListener('click', e => {
      e.stopPropagation();
      this.colorLight = i;
      this.colorInput.value = light.hex;
      // anchor the native picker at the swatch
      this.colorInput.style.left = swatch.style.left;
      this.colorInput.style.top = swatch.style.top;
      const input = this.colorInput as HTMLInputElement & { showPicker?: () => void };
      try { input.showPicker ? input.showPicker() : input.click(); } catch { input.click(); }
    });

    const type = addCtrl('light-ctrl--type', a2, 'Light type');
    type.innerHTML = LIGHT_TYPE_ICONS[light.type];
    const sel = document.createElement('select');
    sel.className = 'light-ctrl__select';
    sel.title = 'Light type';
    for (const t of LIGHT_TYPES) sel.add(new Option(t, t, false, t === light.type));
    sel.addEventListener('change', () => {
      light.type = sel.value as Light['type'];
      this.update();
      this.onChange?.('light-type');
    });
    type.appendChild(sel);
  }

  private updateGizmo() {
    this.gizmoSvg.setAttribute('viewBox', `0 0 ${this.canvas.width} ${this.canvas.height}`);
    this.gizmoSvg.innerHTML = '';
    if (this._selectedLight < 0) return;
    const i = this._selectedLight;
    // rings stay drawable even when the light is off-canvas or behind the camera
    this.drawOrbit('yaw', i);
    this.drawOrbit('pitch', i);
    const screenPos = this._engine.worldToScreen(this.lightPositions[i * 3], this.lightPositions[i * 3 + 1], this.lightPositions[i * 3 + 2]);
    if (screenPos.z <= 0) return;
    const { x: cx, y: cy } = this.clampToCanvasAlongLine(screenPos.x, screenPos.y);
    const type = this.lights[i].type;
    {
      // Aim line from the light to where its ray meets the sphere's surface.
      const lx = this.lightPositions[i * 3], ly = this.lightPositions[i * 3 + 1], lz = this.lightPositions[i * 3 + 2];
      const llen = Math.sqrt(lx * lx + ly * ly + lz * lz) || 1;
      const s = this.scene.sphereRadius / llen;
      const ex = lx * s, ey = ly * s, ez = lz * s;
      const N = 32;
      const sp = this.pathSplitter(false);
      for (let k = 0; k <= N; k++) {
        const t = k / N;
        sp.add(lx + (ex - lx) * t, ly + (ey - ly) * t, lz + (ez - lz) * t);
      }
      const { vis, hid } = sp.paths();
      if (hid) this.appendPaths(hid, [['', 'gizmo-line--hidden']]);
      if (vis) this.appendPaths(vis, [['3', 'gizmo-line-casing'], ['1', 'gizmo-line']]);
    }
    if (type === 'area' && this.lights[i].size > 0) {
      const r = (this.lights[i].size / (screenPos.z * this._engine.tanFov())) * (this.canvas.height / 2);
      const circle = document.createElementNS(NS, 'circle');
      circle.setAttribute('cx', cx.toFixed(1));
      circle.setAttribute('cy', cy.toFixed(1));
      circle.setAttribute('r', Math.max(2, r).toFixed(1));
      circle.setAttribute('class', 'gizmo-area');
      this.gizmoSvg.appendChild(circle);
    }
    {
      // intensity ring — drawn around the clamped marker when the light is
      // off-canvas, so it stays editable without bringing the light back
      const r = intensityRingRadius(this.lights[i].intensity);
      for (const [width, cls] of [['3', 'shape-path-casing'], ['1.5', 'shape-path']] as const) {
        const ring = document.createElementNS(NS, 'circle');
        ring.setAttribute('cx', cx.toFixed(1));
        ring.setAttribute('cy', cy.toFixed(1));
        ring.setAttribute('r', r.toFixed(1));
        ring.setAttribute('fill', 'none');
        ring.setAttribute('stroke-width', width);
        ring.setAttribute('class', cls);
        this.gizmoSvg.appendChild(ring);
      }
    }
  }

  // fixed radii — the meridian tighter so the rings never read as one ellipse
  private orbitRadius(kind: 'yaw' | 'pitch') {
    return this.scene.sphereRadius + (kind === 'yaw' ? 0.5 : 0.28);
  }

  private ringWorld(kind: 'yaw' | 'pitch', aRad: number, yawRad: number, d: number) {
    return kind === 'yaw'
      ? { x: Math.cos(aRad) * d, y: Math.sin(aRad) * YAW_TILT_S * d, z: Math.sin(aRad) * YAW_TILT_C * d }
      : { x: Math.cos(aRad) * Math.cos(yawRad) * d, y: Math.sin(aRad) * d, z: Math.cos(aRad) * Math.sin(yawRad) * d };
  }

  private pathSplitter(withHit: boolean) {
    const engine = this._engine;
    const w = this.canvas.width, h = this.canvas.height;
    let vis = '', hid = '', hit = '', pv = false, ph = false, pt = false;
    return {
      add: (wx: number, wy: number, wz: number, veto?: (sx: number, sy: number) => boolean) => {
        const p = engine.worldToScreen(wx, wy, wz);
        if (p.z <= 0.5) {
          pv = ph = pt = false;
          return;
        }
        const seg = p.x.toFixed(1) + ' ' + p.y.toFixed(1) + ' ';
        if (withHit) {
          if (p.x >= -24 && p.x <= w + 24 && p.y >= -24 && p.y <= h + 24) {
            hit += (pt ? 'L' : 'M') + seg;
            pt = true;
          } else pt = false;
        }
        if (engine.isPointOccluded(wx, wy, wz)) { hid += (ph ? 'L' : 'M') + seg; ph = true; pv = false; }
        else if (veto?.(p.x, p.y)) { pv = false; ph = false; }
        else { vis += (pv ? 'L' : 'M') + seg; pv = true; ph = false; }
      },
      paths: () => ({ vis, hid, hit }),
    };
  }

  private appendPaths(d: string, styles: ReadonlyArray<readonly [string, string]>) {
    for (const [width, cls] of styles) {
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', d);
      if (width) path.setAttribute('stroke-width', width);
      path.setAttribute('class', cls);
      this.gizmoSvg.appendChild(path);
    }
  }

  private drawOrbit(kind: 'yaw' | 'pitch', i: number) {
    const d = this.orbitRadius(kind);
    const yawRad = this.lights[i].yaw * Math.PI / 180;
    // the dial's front half notches the meridian where they cross on screen
    let maskPts: Array<{ x: number; y: number }> | null = null;
    if (kind === 'pitch') {
      maskPts = [];
      const dm = this.orbitRadius('yaw');
      for (let k = 0; k < 256; k++) {
        const m = this.ringWorld('yaw', (k / 256) * 2 * Math.PI, yawRad, dm);
        if (m.z >= 0 || this._engine.isPointOccluded(m.x, m.y, m.z)) continue;
        const mp = this._engine.worldToScreen(m.x, m.y, m.z);
        if (mp.z > 0.5) maskPts.push({ x: mp.x, y: mp.y });
      }
    }
    const nearOtherRing = (x: number, y: number) => {
      if (!maskPts) return false;
      for (const m of maskPts) {
        if ((m.x - x) * (m.x - x) + (m.y - y) * (m.y - y) < 36) return true; // ~6px
      }
      return false;
    };
    const N = 192; // fine enough that the meridian notch can't slip between samples
    const sp = this.pathSplitter(true);
    for (let k = 0; k <= N; k++) {
      const w = this.ringWorld(kind, (k / N) * 2 * Math.PI, yawRad, d);
      sp.add(w.x, w.y, w.z, w.z < 0 ? nearOtherRing : undefined);
    }
    const { vis, hid, hit: hitD } = sp.paths();
    if (hid) this.appendPaths(hid, [['', 'gizmo-line--hidden']]);
    if (vis) this.appendPaths(vis, [['3', 'shape-path-casing'], ['1.5', 'shape-path']]);
    let tickD = '';
    for (let deg = 0; deg < 360; deg += 10) {
      const aRad = deg * Math.PI / 180;
      const base = this.ringWorld(kind, aRad, yawRad, d);
      if (this._engine.isPointOccluded(base.x, base.y, base.z)) continue;
      const len = deg % 45 === 0 ? 0.13 : 0.055;
      const tip = this.ringWorld(kind, aRad, yawRad, d + len);
      const p0 = this._engine.worldToScreen(base.x, base.y, base.z);
      const p1 = this._engine.worldToScreen(tip.x, tip.y, tip.z);
      if (p0.z <= 0.5 || p1.z <= 0.5) continue;
      if (base.z < 0 && (nearOtherRing(p0.x, p0.y) || nearOtherRing(p1.x, p1.y))) continue;
      tickD += `M${p0.x.toFixed(1)} ${p0.y.toFixed(1)} L${p1.x.toFixed(1)} ${p1.y.toFixed(1)} `;
    }
    if (tickD) {
      const ticks = document.createElementNS(NS, 'path') as SVGPathElement;
      ticks.setAttribute('d', tickD);
      // inline style: the class CSS carries its own stroke-width, which
      // beats the presentation attribute — tracks the theme width at 40%
      ticks.style.strokeWidth = 'calc(var(--rcv-stroke-width, 1.5px) * 0.4)';
      ticks.setAttribute('class', 'shape-path');
      this.gizmoSvg.appendChild(ticks);
    }
    if (hitD) {
      const hit = document.createElementNS(NS, 'path') as SVGPathElement;
      hit.setAttribute('d', hitD);
      hit.setAttribute('class', 'gizmo-orbit-hit');
      hit.setAttribute('pointer-events', 'stroke'); // the svg root is pointer-events: none
      hit.dataset.orbit = kind;
      this.gizmoSvg.appendChild(hit);
    }
  }

  private beginOrbitDrag(e: PointerEvent, orbit: 'yaw' | 'pitch') {
    e.preventDefault();
    const li = this._selectedLight;
    // fixed for the whole drag; the light may flip to planeYaw + 180 on the far half
    const planeYaw = this.lights[li].yaw;
    let aCur = orbit === 'yaw'
      ? this.lights[li].yaw
      : (Math.abs(angDelta(this.lights[li].yaw, planeYaw)) <= 90 ? this.lights[li].pitch : 180 - this.lights[li].pitch);
    const ringPoint = (aDeg: number) => {
      const w = this.ringWorld(orbit, aDeg * Math.PI / 180, planeYaw * Math.PI / 180, this.orbitRadius(orbit));
      return this._engine.worldToScreen(w.x, w.y, w.z);
    };
    // drag model by projected shape: fat ellipse — bearing-tracking around the
    // center; slim / edge-on — linear tangent spin (bearings degenerate there)
    const center = this._engine.worldToScreen(0, 0, 0);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, anyPt = false;
    for (let a = 0; a < 360; a += 15) {
      const sp = ringPoint(a);
      if (sp.z <= 0.5) continue;
      anyPt = true;
      minX = Math.min(minX, sp.x); maxX = Math.max(maxX, sp.x);
      minY = Math.min(minY, sp.y); maxY = Math.max(maxY, sp.y);
    }
    const angular = anyPt && Math.min(maxX - minX, maxY - minY) > 0.35 * Math.max(maxX - minX, maxY - minY);
    const ringAngle = (aDeg: number) => {
      const sp = ringPoint(aDeg);
      return Math.atan2(sp.y - center.y, sp.x - center.x) * 180 / Math.PI;
    };
    let spinX = 1, spinY = 0;
    {
      for (const probe of [0, 30, 90]) {
        const a0 = ringPoint(aCur + probe - 2), a1 = ringPoint(aCur + probe + 2);
        if (a0.z <= 0.5 || a1.z <= 0.5) continue;
        const tx = a1.x - a0.x, ty = a1.y - a0.y;
        const tl = Math.hypot(tx, ty);
        if (tl > 2) { spinX = tx / tl; spinY = ty / tl; break; }
      }
    }
    let ringR = 1;
    for (const a of [0, 45, 90, 135]) {
      const p0 = ringPoint(a), p1 = ringPoint(a + 180);
      if (p0.z > 0.5 && p1.z > 0.5) ringR = Math.max(ringR, Math.hypot(p1.x - p0.x, p1.y - p0.y) / 2);
    }
    const rate = 90 / ringR;
    let prev = this.eventToCanvasPixels(e.clientX, e.clientY, false);
    // relative in both modes: grabbing never snaps the light to the grab point
    let thetaPrev = Math.atan2(prev.y - center.y, prev.x - center.x) * 180 / Math.PI;
    let targetBearing: number | null = null;
    const move = (ev: PointerEvent) => {
      const p = this.eventToCanvasPixels(ev.clientX, ev.clientY, false);
      if (angular) {
        if (Math.hypot(p.x - center.x, p.y - center.y) < 24) return; // unstable near center
        const theta = Math.atan2(p.y - center.y, p.x - center.x) * 180 / Math.PI;
        if (targetBearing === null) targetBearing = ringAngle(aCur);
        targetBearing += angDelta(theta, thetaPrev);
        thetaPrev = theta;
        let bestA = aCur, bestErr = Infinity;
        for (let off = -90; off <= 90; off += 1) {
          const a = aCur + off;
          const sp = ringPoint(a);
          if (sp.z <= 0.5) continue;
          const err = Math.abs(angDelta(ringAngle(a), targetBearing));
          if (err < bestErr) { bestErr = err; bestA = a; }
        }
        aCur = bestA;
      } else {
        aCur += ((p.x - prev.x) * spinX + (p.y - prev.y) * spinY) * rate;
      }
      prev = p;
      const l = this.lights[li];
      if (orbit === 'yaw') {
        l.yaw = Math.round(angDelta(aCur, 0));
      } else {
        // past a pole the light continues on the far half of the same plane
        const pitch = Math.asin(Math.sin(aCur * Math.PI / 180)) * 180 / Math.PI;
        l.yaw = Math.round(angDelta(Math.cos(aCur * Math.PI / 180) >= 0 ? planeYaw : planeYaw + 180, 0));
        l.pitch = Math.round(Math.max(-89, Math.min(89, pitch)));
      }
      this.onInput?.('light');
      this.update();
    };
    this.trackDrag(move, 'light');
  }

  private beadWorld(i: number) {
    const lx = this.lightPositions[i * 3], ly = this.lightPositions[i * 3 + 1], lz = this.lightPositions[i * 3 + 2];
    const llen = Math.sqrt(lx * lx + ly * ly + lz * lz) || 1;
    const s = (BEAD_F * this.scene.sphereRadius + (1 - BEAD_F) * this.lights[i].dist) / llen;
    return { x: lx * s, y: ly * s, z: lz * s };
  }

  private beginGripDrag(e: PointerEvent, kind: 'intensity' | 'dist') {
    if (this._selectedLight < 0) return;
    e.preventDefault();
    e.stopPropagation();
    const li = this._selectedLight;

    let distDrag: { uOf: (x: number, y: number) => number; solve: (u: number) => number; uOffset: number } | null = null;
    if (kind === 'dist') {
      const lx = this.lightPositions[li * 3], ly = this.lightPositions[li * 3 + 1], lz = this.lightPositions[li * 3 + 2];
      const llen = Math.sqrt(lx * lx + ly * ly + lz * lz) || 1;
      const dx = lx / llen, dy = ly / llen, dz = lz / llen;
      const proj = (d: number) => {
        const s = BEAD_F * this.scene.sphereRadius + (1 - BEAD_F) * d;
        return this._engine.worldToScreen(dx * s, dy * s, dz * s);
      };
      // cap so no search sample projects from behind the camera
      let hiCap = MAX_LIGHT_DISTANCE;
      if (dz < 0) {
        const sLim = (this.scene.cameraZ + 0.75) / dz;
        const dLim = (sLim - BEAD_F * this.scene.sphereRadius) / (1 - BEAD_F);
        hiCap = Math.max(this.scene.sphereRadius, Math.min(hiCap, dLim));
      }
      const A = proj(this.scene.sphereRadius);
      const B = proj(hiCap);
      const abx = B.x - A.x, aby = B.y - A.y;
      const ab2 = Math.max(abx * abx + aby * aby, 1);
      const abLen = Math.sqrt(ab2);
      const uOf = (x: number, y: number) =>
        Math.max(0, Math.min(1, ((x - A.x) * abx + (y - A.y) * aby) / ab2));
      // the bead's screen path is a line, monotone in dist
      const solve = (u: number) => {
        const target = u * abLen;
        let lo = this.scene.sphereRadius, hi = hiCap;
        for (let k = 0; k < 24; k++) {
          const mid = (lo + hi) / 2;
          const P = proj(mid);
          if (Math.hypot(P.x - A.x, P.y - A.y) < target) lo = mid;
          else hi = mid;
        }
        return (lo + hi) / 2;
      };
      const p0 = this.eventToCanvasPixels(e.clientX, e.clientY, false);
      const b = this.beadWorld(li);
      const bp = this._engine.worldToScreen(b.x, b.y, b.z);
      distDrag = { uOf, solve, uOffset: uOf(bp.x, bp.y) - uOf(p0.x, p0.y) };
    }

    const move = (ev: PointerEvent) => {
      const p = this.eventToCanvasPixels(ev.clientX, ev.clientY, false);
      const l = this.lights[li];
      if (kind === 'intensity') {
        const sp = this._engine.worldToScreen(this.lightPositions[li * 3], this.lightPositions[li * 3 + 1], this.lightPositions[li * 3 + 2]);
        // measure from the same anchor the ring is drawn around (edge-clamped
        // when the light is off-canvas)
        const a = this.clampToCanvasAlongLine(sp.x, sp.y);
        const r = Math.hypot(p.x - a.x, p.y - a.y);
        const x = Math.max(0, Math.min(INT_MAX / (INT_MAX + 1), (r - INT_R0) / INT_R1));
        l.intensity = Math.round((x / (1 - x)) * 100) / 100;
      } else if (distDrag) {
        const u = Math.max(0, Math.min(1, distDrag.uOf(p.x, p.y) + distDrag.uOffset));
        l.dist = Math.round(distDrag.solve(u) * 100) / 100;
      }
      this.onInput?.(kind === 'intensity' ? 'light-intensity' : 'light-dist');
      this.update();
    };
    this.trackDrag(move, kind === 'intensity' ? 'light-intensity' : 'light-dist');
  }

  // ---------------------------------------------------------------- samples (points mode)

  private updateSampleMarker(sample: Sample) {
    const r = this.scene.sphereRadius;
    const screenPos = this._engine.worldToScreen(sample.dir[0] * r, sample.dir[1] * r, sample.dir[2] * r);
    // Keep offscreen samples visible (and grabbable) at the canvas edge,
    // clamped along their line to center — same treatment as light markers
    const { x: cx, y: cy } = this.clampToCanvasAlongLine(screenPos.x, screenPos.y);
    sample.marker.style.left = `${(cx / this.canvas.width) * 100}%`;
    sample.marker.style.top = `${(cy / this.canvas.height) * 100}%`;
    sample.marker.classList.toggle('marker--offscreen', cx !== screenPos.x || cy !== screenPos.y);
    const facing = r - sample.dir[2] * this.scene.cameraZ;
    sample.marker.classList.toggle('marker--behind', facing >= 0);
  }

  private samplesCentroid(out = new Float64Array(3)): Float64Array | null {
    let x = 0, y = 0, z = 0;
    for (const s of this.samples) { x += s.dir[0]; y += s.dir[1]; z += s.dir[2]; }
    const l = Math.hypot(x, y, z);
    if (l < 1e-6) return null; // balanced constellation: no centroid, no widget
    out[0] = x / l; out[1] = y / l; out[2] = z / l;
    return out;
  }

  private updateSamplesRotWidget() {
    const c = this._mode === 'points' && this.samples.length > 1 ? this.samplesCentroid() : null;
    this.samplesRotWidget.toggleAttribute('hidden', !c);
    if (!c) return;
    const r = this.scene.sphereRadius;
    const p = this._engine.worldToScreen(c[0] * r, c[1] * r, c[2] * r);
    const { x: cx, y: cy } = this.clampToCanvasAlongLine(p.x, p.y);
    this.samplesRotWidget.style.left = `${(cx / this.canvas.width) * 100}%`;
    this.samplesRotWidget.style.top = `${(cy / this.canvas.height) * 100}%`;
    this.samplesRotWidget.style.setProperty('--spin', `${this.samplesRotSpin}deg`);
    this.samplesRotWidget.classList.toggle('marker--behind', r - c[2] * this.scene.cameraZ >= 0);
  }

  private beginSamplesRotDrag(e: PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    const c = this.samplesCentroid();
    if (!c) return;
    const u = new Float64Array(3), v = new Float64Array(3);
    circleBasis(c, u, v);
    const bearingAt = (clientX: number, clientY: number) => {
      const q = this.eventToCanvasPixels(clientX, clientY);
      const h = this._engine.castRay(q.x, q.y);
      if (!h) return null;
      const tu = u[0] * h.nx + u[1] * h.ny + u[2] * h.nz;
      const tv = v[0] * h.nx + v[1] * h.ny + v[2] * h.nz;
      return Math.hypot(tu, tv) > 1e-6 ? Math.atan2(tv, tu) : null;
    };
    // incremental, so grabbing the ring anywhere never jumps
    let last = bearingAt(e.clientX, e.clientY);
    const move = (ev: PointerEvent) => {
      const bearing = bearingAt(ev.clientX, ev.clientY);
      if (bearing === null) return;
      if (last !== null) {
        const deg = (bearing - last) * 180 / Math.PI;
        rotateDirs(this.samples.map(s => s.dir), deg, c);
        this.samplesRotSpin += deg;
        this.samples.forEach(sample => {
          const color = this._engine.shade(sample.dir);
          sample.color[0] = color.r;
          sample.color[1] = color.g;
          sample.color[2] = color.b;
          this.updateSampleMarker(sample);
        });
        this.updateSamplesRotWidget();
        this.onInput?.('samples-rotate');
        this.emitPalette();
      }
      last = bearing;
    };
    this.trackDrag(move, 'samples-rotate');
  }

  private createSampleAt(dir: Float64Array, select = true) {
    const color = this._engine.shade(dir);
    const marker = document.createElement('div');
    marker.className = 'marker sample-marker';
    const sample: Sample = { dir, color: new Float64Array([color.r, color.g, color.b]), marker };
    marker.addEventListener('pointerdown', e => this.beginSampleDrag(e, sample));
    this.sampleLayer.appendChild(marker);
    this.updateSampleMarker(sample);
    this.samples.push(sample);
    if (select) {
      this.selectSample(sample); // a fresh sample is the active one — backspace removes it
      this.updateSamplesRotWidget();
      this.emitPalette();
    }
  }

  private beginSampleDrag(event: PointerEvent, sample: Sample) {
    event.preventDefault();
    event.stopPropagation();
    if (this._selectedLight >= 0) this.selectLight(-1);
    this.selectSample(sample);
    this.beginSurfaceDrag(event, sample.dir, () => {
      const color = this._engine.shade(sample.dir);
      sample.color[0] = color.r;
      sample.color[1] = color.g;
      sample.color[2] = color.b;
      this.updateSampleMarker(sample);
      this.updateSamplesRotWidget();
      this.onInput?.('sample');
      this.emitPalette();
    }, 'sample');
  }

  private selectSample(sample: Sample | null) {
    this.selectedSample = sample;
    this.samples.forEach(s => s.marker.classList.toggle('marker--selected', s === this.selectedSample));
    this.onSampleSelect?.(sample ? this.samples.indexOf(sample) : null);
  }

  /** Public: clear the sample selection (Escape). */
  clearSampleSelection() {
    this.selectSample(null);
  }

  /** Public: select a loose sample by index (palette row click). */
  selectSampleAt(i: number) {
    this.selectSample(this.samples[i] ?? null);
  }

  private deleteSelectedSample() {
    if (!this.selectedSample) return;
    if (this.samples.length <= 1) return; // one point is the minimum
    this.selectedSample.marker.remove();
    this.samples = this.samples.filter(s => s !== this.selectedSample);
    this.selectedSample = null;
    this.updateSamplesRotWidget();
    this.emitPalette();
    this.onChange?.('sample');
  }

  // ---------------------------------------------------------------- shape sampling

  shapeSampleDirs(): Float64Array[] {
    if (!this._shape) return [];
    // circles always sample evenly (the API still accepts any Distribution)
    return this._shape.kind === 'line'
      ? sampleLineDirs(this._shape.a, this._shape.b, this._count, distributions[this._spacing])
      : sampleCircleDirs(this._shape.a, this._shape.rho, this._count, { rotate: this._shape.rotate });
  }

  private recomputeShapeColors() {
    this.shapeColors = this.shapeSampleDirs().map(dir => {
      const c = this._engine.shade(dir);
      return new Float64Array([c.r, c.g, c.b]);
    });
  }

  // Little satellite point beside the line's midpoint, held off the geodesic so
  // it never collides with a sample dot — dragging it swings the line around
  private lineRotGripDir(out = new Float64Array(3)) {
    const shape = this._shape!;
    const m = slerp(shape.a, shape.b, 0.5);
    let tx = shape.b[0] - shape.a[0];
    let ty = shape.b[1] - shape.a[1];
    let tz = shape.b[2] - shape.a[2];
    const tl = Math.hypot(tx, ty, tz);
    let px: number, py: number, pz: number;
    if (tl < 1e-6) {
      // zero-length line: any stable side works
      const u = new Float64Array(3), v = new Float64Array(3);
      circleBasis(m, u, v);
      px = u[0]; py = u[1]; pz = u[2];
    } else {
      // (b - a) is tangent at the midpoint, so m × t is the unit perpendicular
      tx /= tl; ty /= tl; tz /= tl;
      px = m[1] * tz - m[2] * ty;
      py = m[2] * tx - m[0] * tz;
      pz = m[0] * ty - m[1] * tx;
    }
    const ROT_GRIP_ARC = 0.13;
    const c = Math.cos(ROT_GRIP_ARC), s = Math.sin(ROT_GRIP_ARC);
    out[0] = c * m[0] + s * px;
    out[1] = c * m[1] + s * py;
    out[2] = c * m[2] + s * pz;
    return out;
  }

  private makeShapeHandle(role: HandleRole, title: string) {
    const h = document.createElement('div');
    h.className = 'marker shape-handle';
    h.dataset.handle = role;
    h.title = title;
    this.shapeHandles.appendChild(h);
    return h;
  }

  private updateShapeOverlay() {
    this.shapeSvg.setAttribute('viewBox', `0 0 ${this.canvas.width} ${this.canvas.height}`);
    this.shapeSvg.innerHTML = '';
    this.shapeHandles.innerHTML = '';
    const active = this._mode !== 'points';
    this.shapeSvg.toggleAttribute('hidden', !active);
    this.shapeHandles.toggleAttribute('hidden', !active);
    if (!active || !this._shape) return;
    const shape = this._shape;

    // Dense polyline along the shape, split into front / behind portions
    const steps = shape.kind === 'line' ? 40 : 72;
    const pt = new Float64Array(3);
    let frontD = '', backD = '', pf = false, pb = false;
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      if (shape.kind === 'line') slerp(shape.a, shape.b, t, pt);
      else circleDir(shape.a, shape.rho, t * 2 * Math.PI, pt);
      const p = this.projectDirPct(pt);
      const seg = p.sx.toFixed(1) + ' ' + p.sy.toFixed(1) + ' ';
      if (!this.dirIsBehind(pt)) { frontD += (pf ? 'L' : 'M') + seg; pf = true; pb = false; }
      else { backD += (pb ? 'L' : 'M') + seg; pb = true; pf = false; }
    }
    const dirs = this.shapeSampleDirs();
    const projected = dirs.map(d => ({ p: this.projectDirPct(d), behind: this.dirIsBehind(d) ? ' shape-dot--back' : '' }));

    // dark casing rings go UNDER the path strokes: the line runs over them,
    // and the colored dots (with their white rings) sit on top of the line
    projected.forEach(({ p, behind }) => {
      const casing = document.createElementNS(NS, 'circle');
      casing.setAttribute('cx', p.sx.toFixed(1));
      casing.setAttribute('cy', p.sy.toFixed(1));
      casing.setAttribute('r', '3');
      casing.setAttribute('class', `shape-dot-casing${behind}`);
      this.shapeSvg.appendChild(casing);
    });

    if (backD) {
      const back = document.createElementNS(NS, 'path');
      back.setAttribute('d', backD);
      back.setAttribute('class', 'shape-path shape-path--back');
      this.shapeSvg.appendChild(back);
    }
    if (frontD) {
      for (const cls of ['shape-path-casing', 'shape-path']) {
        const el = document.createElementNS(NS, 'path');
        el.setAttribute('d', frontD);
        el.setAttribute('class', cls);
        this.shapeSvg.appendChild(el);
      }
    }

    projected.forEach(({ p, behind }, k) => {
      const dot = document.createElementNS(NS, 'circle');
      dot.setAttribute('cx', p.sx.toFixed(1));
      dot.setAttribute('cy', p.sy.toFixed(1));
      dot.setAttribute('r', '3');
      const col = this.shapeColors[k];
      if (col) dot.setAttribute('fill', `rgb(${toSRGB8(col[0])}, ${toSRGB8(col[1])}, ${toSRGB8(col[2])})`);
      dot.setAttribute('class', `shape-dot${behind}`);
      this.shapeSvg.appendChild(dot);
    });

    if (shape.kind === 'line') {
      for (const [role, dir, title] of [['a', shape.a, 'Line start'], ['b', shape.b, 'Line end']] as const) {
        const h = this.makeShapeHandle(role, `${title} — drag to move`);
        const p = this.projectDirPct(dir);
        h.style.left = `${p.x}%`;
        h.style.top = `${p.y}%`;
        h.classList.toggle('shape-handle--behind', this.dirIsBehind(dir));
      }
      const rot = this.makeShapeHandle('rot', 'Drag around the middle to rotate the line');
      this.lineRotGripDir(pt);
      const pr = this.projectDirPct(pt);
      rot.style.left = `${pr.x}%`;
      rot.style.top = `${pr.y}%`;
      rot.classList.add('shape-handle--grip', 'shape-handle--rot');
      rot.classList.toggle('shape-handle--behind', this.dirIsBehind(pt));
    } else {
      const center = this.makeShapeHandle('a', 'Circle center — drag to move');
      const pc = this.projectDirPct(shape.a);
      center.style.left = `${pc.x}%`;
      center.style.top = `${pc.y}%`;
      center.classList.toggle('shape-handle--behind', this.dirIsBehind(shape.a));
      const grip = this.makeShapeHandle('r', 'Drag out to resize — around the ring to rotate the palette');
      circleDir(shape.a, shape.rho, shape.rotate * Math.PI / 180, pt);
      const pg = this.projectDirPct(pt);
      grip.style.left = `${pg.x}%`;
      grip.style.top = `${pg.y}%`;
      grip.classList.add('shape-handle--grip');
      grip.classList.toggle('shape-handle--behind', this.dirIsBehind(pt));
      // Rotation satellite beside the center, like the line's — opposite the
      // radius grip's bearing so they never crowd each other. It steps aside
      // (disappears) once the ring closes in on the center.
      if (shape.rho > CROT_MIN_RHO) {
        const rot = this.makeShapeHandle('crot', 'Drag around the center to rotate the palette');
        circleDir(shape.a, CROT_ARC, shape.rotate * Math.PI / 180 + Math.PI, pt);
        const pr = this.projectDirPct(pt);
        rot.style.left = `${pr.x}%`;
        rot.style.top = `${pr.y}%`;
        rot.classList.add('shape-handle--grip', 'shape-handle--rot');
        rot.classList.toggle('shape-handle--behind', this.dirIsBehind(pt));
      }
    }
  }

  // Trackball drag for a point anchored to the sphere's surface — same feel as
  // the lights: relative to where it was (pressing never jumps), and the back
  // hemisphere is reached by continuing past the silhouette, where horizontal
  // motion inverts like the far side of a spinning globe.
  private beginSurfaceDrag(e: PointerEvent, dir: Float64Array, onMove: () => void, kind: InputKind) {
    // unclamped: the rotation must keep going when the cursor leaves the canvas
    const start = this.eventToCanvasPixels(e.clientX, e.clientY, false);
    const yaw0 = Math.atan2(dir[0], -dir[2]) * 180 / Math.PI;
    const pitch0 = Math.asin(clampDot(dir[1])) * 180 / Math.PI;
    // one silhouette-radius of pointer travel = 90° of rotation
    const silR = Math.max(1, this._engine.worldToScreen(this.scene.sphereRadius, 0, 0).x - this.canvas.width / 2);
    const move = (ev: PointerEvent) => {
      const q = this.eventToCanvasPixels(ev.clientX, ev.clientY, false);
      const dxu = (q.x - start.x) / silR;
      const dyu = (start.y - q.y) / silR;
      let yaw = yaw0 + dxu * SURFACE_DEG_PER_RADIUS;
      // Pitch keeps going over the poles: crossing one flips yaw to the far side
      let pitch = wrap180(pitch0 + dyu * SURFACE_DEG_PER_RADIUS);
      if (pitch > 90) {
        pitch = 180 - pitch;
        yaw += 180;
      } else if (pitch < -90) {
        pitch = -180 - pitch;
        yaw += 180;
      }
      const yr = wrap180(yaw) * Math.PI / 180;
      const pr = pitch * Math.PI / 180;
      const cp = Math.cos(pr);
      dir[0] = Math.sin(yr) * cp;
      dir[1] = Math.sin(pr);
      dir[2] = -Math.cos(yr) * cp;
      onMove();
    };
    this.trackDrag(move, kind);
  }

  private beginHandleDrag(e: PointerEvent, role: HandleRole) {
    if (!this._shape) return;
    const shape = this._shape;
    const refresh = () => {
      this.recomputeShapeColors();
      this.updateShapeOverlay();
      this.onInput?.('shape');
      this.emitPalette();
    };
    if (role === 'a' || role === 'b') {
      // center / endpoints ride the trackball so they can cross to the back
      const target = role === 'a' ? shape.a : shape.b;
      this.beginSurfaceDrag(e, target, refresh, 'shape');
      return;
    }
    // bearing of a surface hit in the tangent plane spanned by (u, v)
    const bearingOf = (u: Float64Array, v: Float64Array, nx: number, ny: number, nz: number) => {
      const tu = u[0] * nx + u[1] * ny + u[2] * nz;
      const tv = v[0] * nx + v[1] * ny + v[2] * nz;
      // dead-center the bearing is undefined
      return Math.hypot(tu, tv) > 1e-6 ? Math.atan2(tv, tu) : null;
    };
    if (role === 'crot') {
      // circle rotation satellite: the pointer's bearing around the center
      // sets the palette rotation — the satellite rides at bearing + 180°,
      // so absolute tracking grabs without a jump
      const cu = new Float64Array(3), cv = new Float64Array(3);
      circleBasis(shape.a, cu, cv);
      const move = (ev: PointerEvent) => {
        const q = this.eventToCanvasPixels(ev.clientX, ev.clientY);
        const h = this._engine.castRay(q.x, q.y);
        if (!h || !this._shape) return;
        const bearing = bearingOf(cu, cv, h.nx, h.ny, h.nz);
        if (bearing === null) return;
        shape.rotate = bearing * 180 / Math.PI - 180;
        refresh();
      };
      this.trackDrag(move, 'shape');
      return;
    }
    if (role === 'rot') {
      // spin grip: swing the line about its midpoint — endpoints follow the
      // pointer's bearing around the center, incrementally so grabbing never jumps
      const m = slerp(shape.a, shape.b, 0.5);
      const mu = new Float64Array(3), mv = new Float64Array(3);
      circleBasis(m, mu, mv);
      const p0 = this.eventToCanvasPixels(e.clientX, e.clientY);
      const h0 = this._engine.castRay(p0.x, p0.y);
      let last = h0 ? bearingOf(mu, mv, h0.nx, h0.ny, h0.nz) : null;
      const move = (ev: PointerEvent) => {
        const q = this.eventToCanvasPixels(ev.clientX, ev.clientY);
        const h = this._engine.castRay(q.x, q.y);
        if (!h || !this._shape) return;
        const bearing = bearingOf(mu, mv, h.nx, h.ny, h.nz);
        if (bearing === null) return;
        if (last !== null) {
          rotateDirs([shape.a, shape.b], (bearing - last) * 180 / Math.PI, m);
          refresh();
        }
        last = bearing;
      };
      this.trackDrag(move, 'shape');
      return;
    }
    // radius grip: absolute — rho is the angle between center and the point under
    // the pointer, rotate its bearing in the circle plane (the grip rides the
    // ring, carrying the sample points around with it)
    const gu = new Float64Array(3), gv = new Float64Array(3);
    circleBasis(shape.a, gu, gv);
    const move = (ev: PointerEvent) => {
      const q = this.eventToCanvasPixels(ev.clientX, ev.clientY);
      const h = this._engine.castRay(q.x, q.y);
      if (!h || !this._shape) return;
      shape.rho = Math.acos(clampDot(shape.a[0] * h.nx + shape.a[1] * h.ny + shape.a[2] * h.nz));
      const bearing = bearingOf(gu, gv, h.nx, h.ny, h.nz);
      // dead-center: hold the current rotation
      if (bearing !== null) shape.rotate = bearing * 180 / Math.PI;
      refresh();
    };
    this.trackDrag(move, 'shape');
  }

  // Current handle positions in canvas pixels, for forgiving grabbing
  private shapeHandlePoints(): Array<{ role: HandleRole; sx: number; sy: number }> {
    if (!this._shape) return [];
    const shape = this._shape;
    const pts: Array<{ role: HandleRole; sx: number; sy: number }> = [];
    const pa = this.projectDirPct(shape.a);
    pts.push({ role: 'a', sx: pa.sx, sy: pa.sy });
    if (shape.kind === 'line') {
      const pb = this.projectDirPct(shape.b);
      pts.push({ role: 'b', sx: pb.sx, sy: pb.sy });
      const pr = this.projectDirPct(this.lineRotGripDir());
      pts.push({ role: 'rot', sx: pr.sx, sy: pr.sy });
    } else {
      const pg = this.projectDirPct(circleDir(shape.a, shape.rho, shape.rotate * Math.PI / 180));
      pts.push({ role: 'r', sx: pg.sx, sy: pg.sy });
      if (shape.rho > CROT_MIN_RHO) {
        const pr = this.projectDirPct(circleDir(shape.a, CROT_ARC, shape.rotate * Math.PI / 180 + Math.PI));
        pts.push({ role: 'crot', sx: pr.sx, sy: pr.sy });
      }
    }
    return pts;
  }

  private deleteShape() {
    this._shape = null;
    this.shapeColors = [];
    this.updateShapeOverlay();
    this.emitPalette();
    this.onChange?.('shape');
  }

  // ---------------------------------------------------------------- mode + defaults

  private normalize3(x: number, y: number, z: number) {
    const l = Math.sqrt(x * x + y * y + z * z) || 1;
    return new Float64Array([x / l, y / l, z / l]);
  }

  // Every mode starts populated, so switching always shows something to edit
  private ensureModeDefaults() {
    if (this._mode === 'points') {
      if (this.samples.length === 0) this.createSampleAt(new Float64Array([0, 0, -1]));
    } else if (this._mode === 'circle') {
      if (!this._shape || this._shape.kind !== 'circle') {
        const center = new Float64Array([0, 0, -1]); // facing the camera
        this._shape = { kind: 'circle', a: center, b: new Float64Array(center), rho: Math.asin(0.8), rotate: 0 };
      }
    } else if (this._mode === 'line') {
      if (!this._shape || this._shape.kind !== 'line') {
        this._shape = {
          kind: 'line',
          a: this.normalize3(-0.6, 0.35, -0.75),
          b: this.normalize3(0.6, -0.35, -0.75),
          rho: 0,
          rotate: 0,
        };
      }
    }
  }

  private setMode(next: SampleMode) {
    this._mode = next;
    this.sampleLayer.toggleAttribute('hidden', next !== 'points');
    this.ensureModeDefaults();
    this.refreshShape();
  }

  private refreshShape() {
    this.recomputeShapeColors();
    this.updateShapeOverlay();
    this.updateSamplesRotWidget();
    this.samples.forEach(s => this.updateSampleMarker(s));
    this.emitPalette();
  }

  private applyControlsClass() {
    this.viewport.classList.toggle('no-controls', !this._controls);
  }

  // ---------------------------------------------------------------- interactions

  private attachInteractions() {
    // Drawing: in a shape mode, dragging on the sphere replaces the shape —
    // unless the press lands near an existing handle, which edits it instead
    this.canvas.addEventListener('pointerdown', e => {
      if (!this._controls || this._mode === 'points') return;
      if (this._selectedLight >= 0) this.selectLight(-1);
      const p = this.eventToCanvasPixels(e.clientX, e.clientY);
      const GRAB_RADIUS = 14; // canvas px — forgiving, so grabs never redraw by accident
      for (const h of this.shapeHandlePoints()) {
        if (Math.hypot(p.x - h.sx, p.y - h.sy) < GRAB_RADIUS) {
          e.preventDefault();
          this.beginHandleDrag(e, h.role);
          return;
        }
      }
      const hit = this._engine.castRay(p.x, p.y);
      if (!hit) return;
      e.preventDefault();
      const start = new Float64Array([hit.nx, hit.ny, hit.nz]);
      // a bare click (no drag) still yields a visible, sampleable shape —
      // a circle of min radius, or a short eastward arc; dragging or the
      // handles can take both anywhere afterwards
      const MIN_ARC = 0.35;
      const lineEnd = new Float64Array(start);
      if (this._mode === 'line') {
        const cA = Math.cos(MIN_ARC), sA = Math.sin(MIN_ARC);
        lineEnd[0] = start[0] * cA + start[2] * sA;
        lineEnd[2] = -start[0] * sA + start[2] * cA;
      }
      this._shape = this._mode === 'line'
        ? { kind: 'line', a: start, b: lineEnd, rho: 0, rotate: 0 }
        : { kind: 'circle', a: start, b: lineEnd, rho: MIN_ARC, rotate: 0 };
      let dragging = false;
      const move = (ev: PointerEvent) => {
        const q = this.eventToCanvasPixels(ev.clientX, ev.clientY);
        // a couple of pixels of press jiggle is still a click — the initial
        // shape only starts following the cursor after real movement
        if (!dragging && Math.hypot(q.x - p.x, q.y - p.y) < 5) return;
        dragging = true;
        const h2 = this._engine.castRay(q.x, q.y);
        if (h2 && this._shape) {
          if (this._shape.kind === 'line') {
            this._shape.b[0] = h2.nx; this._shape.b[1] = h2.ny; this._shape.b[2] = h2.nz;
          } else {
            this._shape.rho = Math.acos(clampDot(this._shape.a[0] * h2.nx + this._shape.a[1] * h2.ny + this._shape.a[2] * h2.nz));
          }
          this.recomputeShapeColors();
          this.updateShapeOverlay();
          this.onInput?.('shape');
          this.emitPalette();
        }
      };
      this.trackDrag(move, 'shape');
      this.recomputeShapeColors();
      this.updateShapeOverlay();
      this.emitPalette();
    });

    this.shapeHandles.addEventListener('pointerdown', e => {
      if (!this._controls) return;
      const el = (e.target as HTMLElement).closest('.shape-handle') as HTMLElement | null;
      if (!el || !this._shape) return;
      e.preventDefault();
      e.stopPropagation();
      if (this._selectedLight >= 0) this.selectLight(-1);
      this.beginHandleDrag(e, el.dataset.handle as HandleRole);
    });

    this.canvas.addEventListener('click', event => {
      if (!this._controls) return;
      if (this._selectedLight >= 0) {
        this.selectLight(-1);
        return; // first click just dismisses the light gizmos
      }
      if (this._mode !== 'points') return; // shape modes sample by dragging
      const { x, y } = this.eventToCanvasPixels(event.clientX, event.clientY);
      const hit = this._engine.castRay(x, y);
      if (!hit) return;
      this.createSampleAt(new Float64Array([hit.nx, hit.ny, hit.nz]));
      this.onChange?.('sample');
    });

    this.lightLayer.addEventListener('pointerdown', e => {
      if (!this._controls) return;
      const gripEl = (e.target as HTMLElement).closest('[data-grip]') as HTMLElement | null;
      if (gripEl) {
        this.beginGripDrag(e, gripEl.dataset.grip as 'intensity' | 'dist');
        return;
      }
      const markerEl = (e.target as HTMLElement).closest('.light-marker') as HTMLElement | null;
      if (!markerEl || markerEl.dataset.light === undefined) return;
      e.preventDefault();
      const li = parseInt(markerEl.dataset.light, 10);
      this.selectLight(li);
      const len = Math.hypot(this.lightPositions[li * 3], this.lightPositions[li * 3 + 1], this.lightPositions[li * 3 + 2]) || 1;
      const dir = new Float64Array([
        this.lightPositions[li * 3] / len,
        this.lightPositions[li * 3 + 1] / len,
        this.lightPositions[li * 3 + 2] / len,
      ]);
      this.beginSurfaceDrag(e, dir, () => {
        const l = this.lights[li];
        const a = positionToAngles(dir[0], dir[1], dir[2]);
        l.yaw = Math.round(a.yaw);
        l.pitch = Math.round(Math.max(-89, Math.min(89, a.pitch)));
        this.onInput?.('light');
        this.update();
      }, 'light');
    });

    // NOTE: no camera wheel here — scroll policy belongs to the embedding
    // page. The one wheel the component claims: while a light is selected,
    // scrolling anywhere over the viewport slides that light's distance —
    // far easier than hitting the small marker with the cursor. With nothing
    // selected the wheel falls through untouched.
    this.viewport.addEventListener('wheel', e => {
      if (!this._controls || this._selectedLight < 0) return;
      e.preventDefault();
      e.stopPropagation();
      const l = this.lights[this._selectedLight];
      if (l.type === 'directional') {
        // distance means nothing for a directional light (parallel rays) —
        // scroll drives its intensity instead, so every type has a wheel
        l.intensity = Math.round(Math.max(0, Math.min(INT_MAX, l.intensity + (e.deltaY > 0 ? -0.05 : 0.05))) * 100) / 100;
        this.onInput?.('light-intensity');
      } else {
        l.dist = Math.min(MAX_LIGHT_DISTANCE, Math.max(this.scene.sphereRadius, l.dist + (e.deltaY > 0 ? 0.15 : -0.15)));
        this.onInput?.('light-dist');
      }
      this.update();
    }, { passive: false });

    this.gizmoSvg.addEventListener('pointerdown', e => {
      if (!this._controls) return;
      const orbit = (e.target as SVGElement).dataset?.orbit as 'yaw' | 'pitch' | undefined;
      if (!orbit || this._selectedLight < 0) return;
      this.beginOrbitDrag(e, orbit);
    });
  }

  /** Shared drag plumbing: window-level move/up, change emitted on release. */
  private trackDrag(move: (ev: PointerEvent) => void, kind: InputKind) {
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.onChange?.(kind);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  private emitPalette() {
    this.onPalette?.();
  }
}

function intensityRingRadius(intensity: number) {
  return INT_R0 + INT_R1 * (intensity / (intensity + 1));
}
