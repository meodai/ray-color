// Ray Color playground — chrome around the <ray-color-view> component.
// The viewport (render pipeline, gizmos, markers, shape editing) lives in the
// component; this file owns the toolbar, drawers, inspector, presets, palette
// panel, exports and sound, wired through the component's events and API.

import { SourceSession, createCollection } from 'token-beam';
import { SoundManager } from './sound';
import {
  toSRGB8,
  srgbToLinear,
  MAX_LIGHT_DISTANCE,
  type Light,
} from './engine';
import './view'; // registers <ray-color-view> before the element below upgrades
import { LIGHT_TYPE_ICONS } from './view';
import type { RayColorViewElement, SampleMode, SpacingName, InputKind } from './view';
import { PRESETS } from './presets';

const sound = new SoundManager();
window.addEventListener('pointerdown', () => sound.unlock(), { capture: true });
window.addEventListener('keydown', () => sound.unlock(), { capture: true });

const view = document.getElementById('view') as RayColorViewElement;
// The component owns the canonical scene/lights objects; the chrome edits
// them in place and calls view.update() — exactly the old engine contract
const state = view.scene!;
const lights = view.lights;

let selectedLight = -1; // chrome mirror of the view's light selection
let applyingPreset = false;

// ---------------------------------------------------------------- favicon

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
    const canvas = view.canvas;
    const engine = view.engine;
    if (!canvas || !engine) return;
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

// ---------------------------------------------------------------- light rail

function contrastColor(hexColor: string) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hexColor);
  if (!m) return '#000';
  const [r, g, b] = [m[1], m[2], m[3]].map(c => srgbToLinear(parseInt(c, 16) / 255));
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.4 ? '#000' : '#fff';
}

function updateLightRail() {
  document.querySelectorAll<HTMLElement>('.control-rail__light').forEach((el, i) => {
    el.style.background = lights[i].hex;
    el.style.color = contrastColor(lights[i].hex);
    if (el.dataset.iconType !== lights[i].type) {
      el.dataset.iconType = lights[i].type;
      el.innerHTML = LIGHT_TYPE_ICONS[lights[i].type];
    }
    el.classList.toggle('control-rail__light--active', i === selectedLight);
  });
}

// ---------------------------------------------------------------- orbit globe
// Arcball control in the inspector (after color-names-viz-over-time):
// a tilted orthographic globe — meridian and parallel cross at the dot,
// front halves bright, back halves dim. Drag anywhere on it to aim the light.

const inspector = document.getElementById('inspector')!;
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
  view.update();
});
orbitEl.addEventListener('pointerup', e => {
  orbiting = false;
  orbitEl.releasePointerCapture(e.pointerId);
});

// ---------------------------------------------------------------- toolbar: mode / count / spacing

const segButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.seg__btn[data-mode]'));
const shapeCountWrap = document.getElementById('shapeCountWrap')!;
const shapeCountInput = document.getElementById('shapeCount') as HTMLInputElement;
const shapeCountSlider = shapeCountWrap.querySelector('.numberslider') as HTMLElement;
const shapeCountMinus = document.getElementById('shapeCountMinus')!;
const shapeCountPlus = document.getElementById('shapeCountPlus')!;

const spacingSeg = document.getElementById('spacingSeg')!;
const spacingButtons = Array.from(spacingSeg.querySelectorAll<HTMLButtonElement>('.seg__btn'));

function syncModeUI() {
  const mode = view.mode;
  segButtons.forEach(b => b.classList.toggle('seg__btn--active', b.dataset.mode === mode));
  shapeCountWrap.hidden = mode === 'points';
  // spacing only matters for open shapes: on a closed circle smoothstep just
  // bunches points at the seam, so the UI offers it for lines only
  spacingSeg.hidden = mode !== 'line';
}

segButtons.forEach(b => b.addEventListener('click', () => {
  sound.playTack();
  view.mode = b.dataset.mode as SampleMode;
  syncModeUI();
}));

// OKPalette-style numberslider: - / + steppers around a number input,
// with a --relval fill on the pill while focused
function syncShapeCountFill() {
  const min = parseInt(shapeCountInput.min, 10) || 2;
  const max = parseInt(shapeCountInput.max, 10) || 32;
  shapeCountSlider.style.setProperty('--relval', String((view.count - min) / (max - min)));
}

function applyShapeCount(next: number) {
  const min = parseInt(shapeCountInput.min, 10) || 2;
  const max = parseInt(shapeCountInput.max, 10) || 32;
  view.count = Math.min(max, Math.max(min, next));
  shapeCountInput.value = String(view.count);
  syncShapeCountFill();
}

shapeCountInput.addEventListener('input', () => {
  // while typing, track valid values without rewriting the field
  const v = parseInt(shapeCountInput.value, 10);
  if (Number.isNaN(v)) return;
  view.count = Math.min(32, Math.max(2, v));
  syncShapeCountFill();
});
shapeCountInput.addEventListener('change', () => {
  applyShapeCount(parseInt(shapeCountInput.value, 10) || view.count);
});
shapeCountMinus.addEventListener('click', () => {
  sound.playTick();
  applyShapeCount(view.count - 1);
});
shapeCountPlus.addEventListener('click', () => {
  sound.playTick();
  applyShapeCount(view.count + 1);
});

