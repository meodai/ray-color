// Ray Color playground — direct-manipulation demo for the ray-color engine.
// State lives here; the engine renders it and answers all scene questions.

import { SourceSession, createCollection } from 'token-beam';
import { SoundManager } from './sound';
import {
  createEngine,
  toSRGB8,
  srgbToLinear,
  MAX_LIGHT_DISTANCE,
  DEFAULT_PASS_SCALES,
  slerp,
  circleDir,
  circleBasis,
  rotateAboutAxis,
  rotateDirs,
  sampleLineDirs,
  sampleCircleDirs,
  distributions,
  positionToAngles,
  type Light,
  type Scene,
} from './engine';
import { createGlPreview, type GlPreview } from './gl-preview';
import { PRESETS } from './presets';

const sound = new SoundManager();
window.addEventListener('pointerdown', () => sound.unlock(), { capture: true });
window.addEventListener('keydown', () => sound.unlock(), { capture: true });

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d');
if (!ctx) throw new Error('Canvas 2D context unavailable');
// Backing store matches the displayed CSS size (1 rendered pixel = 1 CSS px),
// so the render isn't upscaled. Kept in sync on resize below.
const displaySize = () => Math.max(64, Math.round(canvas.clientWidth)) || 400;
canvas.width = canvas.height = displaySize();
let imageData = ctx.createImageData(canvas.width, canvas.height);

// ---------------------------------------------------------------- state

// Defaults tuned by hand in the app itself (from a [ray-color settings] log)
const state: Scene = {
  cameraZ: -9,
  fov: 30,
  sphereRadius: 1.2,
  sphereHex: '#ffffff',
  wallHex: '#999999',
  indirect: 0.3,
  areaQuality: 6,
  wallReflect: { back: 0, left: 0, right: 0, top: 0, bottom: 0 },
};

const lights: Light[] = [
  { type: 'directional', yaw: -150, pitch: 48, dist: 2, hex: '#ff0000', intensity: 0.95, angle: 30, size: 0.15 },
  { type: 'directional', yaw: -125, pitch: -40, dist: 2, hex: '#fff700', intensity: 0.3, angle: 30, size: 0.4 },
  { type: 'directional', yaw: -39, pitch: -35, dist: 2, hex: '#00ffb3', intensity: 0.2, angle: 30, size: 0.15 },
];

let engine = createEngine(canvas.width, canvas.height, state, lights);
let lightPositions = engine.lightPositions;

// WebGL2 preview: instant f32 frames while interacting; the f64 CPU render
// (the one palettes sample from, bit-for-bit) lands once interaction settles.
// Null on machines without WebGL2 — everything falls back to CPU-only.
let glPreview: GlPreview | null = createGlPreview(canvas.width, canvas.height);
if (glPreview) {
  glPreview.canvas.id = 'gl-canvas';
  glPreview.canvas.setAttribute('aria-hidden', 'true');
  canvas.insertAdjacentElement('afterend', glPreview.canvas);
  glPreview.canvas.addEventListener('webglcontextlost', () => {
    glPreview!.canvas.remove();
    glPreview = null;
    requestRender();
  });
}

interface Sample {
  // Float64 to match the renderer's precision exactly — float32 rounding
  // shows up as off-by-one channel values after sRGB encoding
  dir: Float64Array; // unit direction from sphere center (surface anchor)
  color: Float64Array;
  marker: HTMLElement;
}
let samples: Sample[] = [];
let selectedLight = -1;

type SampleMode = 'points' | 'line' | 'circle';
let mode: SampleMode = 'circle';
interface SurfaceShape {
  kind: 'line' | 'circle';
  a: Float64Array;   // line start / circle center (unit direction)
  b: Float64Array;   // line end (unit direction)
  rho: number;       // circle angular radius (radians)
  rotate: number;    // circle sample rotation around the ring (degrees) —
                     // line rotation bakes straight into a/b instead
}
let shape: SurfaceShape | null = null;
let shapeColors: Float64Array[] = [];
let shapeCount = 7;
let shapeSpacing: keyof typeof distributions = 'linear';

// ---------------------------------------------------------------- rendering

async function startRender() {
  engine.beginFrame();
  for (let pass = 0; pass < DEFAULT_PASS_SCALES.length; pass++) {
    engine.renderPass(imageData.data, DEFAULT_PASS_SCALES[pass], pass === 0 ? 0 : DEFAULT_PASS_SCALES[pass - 1]);
    ctx!.putImageData(imageData, 0, 0);
    await new Promise(requestAnimationFrame);
  }
  // Settled (no follow-up render queued): anti-alias the geometric edges
  if (!pendingRender) {
    engine.refineEdges(imageData.data);
    ctx!.putImageData(imageData, 0, 0);
    scheduleFavicon();
  }
}

// Generative favicon: the rendered sphere itself, clipped to its silhouette.
// Runs on idle time after a render settles so it never competes with drawing.
const faviconLink = document.querySelector('link[rel="icon"]') as HTMLLinkElement;
const faviconCanvas = document.createElement('canvas');
faviconCanvas.width = faviconCanvas.height = 64;
let faviconQueued = 0;
function scheduleFavicon() {
  if (faviconQueued) return;
  const run = () => {
    faviconQueued = 0;
    // exact perspective silhouette: apparent radius asin(r/d), projected
    const d = -state.cameraZ;
    const r = state.sphereRadius;
    if (d <= r) return;
    const rpx = (r / Math.sqrt(d * d - r * r)) / engine.tanFov() * (canvas.width / 2);
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const f = faviconCanvas.getContext('2d')!;
    f.clearRect(0, 0, 64, 64);
    f.save();
    f.beginPath();
    f.arc(32, 32, 31, 0, Math.PI * 2);
    f.clip();
    f.drawImage(canvas, cx - rpx, cy - rpx, rpx * 2, rpx * 2, 1, 1, 62, 62);
    f.restore();
    faviconLink.type = 'image/png';
    faviconLink.href = faviconCanvas.toDataURL('image/png');
  };
  faviconQueued = typeof requestIdleCallback === 'function'
    ? requestIdleCallback(run, { timeout: 2000 })
    : window.setTimeout(run, 300);
}

let renderInProgress = false;
let pendingRender = false;
let settleTimer: number | undefined;
let renderGen = 0;
const SETTLE_MS = 160;

function requestRender() {
  if (glPreview) {
    // GPU frame now; full-precision CPU frame once edits stop coming
    renderGen++;
    glPreview.draw(state, lights);
    if (!glPreview.canvas.classList.contains('gl-visible')) glPreview.canvas.classList.add('gl-visible');
    clearTimeout(settleTimer);
    settleTimer = window.setTimeout(cpuSettle, SETTLE_MS);
    return;
  }
  cpuProgressiveRender();
}

// The settled CPU render skips the intermediate blits (the GL frame covers
// the canvas until the final anti-aliased image is ready), so the progressive
// ladder never flickers through — but still yields between passes.
async function cpuSettle() {
  if (renderInProgress) {
    // A superseded settle may still be inside a blocking pass — try again
    // rather than dropping the final render on the floor
    settleTimer = window.setTimeout(cpuSettle, SETTLE_MS);
    return;
  }
  renderInProgress = true;
  const gen = renderGen;
  engine.beginFrame();
  let done = true;
  for (let pass = 0; pass < DEFAULT_PASS_SCALES.length; pass++) {
    engine.renderPass(imageData.data, DEFAULT_PASS_SCALES[pass], pass === 0 ? 0 : DEFAULT_PASS_SCALES[pass - 1]);
    await new Promise(requestAnimationFrame);
    if (gen !== renderGen) { done = false; break; } // superseded mid-settle
  }
  if (done) {
    engine.refineEdges(imageData.data);
    ctx!.putImageData(imageData, 0, 0);
    glPreview?.canvas.classList.remove('gl-visible');
    scheduleFavicon();
  }
  renderInProgress = false;
  // Superseded settles return without drawing; the timer set by the newer
  // requestRender rebounds into cpuSettle once edits stop.
}

// Exports read #canvas, which can hold a stale frame while the GL preview
// covers it. Force the settled f64 render synchronously — a one-off hitch on
// click, in exchange for exports always being the exact CPU frame.
function ensureSettledCanvas() {
  if (!glPreview || !glPreview.canvas.classList.contains('gl-visible')) return;
  clearTimeout(settleTimer);
  renderGen++; // aborts any in-flight async settle without drawing
  engine.beginFrame();
  engine.renderPass(imageData.data, 1);
  engine.refineEdges(imageData.data);
  ctx!.putImageData(imageData, 0, 0);
  glPreview.canvas.classList.remove('gl-visible');
  scheduleFavicon();
}

async function cpuProgressiveRender() {
  if (renderInProgress) {
    pendingRender = true;
    return;
  }
  renderInProgress = true;
  await startRender();
  renderInProgress = false;
  if (pendingRender) {
    pendingRender = false;
    cpuProgressiveRender();
  }
}

// ---------------------------------------------------------------- projection helpers

function eventToCanvasPixels(clientX: number, clientY: number, clamp = true) {
  const rect = canvas.getBoundingClientRect();
  // Exclude the canvas border from the mapping (rect includes it)
  const bx = (rect.width - canvas.clientWidth) / 2;
  const by = (rect.height - canvas.clientHeight) / 2;
  let x = (clientX - rect.left - bx) * (canvas.width / canvas.clientWidth);
  let y = (clientY - rect.top - by) * (canvas.height / canvas.clientHeight);
  if (clamp) {
    x = Math.min(canvas.width - 1, Math.max(0, x));
    y = Math.min(canvas.height - 1, Math.max(0, y));
  }
  return { x, y };
}

// ---------------------------------------------------------------- markers, gizmo, inspector

const lightLayer = document.getElementById('light-layer')!;
const sampleLayer = document.getElementById('sample-layer')!;
const gizmoSvg = document.getElementById('gizmo')!;
const inspector = document.getElementById('inspector')!;

// Light-type icons (same drawings as the type select), injected into the
// control rail; stroke/fill follow currentColor so they can be tinted
const LIGHT_TYPE_ICONS: Record<string, string> = {
  point: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2" fill="currentColor"/><path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3M3.4 3.4l2.1 2.1M10.5 10.5l2.1 2.1M12.6 3.4l-2.1 2.1M5.5 10.5l-2.1 2.1" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/></svg>',
  area: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="5" cy="8" r="3.4" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.5 4.5l2.3-1.4M11.3 8h3.2M10.5 11.5l2.3 1.4" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/></svg>',
  directional: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4h7M2 8h7M2 12h7" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/><path d="M9.5 2.4L14 4l-4.5 1.6zM9.5 6.4L14 8l-4.5 1.6zM9.5 10.4L14 12l-4.5 1.6z" fill="currentColor"/></svg>',
  spot: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 8L12 3.8M2.5 8L12 12.2" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/><ellipse cx="12.2" cy="8" rx="1.7" ry="4.3" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
};

function contrastColor(hexColor: string) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hexColor);
  if (!m) return '#000';
  const [r, g, b] = [m[1], m[2], m[3]].map(c => srgbToLinear(parseInt(c, 16) / 255));
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.4 ? '#000' : '#fff';
}

