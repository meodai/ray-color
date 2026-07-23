// Ray Color playground — direct-manipulation demo for the ray-color engine.
// State lives here; the engine renders it and answers all scene questions.

import {
  createEngine,
  toSRGB8,
  MAX_LIGHT_DISTANCE,
  DEFAULT_PASS_SCALES,
  type Light,
  type Scene,
} from './engine';

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d');
if (!ctx) throw new Error('Canvas 2D context unavailable');
const imageData = ctx.createImageData(canvas.width, canvas.height);

// ---------------------------------------------------------------- state

const state: Scene = {
  cameraZ: -4.5,
  fov: 30,
  sphereRadius: 0.8,
  sphereHex: '#ffffff',
  wallHex: '#999999',
  indirect: 0.3,
  lightSize: 0.15,
  areaQuality: 6,
};

const lights: Light[] = [
  { type: 'directional', yaw: 45, pitch: 20, dist: 2, hex: '#ff0000', intensity: 0.6, angle: 30 },
  { type: 'directional', yaw: -135, pitch: 20, dist: 2, hex: '#00ff00', intensity: 0.6, angle: 30 },
  { type: 'directional', yaw: 0, pitch: 30, dist: 2, hex: '#0000ff', intensity: 0.6, angle: 30 },
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
  if (type === 'area' && state.lightSize > 0) {
    const r = (state.lightSize / (screenPos.z * engine.tanFov())) * (canvas.height / 2);
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
  sample.marker.style.left = `${(screenPos.x / canvas.width) * 100}%`;
  sample.marker.style.top = `${(screenPos.y / canvas.height) * 100}%`;
  const facing = r - sample.dir[2] * state.cameraZ;
  sample.marker.classList.toggle('marker--behind', facing >= 0);
}

// Inspector popover — a projection of lights[selectedLight]
const inspTitle = document.getElementById('inspTitle')!;
const inspType = document.getElementById('inspType') as HTMLSelectElement;
const inspColor = document.getElementById('inspColor') as HTMLInputElement;
const inspIntensity = document.getElementById('inspIntensity') as HTMLInputElement;
const inspDist = document.getElementById('inspDist') as HTMLInputElement;
const inspAngle = document.getElementById('inspAngle') as HTMLInputElement;
const inspDistRow = document.getElementById('inspDistRow')!;
const inspAngleRow = document.getElementById('inspAngleRow')!;

function openInspector(i: number) {
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
  inspAngleRow.hidden = l.type !== 'spot';
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

// ---------------------------------------------------------------- scene popover

const sceneBtn = document.getElementById('sceneBtn')!;
const scenePopover = document.getElementById('scenePopover')!;
const scn = {
  sphereColor: document.getElementById('scnSphereColor') as HTMLInputElement,
  wallColor: document.getElementById('scnWallColor') as HTMLInputElement,
  radius: document.getElementById('scnRadius') as HTMLInputElement,
  fov: document.getElementById('scnFov') as HTMLInputElement,
  indirect: document.getElementById('scnIndirect') as HTMLInputElement,
  lightSize: document.getElementById('scnLightSize') as HTMLInputElement,
  quality: document.getElementById('scnQuality') as HTMLInputElement,
};

sceneBtn.addEventListener('click', () => {
  scenePopover.hidden = !scenePopover.hidden;
  sceneBtn.setAttribute('aria-expanded', String(!scenePopover.hidden));
});

function readSceneInputs() {
  state.sphereHex = scn.sphereColor.value;
  state.wallHex = scn.wallColor.value;
  state.sphereRadius = parseFloat(scn.radius.value);
  state.fov = parseFloat(scn.fov.value);
  state.indirect = parseFloat(scn.indirect.value);
  state.lightSize = parseFloat(scn.lightSize.value);
  state.areaQuality = Math.max(1, parseInt(scn.quality.value, 10) || 1);
  update();
}
Object.values(scn).forEach(input => input.addEventListener('input', readSceneInputs));

function syncOutputs() {
  document.querySelectorAll<HTMLOutputElement>('output').forEach(out => {
    const input = out.id ? document.getElementById(out.id.replace('Out', '')) as HTMLInputElement | null : null;
    if (input) out.textContent = input.value;
  });
}

// ---------------------------------------------------------------- gradient stops

const copyBtn = document.getElementById('copyCss') as HTMLButtonElement;
let selectedSample: Sample | null = null;

function cssStops(): string {
  const seg = 100 / samples.length;
  return samples.map((s, i) => {
    // Same sRGB encoding as the renderer, so stops match the pixels exactly
    const r = toSRGB8(s.color[0]), g = toSRGB8(s.color[1]), b = toSRGB8(s.color[2]);
    const end = i === samples.length - 1 ? 100 : (i + 1) * seg;
    return `rgb(${r}, ${g}, ${b}) ${(i * seg).toFixed(1)}% ${end.toFixed(1)}%`;
  }).join(', ');
}

function updateStops() {
  const has = samples.length > 0;
  copyBtn.hidden = !has;
  document.documentElement.style.setProperty('--stops', has ? cssStops() : 'transparent 0% 100%');
}

function selectSample(sample: Sample | null) {
  selectedSample = sample;
  samples.forEach(s => s.marker.classList.toggle('marker--selected', s === selectedSample));
}

function deleteSelectedSample() {
  if (!selectedSample) return;
  selectedSample.marker.remove();
  samples = samples.filter(s => s !== selectedSample);
  selectedSample = null;
  updateStops();
}

copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(`linear-gradient(90deg, ${cssStops()})`);
    copyBtn.textContent = 'Copied';
  } catch {
    copyBtn.textContent = 'Copy failed';
  }
  setTimeout(() => { copyBtn.textContent = 'Copy CSS'; }, 1200);
});

