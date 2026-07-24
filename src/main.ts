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
  sampleLineDirs,
  sampleCircleDirs,
  distributions,
  type Light,
  type Scene,
} from './engine';

const sound = new SoundManager();
window.addEventListener('pointerdown', () => sound.unlock(), { capture: true });
window.addEventListener('keydown', () => sound.unlock(), { capture: true });

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d');
if (!ctx) throw new Error('Canvas 2D context unavailable');
const imageData = ctx.createImageData(canvas.width, canvas.height);

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

const engine = createEngine(canvas.width, canvas.height, state, lights);
const lightPositions = engine.lightPositions;

interface Sample {
  // Float64 to match the renderer's precision exactly — float32 rounding
  // shows up as off-by-one channel values after sRGB encoding
  dir: Float64Array; // unit direction from sphere center (surface anchor)
  color: Float64Array;
  marker: HTMLElement;
}
let samples: Sample[] = [];
let selectedLight = -1;

// Sampling mode: individual points, or one shape (geodesic line / circle)
// drawn on the sphere that samples N colors along it
type SampleMode = 'points' | 'line' | 'circle';
let mode: SampleMode = 'circle';
interface SurfaceShape {
  kind: 'line' | 'circle';
  a: Float64Array;   // line start / circle center (unit direction)
  b: Float64Array;   // line end (unit direction)
  rho: number;       // circle angular radius (radians)
}
let shape: SurfaceShape | null = null;
let shapeColors: Float64Array[] = [];
let shapeCount = 5;
let shapeSpacing: keyof typeof distributions = 'linear';

// ---------------------------------------------------------------- rendering

async function startRender() {
  engine.beginFrame();
  for (let pass = 0; pass < DEFAULT_PASS_SCALES.length; pass++) {
    engine.renderPass(imageData.data, DEFAULT_PASS_SCALES[pass], pass === 0 ? 0 : DEFAULT_PASS_SCALES[pass - 1]);
    ctx!.putImageData(imageData, 0, 0);
    await new Promise(requestAnimationFrame);
  }
}

let renderInProgress = false;
let pendingRender = false;