// Pull an off-canvas point back to the canvas edge ALONG its line toward the
// canvas center — so edge-clamped markers sit exactly on their aim line
function clampToCanvasAlongLine(px: number, py: number) {
  const tx = canvas.width / 2, ty = canvas.height / 2;
  const dx = tx - px, dy = ty - py;
  let t = 0;
  if (px < 0) t = Math.max(t, -px / dx);
  else if (px > canvas.width) t = Math.max(t, (canvas.width - px) / dx);
  if (py < 0) t = Math.max(t, -py / dy);
  else if (py > canvas.height) t = Math.max(t, (canvas.height - py) / dy);
  return { x: px + dx * t, y: py + dy * t };
}

function updateLightMarkers() {
  lightLayer.innerHTML = '';
  for (let i = 0; i < 3; i++) {
    const screenPos = engine.worldToScreen(lightPositions[i * 3], lightPositions[i * 3 + 1], lightPositions[i * 3 + 2]);
    if (screenPos.z <= 0) continue;
    const { x: cx, y: cy } = clampToCanvasAlongLine(screenPos.x, screenPos.y);
    const normalizedScale = Math.max(0, Math.min(1, (8 - screenPos.z) / 7.5));
    const marker = document.createElement('div');
    marker.className = `marker light-marker${lights[i].type === 'directional' ? ' light-marker--directional' : ''}`;
    marker.dataset.light = String(i);
    if (cx !== screenPos.x || cy !== screenPos.y) marker.classList.add('marker--offscreen');
    if (i === selectedLight) marker.classList.add('marker--selected');
    marker.style.left = `${(cx / canvas.width) * 100}%`;
    marker.style.top = `${(cy / canvas.height) * 100}%`;
    // Hollow ring = the light is behind the sphere
    if (engine.isLightOccluded(i)) {
      marker.classList.add('light-marker--occluded');
      marker.style.borderColor = lights[i].hex;
    } else {
      marker.style.backgroundColor = lights[i].hex;
    }
    marker.style.setProperty('--scale', normalizedScale.toString());
    lightLayer.appendChild(marker);
  }
  document.querySelectorAll<HTMLElement>('.control-rail__light').forEach((el, i) => {
    el.style.background = lights[i].hex;
    el.style.color = contrastColor(lights[i].hex);
    if (el.dataset.iconType !== lights[i].type) {
      el.dataset.iconType = lights[i].type;
      el.innerHTML = LIGHT_TYPE_ICONS[lights[i].type];
    }
    el.classList.toggle('control-rail__light--active', i === selectedLight);
  });
  document.body.classList.toggle('light-editing', selectedLight >= 0);
  if (selectedLight >= 0) {
    const i = selectedLight;
    const sp = engine.worldToScreen(lightPositions[i * 3], lightPositions[i * 3 + 1], lightPositions[i * 3 + 2]);
    if (sp.z > 0) {
      const addGrip = (kind: string, x: number, y: number, round: boolean, title: string) => {
        const g = document.createElement('div');
        g.className = 'shape-handle light-grip' + (round ? ' shape-handle--grip' : '');
        g.dataset.grip = kind;
        g.title = title;
        g.style.left = `${(x / canvas.width) * 100}%`;
        g.style.top = `${(y / canvas.height) * 100}%`;
        g.style.transform = 'translate(-50%, -50%)';
        lightLayer.appendChild(g);
        return g;
      };
      const onCanvas = sp.x >= 0 && sp.x <= canvas.width && sp.y >= 0 && sp.y <= canvas.height;
      if (onCanvas) {
        const r = intensityRingRadius(lights[i].intensity);
        const ga = -Math.PI / 4; // upper-right, clear of the aim line toward the sphere
        addGrip('intensity', sp.x + Math.cos(ga) * r, sp.y + Math.sin(ga) * r, true, 'Intensity — drag to resize the ring');
      }
      // edge-clamped as a remote when the beam leaves the canvas
      const b = beadWorld(i);
      const bp = engine.worldToScreen(b.x, b.y, b.z);
      let bx = bp.x, by = bp.y;
      const beadOff = bx < 0 || bx > canvas.width || by < 0 || by > canvas.height;
      if (beadOff) ({ x: bx, y: by } = clampToCanvasAlongLine(bp.x, bp.y));
      const bead = addGrip('dist', bx, by, false, 'Distance — slide along the beam');
      if (beadOff) bead.classList.add('shape-handle--behind');
    }
  }
  updateGizmo();
}

function updateGizmo() {
  gizmoSvg.setAttribute('viewBox', `0 0 ${canvas.width} ${canvas.height}`);
  gizmoSvg.innerHTML = '';
  if (selectedLight < 0) return;
  const i = selectedLight;
  const NS = 'http://www.w3.org/2000/svg';
  // rings stay drawable even when the light is off-canvas or behind the camera
  drawOrbit('yaw', i, NS);
  drawOrbit('pitch', i, NS);
  const screenPos = engine.worldToScreen(lightPositions[i * 3], lightPositions[i * 3 + 1], lightPositions[i * 3 + 2]);
  if (screenPos.z <= 0) return;
  const { x: cx, y: cy } = clampToCanvasAlongLine(screenPos.x, screenPos.y);
  const type = lights[i].type;
  {
    // Aim line from the light to where its ray meets the sphere's surface.
    const lx = lightPositions[i * 3], ly = lightPositions[i * 3 + 1], lz = lightPositions[i * 3 + 2];
    const llen = Math.sqrt(lx * lx + ly * ly + lz * lz) || 1;
    const s = state.sphereRadius / llen;
    const ex = lx * s, ey = ly * s, ez = lz * s;
    const N = 32;
    const sp = pathSplitter(false);
    for (let k = 0; k <= N; k++) {
      const t = k / N;
      sp.add(lx + (ex - lx) * t, ly + (ey - ly) * t, lz + (ez - lz) * t);
    }
    const { vis, hid } = sp.paths();
    if (hid) appendPaths(NS, hid, [['', 'gizmo-line--hidden']]);
    if (vis) appendPaths(NS, vis, [['3', 'gizmo-line-casing'], ['1', 'gizmo-line']]);
  }
  if (type === 'area' && lights[i].size > 0) {
    const r = (lights[i].size / (screenPos.z * engine.tanFov())) * (canvas.height / 2);
    const circle = document.createElementNS(NS, 'circle');
    circle.setAttribute('cx', cx.toFixed(1));
    circle.setAttribute('cy', cy.toFixed(1));
    circle.setAttribute('r', Math.max(2, r).toFixed(1));
    circle.setAttribute('class', 'gizmo-area');
    gizmoSvg.appendChild(circle);
  }
  if (cx === screenPos.x && cy === screenPos.y) {
    const r = intensityRingRadius(lights[i].intensity);
    for (const [width, cls] of [['3', 'shape-path-casing'], ['1.5', 'shape-path']] as const) {
      const ring = document.createElementNS(NS, 'circle');
      ring.setAttribute('cx', cx.toFixed(1));
      ring.setAttribute('cy', cy.toFixed(1));
      ring.setAttribute('r', r.toFixed(1));
      ring.setAttribute('fill', 'none');
      ring.setAttribute('stroke-width', width);
      ring.setAttribute('class', cls);
      gizmoSvg.appendChild(ring);
    }
  }
}

// fixed radii — the meridian tighter so the rings never read as one ellipse
const orbitRadius = (kind: 'yaw' | 'pitch') => state.sphereRadius + (kind === 'yaw' ? 0.5 : 0.28);

function ringWorld(kind: 'yaw' | 'pitch', aRad: number, yawRad: number, d: number) {
  return kind === 'yaw'
    ? { x: Math.cos(aRad) * d, y: Math.sin(aRad) * YAW_TILT_S * d, z: Math.sin(aRad) * YAW_TILT_C * d }
    : { x: Math.cos(aRad) * Math.cos(yawRad) * d, y: Math.sin(aRad) * d, z: Math.cos(aRad) * Math.sin(yawRad) * d };
}