// ---------------------------------------------------------------- update pipeline

function update() {
  engine.commit();
  samples.forEach(sample => {
    const color = engine.shade(sample.dir);
    sample.color[0] = color.r;
    sample.color[1] = color.g;
    sample.color[2] = color.b;
    updateSampleMarker(sample);
  });
  updateStops();
  updateLightMarkers();
  if (selectedLight >= 0) {
    inspDist.value = lights[selectedLight].dist.toString();
    syncOutputs();
    updateOrbitGlobe();
  }
  requestRender();
}

// ---------------------------------------------------------------- interactions

canvas.addEventListener('click', event => {
  if (selectedLight >= 0) {
    closeInspector();
    return; // first click just dismisses the inspector
  }
  const { x, y } = eventToCanvasPixels(event.clientX, event.clientY);
  const hit = engine.castRay(x, y);
  if (!hit) return;
  const dir = new Float64Array([hit.nx, hit.ny, hit.nz]);
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
});

function beginSampleDrag(event: PointerEvent, sample: Sample) {
  event.preventDefault();
  event.stopPropagation();
  selectSample(sample);
  const move = (e: PointerEvent) => {
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
    scenePopover.hidden = true;
    sceneBtn.setAttribute('aria-expanded', 'false');
  } else if ((e.key === 'Backspace' || e.key === 'Delete') && !inField) {
    e.preventDefault();
    deleteSelectedSample();
  } else if ((e.key === '1' || e.key === '2' || e.key === '3') && !inField) {
    openInspector(parseInt(e.key, 10) - 1);
  }
});

// Close the scene popover when clicking outside it
document.addEventListener('pointerdown', e => {
  if (scenePopover.hidden) return;
  const t = e.target as HTMLElement;
  if (!scenePopover.contains(t) && t !== sceneBtn && !sceneBtn.contains(t)) {
    scenePopover.hidden = true;
    sceneBtn.setAttribute('aria-expanded', 'false');
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

syncOutputs();
update();