spacingButtons.forEach(b => b.addEventListener('click', () => {
  view.spacing = b.dataset.spacing as SpacingName;
  spacingButtons.forEach(x => x.classList.toggle('seg__btn--active', x === b));
}));

// ---------------------------------------------------------------- inspector

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

function syncInspectorUI() {
  if (selectedLight < 0) return;
  const l = lights[selectedLight];
  inspTitle.textContent = `Light ${selectedLight + 1}`;
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
}

function openInspector(i: number) {
  sound.playTack();
  setControlsOpen(true);
  lightHint.hidden = true;
  selectedLight = i;
  view.selectLight(i); // no-ops when already selected — sync directly too
  syncInspectorUI();
  updateLightRail();
}

function closeInspector() {
  view.selectLight(-1);
  selectedLight = -1;
  inspector.hidden = true;
  lightHint.hidden = false;
  updateLightRail();
}

view.addEventListener('lightselect', e => {
  const idx = (e as CustomEvent).detail.index as number | null;
  selectedLight = idx ?? -1;
  if (idx === null) {
    inspector.hidden = true;
    lightHint.hidden = false;
  } else {
    sound.playTack();
    lightHint.hidden = true;
    if (controlsOpen()) syncInspectorUI();
  }
  updateLightRail();
});

inspType.addEventListener('change', () => {
  if (selectedLight < 0) return;
  lights[selectedLight].type = inspType.value as Light['type'];
  syncInspectorUI(); // re-project row visibility
  view.update();
});
inspColor.addEventListener('input', () => {
  if (selectedLight < 0) return;
  lights[selectedLight].hex = inspColor.value;
  view.update();
});
inspIntensity.addEventListener('input', () => {
  if (selectedLight < 0) return;
  lights[selectedLight].intensity = parseFloat(inspIntensity.value);
  syncOutputs();
  view.update();
});
inspDist.addEventListener('input', () => {
  if (selectedLight < 0) return;
  lights[selectedLight].dist = parseFloat(inspDist.value);
  syncOutputs();
  view.update();
});
inspAngle.addEventListener('input', () => {
  if (selectedLight < 0) return;
  lights[selectedLight].angle = parseFloat(inspAngle.value);
  syncOutputs();
  view.update();
});
inspSize.addEventListener('input', () => {
  if (selectedLight < 0) return;
  lights[selectedLight].size = parseFloat(inspSize.value);
  syncOutputs();
  view.update();
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
  view.update();
}
Object.values(scn).forEach(input => input.addEventListener('input', readSceneInputs));

// Scene presets. The select shows a preset name only while the scene still IS that preset:
// any manual edit funnels through the view's update event, which snaps it back to None.
const presetSelect = document.getElementById('scnPreset') as HTMLSelectElement;
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
  view.count = ps.count;
  shapeCountInput.value = String(view.count);
  syncShapeCountFill();
  view.spacing = ps.spacing ?? 'linear';
  spacingButtons.forEach(b => b.classList.toggle('seg__btn--active', b.dataset.spacing === view.spacing));
  view.mode = ps.kind; // set before the shape so mode defaults don't replace it
  view.shape = ps;
  syncModeUI();
  syncSceneInputs();
  if (selectedLight >= 0) syncInspectorUI(); // re-sync open inspector
  view.update();
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

// ---------------------------------------------------------------- drawers

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

// ---------------------------------------------------------------- color names

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
  const values = [...new Set(view.rawColors().map(hex6))];
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

// ---------------------------------------------------------------- lib snippet

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

  const mode = view.mode;
  const shape = view.shape;
  let samplerImport = '';
  let sampler: string;
  if (shape && mode === 'circle') {
    samplerImport = ',\n  sampleCircleDirs';
    const rot = Math.abs(shape.rotate) > 0.05 ? `,\n  { rotate: ${fmt(shape.rotate)} }` : '';
    sampler = `const dirs = sampleCircleDirs(\n  ${vec(shape.a)}, ${fmt(shape.rho)}, ${view.count}${rot}\n);`;
  } else if (shape && mode === 'line') {
    samplerImport = ',\n  sampleLineDirs, distributions';
    sampler = `const dirs = sampleLineDirs(\n  ${vec(shape.a)},\n  ${vec(shape.b)},\n  ${view.count}, distributions.${view.spacing}\n);`;
  } else {
    sampler = `const dirs = [\n${view.sampleDirs().map(d => '  ' + vec(d)).join(',\n')}\n];`;
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

// ---------------------------------------------------------------- palette panel

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
    if (view.mode === 'points' && i === view.selectedSampleIndex) row.classList.add('palette__row--selected');
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
    name.textContent = colorNameCache.get(h) ?? '…';
    const deco = document.createElement('span');
    deco.className = 'palette__row-info-deco';
    const hexEl = document.createElement('div');
    hexEl.className = 'palette__row-hex';
    hexEl.textContent = '#' + h;
    head.append(name, deco, hexEl);
    info.appendChild(head);
    row.append(sw, info);
    if (view.mode === 'points') {
      info.addEventListener('click', () => {
        if (colorsOpen()) view.selectSampleAt(i);
      });
    }
    paletteEl.appendChild(row);
  });
  if (colorsOpen()) requestColorNames();
}