function pathSplitter(withHit: boolean) {
  let vis = '', hid = '', hit = '', pv = false, ph = false, pt = false;
  return {
    add(wx: number, wy: number, wz: number, veto?: (sx: number, sy: number) => boolean) {
      const p = engine.worldToScreen(wx, wy, wz);
      if (p.z <= 0.5) {
        pv = ph = pt = false;
        return;
      }
      const seg = p.x.toFixed(1) + ' ' + p.y.toFixed(1) + ' ';
      if (withHit) {
        if (p.x >= -24 && p.x <= canvas.width + 24 && p.y >= -24 && p.y <= canvas.height + 24) {
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

function appendPaths(NS: string, d: string, styles: ReadonlyArray<readonly [string, string]>) {
  for (const [width, cls] of styles) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    if (width) path.setAttribute('stroke-width', width);
    path.setAttribute('class', cls);
    gizmoSvg.appendChild(path);
  }
}

function drawOrbit(kind: 'yaw' | 'pitch', i: number, NS: string) {
  const d = orbitRadius(kind);
  const yawRad = lights[i].yaw * Math.PI / 180;
  // the dial's front half notches the meridian where they cross on screen
  let maskPts: Array<{ x: number; y: number }> | null = null;
  if (kind === 'pitch') {
    maskPts = [];
    const dm = orbitRadius('yaw');
    for (let k = 0; k < 256; k++) {
      const m = ringWorld('yaw', (k / 256) * 2 * Math.PI, yawRad, dm);
      if (m.z >= 0 || engine.isPointOccluded(m.x, m.y, m.z)) continue;
      const mp = engine.worldToScreen(m.x, m.y, m.z);
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
  const sp = pathSplitter(true);
  for (let k = 0; k <= N; k++) {
    const w = ringWorld(kind, (k / N) * 2 * Math.PI, yawRad, d);
    sp.add(w.x, w.y, w.z, w.z < 0 ? nearOtherRing : undefined);
  }
  const { vis, hid, hit: hitD } = sp.paths();
  if (hid) appendPaths(NS, hid, [['', 'gizmo-line--hidden']]);
  if (vis) appendPaths(NS, vis, [['3', 'shape-path-casing'], ['1.5', 'shape-path']]);
  let tickD = '';
  for (let deg = 0; deg < 360; deg += 10) {
    const aRad = deg * Math.PI / 180;
    const base = ringWorld(kind, aRad, yawRad, d);
    if (engine.isPointOccluded(base.x, base.y, base.z)) continue;
    const len = deg % 45 === 0 ? 0.13 : 0.055;
    const tip = ringWorld(kind, aRad, yawRad, d + len);
    const p0 = engine.worldToScreen(base.x, base.y, base.z);
    const p1 = engine.worldToScreen(tip.x, tip.y, tip.z);
    if (p0.z <= 0.5 || p1.z <= 0.5) continue;
    if (base.z < 0 && (nearOtherRing(p0.x, p0.y) || nearOtherRing(p1.x, p1.y))) continue;
    tickD += `M${p0.x.toFixed(1)} ${p0.y.toFixed(1)} L${p1.x.toFixed(1)} ${p1.y.toFixed(1)} `;
  }
  if (tickD) {
    const ticks = document.createElementNS(NS, 'path') as SVGPathElement;
    ticks.setAttribute('d', tickD);
    // inline style: the class CSS carries its own stroke-width, which
    // beats the presentation attribute
    ticks.style.strokeWidth = '0.6';
    ticks.setAttribute('class', 'shape-path');
    gizmoSvg.appendChild(ticks);
  }
  if (hitD) {
    const hit = document.createElementNS(NS, 'path') as SVGPathElement;
    hit.setAttribute('d', hitD);
    hit.setAttribute('class', 'gizmo-orbit-hit');
    hit.setAttribute('pointer-events', 'stroke'); // the svg root is pointer-events: none
    hit.dataset.orbit = kind;
    gizmoSvg.appendChild(hit);
  }
}

const angDelta = (a: number, b: number) => ((a - b + 540) % 360) - 180;
const YAW_TILT_S = Math.sin(10 * Math.PI / 180);
const YAW_TILT_C = Math.cos(10 * Math.PI / 180);

gizmoSvg.addEventListener('pointerdown', e => {
  const orbit = (e.target as SVGElement).dataset?.orbit as 'yaw' | 'pitch' | undefined;
  if (!orbit || selectedLight < 0) return;
  e.preventDefault();
  const li = selectedLight;
  // fixed for the whole drag; the light may flip to planeYaw + 180 on the far half
  const planeYaw = lights[li].yaw;
  let aCur = orbit === 'yaw'
    ? lights[li].yaw
    : (Math.abs(angDelta(lights[li].yaw, planeYaw)) <= 90 ? lights[li].pitch : 180 - lights[li].pitch);
  const ringPoint = (aDeg: number) => {
    const w = ringWorld(orbit, aDeg * Math.PI / 180, planeYaw * Math.PI / 180, orbitRadius(orbit));
    return engine.worldToScreen(w.x, w.y, w.z);
  };
  // drag model by projected shape: fat ellipse — bearing-tracking around the
  // center; slim / edge-on — linear tangent spin (bearings degenerate there)
  const center = engine.worldToScreen(0, 0, 0);
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
  let prev = eventToCanvasPixels(e.clientX, e.clientY, false);
  // relative in both modes: grabbing never snaps the light to the grab point
  let thetaPrev = Math.atan2(prev.y - center.y, prev.x - center.x) * 180 / Math.PI;
  let targetBearing: number | null = null;
  const move = (ev: PointerEvent) => {
    const p = eventToCanvasPixels(ev.clientX, ev.clientY, false);
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
    const l = lights[li];
    if (orbit === 'yaw') {
      l.yaw = Math.round(angDelta(aCur, 0));
    } else {
      // past a pole the light continues on the far half of the same plane
      const pitch = Math.asin(Math.sin(aCur * Math.PI / 180)) * 180 / Math.PI;
      l.yaw = Math.round(angDelta(Math.cos(aCur * Math.PI / 180) >= 0 ? planeYaw : planeYaw + 180, 0));
      l.pitch = Math.round(Math.max(-89, Math.min(89, pitch)));
    }
    sound.playTick();
    update();
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});

// asymptotic (x / (x + 1)): any intensity has a radius, dragging never snap-clamps
const INT_R0 = 16;   // ring radius at intensity 0
const INT_R1 = 36;   // additional radius as intensity -> inf
const INT_MAX = 19;  // hard ceiling when dragging the grip outward

function intensityRingRadius(intensity: number) {
  return INT_R0 + INT_R1 * (intensity / (intensity + 1));
}

const BEAD_F = 0.5;

function beadWorld(i: number) {
  const lx = lightPositions[i * 3], ly = lightPositions[i * 3 + 1], lz = lightPositions[i * 3 + 2];
  const llen = Math.sqrt(lx * lx + ly * ly + lz * lz) || 1;
  const s = (BEAD_F * state.sphereRadius + (1 - BEAD_F) * lights[i].dist) / llen;
  return { x: lx * s, y: ly * s, z: lz * s };
}

// ---------------------------------------------------------------- orbit globe
// Arcball control in the inspector (after color-names-viz-over-time):
// a tilted orthographic globe — meridian and parallel cross at the dot,
// front halves bright, back halves dim. Drag anywhere on it to aim the light.

const orbitEl = document.getElementById('orbit')!;
const orbitDot = document.getElementById('orbit-dot')!;
const orbitOut = document.getElementById('orbitOut')!;
const arcMF = document.getElementById('arc-mf')!;
const arcMB = document.getElementById('arc-mb')!;
const arcPF = document.getElementById('arc-pf')!;
const arcPB = document.getElementById('arc-pb')!;
const SPH_R = 44, SPH_C = 50, TILT = 0.34;
const CB = Math.cos(TILT), SB = Math.sin(TILT);

// Unit-sphere point -> [viewBoxX, viewBoxY, depth]; globe +z faces the viewer,
// which is scene -z (toward the camera), so aiming feels consistent.
const proj3 = (x: number, y: number, z: number): [number, number, number] =>
  [SPH_C + x * SPH_R, SPH_C - (y * CB - z * SB) * SPH_R, y * SB + z * CB];

// Sample a ring fn(u)->[x,y,z], splitting into front / back subpaths by depth.
// The exact horizon crossing (depth = 0) is interpolated so both halves meet
// precisely on the globe's silhouette instead of at the nearest sample.
function ringPath(fn: (u: number) => [number, number, number], N: number) {
  let front = '', back = '', pf = false, pb = false;
  let prev: { sx: number, sy: number, d: number } | null = null;
  for (let i = 0; i <= N; i++) {
    const [x, y, z] = fn(i / N);
    const [sx, sy, d] = proj3(x, y, z);
    if (prev && (d >= 0) !== (prev.d >= 0)) {
      const t = prev.d / (prev.d - d);
      const ix = prev.sx + (sx - prev.sx) * t;
      const iy = prev.sy + (sy - prev.sy) * t;
      const cpt = ix.toFixed(1) + ' ' + iy.toFixed(1) + ' ';
      if (prev.d >= 0) {
        front += (pf ? 'L' : 'M') + cpt;
        back += 'M' + cpt;
        pf = false; pb = true;
      } else {
        back += (pb ? 'L' : 'M') + cpt;
        front += 'M' + cpt;
        pb = false; pf = true;
      }
    }
    const pt = sx.toFixed(1) + ' ' + sy.toFixed(1) + ' ';
    if (d >= 0) { front += (pf ? 'L' : 'M') + pt; pf = true; pb = false; }
    else { back += (pb ? 'L' : 'M') + pt; pb = true; pf = false; }
    prev = { sx, sy, d };
  }
  return [front, back];
}

function updateOrbitGlobe() {
  if (selectedLight < 0) return;
  const l = lights[selectedLight];
  const yaw = l.yaw * Math.PI / 180;
  const pitch = l.pitch * Math.PI / 180;
  const cosY = Math.cos(yaw), sinY = Math.sin(yaw);
  const sinFi = Math.sin(pitch), cosFi = Math.cos(pitch);
  const [mf, mb] = ringPath(u => {
    const t = (u - 0.5) * Math.PI, c = Math.cos(t);
    return [c * cosY, Math.sin(t), -c * sinY];
  }, 48);
  const [pf, pb] = ringPath(u => {
    const s = u * 2 * Math.PI;
    return [cosFi * Math.cos(s), sinFi, cosFi * Math.sin(s)];
  }, 72);
  arcMF.setAttribute('d', mf);
  arcMB.setAttribute('d', mb);
  arcPF.setAttribute('d', pf);
  arcPB.setAttribute('d', pb);
  const [dx, dy, depth] = proj3(cosFi * cosY, sinFi, -cosFi * sinY);
  orbitDot.style.left = dx + '%';
  orbitDot.style.top = dy + '%';
  orbitDot.style.backgroundColor = l.hex;
  // On the far hemisphere the dot drops behind the wireframe, greyed like the back arcs
  orbitDot.classList.toggle('orbit-dot--back', depth < 0);
  orbitOut.textContent = `${Math.round(l.yaw)}° / ${Math.round(l.pitch)}°`;
}

// Trackball dragging: relative to where the light was — pressing never jumps
// the dot. Dragging spins the globe (one radius of movement = 90°), so the
// back hemisphere is reached by simply continuing past the silhouette.
// Note the trackball feel: while the dot is on the back it moves opposite
// to the pointer, exactly like the far side of a spinning globe.
const ORBIT_DEG_PER_RADIUS = 90;
let orbiting = false;
let orbitStart = { x: 0, y: 0, yaw: 0, pitch: 0 };

orbitEl.addEventListener('pointerdown', e => {
  if (selectedLight < 0) return;
  orbiting = true;
  orbitEl.setPointerCapture(e.pointerId);
  const l = lights[selectedLight];
  orbitStart = { x: e.clientX, y: e.clientY, yaw: l.yaw, pitch: l.pitch };
});
const wrap180 = (deg: number) => (((deg % 360) + 540) % 360) - 180;

orbitEl.addEventListener('pointermove', e => {
  if (!orbiting || selectedLight < 0) return;
  sound.playTick();
  const r = orbitEl.getBoundingClientRect();
  const dxu = (e.clientX - orbitStart.x) / (r.width / 2);  // pointer delta in globe radii
  const dyu = (orbitStart.y - e.clientY) / (r.height / 2);
  const l = lights[selectedLight];
  let yaw = orbitStart.yaw + dxu * ORBIT_DEG_PER_RADIUS;
  // Pitch keeps going over the poles: crossing one flips yaw to the far side
  let pitch = wrap180(orbitStart.pitch + dyu * ORBIT_DEG_PER_RADIUS);
  if (pitch > 90) {
    pitch = 180 - pitch;
    yaw += 180;
  } else if (pitch < -90) {
    pitch = -180 - pitch;
    yaw += 180;
  }
  l.yaw = Math.round(wrap180(yaw));
  l.pitch = Math.round(Math.max(-89, Math.min(89, pitch)));
  update();
});
orbitEl.addEventListener('pointerup', e => {
  orbiting = false;
  orbitEl.releasePointerCapture(e.pointerId);
});

function updateSampleMarker(sample: Sample) {
  const r = state.sphereRadius;
  const screenPos = engine.worldToScreen(sample.dir[0] * r, sample.dir[1] * r, sample.dir[2] * r);
  // Keep offscreen samples visible (and grabbable) at the canvas edge,
  // clamped along their line to center — same treatment as light markers
  const { x: cx, y: cy } = clampToCanvasAlongLine(screenPos.x, screenPos.y);
  sample.marker.style.left = `${(cx / canvas.width) * 100}%`;
  sample.marker.style.top = `${(cy / canvas.height) * 100}%`;
  sample.marker.classList.toggle('marker--offscreen', cx !== screenPos.x || cy !== screenPos.y);
  const facing = r - sample.dir[2] * state.cameraZ;
  sample.marker.classList.toggle('marker--behind', facing >= 0);
}

// Group rotation for loose points: when several samples exist, a dashed ring
// sits at their spherical centroid — dragging it spins the whole constellation
// around that center, same gesture as the shapes' rotation grips

function samplesCentroid(out = new Float64Array(3)): Float64Array | null {
  let x = 0, y = 0, z = 0;
  for (const s of samples) { x += s.dir[0]; y += s.dir[1]; z += s.dir[2]; }
  const l = Math.hypot(x, y, z);
  if (l < 1e-6) return null; // balanced constellation: no centroid, no widget
  out[0] = x / l; out[1] = y / l; out[2] = z / l;
  return out;
}

let samplesRotSpin = 0; // cosmetic: the knob keeps the accumulated turn
const samplesRotWidget = document.createElement('div');
samplesRotWidget.className = 'marker samples-rot';
samplesRotWidget.title = 'Drag to rotate the points around their center';
samplesRotWidget.addEventListener('pointerdown', e => beginSamplesRotDrag(e));
sampleLayer.appendChild(samplesRotWidget);

function updateSamplesRotWidget() {
  const c = mode === 'points' && samples.length > 1 ? samplesCentroid() : null;
  samplesRotWidget.toggleAttribute('hidden', !c);
  if (!c) return;
  const r = state.sphereRadius;
  const p = engine.worldToScreen(c[0] * r, c[1] * r, c[2] * r);
  const { x: cx, y: cy } = clampToCanvasAlongLine(p.x, p.y);
  samplesRotWidget.style.left = `${(cx / canvas.width) * 100}%`;
  samplesRotWidget.style.top = `${(cy / canvas.height) * 100}%`;
  samplesRotWidget.style.setProperty('--spin', `${samplesRotSpin}deg`);
  samplesRotWidget.classList.toggle('marker--behind', r - c[2] * state.cameraZ >= 0);
}

function beginSamplesRotDrag(e: PointerEvent) {
  e.preventDefault();
  e.stopPropagation();
  const c = samplesCentroid();
  if (!c) return;
  const u = new Float64Array(3), v = new Float64Array(3);
  circleBasis(c, u, v);
  const bearingAt = (clientX: number, clientY: number) => {
    const q = eventToCanvasPixels(clientX, clientY);
    const h = engine.castRay(q.x, q.y);
    if (!h) return null;
    const tu = u[0] * h.nx + u[1] * h.ny + u[2] * h.nz;
    const tv = v[0] * h.nx + v[1] * h.ny + v[2] * h.nz;
    return Math.hypot(tu, tv) > 1e-6 ? Math.atan2(tv, tu) : null;
  };
  // incremental, so grabbing the ring anywhere never jumps
  let last = bearingAt(e.clientX, e.clientY);
  const move = (ev: PointerEvent) => {
    sound.playTick();
    const bearing = bearingAt(ev.clientX, ev.clientY);
    if (bearing === null) return;
    if (last !== null) {
      const deg = (bearing - last) * 180 / Math.PI;
      rotateDirs(samples.map(s => s.dir), deg, c);
      samplesRotSpin += deg;
      samples.forEach(sample => {
        const color = engine.shade(sample.dir);
        sample.color[0] = color.r;
        sample.color[1] = color.g;
        sample.color[2] = color.b;
        updateSampleMarker(sample);
      });
      updateStops();
    }
    last = bearing;
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

// ---------------------------------------------------------------- shape sampling
// One shape at a time, anchored to the sphere's surface: a geodesic arc
// between two anchors, or a circle of angular radius rho around a center.

const shapeSvg = document.getElementById('shape-svg')!;
const shapeHandles = document.getElementById('shape-handles')!;

function shapeSampleDirs(): Float64Array[] {
  if (!shape) return [];
  // circles always sample evenly (the API still accepts any Distribution)
  return shape.kind === 'line'
    ? sampleLineDirs(shape.a, shape.b, shapeCount, distributions[shapeSpacing])
    : sampleCircleDirs(shape.a, shape.rho, shapeCount, { rotate: shape.rotate });
}

function recomputeShapeColors() {
  shapeColors = shapeSampleDirs().map(dir => {
    const c = engine.shade(dir);
    return new Float64Array([c.r, c.g, c.b]);
  });
}

// Front/back test for a surface direction (same as sample markers)
const dirIsBehind = (d: ArrayLike<number>) => state.sphereRadius - d[2] * state.cameraZ >= 0;

function projectDirPct(d: ArrayLike<number>) {
  const r = state.sphereRadius;
  const p = engine.worldToScreen(d[0] * r, d[1] * r, d[2] * r);
  return { x: (p.x / canvas.width) * 100, y: (p.y / canvas.height) * 100, sx: p.x, sy: p.y };
}

type HandleRole = 'a' | 'b' | 'r' | 'rot';

// Little satellite point beside the line's midpoint, held off the geodesic so
// it never collides with a sample dot — dragging it swings the line around
const ROT_GRIP_ARC = 0.13;
function lineRotGripDir(out = new Float64Array(3)) {
  const m = slerp(shape!.a, shape!.b, 0.5);
  let tx = shape!.b[0] - shape!.a[0];
  let ty = shape!.b[1] - shape!.a[1];
  let tz = shape!.b[2] - shape!.a[2];
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
  const c = Math.cos(ROT_GRIP_ARC), s = Math.sin(ROT_GRIP_ARC);
  out[0] = c * m[0] + s * px;
  out[1] = c * m[1] + s * py;
  out[2] = c * m[2] + s * pz;
  return out;
}

function makeShapeHandle(role: HandleRole, title: string) {
  const h = document.createElement('div');
  h.className = 'marker shape-handle';
  h.dataset.handle = role;
  h.title = title;
  shapeHandles.appendChild(h);
  return h;
}

function updateShapeOverlay() {
  shapeSvg.setAttribute('viewBox', `0 0 ${canvas.width} ${canvas.height}`);
  shapeSvg.innerHTML = '';
  shapeHandles.innerHTML = '';
  const active = mode !== 'points';
  shapeSvg.toggleAttribute('hidden', !active);
  shapeHandles.toggleAttribute('hidden', !active);
  if (!active || !shape) return;
  const NS = 'http://www.w3.org/2000/svg';

  // Dense polyline along the shape, split into front / behind portions
  const steps = shape.kind === 'line' ? 40 : 72;
  const pt = new Float64Array(3);
  let frontD = '', backD = '', pf = false, pb = false;
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    if (shape.kind === 'line') slerp(shape.a, shape.b, t, pt);
    else circleDir(shape.a, shape.rho, t * 2 * Math.PI, pt);
    const p = projectDirPct(pt);
    const seg = p.sx.toFixed(1) + ' ' + p.sy.toFixed(1) + ' ';
    if (!dirIsBehind(pt)) { frontD += (pf ? 'L' : 'M') + seg; pf = true; pb = false; }
    else { backD += (pb ? 'L' : 'M') + seg; pb = true; pf = false; }
  }
  if (backD) {
    const back = document.createElementNS(NS, 'path');
    back.setAttribute('d', backD);
    back.setAttribute('class', 'shape-path shape-path--back');
    shapeSvg.appendChild(back);
  }
  if (frontD) {
    for (const cls of ['shape-path-casing', 'shape-path']) {
      const el = document.createElementNS(NS, 'path');
      el.setAttribute('d', frontD);
      el.setAttribute('class', cls);
      shapeSvg.appendChild(el);
    }
  }

  const dirs = shapeSampleDirs();
  dirs.forEach((d, k) => {
    const p = projectDirPct(d);
    const dot = document.createElementNS(NS, 'circle');
    dot.setAttribute('cx', p.sx.toFixed(1));
    dot.setAttribute('cy', p.sy.toFixed(1));
    dot.setAttribute('r', '3');
    const col = shapeColors[k];
    if (col) dot.setAttribute('fill', `rgb(${toSRGB8(col[0])}, ${toSRGB8(col[1])}, ${toSRGB8(col[2])})`);
    dot.setAttribute('class', `shape-dot${dirIsBehind(d) ? ' shape-dot--back' : ''}`);
    shapeSvg.appendChild(dot);
  });

  if (shape.kind === 'line') {
    for (const [role, dir, title] of [['a', shape.a, 'Line start'], ['b', shape.b, 'Line end']] as const) {
      const h = makeShapeHandle(role, `${title} — drag to move`);
      const p = projectDirPct(dir);
      h.style.left = `${p.x}%`;
      h.style.top = `${p.y}%`;
      h.classList.toggle('shape-handle--behind', dirIsBehind(dir));
    }
    const rot = makeShapeHandle('rot', 'Drag around the middle to rotate the line');
    lineRotGripDir(pt);
    const pr = projectDirPct(pt);
    rot.style.left = `${pr.x}%`;
    rot.style.top = `${pr.y}%`;
    rot.classList.add('shape-handle--grip', 'shape-handle--rot');
    rot.classList.toggle('shape-handle--behind', dirIsBehind(pt));
  } else {
    const center = makeShapeHandle('a', 'Circle center — drag to move');
    const pc = projectDirPct(shape.a);
    center.style.left = `${pc.x}%`;
    center.style.top = `${pc.y}%`;
    center.classList.toggle('shape-handle--behind', dirIsBehind(shape.a));
    const grip = makeShapeHandle('r', 'Drag out to resize — around the ring to rotate the palette');
    circleDir(shape.a, shape.rho, shape.rotate * Math.PI / 180, pt);
    const pg = projectDirPct(pt);
    grip.style.left = `${pg.x}%`;
    grip.style.top = `${pg.y}%`;
    grip.classList.add('shape-handle--grip');
    grip.classList.toggle('shape-handle--behind', dirIsBehind(pt));
  }
}

const clampDot = (d: number) => Math.max(-1, Math.min(1, d));

// Trackball drag for a point anchored to the sphere's surface — same feel as
// the lights: relative to where it was (pressing never jumps), and the back
// hemisphere is reached by continuing past the silhouette, where horizontal
// motion inverts like the far side of a spinning globe.
const SURFACE_DEG_PER_RADIUS = 90;
function beginSurfaceDrag(e: PointerEvent, dir: Float64Array, onMove: () => void) {
  // unclamped: the rotation must keep going when the cursor leaves the canvas
  const start = eventToCanvasPixels(e.clientX, e.clientY, false);
  const yaw0 = Math.atan2(dir[0], -dir[2]) * 180 / Math.PI;
  const pitch0 = Math.asin(clampDot(dir[1])) * 180 / Math.PI;
  // one silhouette-radius of pointer travel = 90° of rotation
  const silR = Math.max(1, engine.worldToScreen(state.sphereRadius, 0, 0).x - canvas.width / 2);
  const move = (ev: PointerEvent) => {
    sound.playTick();
    const q = eventToCanvasPixels(ev.clientX, ev.clientY, false);
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
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function beginHandleDrag(e: PointerEvent, role: HandleRole) {
  if (!shape) return;
  if (role === 'a' || role === 'b') {
    // center / endpoints ride the trackball so they can cross to the back
    const target = role === 'a' ? shape.a : shape.b;
    beginSurfaceDrag(e, target, () => {
      recomputeShapeColors();
      updateShapeOverlay();
      updateStops();
    });
    return;
  }
  const refresh = () => {
    recomputeShapeColors();
    updateShapeOverlay();
    updateStops();
  };
  // bearing of a surface hit in the tangent plane spanned by (u, v)
  const bearingOf = (u: Float64Array, v: Float64Array, nx: number, ny: number, nz: number) => {
    const tu = u[0] * nx + u[1] * ny + u[2] * nz;
    const tv = v[0] * nx + v[1] * ny + v[2] * nz;
    // dead-center the bearing is undefined
    return Math.hypot(tu, tv) > 1e-6 ? Math.atan2(tv, tu) : null;
  };
  if (role === 'rot') {
    // spin grip: swing the line about its midpoint — endpoints follow the
    // pointer's bearing around the center, incrementally so grabbing never jumps
    const m = slerp(shape.a, shape.b, 0.5);
    const mu = new Float64Array(3), mv = new Float64Array(3);
    circleBasis(m, mu, mv);
    const p0 = eventToCanvasPixels(e.clientX, e.clientY);
    const h0 = engine.castRay(p0.x, p0.y);
    let last = h0 ? bearingOf(mu, mv, h0.nx, h0.ny, h0.nz) : null;
    const move = (ev: PointerEvent) => {
      sound.playTick();
      const q = eventToCanvasPixels(ev.clientX, ev.clientY);
      const h = engine.castRay(q.x, q.y);
      if (!h || !shape) return;
      const bearing = bearingOf(mu, mv, h.nx, h.ny, h.nz);
      if (bearing === null) return;
      if (last !== null) {
        rotateAboutAxis(shape.a, m, bearing - last);
        rotateAboutAxis(shape.b, m, bearing - last);
        refresh();
      }
      last = bearing;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return;
  }
  // radius grip: absolute — rho is the angle between center and the point under
  // the pointer, rotate its bearing in the circle plane (the grip rides the
  // ring, carrying the sample points around with it)
  const gu = new Float64Array(3), gv = new Float64Array(3);
  circleBasis(shape.a, gu, gv);
  const move = (ev: PointerEvent) => {
    sound.playTick();
    const q = eventToCanvasPixels(ev.clientX, ev.clientY);
    const h = engine.castRay(q.x, q.y);
    if (!h || !shape) return;
    shape.rho = Math.acos(clampDot(shape.a[0] * h.nx + shape.a[1] * h.ny + shape.a[2] * h.nz));
    const bearing = bearingOf(gu, gv, h.nx, h.ny, h.nz);
    // dead-center: hold the current rotation
    if (bearing !== null) shape.rotate = bearing * 180 / Math.PI;
    refresh();
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

// Current handle positions in canvas pixels, for forgiving grabbing
function shapeHandlePoints(): Array<{ role: HandleRole; sx: number; sy: number }> {
  if (!shape) return [];
  const pts: Array<{ role: HandleRole; sx: number; sy: number }> = [];
  const pa = projectDirPct(shape.a);
  pts.push({ role: 'a', sx: pa.sx, sy: pa.sy });
  if (shape.kind === 'line') {
    const pb = projectDirPct(shape.b);
    pts.push({ role: 'b', sx: pb.sx, sy: pb.sy });
    const pr = projectDirPct(lineRotGripDir());
    pts.push({ role: 'rot', sx: pr.sx, sy: pr.sy });
  } else {
    const pg = projectDirPct(circleDir(shape.a, shape.rho, shape.rotate * Math.PI / 180));
    pts.push({ role: 'r', sx: pg.sx, sy: pg.sy });
  }
  return pts;
}

// Drawing: in a shape mode, dragging on the sphere replaces the shape —
// unless the press lands near an existing handle, which edits it instead
canvas.addEventListener('pointerdown', e => {
  if (mode === 'points') return;
  if (selectedLight >= 0) closeInspector();
  const p = eventToCanvasPixels(e.clientX, e.clientY);
  const GRAB_RADIUS = 14; // canvas px — forgiving, so grabs never redraw by accident
  for (const h of shapeHandlePoints()) {
    if (Math.hypot(p.x - h.sx, p.y - h.sy) < GRAB_RADIUS) {
      e.preventDefault();
      beginHandleDrag(e, h.role);
      return;
    }
  }
  const hit = engine.castRay(p.x, p.y);
  if (!hit) return;
  e.preventDefault();
  const start = new Float64Array([hit.nx, hit.ny, hit.nz]);
  // a bare click (no drag) still yields a visible, sampleable shape —
  // a circle of min radius, or a short eastward arc; dragging or the
  // handles can take both anywhere afterwards
  const MIN_ARC = 0.35;
  const lineEnd = new Float64Array(start);
  if (mode === 'line') {
    const cA = Math.cos(MIN_ARC), sA = Math.sin(MIN_ARC);
    lineEnd[0] = start[0] * cA + start[2] * sA;
    lineEnd[2] = -start[0] * sA + start[2] * cA;
  }
  shape = mode === 'line'
    ? { kind: 'line', a: start, b: lineEnd, rho: 0, rotate: 0 }
    : { kind: 'circle', a: start, b: lineEnd, rho: MIN_ARC, rotate: 0 };
  let dragging = false;
  const move = (ev: PointerEvent) => {
    const q = eventToCanvasPixels(ev.clientX, ev.clientY);
    // a couple of pixels of press jiggle is still a click — the initial
    // shape only starts following the cursor after real movement
    if (!dragging && Math.hypot(q.x - p.x, q.y - p.y) < 5) return;
    dragging = true;
    const h2 = engine.castRay(q.x, q.y);
    if (h2 && shape) {
      if (shape.kind === 'line') {
        shape.b[0] = h2.nx; shape.b[1] = h2.ny; shape.b[2] = h2.nz;
      } else {
        shape.rho = Math.acos(clampDot(shape.a[0] * h2.nx + shape.a[1] * h2.ny + shape.a[2] * h2.nz));
      }
      recomputeShapeColors();
      updateShapeOverlay();
      updateStops();
    }
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  recomputeShapeColors();
  updateShapeOverlay();
  updateStops();
});

shapeHandles.addEventListener('pointerdown', e => {
  const el = (e.target as HTMLElement).closest('.shape-handle') as HTMLElement | null;
  if (!el || !shape) return;
  e.preventDefault();
  e.stopPropagation();
  if (selectedLight >= 0) closeInspector();
  beginHandleDrag(e, el.dataset.handle as HandleRole);
});

function deleteShape() {
  shape = null;
  shapeColors = [];
  updateShapeOverlay();
  updateStops();
}

const segButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.seg__btn[data-mode]'));
const shapeCountWrap = document.getElementById('shapeCountWrap')!;
const shapeCountInput = document.getElementById('shapeCount') as HTMLInputElement;
const shapeCountSlider = shapeCountWrap.querySelector('.numberslider') as HTMLElement;
const shapeCountMinus = document.getElementById('shapeCountMinus')!;
const shapeCountPlus = document.getElementById('shapeCountPlus')!;

const spacingSeg = document.getElementById('spacingSeg')!;
const spacingButtons = Array.from(spacingSeg.querySelectorAll<HTMLButtonElement>('.seg__btn'));

function normalize3(x: number, y: number, z: number) {
  const l = Math.sqrt(x * x + y * y + z * z) || 1;
  return new Float64Array([x / l, y / l, z / l]);
}

// Every mode starts populated, so switching always shows something to edit
function ensureModeDefaults() {
  if (mode === 'points') {
    if (samples.length === 0) createSampleAt(new Float64Array([0, 0, -1]));
  } else if (mode === 'circle') {
    if (!shape || shape.kind !== 'circle') {
      const center = new Float64Array([0, 0, -1]); // facing the camera
      shape = { kind: 'circle', a: center, b: new Float64Array(center), rho: Math.asin(0.8), rotate: 0 };
    }
  } else if (mode === 'line') {
    if (!shape || shape.kind !== 'line') {
      shape = {
        kind: 'line',
        a: normalize3(-0.6, 0.35, -0.75),
        b: normalize3(0.6, -0.35, -0.75),
        rho: 0,
        rotate: 0,
      };
    }
  }
}

function setMode(next: SampleMode) {
  mode = next;
  segButtons.forEach(b => b.classList.toggle('seg__btn--active', b.dataset.mode === mode));
  shapeCountWrap.hidden = mode === 'points';
  // spacing only matters for open shapes: on a closed circle smoothstep just
  // bunches points at the seam, so the UI offers it for lines only
  spacingSeg.hidden = mode !== 'line';
  sampleLayer.toggleAttribute('hidden', mode !== 'points');
  ensureModeDefaults();
  recomputeShapeColors();
  updateShapeOverlay();
  updateStops();
}

segButtons.forEach(b => b.addEventListener('click', () => {
  sound.playTack();
  setMode(b.dataset.mode as SampleMode);
}));

// OKPalette-style numberslider: - / + steppers around a number input,
// with a --relval fill on the pill while focused
function syncShapeCountFill() {
  const min = parseInt(shapeCountInput.min, 10) || 2;
  const max = parseInt(shapeCountInput.max, 10) || 32;
  shapeCountSlider.style.setProperty('--relval', String((shapeCount - min) / (max - min)));
}

function shapeCountChanged() {
  syncShapeCountFill();
  recomputeShapeColors();
  updateShapeOverlay();
  updateStops();
}

function applyShapeCount(next: number) {
  const min = parseInt(shapeCountInput.min, 10) || 2;
  const max = parseInt(shapeCountInput.max, 10) || 32;
  shapeCount = Math.min(max, Math.max(min, next));
  shapeCountInput.value = String(shapeCount);
  shapeCountChanged();
}

shapeCountInput.addEventListener('input', () => {
  // while typing, track valid values without rewriting the field
  const v = parseInt(shapeCountInput.value, 10);
  if (Number.isNaN(v)) return;
  shapeCount = Math.min(32, Math.max(2, v));
  shapeCountChanged();
});
shapeCountInput.addEventListener('change', () => {
  applyShapeCount(parseInt(shapeCountInput.value, 10) || shapeCount);
});
shapeCountMinus.addEventListener('click', () => {
  sound.playTick();
  applyShapeCount(shapeCount - 1);
});
shapeCountPlus.addEventListener('click', () => {
  sound.playTick();
  applyShapeCount(shapeCount + 1);
});

spacingButtons.forEach(b => b.addEventListener('click', () => {
  shapeSpacing = b.dataset.spacing as keyof typeof distributions;
  spacingButtons.forEach(x => x.classList.toggle('seg__btn--active', x === b));
  recomputeShapeColors();
  updateShapeOverlay();
  updateStops();
}));

// Inspector popover — a projection of lights[selectedLight]
const inspTitle = document.getElementById('inspTitle')!;
const inspType = document.getElementById('inspType') as HTMLSelectElement;
const inspColor = document.getElementById('inspColor') as HTMLInputElement;
const inspIntensity = document.getElementById('inspIntensity') as HTMLInputElement;
const inspDist = document.getElementById('inspDist') as HTMLInputElement;
const inspAngle = document.getElementById('inspAngle') as HTMLInputElement;
const inspSize = document.getElementById('inspSize') as HTMLInputElement;
const inspDistRow = document.getElementById('inspDistRow')!;
const inspAngleRow = document.getElementById('inspAngleRow')!;
const inspSizeRow = document.getElementById('inspSizeRow')!;

function openInspector(i: number) {
  sound.playTack();
  setControlsOpen(true);
  lightHint.hidden = true;
  selectedLight = i;
  const l = lights[i];
  inspTitle.textContent = `Light ${i + 1}`;
  inspType.value = l.type;
  inspColor.value = l.hex;
  inspIntensity.value = l.intensity.toString();
  inspDist.min = state.sphereRadius.toString();
  inspDist.max = MAX_LIGHT_DISTANCE.toString();
  inspDist.value = l.dist.toString();
  inspAngle.value = l.angle.toString();
  inspSize.value = l.size.toString();
  inspAngleRow.hidden = l.type !== 'spot';
  inspSizeRow.hidden = l.type !== 'area';
  inspDistRow.classList.toggle('field--inactive', l.type === 'directional');
  inspDist.disabled = l.type === 'directional';
  syncOutputs();
  updateOrbitGlobe();
  inspector.hidden = false;
  updateLightMarkers();
}

function closeInspector() {
  selectedLight = -1;
  inspector.hidden = true;
  lightHint.hidden = false;
  updateLightMarkers();
}

function selectLight(i: number) {
  sound.playTack();
  selectedLight = i;
  if (controlsOpen()) openInspector(i);
  updateLightMarkers();
}

function beginGripDrag(e: PointerEvent, kind: 'intensity' | 'dist') {
  if (selectedLight < 0) return;
  e.preventDefault();
  e.stopPropagation();
  const li = selectedLight;

  let distDrag: { uOf: (x: number, y: number) => number; solve: (u: number) => number; uOffset: number } | null = null;
  if (kind === 'dist') {
    const lx = lightPositions[li * 3], ly = lightPositions[li * 3 + 1], lz = lightPositions[li * 3 + 2];
    const llen = Math.sqrt(lx * lx + ly * ly + lz * lz) || 1;
    const dx = lx / llen, dy = ly / llen, dz = lz / llen;
    const proj = (d: number) => {
      const s = BEAD_F * state.sphereRadius + (1 - BEAD_F) * d;
      return engine.worldToScreen(dx * s, dy * s, dz * s);
    };
    // cap so no search sample projects from behind the camera
    let hiCap = MAX_LIGHT_DISTANCE;
    if (dz < 0) {
      const sLim = (state.cameraZ + 0.75) / dz;
      const dLim = (sLim - BEAD_F * state.sphereRadius) / (1 - BEAD_F);
      hiCap = Math.max(state.sphereRadius, Math.min(hiCap, dLim));
    }
    const A = proj(state.sphereRadius);
    const B = proj(hiCap);
    const abx = B.x - A.x, aby = B.y - A.y;
    const ab2 = Math.max(abx * abx + aby * aby, 1);
    const abLen = Math.sqrt(ab2);
    const uOf = (x: number, y: number) =>
      Math.max(0, Math.min(1, ((x - A.x) * abx + (y - A.y) * aby) / ab2));
    // the bead's screen path is a line, monotone in dist
    const solve = (u: number) => {
      const target = u * abLen;
      let lo = state.sphereRadius, hi = hiCap;
      for (let k = 0; k < 24; k++) {
        const mid = (lo + hi) / 2;
        const P = proj(mid);
        if (Math.hypot(P.x - A.x, P.y - A.y) < target) lo = mid;
        else hi = mid;
      }
      return (lo + hi) / 2;
    };
    const p0 = eventToCanvasPixels(e.clientX, e.clientY, false);
    const b = beadWorld(li);
    const bp = engine.worldToScreen(b.x, b.y, b.z);
    distDrag = { uOf, solve, uOffset: uOf(bp.x, bp.y) - uOf(p0.x, p0.y) };
  }

  const move = (ev: PointerEvent) => {
    const p = eventToCanvasPixels(ev.clientX, ev.clientY, false);
    const l = lights[li];
    if (kind === 'intensity') {
      const sp = engine.worldToScreen(lightPositions[li * 3], lightPositions[li * 3 + 1], lightPositions[li * 3 + 2]);
      const r = Math.hypot(p.x - sp.x, p.y - sp.y);
      const x = Math.max(0, Math.min(INT_MAX / (INT_MAX + 1), (r - INT_R0) / INT_R1));
      l.intensity = Math.round((x / (1 - x)) * 100) / 100;
      inspIntensity.value = l.intensity.toString();
    } else if (distDrag) {
      const u = Math.max(0, Math.min(1, distDrag.uOf(p.x, p.y) + distDrag.uOffset));
      l.dist = Math.round(distDrag.solve(u) * 100) / 100;
      inspDist.value = l.dist.toString();
    }
    sound.playTick();
    syncOutputs();
    update();
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

inspType.addEventListener('change', () => {
  if (selectedLight < 0) return;
  lights[selectedLight].type = inspType.value as Light['type'];
  openInspector(selectedLight); // re-project row visibility
  update();
});
inspColor.addEventListener('input', () => {
  if (selectedLight < 0) return;
  lights[selectedLight].hex = inspColor.value;
  update();
});
inspIntensity.addEventListener('input', () => {
  if (selectedLight < 0) return;
  lights[selectedLight].intensity = parseFloat(inspIntensity.value);
  syncOutputs();
  update();
});
inspDist.addEventListener('input', () => {
  if (selectedLight < 0) return;
  lights[selectedLight].dist = parseFloat(inspDist.value);
  syncOutputs();
  update();
});
inspAngle.addEventListener('input', () => {
  if (selectedLight < 0) return;
  lights[selectedLight].angle = parseFloat(inspAngle.value);
  syncOutputs();
  update();
});
inspSize.addEventListener('input', () => {
  if (selectedLight < 0) return;
  lights[selectedLight].size = parseFloat(inspSize.value);
  syncOutputs();
  update();
});

// ---------------------------------------------------------------- scene popover

const scn = {
  sphereColor: document.getElementById('scnSphereColor') as HTMLInputElement,
  wallColor: document.getElementById('scnWallColor') as HTMLInputElement,
  radius: document.getElementById('scnRadius') as HTMLInputElement,
  fov: document.getElementById('scnFov') as HTMLInputElement,
  camera: document.getElementById('scnCamera') as HTMLInputElement,
  indirect: document.getElementById('scnIndirect') as HTMLInputElement,
  reflect: document.getElementById('scnReflect') as HTMLInputElement,
  quality: document.getElementById('scnQuality') as HTMLInputElement,
};

function readSceneInputs() {
  state.sphereHex = scn.sphereColor.value;
  state.wallHex = scn.wallColor.value;
  state.sphereRadius = parseFloat(scn.radius.value);
  state.fov = parseFloat(scn.fov.value);
  state.cameraZ = parseFloat(scn.camera.value);
  state.indirect = parseFloat(scn.indirect.value);
  const rv = parseFloat(scn.reflect.value);
  state.wallReflect.back = rv;
  state.wallReflect.left = rv;
  state.wallReflect.right = rv;
  state.wallReflect.top = rv;
  state.wallReflect.bottom = rv;
  state.areaQuality = Math.max(1, parseInt(scn.quality.value, 10) || 1);
  update();
}
Object.values(scn).forEach(input => input.addEventListener('input', readSceneInputs));

// Scene presets. The select shows a preset name only while the scene still IS that preset:
// any manual edit funnels through update(), which snaps it back to None.
const presetSelect = document.getElementById('scnPreset') as HTMLSelectElement;
let applyingPreset = false;
PRESETS.forEach((p, i) => presetSelect.add(new Option(p.name, String(i))));
presetSelect.addEventListener('change', () => {
  const preset = PRESETS[parseInt(presetSelect.value, 10)];
  if (!preset) return;
  applyingPreset = true;
  Object.assign(state, structuredClone(preset.scene));
  preset.lights.forEach((pl, i) => {
    if (i >= lights.length) return;
    Object.assign(lights[i], structuredClone(pl));
    // Presets are yaw/pitch/dist authored — a leftover cartesian position
    // would override them on commit()
    delete lights[i].position;
  });
  // Each preset ships a sampling shape tuned to its lighting, so loading one
  // immediately shows a considered palette
  const ps = preset.shape;
  shape = {
    kind: ps.kind,
    a: new Float64Array(ps.a),
    b: new Float64Array(ps.b ?? ps.a),
    rho: ps.rho ?? 0,
    rotate: ps.rotate ?? 0,
  };
  shapeCount = ps.count;
  shapeCountInput.value = String(shapeCount);
  syncShapeCountFill();
  shapeSpacing = ps.spacing ?? 'linear';
  spacingButtons.forEach(b => b.classList.toggle('seg__btn--active', b.dataset.spacing === shapeSpacing));
  setMode(ps.kind); // shape is already the right kind, so mode defaults keep it
  syncSceneInputs();
  if (selectedLight >= 0) openInspector(selectedLight); // re-sync open inspector
  update();
  updateLibSnippet();
  sound.playSuccess();
  applyingPreset = false;
});

// Push state back into the scene controls (preset load). The single
// reflectivity slider can't express per-wall values; it shows the strongest
// wall and only flattens them if the user actually drags it.
function syncSceneInputs() {
  scn.sphereColor.value = state.sphereHex;
  scn.wallColor.value = state.wallHex;
  scn.radius.value = String(state.sphereRadius);
  scn.fov.value = String(state.fov);
  scn.camera.value = String(state.cameraZ);
  scn.indirect.value = String(state.indirect);
  scn.reflect.value = String(Math.max(state.wallReflect.back, state.wallReflect.left, state.wallReflect.right, state.wallReflect.top, state.wallReflect.bottom));
  scn.quality.value = String(state.areaQuality);
  syncOutputs();
}

function syncOutputs() {
  document.querySelectorAll<HTMLOutputElement>('output').forEach(out => {
    const input = out.id ? document.getElementById(out.id.replace('Out', '')) as HTMLInputElement | null : null;
    if (input) out.textContent = input.value;
  });
  rangeSyncs.forEach(sync => sync());
}

// ---------------------------------------------------------------- gradient stops

const colorOverlay = document.getElementById('colorOverlay')!;
const drawerToggleBtn = document.getElementById('drawerToggleBtn')!;
const paletteEl = document.getElementById('palette')!;

drawerToggleBtn.addEventListener('click', e => {
  e.stopPropagation();
  setColorsOpen(!colorsOpen());
});

const paletteNameEl = document.getElementById('paletteName')!;
document.getElementById('closeColorsBtn')!.addEventListener('click', e => {
  e.stopPropagation();
  setColorsOpen(false);
});
let selectedSample: Sample | null = null;

const hex6 = (c: ArrayLike<number>) =>
  toSRGB8(c[0]).toString(16).padStart(2, '0') +
  toSRGB8(c[1]).toString(16).padStart(2, '0') +
  toSRGB8(c[2]).toString(16).padStart(2, '0');

const colorsOpen = () => document.body.classList.contains('colors-open');

function setColorsOpen(open: boolean) {
  if (open) setControlsOpen(false); // one drawer at a time
  if (colorsOpen() !== open) sound.playToggle(open);
  if (!open) {
    colorOverlay.querySelector('.l-overlay__body')?.scrollTo({ top: 0, behavior: 'smooth' });
  }
  document.body.classList.toggle('colors-open', open);
  if (open) requestColorNames();
}

// The sidebar itself is the toggle: click the closed rail to open; when open,
// clicking the swatch rail (or empty panel space) closes it again. Row info
// selects, and the export footer keeps its own actions.
const controlOverlay = document.getElementById('controlOverlay')!;
const controlsToggleBtn = document.getElementById('controlsToggleBtn')!;
const lightHint = document.getElementById('lightHint')!;
const controlsOpen = () => document.body.classList.contains('controls-open');

function setControlsOpen(open: boolean) {
  if (open) setColorsOpen(false); // one drawer at a time
  if (controlsOpen() !== open) sound.playToggle(open);
  document.body.classList.toggle('controls-open', open);
}

controlsToggleBtn.addEventListener('click', e => {
  e.stopPropagation();
  setControlsOpen(!controlsOpen());
});

controlOverlay.addEventListener('click', e => {
  const t = e.target as HTMLElement;
  const rail = t.closest('.control-rail__light') as HTMLElement | null;
  if (rail) {
    openInspector(parseInt(rail.dataset.railLight || '0', 10));
    return;
  }
  if (!controlsOpen()) {
    setControlsOpen(true);
    return;
  }
  if (t.closest('.l-overlay__body--controls')) return;
  setControlsOpen(false);
});

colorOverlay.addEventListener('click', e => {
  const t = e.target as HTMLElement;
  if (!colorsOpen()) {
    setColorsOpen(true);
    return;
  }
  if (t.closest('.l-overlay__footer') || t.closest('.palette__row-info') || t.closest('.lib-snippet')) return;
  setColorsOpen(false);
});

const libSnippetPre = document.querySelector('.lib-snippet .code')!;
libSnippetPre.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(libSnippetCode.textContent || '');
    sound.playSuccess();
    libSnippetPre.classList.add('code--copied');
    setTimeout(() => libSnippetPre.classList.remove('code--copied'), 1200);
  } catch { /* clipboard unavailable */ }
});

// Color names via api.color.pizza (debounced + abortable, cached per hex)
const colorNameCache = new Map<string, string>();
let nameTimer: number | undefined;
let nameAbort: AbortController | null = null;

function applyColorNames() {
  document.querySelectorAll<HTMLElement>('.palette__row-name').forEach(el => {
    const name = colorNameCache.get(el.dataset.hex || '');
    if (name) el.textContent = name;
  });
}

let lastPaletteKey = '';

function requestColorNames() {
  if (!colorsOpen()) return;
  applyColorNames();
  // Full palette every time: the response's paletteTitle names the drawer,
  // like OKPalette's header (per-hex names still come from the cache)
  const values = [...new Set(activeColors().map(hex6))];
  if (!values.length) {
    paletteNameEl.textContent = '';
    lastPaletteKey = '';
    return;
  }
  const key = values.join(',');
  if (key === lastPaletteKey) return;
  clearTimeout(nameTimer);
  nameAbort?.abort();
  nameTimer = window.setTimeout(() => {
    nameAbort = new AbortController();
    fetch(`https://api.color.pizza/v1/?values=${key}&list=bestOf&noduplicates=true`, { signal: nameAbort.signal })
      .then(r => r.json())
      .then(data => {
        lastPaletteKey = key;
        for (const c of data.colors ?? []) {
          colorNameCache.set(String(c.requestedHex).replace('#', '').toLowerCase(), c.name);
        }
        if (data.paletteTitle) paletteNameEl.textContent = data.paletteTitle;
        applyColorNames();
      })
      .catch(() => { /* offline or aborted — rows keep showing their hex */ });
  }, 400);
}

// Living documentation: a snippet that reproduces the current palette
// headlessly with the ray-color engine
const libSnippetCode = document.getElementById('libSnippetCode')!;

function updateLibSnippet() {
  const fmt = (n: number) => String(Math.round(n * 1000) / 1000);
  const vec = (v: ArrayLike<number>) => `[${fmt(v[0])}, ${fmt(v[1])}, ${fmt(v[2])}]`;
  // Wrap object literals onto short lines (recursively) so the block barely scrolls
  const wrapProps = (o: Record<string, unknown>, indent: string, budget = 40): string => {
    const inner = indent + '  ';
    const parts = Object.entries(o).filter(([k]) => k !== 'position').map(([k, v]) => {
      if (typeof v === 'string') return `${k}: '${v}'`;
      if (typeof v === 'object' && v !== null) return `${k}: ${wrapProps(v as Record<string, unknown>, inner, budget)}`;
      return `${k}: ${fmt(v as number)}`;
    });
    const lines: string[] = [];
    let cur = '';
    for (const p of parts) {
      if (p.includes('\n')) {
        if (cur) { lines.push(cur); cur = ''; }
        lines.push(p);
        continue;
      }
      if (cur && (cur + ', ' + p).length > budget) { lines.push(cur); cur = p; }
      else cur = cur ? cur + ', ' + p : p;
    }
    if (cur) lines.push(cur);
    return '{\n' + inner + lines.join(',\n' + inner) + '\n' + indent + '}';
  };

  let samplerImport = '';
  let sampler: string;
  if (shape && mode === 'circle') {
    samplerImport = ',\n  sampleCircleDirs';
    const rot = Math.abs(shape.rotate) > 0.05 ? `,\n  { rotate: ${fmt(shape.rotate)} }` : '';
    sampler = `const dirs = sampleCircleDirs(\n  ${vec(shape.a)}, ${fmt(shape.rho)}, ${shapeCount}${rot}\n);`;
  } else if (shape && mode === 'line') {
    samplerImport = ',\n  sampleLineDirs, distributions';
    sampler = `const dirs = sampleLineDirs(\n  ${vec(shape.a)},\n  ${vec(shape.b)},\n  ${shapeCount}, distributions.${shapeSpacing}\n);`;
  } else {
    sampler = `const dirs = [\n${samples.map(s => '  ' + vec(s.dir)).join(',\n')}\n];`;
  }

  libSnippetCode.textContent = `import {
  createEngine, toSRGB8${samplerImport}
} from 'ray-color';

const engine = createEngine(
  ${wrapProps(state as unknown as Record<string, unknown>, '  ')},
  [
${lights.map(l => '    ' + wrapProps(l as unknown as Record<string, unknown>, '    ')).join(',\n')}
  ]
);
engine.commit();

${sampler}
const palette = dirs.map(d =>
  ({ ...engine.shade(d) })); // linear RGB
const hex = palette.map(c =>
  '#' + [c.r, c.g, c.b]
    .map(v => toSRGB8(v).toString(16)
    .padStart(2, '0')).join(''));`;
}

function renderPalette(colors: ArrayLike<number>[]) {
  paletteEl.innerHTML = '';
  if (colors.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'palette__empty';
    empty.textContent = 'Click the sphere to sample colors.';
    paletteEl.appendChild(empty);
  }
  colors.forEach((c, i) => {
    const h = hex6(c);
    const row = document.createElement('div');
    row.className = 'palette__row';
    row.style.setProperty('--i', String(i / colors.length)); // OKPalette's relI
    row.addEventListener('mouseenter', () => sound.playTack());
    if (mode === 'points' && samples[i] === selectedSample) row.classList.add('palette__row--selected');
    const sw = document.createElement('div');
    sw.className = 'palette__swatch';
    sw.style.background = '#' + h;
    const info = document.createElement('div');
    info.className = 'palette__row-info';
    const head = document.createElement('div');
    head.className = 'palette__row-info-header';
    const name = document.createElement('div');
    name.className = 'palette__row-name';
    name.dataset.hex = h;
    name.textContent = colorNameCache.get(h) ?? '\u2026';
    const deco = document.createElement('span');
    deco.className = 'palette__row-info-deco';
    const hexEl = document.createElement('div');
    hexEl.className = 'palette__row-hex';
    hexEl.textContent = '#' + h;
    head.append(name, deco, hexEl);
    info.appendChild(head);
    row.append(sw, info);
    if (mode === 'points') {
      info.addEventListener('click', () => {
        if (colorsOpen()) selectSample(samples[i]);
      });
    }
    paletteEl.appendChild(row);
  });
  if (colorsOpen()) requestColorNames();
}

function paletteData() {
  return activeColors().map(c => {
    const h = hex6(c);
    return { hex: '#' + h, name: colorNameCache.get(h) || '#' + h };
  });
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Token Beam: live-sync the palette to paired tools (as in OKPalette)
const tokenBeamBtn = document.getElementById('tokenBeamBtn')!;
const TOKEN_BEAM_SERVER_URL = 'wss://tokenbeam.dev';
const ERROR_TOKEN_BEAM_LABEL = 'error beam';
let tokenBeamClient: SourceSession | null = null;
let tokenBeamSessionToken: string | null = null;
let tokenBeamConnectedTargets = 0;

const setTokenBeamLabel = (label: string) => {
  const text = tokenBeamBtn.querySelector('span');
  if (text) text.textContent = label;
};

const setTokenBeamConnectedState = (isConnected: boolean) => {
  tokenBeamBtn.classList.toggle('is-connected', isConnected);
};

const buildTokenBeamPayload = () => {
  const tokenEntries: Record<string, string> = {};
  paletteData().forEach((color, index) => {
    tokenEntries[`color/${String(index + 1).padStart(2, '0')}`] = color.hex;
  });
  return createCollection('RayColor', tokenEntries);
};

function syncPaletteToTokenBeam() {
  if (!tokenBeamClient || activeColors().length === 0) return;
  tokenBeamClient.sync(buildTokenBeamPayload());
}

const ensureTokenBeamSession = async () => {
  if (tokenBeamClient) return true;
  tokenBeamClient = new SourceSession({
    serverUrl: TOKEN_BEAM_SERVER_URL,
    clientType: 'web',
    origin: 'RayColor',
    icon: { type: 'unicode', value: '\u{1F526}' },
  });
  tokenBeamClient.on('paired', ({ sessionToken }: { sessionToken: string }) => {
    tokenBeamSessionToken = sessionToken;
    tokenBeamConnectedTargets = 0;
    setTokenBeamConnectedState(false);
    setTokenBeamLabel(sessionToken);
  });
  tokenBeamClient.on('peer-connected', () => {
    tokenBeamConnectedTargets += 1;
    setTokenBeamConnectedState(true);
    syncPaletteToTokenBeam();
  });
  tokenBeamClient.on('peer-disconnected', () => {
    tokenBeamConnectedTargets = Math.max(0, tokenBeamConnectedTargets - 1);
    setTokenBeamConnectedState(tokenBeamConnectedTargets > 0);
  });
  tokenBeamClient.on('disconnected', () => {
    tokenBeamConnectedTargets = 0;
    setTokenBeamConnectedState(false);
    setTokenBeamLabel(ERROR_TOKEN_BEAM_LABEL);
  });
  tokenBeamClient.on('warning', () => {});
  tokenBeamClient.on('error', () => {
    setTokenBeamConnectedState(false);
    setTokenBeamLabel(ERROR_TOKEN_BEAM_LABEL);
  });
  try {
    await tokenBeamClient.connect();
    return true;
  } catch (error) {
    console.warn('Failed to connect to Token Beam:', error);
    tokenBeamClient = null;
    setTokenBeamConnectedState(false);
    setTokenBeamLabel(ERROR_TOKEN_BEAM_LABEL);
    return false;
  }
};

ensureTokenBeamSession();

tokenBeamBtn.addEventListener('click', async e => {
  e.stopPropagation();
  const isConnected = tokenBeamClient || (await ensureTokenBeamSession());
  if (!isConnected) return;
  if (tokenBeamSessionToken) {
    navigator.clipboard.writeText(tokenBeamSessionToken).catch(() => {});
    sound.playSuccess();
    return;
  }
  setTokenBeamLabel(ERROR_TOKEN_BEAM_LABEL);
});

const copyPaletteBtn = document.getElementById('copyPaletteBtn')!;
copyPaletteBtn.addEventListener('click', async e => {
  e.stopPropagation();
  const label = copyPaletteBtn.querySelector('span')!;
  try {
    await navigator.clipboard.writeText(paletteData().map(c => `${c.hex} | ${c.name}`).join('\n'));
    sound.playSuccess();
    label.textContent = 'Copied';
  } catch {
    label.textContent = 'Failed';
  }
  setTimeout(() => { label.textContent = 'Copy'; }, 1200);
});

document.getElementById('downloadPaletteBtnPNG')!.addEventListener('click', e => {
  e.stopPropagation();
  const colors = paletteData();
  if (!colors.length) return;
  ensureSettledCanvas();
  // Render + color strip below, like OKPalette's image export
  const stripHeight = 80;
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height + stripHeight;
  const octx = out.getContext('2d')!;
  octx.drawImage(canvas, 0, 0);
  // The sample dots, as drawn on screen — so the image explains itself
  if (mode !== 'points' && shape) {
    shapeSampleDirs().forEach((d, i) => {
      const p = projectDirPct(d);
      const col = shapeColors[i];
      octx.globalAlpha = dirIsBehind(d) ? 0.3 : 1; // faded through the sphere, like on screen
      octx.beginPath();
      octx.arc(p.sx, p.sy, 4, 0, Math.PI * 2);
      octx.fillStyle = col ? `rgb(${toSRGB8(col[0])}, ${toSRGB8(col[1])}, ${toSRGB8(col[2])})` : '#fff';
      octx.fill();
      octx.lineWidth = 1.5;
      octx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
      octx.stroke();
    });
    octx.globalAlpha = 1;
  }
  const colorWidth = out.width / colors.length;
  colors.forEach((c, i) => {
    octx.fillStyle = c.hex;
    octx.fillRect(i * colorWidth, canvas.height, colorWidth + 1, stripHeight);
  });
  sound.playSuccess();
  // Name the file after the palette when color.pizza has titled the current
  // colors (the title sticks around after edits, so check it isn't stale)
  const fresh = lastPaletteKey === [...new Set(activeColors().map(hex6))].join(',');
  const slug = fresh
    ? (paletteNameEl.textContent ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    : '';
  out.toBlob(blob => { if (blob) downloadBlob(blob, slug ? `ray-color-${slug}.png` : 'ray-color-palette.png'); });
});

function activeColors(): ArrayLike<number>[] {
  return mode === 'points' ? samples.map(s => s.color) : shapeColors;
}

function cssStops(): string {
  const colors = activeColors();
  const seg = 100 / colors.length;
  return colors.map((c, i) => {
    // Same sRGB encoding as the renderer, so stops match the pixels exactly
    const r = toSRGB8(c[0]), g = toSRGB8(c[1]), b = toSRGB8(c[2]);
    const end = i === colors.length - 1 ? 100 : (i + 1) * seg;
    return `rgb(${r}, ${g}, ${b}) ${(i * seg).toFixed(1)}% ${end.toFixed(1)}%`;
  }).join(', ');
}

function updateStops() {
  const colors = activeColors();
  document.documentElement.style.setProperty('--stops', colors.length ? cssStops() : 'transparent 0% 100%');
  renderPalette(colors);
  updateSamplesRotWidget(); // every sample mutation funnels through here
  updateLibSnippet();
  syncPaletteToTokenBeam();
}

function selectSample(sample: Sample | null) {
  selectedSample = sample;
  samples.forEach(s => s.marker.classList.toggle('marker--selected', s === selectedSample));
  document.querySelectorAll('.palette__row').forEach((row, i) =>
    row.classList.toggle('palette__row--selected', mode === 'points' && samples[i] === selectedSample));
}

function deleteSelectedSample() {
  if (!selectedSample) return;
  if (samples.length <= 1) return; // one point is the minimum
  selectedSample.marker.remove();
  samples = samples.filter(s => s !== selectedSample);
  selectedSample = null;
  updateStops();
}

// ---------------------------------------------------------------- update pipeline

function update() {
  engine.commit();
  // Any change that isn't a preset load means the scene is no longer that
  // preset — snap the picker back to None
  if (!applyingPreset && presetSelect.value !== '') presetSelect.value = '';
  samples.forEach(sample => {
    const color = engine.shade(sample.dir);
    sample.color[0] = color.r;
    sample.color[1] = color.g;
    sample.color[2] = color.b;
    updateSampleMarker(sample);
  });
  recomputeShapeColors(); // the shape re-lights with the scene, like points do
  updateShapeOverlay();
  updateStops();
  updateLightMarkers();
  if (selectedLight >= 0) {
    inspDist.value = lights[selectedLight].dist.toString();
    updateOrbitGlobe();
  }
  syncOutputs();
  requestRender();
}

// ---------------------------------------------------------------- interactions

canvas.addEventListener('click', event => {
  if (selectedLight >= 0) {
    closeInspector();
    return; // first click just dismisses the inspector
  }
  if (mode !== 'points') return; // shape modes sample by dragging
  const { x, y } = eventToCanvasPixels(event.clientX, event.clientY);
  const hit = engine.castRay(x, y);
  if (!hit) return;
  createSampleAt(new Float64Array([hit.nx, hit.ny, hit.nz]));
  sound.playTack();
});

function createSampleAt(dir: Float64Array) {
  const color = engine.shade(dir);
  const marker = document.createElement('div');
  marker.className = 'marker sample-marker';
  const sample: Sample = { dir, color: new Float64Array([color.r, color.g, color.b]), marker };
  marker.addEventListener('pointerdown', e => beginSampleDrag(e, sample));
  sampleLayer.appendChild(marker);
  updateSampleMarker(sample);
  samples.push(sample);
  selectSample(sample); // a fresh sample is the active one — backspace removes it
  updateStops();
}

function beginSampleDrag(event: PointerEvent, sample: Sample) {
  event.preventDefault();
  event.stopPropagation();
  if (selectedLight >= 0) closeInspector();
  selectSample(sample);
  beginSurfaceDrag(event, sample.dir, () => {
    const color = engine.shade(sample.dir);
    sample.color[0] = color.r;
    sample.color[1] = color.g;
    sample.color[2] = color.b;
    updateSampleMarker(sample);
    updateStops();
  });
}

let draggedLight = -1;

lightLayer.addEventListener('pointerdown', e => {
  const gripEl = (e.target as HTMLElement).closest('[data-grip]') as HTMLElement | null;
  if (gripEl) {
    beginGripDrag(e, gripEl.dataset.grip as 'intensity' | 'dist');
    return;
  }
  const markerEl = (e.target as HTMLElement).closest('.light-marker') as HTMLElement | null;
  if (!markerEl || markerEl.dataset.light === undefined) return;
  e.preventDefault();
  draggedLight = parseInt(markerEl.dataset.light, 10);
  const li = draggedLight;
  if (selectedLight !== li) selectLight(li);
  const len = Math.hypot(lightPositions[li * 3], lightPositions[li * 3 + 1], lightPositions[li * 3 + 2]) || 1;
  const dir = new Float64Array([
    lightPositions[li * 3] / len,
    lightPositions[li * 3 + 1] / len,
    lightPositions[li * 3 + 2] / len,
  ]);
  beginSurfaceDrag(e, dir, () => {
    const l = lights[li];
    const a = positionToAngles(dir[0], dir[1], dir[2]);
    l.yaw = Math.round(a.yaw);
    l.pitch = Math.round(Math.max(-89, Math.min(89, a.pitch)));
    update();
  });
  const up = () => {
    window.removeEventListener('pointerup', up);
    draggedLight = -1;
  };
  window.addEventListener('pointerup', up);
});

lightLayer.addEventListener('wheel', e => {
  const markerEl = (e.target as HTMLElement).closest('.light-marker') as HTMLElement | null;
  if (!markerEl || markerEl.dataset.light === undefined) return;
  e.preventDefault();
  const l = lights[parseInt(markerEl.dataset.light, 10)];
  if (l.type === 'directional') return; // distance means nothing for a directional light
  l.dist = Math.min(MAX_LIGHT_DISTANCE, Math.max(state.sphereRadius, l.dist + (e.deltaY > 0 ? 0.15 : -0.15)));
  update();
}, { passive: false });

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  state.cameraZ = Math.min(-2, Math.max(-10, state.cameraZ - e.deltaY * 0.005));
  // keep the drawer's dolly slider honest
  scn.camera.value = String(state.cameraZ);
  syncOutputs();
  update();
}, { passive: false });

window.addEventListener('keydown', e => {
  const target = e.target as HTMLElement;
  const inField = target.tagName === 'INPUT' || target.tagName === 'SELECT';
  if (e.key === 'Escape') {
    closeInspector();
    selectSample(null);
    setColorsOpen(false);
    setControlsOpen(false);
  } else if ((e.key === 'Backspace' || e.key === 'Delete') && !inField) {
    e.preventDefault();
    if (mode === 'points') deleteSelectedSample();
    else deleteShape();
  } else if ((e.key === '1' || e.key === '2' || e.key === '3') && !inField) {
    openInspector(parseInt(e.key, 10) - 1);
  }
});

// ---------------------------------------------------------------- play: orbit the lights

const playBtn = document.getElementById('playBtn') as HTMLButtonElement;
// Each light orbits around its own axis: horizontal ring, vertical loop over
// the poles, and a circle in the view plane — at slightly different speeds
const ORBIT_AXES = [
  { axis: 'y', speed: 24 },
  { axis: 'x', speed: -18 },
  { axis: 'z', speed: 21 },
] as const;
let playing = false;
let lastFrameTime = 0;

function playFrame(now: number) {
  if (!playing) return;
  const dt = Math.min(100, now - lastFrameTime); // clamp pauses (tab switches)
  lastFrameTime = now;
  for (let i = 0; i < 3; i++) {
    const l = lights[i];
    const { axis, speed } = ORBIT_AXES[i];
    const a = (speed * dt / 1000) * Math.PI / 180;
    const yaw = l.yaw * Math.PI / 180;
    const pitch = l.pitch * Math.PI / 180;
    let vx = Math.cos(pitch) * Math.cos(yaw);
    let vy = Math.sin(pitch);
    let vz = Math.cos(pitch) * Math.sin(yaw);
    const c = Math.cos(a), s = Math.sin(a);
    if (axis === 'y') {
      const nx = vx * c - vz * s;
      vz = vx * s + vz * c;
      vx = nx;
    } else if (axis === 'x') {
      const ny = vy * c - vz * s;
      vz = vy * s + vz * c;
      vy = ny;
    } else {
      const nx = vx * c - vy * s;
      vy = vx * s + vy * c;
      vx = nx;
    }
    l.pitch = Math.max(-89, Math.min(89, Math.asin(Math.max(-1, Math.min(1, vy))) * 180 / Math.PI));
    l.yaw = Math.atan2(vz, vx) * 180 / Math.PI;
  }
  update();
  requestAnimationFrame(playFrame);
}

playBtn.addEventListener('click', () => {
  playing = !playing;
  playBtn.innerHTML = playing ? '&#10074;&#10074;' : '&#9654;';
  playBtn.setAttribute('aria-pressed', String(playing));
  if (playing) {
    lastFrameTime = performance.now();
    requestAnimationFrame(playFrame);
  }
});

// ---------------------------------------------------------------- boot

// Wrap every range input in OKPalette's ruler-slider chrome
function enhanceRangeInputs() {
  document.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach(input => {
    const wrap = document.createElement('div');
    wrap.className = 'range';
    wrap.style.setProperty('--center', '0');
    input.parentNode!.insertBefore(wrap, input);
    wrap.appendChild(input);
    const highlight = document.createElement('div');
    highlight.className = 'range-highlight';
    const marker = document.createElement('div');
    marker.className = 'range-marker';
    wrap.append(highlight, marker);
    const sync = () => {
      const min = parseFloat(input.min || '0');
      const max = parseFloat(input.max || '100');
      const v = parseFloat(input.value);
      wrap.style.setProperty('--progress', String(max > min ? (v - min) / (max - min) : 0));
    };
    input.addEventListener('input', sync);
    rangeSyncs.push(sync);
    sync();
  });
}
const rangeSyncs: Array<() => void> = [];

enhanceRangeInputs();

// The engine's buffers are sized at creation, so a layout change means a new
// engine — same scene/lights refs, so nothing else needs rewiring
let resizeTimer: number | undefined;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    const size = displaySize();
    if (size === canvas.width) return;
    canvas.width = canvas.height = size;
    imageData = ctx!.createImageData(size, size);
    engine = createEngine(size, size, state, lights);
    lightPositions = engine.lightPositions;
    glPreview?.resize(size, size);
    update();
    updateLibSnippet();
  }, 150);
});

syncOutputs();
engine.commit();
setMode(mode); // applies mode defaults AND the toolbar's mode-specific controls
update();