async function requestRender() {
  if (renderInProgress) {
    pendingRender = true;
    return;
  }
  renderInProgress = true;
  await startRender();
  renderInProgress = false;
  if (pendingRender) {
    pendingRender = false;
    requestRender();
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

// Black or white, whichever contrasts better on the given color
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
  updateGizmo();
}

function updateGizmo() {
  gizmoSvg.setAttribute('viewBox', `0 0 ${canvas.width} ${canvas.height}`);
  gizmoSvg.innerHTML = '';
  if (selectedLight < 0) return;
  const i = selectedLight;
  const screenPos = engine.worldToScreen(lightPositions[i * 3], lightPositions[i * 3 + 1], lightPositions[i * 3 + 2]);
  if (screenPos.z <= 0) return;
  const { x: cx, y: cy } = clampToCanvasAlongLine(screenPos.x, screenPos.y);
  const NS = 'http://www.w3.org/2000/svg';
  const type = lights[i].type;
  if (type === 'directional' || type === 'spot') {
    // Aim line from the light to where its ray meets the sphere's surface.
    // Sampled in 3D and split into visible / sphere-occluded portions.
    const lx = lightPositions[i * 3], ly = lightPositions[i * 3 + 1], lz = lightPositions[i * 3 + 2];
    const llen = Math.sqrt(lx * lx + ly * ly + lz * lz) || 1;
    const s = state.sphereRadius / llen;
    const ex = lx * s, ey = ly * s, ez = lz * s;
    const N = 32;
    let visD = '', hidD = '', pv = false, ph = false;
    for (let k = 0; k <= N; k++) {
      const t = k / N;
      const wx = lx + (ex - lx) * t;
      const wy = ly + (ey - ly) * t;
      const wz = lz + (ez - lz) * t;
      const hidden = engine.isPointOccluded(wx, wy, wz);
      const p = engine.worldToScreen(wx, wy, wz);
      const pt = p.x.toFixed(1) + ' ' + p.y.toFixed(1) + ' ';
      if (!hidden) { visD += (pv ? 'L' : 'M') + pt; pv = true; ph = false; }
      else { hidD += (ph ? 'L' : 'M') + pt; ph = true; pv = false; }
    }
    if (hidD) {
      const hid = document.createElementNS(NS, 'path');
      hid.setAttribute('d', hidD);
      hid.setAttribute('class', 'gizmo-line--hidden');
      gizmoSvg.appendChild(hid);
    }
    if (visD) {
      for (const [width, cls] of [['3', 'gizmo-line-casing'], ['1', 'gizmo-line']] as const) {
        const path = document.createElementNS(NS, 'path');
        path.setAttribute('d', visD);
        path.setAttribute('stroke-width', width);
        path.setAttribute('class', cls);
        gizmoSvg.appendChild(path);
      }
    }
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

// ---------------------------------------------------------------- shape sampling
// One shape at a time, anchored to the sphere's surface: a geodesic arc
// between two anchors, or a circle of angular radius rho around a center.

const shapeSvg = document.getElementById('shape-svg')!;
const shapeHandles = document.getElementById('shape-handles')!;

// The N unit directions the current shape samples — geometry from the engine,
// point spacing via the selected Distribution (linear / smoothstep)
function shapeSampleDirs(): Float64Array[] {
  if (!shape) return [];
  const spacing = distributions[shapeSpacing];
  return shape.kind === 'line'
    ? sampleLineDirs(shape.a, shape.b, shapeCount, spacing)
    : sampleCircleDirs(shape.a, shape.rho, shapeCount, spacing);
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

function makeShapeHandle(role: 'a' | 'b' | 'r', title: string) {
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

  // Sample dots, filled with the color they sample
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

  // Handles: line endpoints, or circle center + radius grip
  if (shape.kind === 'line') {
    for (const [role, dir, title] of [['a', shape.a, 'Line start'], ['b', shape.b, 'Line end']] as const) {
      const h = makeShapeHandle(role, `${title} — drag to move`);
      const p = projectDirPct(dir);
      h.style.left = `${p.x}%`;
      h.style.top = `${p.y}%`;
      h.classList.toggle('shape-handle--behind', dirIsBehind(dir));
    }
  } else {
    const center = makeShapeHandle('a', 'Circle center — drag to move');
    const pc = projectDirPct(shape.a);
    center.style.left = `${pc.x}%`;
    center.style.top = `${pc.y}%`;
    center.classList.toggle('shape-handle--behind', dirIsBehind(shape.a));
    const grip = makeShapeHandle('r', 'Circle radius — drag to resize');
    circleDir(shape.a, shape.rho, 0, pt);
    const pg = projectDirPct(pt);
    grip.style.left = `${pg.x}%`;
    grip.style.top = `${pg.y}%`;
    grip.classList.add('shape-handle--grip');
    grip.classList.toggle('shape-handle--behind', dirIsBehind(pt));
  }
}

const clampDot = (d: number) => Math.max(-1, Math.min(1, d));

// Editing: drag an endpoint, the circle's center, or the radius grip
function beginHandleDrag(role: 'a' | 'b' | 'r') {
  const move = (ev: PointerEvent) => {
    sound.playTick();
    const q = eventToCanvasPixels(ev.clientX, ev.clientY);
    const h = engine.castRay(q.x, q.y);
    if (!h || !shape) return;
    if (role === 'r') {
      shape.rho = Math.acos(clampDot(shape.a[0] * h.nx + shape.a[1] * h.ny + shape.a[2] * h.nz));
    } else {
      const target = role === 'a' ? shape.a : shape.b;
      target[0] = h.nx; target[1] = h.ny; target[2] = h.nz;
    }
    recomputeShapeColors();
    updateShapeOverlay();
    updateStops();
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

// Current handle positions in canvas pixels, for forgiving grabbing
function shapeHandlePoints(): Array<{ role: 'a' | 'b' | 'r'; sx: number; sy: number }> {
  if (!shape) return [];
  const pts: Array<{ role: 'a' | 'b' | 'r'; sx: number; sy: number }> = [];
  const pa = projectDirPct(shape.a);
  pts.push({ role: 'a', sx: pa.sx, sy: pa.sy });
  if (shape.kind === 'line') {
    const pb = projectDirPct(shape.b);
    pts.push({ role: 'b', sx: pb.sx, sy: pb.sy });
  } else {
    const pg = projectDirPct(circleDir(shape.a, shape.rho, 0));
    pts.push({ role: 'r', sx: pg.sx, sy: pg.sy });
  }
  return pts;
}

// Drawing: in a shape mode, dragging on the sphere replaces the shape —
// unless the press lands near an existing handle, which edits it instead
canvas.addEventListener('pointerdown', e => {
  if (mode === 'points') return;
  const p = eventToCanvasPixels(e.clientX, e.clientY);
  const GRAB_RADIUS = 14; // canvas px — forgiving, so grabs never redraw by accident
  for (const h of shapeHandlePoints()) {
    if (Math.hypot(p.x - h.sx, p.y - h.sy) < GRAB_RADIUS) {
      e.preventDefault();
      beginHandleDrag(h.role);
      return;
    }
  }
  const hit = engine.castRay(p.x, p.y);
  if (!hit) return;
  e.preventDefault();
  const start = new Float64Array([hit.nx, hit.ny, hit.nz]);
  shape = mode === 'line'
    ? { kind: 'line', a: start, b: new Float64Array(start), rho: 0 }
    : { kind: 'circle', a: start, b: new Float64Array(start), rho: 0 };
  const move = (ev: PointerEvent) => {
    const q = eventToCanvasPixels(ev.clientX, ev.clientY);
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
  beginHandleDrag(el.dataset.handle as 'a' | 'b' | 'r');
});

function deleteShape() {
  shape = null;
  shapeColors = [];
  updateShapeOverlay();
  updateStops();
}

// Mode switching (segmented control) — sample markers only show in points mode
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
      shape = { kind: 'circle', a: center, b: new Float64Array(center), rho: Math.asin(0.8) };
    }
  } else if (mode === 'line') {
    if (!shape || shape.kind !== 'line') {
      shape = {
        kind: 'line',
        a: normalize3(-0.6, 0.35, -0.75),
        b: normalize3(0.6, -0.35, -0.75),
        rho: 0,
      };
    }
  }
}

function setMode(next: SampleMode) {
  mode = next;
  segButtons.forEach(b => b.classList.toggle('seg__btn--active', b.dataset.mode === mode));
  shapeCountWrap.hidden = mode === 'points';
  spacingSeg.hidden = mode === 'points';
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
  indirect: document.getElementById('scnIndirect') as HTMLInputElement,
  reflect: document.getElementById('scnReflect') as HTMLInputElement,
  quality: document.getElementById('scnQuality') as HTMLInputElement,
};

function readSceneInputs() {
  state.sphereHex = scn.sphereColor.value;
  state.wallHex = scn.wallColor.value;
  state.sphereRadius = parseFloat(scn.radius.value);
  state.fov = parseFloat(scn.fov.value);
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
    // tidy up on the way out: glide the palette list back to the top
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

// Clicking the snippet copies it
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

function requestColorNames() {
  if (!colorsOpen()) return;
  const missing = [...new Set(activeColors().map(hex6))].filter(h => !colorNameCache.has(h));
  applyColorNames();
  if (!missing.length) return;
  clearTimeout(nameTimer);
  nameAbort?.abort();
  nameTimer = window.setTimeout(() => {
    nameAbort = new AbortController();
    fetch(`https://api.color.pizza/v1/?values=${missing.join(',')}&list=bestOf&noduplicates=true`, { signal: nameAbort.signal })
      .then(r => r.json())
      .then(data => {
        for (const c of data.colors ?? []) {
          colorNameCache.set(String(c.requestedHex).replace('#', '').toLowerCase(), c.name);
        }
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
    samplerImport = ',\n  sampleCircleDirs, distributions';
    sampler = `const dirs = sampleCircleDirs(\n  ${vec(shape.a)}, ${fmt(shape.rho)}, ${shapeCount},\n  distributions.${shapeSpacing}\n);`;
  } else if (shape && mode === 'line') {
    samplerImport = ',\n  sampleLineDirs, distributions';
    sampler = `const dirs = sampleLineDirs(\n  ${vec(shape.a)},\n  ${vec(shape.b)},\n  ${shapeCount}, distributions.${shapeSpacing}\n);`;
  } else {
    sampler = `const dirs = [\n${samples.map(s => '  ' + vec(s.dir)).join(',\n')}\n];`;
  }

  libSnippetCode.textContent = `import {
  createEngine, toSRGB8${samplerImport}
} from 'ray-color';

const engine = createEngine(400, 400,
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

// The overlay lists the active palette: swatch rail + name/hex rows
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
  // Render + color strip below, like OKPalette's image export
  const stripHeight = 80;
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height + stripHeight;
  const octx = out.getContext('2d')!;
  octx.drawImage(canvas, 0, 0);
  const colorWidth = out.width / colors.length;
  colors.forEach((c, i) => {
    octx.fillStyle = c.hex;
    octx.fillRect(i * colorWidth, canvas.height, colorWidth + 1, stripHeight);
  });
  sound.playSuccess();
  out.toBlob(blob => { if (blob) downloadBlob(blob, 'ray-color-palette.png'); });
});

// The palette of the active mode: individual points, or the shape's samples
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

// Debounced settings snapshot in the console — copy the logged JSON to tune defaults
let settingsLogTimer: number | undefined;
function logSettings() {
  clearTimeout(settingsLogTimer);
  settingsLogTimer = window.setTimeout(() => {
    const snapshot = {
      scene: { ...state },
      lights: lights.map(l => ({ ...l })),
      mode,
      shape: shape ? { kind: shape.kind, a: [...shape.a], b: [...shape.b], rho: shape.rho } : null,
      shapeCount,
      shapeSpacing,
      samples: samples.map(s => [...s.dir]),
    };
    console.log('[ray-color settings]', JSON.stringify(snapshot, (_k, v) => typeof v === 'number' ? Math.round(v * 1000) / 1000 : v));
  }, 400);
}

function update() {
  engine.commit();
  logSettings();
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
  selectSample(sample);
  const move = (e: PointerEvent) => {
    sound.playTick();
    const p = eventToCanvasPixels(e.clientX, e.clientY);
    const hit = engine.castRay(p.x, p.y);
    if (hit) {
      sample.dir[0] = hit.nx;
      sample.dir[1] = hit.ny;
      sample.dir[2] = hit.nz;
      const color = engine.shade(sample.dir);
      sample.color[0] = color.r;
      sample.color[1] = color.g;
      sample.color[2] = color.b;
    }
    updateSampleMarker(sample);
    updateStops();
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

let draggedLight = -1;
let dragMoved = false;
let dragBackHemi = false;
let dragCursorStart = { x: 0, y: 0 };
let dragProjStart = { x: 0, y: 0 };

lightLayer.addEventListener('pointerdown', e => {
  const markerEl = (e.target as HTMLElement).closest('.light-marker') as HTMLElement | null;
  if (!markerEl || markerEl.dataset.light === undefined) return;
  e.preventDefault();
  draggedLight = parseInt(markerEl.dataset.light, 10);
  dragMoved = false;
  // Which orbit hemisphere is the light on right now? Preserve it while dragging.
  const pz = lightPositions[draggedLight * 3 + 2];
  const d0 = lights[draggedLight].dist;
  dragBackHemi = d0 * d0 - pz * state.cameraZ >= 0;
  // Relative drag: apply the cursor delta to the light's TRUE projected
  // position, so an edge-clamped marker steers its off-canvas light remotely
  dragCursorStart = eventToCanvasPixels(e.clientX, e.clientY, false);
  const sp = engine.worldToScreen(lightPositions[draggedLight * 3], lightPositions[draggedLight * 3 + 1], lightPositions[draggedLight * 3 + 2]);
  dragProjStart = { x: sp.x, y: sp.y };
  const move = (ev: PointerEvent) => {
    dragMoved = true;
    dragLightTo(ev.clientX, ev.clientY);
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    // A press without movement is a click: toggle the inspector
    if (!dragMoved) {
      if (selectedLight === draggedLight) closeInspector();
      else openInspector(draggedLight);
    }
    draggedLight = -1;
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  if (selectedLight >= 0 && selectedLight !== draggedLight) openInspector(draggedLight);
});

function dragLightTo(clientX: number, clientY: number) {
  if (draggedLight < 0) return;
  sound.playTick();
  const p = eventToCanvasPixels(clientX, clientY, false);
  const x = dragProjStart.x + (p.x - dragCursorStart.x);
  const y = dragProjStart.y + (p.y - dragCursorStart.y);
  const l = lights[draggedLight];
  const res = engine.pointerToLightAngles(x, y, l.dist, dragBackHemi);
  l.yaw = Math.round(res.yaw);
  l.pitch = Math.round(Math.max(-89, Math.min(89, res.pitch)));
  if (res.dist !== l.dist) {
    l.dist = Math.min(MAX_LIGHT_DISTANCE, Math.max(state.sphereRadius, res.dist));
  }
  update();
}

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

syncOutputs();
engine.commit();
setMode(mode); // applies mode defaults AND the toolbar's mode-specific controls
update();