function paletteData() {
  return view.rawColors().map(c => {
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

// ---------------------------------------------------------------- token beam

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
  if (!tokenBeamClient || view.rawColors().length === 0) return;
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

// ---------------------------------------------------------------- exports

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
  const render = view.exportImage(); // settled f64 frame + sample dots
  if (!render) return;
  // Render + color strip below, like OKPalette's image export
  const stripHeight = 80;
  const out = document.createElement('canvas');
  out.width = render.width;
  out.height = render.height + stripHeight;
  const octx = out.getContext('2d')!;
  octx.drawImage(render, 0, 0);
  const colorWidth = out.width / colors.length;
  colors.forEach((c, i) => {
    octx.fillStyle = c.hex;
    octx.fillRect(i * colorWidth, render.height, colorWidth + 1, stripHeight);
  });
  sound.playSuccess();
  // Name the file after the palette when color.pizza has titled the current
  // colors (the title sticks around after edits, so check it isn't stale)
  const fresh = lastPaletteKey === [...new Set(view.rawColors().map(hex6))].join(',');
  const slug = fresh
    ? (paletteNameEl.textContent ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    : '';
  out.toBlob(blob => { if (blob) downloadBlob(blob, slug ? `ray-color-${slug}.png` : 'ray-color-palette.png'); });
});

// ---------------------------------------------------------------- view events

function updateStops() {
  const colors = view.rawColors();
  document.documentElement.style.setProperty('--stops', colors.length ? cssStops() : 'transparent 0% 100%');
  renderPalette(colors);
  updateLibSnippet();
  syncPaletteToTokenBeam();
}

function cssStops(): string {
  const colors = view.rawColors();
  const seg = 100 / colors.length;
  return colors.map((c, i) => {
    // Same sRGB encoding as the renderer, so stops match the pixels exactly
    const r = toSRGB8(c[0]), g = toSRGB8(c[1]), b = toSRGB8(c[2]);
    const end = i === colors.length - 1 ? 100 : (i + 1) * seg;
    return `rgb(${r}, ${g}, ${b}) ${(i * seg).toFixed(1)}% ${end.toFixed(1)}%`;
  }).join(', ');
}

view.addEventListener('palettechange', () => updateStops());

view.addEventListener('input', e => {
  sound.playTick();
  const kind = (e as CustomEvent).detail.kind as InputKind;
  // keep the chrome's mirrors of view-driven edits honest
  if (kind === 'light-intensity' && selectedLight >= 0) {
    inspIntensity.value = lights[selectedLight].intensity.toString();
    syncOutputs();
  } else if (kind === 'light-dist' && selectedLight >= 0) {
    inspDist.value = lights[selectedLight].dist.toString();
    syncOutputs();
  } else if (kind === 'light-color' && selectedLight >= 0) {
    inspColor.value = lights[selectedLight].hex;
  }
});

view.addEventListener('viewupdate', () => {
  // Any change that isn't a preset load means the scene is no longer that
  // preset — snap the picker back to None
  if (!applyingPreset && presetSelect.value !== '') presetSelect.value = '';
  if (selectedLight >= 0) {
    inspDist.value = lights[selectedLight].dist.toString();
    updateOrbitGlobe();
  }
  updateLightRail();
  syncOutputs();
});

view.addEventListener('sampleselect', () => {
  document.querySelectorAll('.palette__row').forEach((row, i) =>
    row.classList.toggle('palette__row--selected', view.mode === 'points' && i === view.selectedSampleIndex));
});

view.addEventListener('settled', () => scheduleFavicon());

// No scroll-to-dolly: the camera distance lives on the drawer's slider.
// (While a light is selected the component claims the wheel for that light's
// distance/intensity — part of its control kit, not the page's scroll.)

view.addEventListener('change', e => {
  const kind = (e as CustomEvent).detail.kind as InputKind;
  if (kind === 'sample') sound.playTack();
  // the ring menu's type select changes row visibility in the inspector
  if (kind === 'light-type' && selectedLight >= 0) syncInspectorUI();
});

// ---------------------------------------------------------------- keyboard

window.addEventListener('keydown', e => {
  const target = e.target as HTMLElement;
  const inField = target.tagName === 'INPUT' || target.tagName === 'SELECT';
  if (e.key === 'Escape') {
    closeInspector();
    view.clearSampleSelection();
    setColorsOpen(false);
    setControlsOpen(false);
  } else if ((e.key === 'Backspace' || e.key === 'Delete') && !inField) {
    e.preventDefault();
    view.deleteSelection();
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
  view.update();
  requestAnimationFrame(playFrame);
}

playBtn.addEventListener('click', e => {
  e.stopPropagation(); // the drawer's own click handling must not toggle it shut
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
syncModeUI();
syncShapeCountFill();
updateLightRail();
syncOutputs();
updateStops();
