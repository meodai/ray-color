// Ray Color — classic slider view, a demo for the ray-color engine.
// The DOM inputs are the source of truth; updateScene() reads them into the
// engine's scene/lights and the engine renders and answers scene questions.

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
const resolutionDisplay = document.getElementById('resolution');
const fpsDisplay = document.getElementById('fps');

// ---------------------------------------------------------------- state

const scene: Scene = {
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

const engine = createEngine(canvas.width, canvas.height, scene, lights);
const lightPositions = engine.lightPositions;

interface ColorSample {
  // Float64 to match the renderer's precision exactly — float32 rounding
  // shows up as off-by-one channel values after sRGB encoding
  dir: Float64Array; // unit direction from sphere center — anchors the sample to the surface
  color: Float64Array;
  marker: HTMLElement;
}
let samples: ColorSample[] = [];
let selectedLight = -1;

// ---------------------------------------------------------------- gradient & samples list

function updateGradientStops() {
  const stops: string[] = [];
  // Provide a safe default when there are no samples (transparent bar)
  if (!samples || samples.length === 0) {
    document.documentElement.style.setProperty('--stops', 'transparent 0% 100%');
    return;
  }

  // Evenly distribute stops across 0-100%
  const seg = 100 / samples.length;
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    // Same sRGB encoding as the renderer, so stops match the pixels exactly
    const r = toSRGB8(sample.color[0]);
    const g = toSRGB8(sample.color[1]);
    const b = toSRGB8(sample.color[2]);
    const color = `rgb(${r}, ${g}, ${b})`;
    const startPercent = (i * seg);
    const endPercent = (i === samples.length - 1) ? 100 : ((i + 1) * seg);
    stops.push(`${color} ${startPercent}% ${endPercent}%`);
  }

  document.documentElement.style.setProperty('--stops', stops.join(', '));
}

function updateSamplesList() {
  const list = document.getElementById('samples-list');
  if (!list) return;
  list.innerHTML = '';
  if (samples.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'samples-empty';
    empty.textContent = 'Click the sphere to sample a color.';
    list.appendChild(empty);
    return;
  }
  samples.forEach(sample => {
    const item = document.createElement('div');
    item.className = 'sample-item';
    const colorBox = document.createElement('div');
    colorBox.className = 'sample-color';
    const sr = toSRGB8(sample.color[0]), sg = toSRGB8(sample.color[1]), sb = toSRGB8(sample.color[2]);
    colorBox.style.backgroundColor = `rgb(${sr}, ${sg}, ${sb})`;
    const text = document.createElement('div');
    text.textContent = `RGB(${sr}, ${sg}, ${sb})`;
    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove-sample';
    removeBtn.textContent = '×';
    removeBtn.onclick = () => {
      samples = samples.filter(s => s !== sample);
      sample.marker.remove();
      updateSamplesList();
      updateGradientStops();
    };
    item.appendChild(colorBox);
    item.appendChild(text);
    item.appendChild(removeBtn);
    list.appendChild(item);
  });
}

// ---------------------------------------------------------------- markers & gizmo

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
  const markersContainer = document.getElementById('light-markers');
  if (!markersContainer) return;
  markersContainer.innerHTML = '';
  for (let i = 0; i < 3; i++) {
    const screenPos = engine.worldToScreen(lightPositions[i * 3], lightPositions[i * 3 + 1], lightPositions[i * 3 + 2]);
    if (screenPos.z <= 0) continue;
    // Keep offscreen lights grabbable by clamping them to the canvas edge,
    // sliding along the aim line so the marker stays on it
    const { x: cx, y: cy } = clampToCanvasAlongLine(screenPos.x, screenPos.y);

    // Calculate normalized scale based on Z distance (0 = far, 1 = near)
    // Using a reasonable range: 0.5 to 8 units from camera
    const minZ = 0.5;
    const maxZ = 8;
    const normalizedScale = Math.max(0, Math.min(1, (maxZ - screenPos.z) / (maxZ - minZ)));

    const marker = document.createElement('div');
    marker.className = `marker light-marker${lights[i].type === 'directional' ? ' light-marker--directional' : ''}`;
    marker.dataset.light = String(i);
    if (cx !== screenPos.x || cy !== screenPos.y) marker.classList.add('marker--offscreen');
    if (i === selectedLight) marker.classList.add('marker--selected');
    // Percent positioning keeps markers aligned even if the canvas is CSS-scaled
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
    markersContainer.appendChild(marker);
  }
  updateLightGizmo();
}

// Selection overlay: aim line, area extent, and an info label for the selected light
function updateLightGizmo() {
  const svg = document.getElementById('light-gizmo');
  const label = document.getElementById('light-gizmo-label');
  if (!svg || !label) return;
  svg.setAttribute('viewBox', `0 0 ${canvas.width} ${canvas.height}`);
  svg.innerHTML = '';
  for (let p = 1; p <= 3; p++) {
    const panel = document.getElementById(`light${p}Panel`);
    if (panel) panel.classList.toggle('panel--selected', p - 1 === selectedLight);
  }
  if (selectedLight < 0) {
    label.hidden = true;
    return;
  }
  const i = selectedLight;
  const screenPos = engine.worldToScreen(lightPositions[i * 3], lightPositions[i * 3 + 1], lightPositions[i * 3 + 2]);
  if (screenPos.z <= 0) {
    label.hidden = true;
    return;
  }
  const { x: cx, y: cy } = clampToCanvasAlongLine(screenPos.x, screenPos.y);
  const type = lights[i].type;
  const NS = 'http://www.w3.org/2000/svg';

  // Directional and spot lights aim at the origin — draw the aim line to
  // where the ray meets the sphere's surface, splitting off the portion the
  // sphere itself occludes (drawn as a faint trace)
  if (type === 'directional' || type === 'spot') {
    const lx = lightPositions[i * 3], ly = lightPositions[i * 3 + 1], lz = lightPositions[i * 3 + 2];
    const llen = Math.sqrt(lx * lx + ly * ly + lz * lz) || 1;
    const s = scene.sphereRadius / llen;
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
      svg.appendChild(hid);
    }
    if (visD) {
      for (const [width, cls] of [['3', 'gizmo-line-casing'], ['1', 'gizmo-line']] as const) {
        const path = document.createElementNS(NS, 'path');
        path.setAttribute('d', visD);
        path.setAttribute('stroke-width', width);
        path.setAttribute('class', cls);
        svg.appendChild(path);
      }
    }
  }

  // Area lights show their emitter size
  if (type === 'area' && scene.lightSize > 0) {
    const r = (scene.lightSize / (screenPos.z * engine.tanFov())) * (canvas.height / 2);
    const circle = document.createElementNS(NS, 'circle');
    circle.setAttribute('cx', cx.toFixed(1));
    circle.setAttribute('cy', cy.toFixed(1));
    circle.setAttribute('r', Math.max(2, r).toFixed(1));
    circle.setAttribute('class', 'gizmo-area');
    svg.appendChild(circle);
  }

  const yawEl = document.getElementById(`light${i + 1}Yaw`) as HTMLInputElement | null;
  const pitchEl = document.getElementById(`light${i + 1}Pitch`) as HTMLInputElement | null;
  const distEl = document.getElementById(`light${i + 1}Dist`) as HTMLInputElement | null;
  const angleEl = document.getElementById(`light${i + 1}Angle`) as HTMLInputElement | null;
  let details = `yaw ${yawEl?.value ?? '?'}° · pitch ${pitchEl?.value ?? '?'}°`;
  if (type !== 'directional') details += ` · dist ${distEl?.value ?? '?'}`;
  if (type === 'spot') details += ` · cone ${angleEl?.value ?? '?'}°`;
  label.innerHTML = `<strong>Light ${i + 1} · ${type}</strong><br>${details}`;
  label.hidden = false;
  label.style.left = `${(cx / canvas.width) * 100}%`;
  label.style.top = `${(cy / canvas.height) * 100}%`;
  // Flip the label to the other side near the right edge
  label.style.transform = cx > canvas.width * 0.62
    ? 'translate(calc(-100% - .75rem), -50%)'
    : 'translate(.75rem, -50%)';
}

// ---------------------------------------------------------------- rendering

function runPass(scale: number, skipStride: number) {
  const startTime = performance.now();
  engine.renderPass(imageData.data, scale, skipStride);
  ctx!.putImageData(imageData, 0, 0);
  if (resolutionDisplay) (resolutionDisplay as HTMLElement).textContent = `Resolution: ${Math.floor(100 / scale)}%`;
  const frameTime = performance.now() - startTime;
  if (fpsDisplay) (fpsDisplay as HTMLElement).textContent = `Frame: ${frameTime.toFixed(1)}ms`;
}

async function startRender() {
  engine.beginFrame();
  for (let pass = 0; pass < DEFAULT_PASS_SCALES.length; pass++) {
    runPass(DEFAULT_PASS_SCALES[pass], pass === 0 ? 0 : DEFAULT_PASS_SCALES[pass - 1]);
    await new Promise(requestAnimationFrame);
  }
  updateLightMarkers();
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

// ---------------------------------------------------------------- pointer & samples

// Map a pointer event to canvas pixel coordinates (canvas may be CSS-scaled).
// clamp keeps the point on the canvas — needed for pixel lookups, not for aiming.
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

// Reproject a sample's surface point to the screen; dim it when it faces away
function updateSampleMarker(sample: ColorSample) {
  const r = scene.sphereRadius;
  const screenPos = engine.worldToScreen(sample.dir[0] * r, sample.dir[1] * r, sample.dir[2] * r);
  sample.marker.style.left = `${(screenPos.x / canvas.width) * 100}%`;
  sample.marker.style.top = `${(screenPos.y / canvas.height) * 100}%`;
  // Point is visible when its normal faces the camera: dot(normal, P - camera) < 0
  const facing = r - sample.dir[2] * scene.cameraZ;
  sample.marker.classList.toggle('marker--behind', facing >= 0);
}

function moveSampleTo(sample: ColorSample, x: number, y: number) {
  const hit = engine.castRay(x, y);
  if (hit) { // only follow the pointer while it stays on the sphere
    sample.dir[0] = hit.nx;
    sample.dir[1] = hit.ny;
    sample.dir[2] = hit.nz;
    const color = engine.shade(sample.dir);
    sample.color[0] = color.r;
    sample.color[1] = color.g;
    sample.color[2] = color.b;
  }
  updateSampleMarker(sample);
  updateSamplesList();
  updateGradientStops();
}

function beginSampleDrag(event: PointerEvent, sample: ColorSample) {
  event.preventDefault();
  event.stopPropagation();
  const move = (e: PointerEvent) => {
    const p = eventToCanvasPixels(e.clientX, e.clientY);
    moveSampleTo(sample, p.x, p.y);
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function handleCanvasClick(event: MouseEvent) {
  const { x, y } = eventToCanvasPixels(event.clientX, event.clientY);
  const hit = engine.castRay(x, y);
  if (!hit) return;
  const dir = new Float64Array([hit.nx, hit.ny, hit.nz]);
  const color = engine.shade(dir);
  const marker = document.createElement('div');
  marker.className = 'marker sample-marker';
  const sample: ColorSample = {
    dir,
    color: new Float64Array([color.r, color.g, color.b]),
    marker: marker
  };
  marker.addEventListener('pointerdown', e => beginSampleDrag(e, sample));
  const sm = document.getElementById('sample-markers');
  if (sm) sm.appendChild(marker);
  updateSampleMarker(sample);
  samples.push(sample);
  updateSamplesList();
  updateGradientStops();
}

// ---------------------------------------------------------------- light dragging

let draggedLight = -1;
let dragBackHemi = false;
let dragCursorStart = { x: 0, y: 0 };
let dragProjStart = { x: 0, y: 0 };

function dragLightTo(clientX: number, clientY: number) {
  if (draggedLight < 0) return;
  // Relative drag: cursor delta applied to the light's true projected position
  const p = eventToCanvasPixels(clientX, clientY, false);
  const x = dragProjStart.x + (p.x - dragCursorStart.x);
  const y = dragProjStart.y + (p.y - dragCursorStart.y);
  const distEl = document.getElementById(`light${draggedLight + 1}Dist`) as HTMLInputElement | null;
  const dist = distEl ? parseFloat(distEl.value) || 2 : 2;
  const { yaw, pitch, dist: newDist } = engine.pointerToLightAngles(x, y, dist, dragBackHemi);
  const yawEl = document.getElementById(`light${draggedLight + 1}Yaw`) as HTMLInputElement | null;
  const pitchEl = document.getElementById(`light${draggedLight + 1}Pitch`) as HTMLInputElement | null;
  if (yawEl) yawEl.value = Math.round(yaw).toString();
  if (pitchEl) pitchEl.value = Math.round(Math.max(-89, Math.min(89, pitch))).toString();
  if (distEl && newDist !== dist) {
    distEl.value = Math.min(MAX_LIGHT_DISTANCE, Math.max(scene.sphereRadius, newDist)).toFixed(2);
  }
  updateScene();
}

// ---------------------------------------------------------------- scene sync

function updateScene() {
  scene.cameraZ = parseFloat((document.getElementById('cameraZ') as HTMLInputElement).value);
  scene.fov = parseFloat((document.getElementById('cameraFOV') as HTMLInputElement).value);
  scene.sphereRadius = parseFloat((document.getElementById('sphereRadius') as HTMLInputElement).value);
  // Distance bounds: a light can't sit inside the sphere, and 12 units is far
  // enough that inverse-square attenuation has faded it to almost nothing
  const distInputs = document.querySelectorAll('input[data-dynamic-dist]') as NodeListOf<HTMLInputElement>;
  const minDist = scene.sphereRadius;
  const maxDist = MAX_LIGHT_DISTANCE;
  distInputs.forEach(inp => {
    inp.min = minDist.toFixed(3);
    inp.max = maxDist.toFixed(3);
    // Clamp existing value
    let v = parseFloat(inp.value);
    if (isNaN(v)) v = minDist;
    if (v < minDist) v = minDist;
    if (v > maxDist) v = maxDist;
    inp.value = v.toString();
  });
  scene.sphereHex = (document.getElementById('sphereColor') as HTMLInputElement).value;
  scene.wallHex = (document.getElementById('wallColor') as HTMLInputElement).value;
  scene.indirect = parseFloat((document.getElementById('indirectIntensity') as HTMLInputElement).value);
  scene.lightSize = parseFloat((document.getElementById('lightSize') as HTMLInputElement).value);
  const aqEl = document.getElementById('areaQuality') as HTMLInputElement | null;
  if (aqEl) scene.areaQuality = Math.max(1, parseInt(aqEl.value, 10) || 1);
  for (let i = 0; i < 3; i++) {
    const l = lights[i];
    l.type = (document.getElementById(`light${i + 1}Type`) as HTMLSelectElement).value as Light['type'];
    const yawEl = document.getElementById(`light${i + 1}Yaw`) as HTMLInputElement | null;
    const pitchEl = document.getElementById(`light${i + 1}Pitch`) as HTMLInputElement | null;
    const distEl = document.getElementById(`light${i + 1}Dist`) as HTMLInputElement | null;
    l.yaw = yawEl ? parseFloat(yawEl.value) : 0;
    l.pitch = pitchEl ? parseFloat(pitchEl.value) : 0;
    l.dist = distEl ? parseFloat(distEl.value) : 2;
    l.hex = (document.getElementById(`light${i + 1}Color`) as HTMLInputElement).value;
    l.intensity = parseFloat((document.getElementById(`light${i + 1}I`) as HTMLInputElement).value);
    l.angle = parseFloat((document.getElementById(`light${i + 1}Angle`) as HTMLInputElement).value);
    // Cone angle only applies to spot lights; distance has no effect on directional shading
    const angleWrap = document.getElementById(`light${i + 1}AngleControl`);
    if (angleWrap) angleWrap.hidden = l.type !== 'spot';
    const distWrap = distEl ? distEl.closest('.control') : null;
    if (distWrap) distWrap.classList.toggle('control--inactive', l.type === 'directional');
    if (distEl) distEl.disabled = l.type === 'directional';
  }
  // Commit to the engine first, then re-light and reproject the surface-
  // anchored samples — they stay on their spot when the camera moves
  engine.commit();
  samples.forEach(sample => {
    const color = engine.shade(sample.dir);
    sample.color[0] = color.r;
    sample.color[1] = color.g;
    sample.color[2] = color.b;
    updateSampleMarker(sample);
  });
  updateSamplesList();
  updateGradientStops();
  syncControlOutputs();
  updateLightMarkers(); // immediate marker/gizmo feedback, ahead of the async render
  requestRender();
}

// Mirror each range input's current value into its <output> readout
function syncControlOutputs() {
  document.querySelectorAll<HTMLOutputElement>('output[data-for]').forEach(out => {
    const input = document.getElementById(out.dataset.for || '') as HTMLInputElement | null;
    if (input) out.textContent = input.value;
  });
}

// ---------------------------------------------------------------- listeners

// Add event listeners (updateScene reads every control, so one listener per element is enough)
document.querySelectorAll('input').forEach(input => {
  input.addEventListener('input', updateScene);
});
document.querySelectorAll('select').forEach(select => {
  select.addEventListener('change', updateScene);
});
canvas.addEventListener('click', event => {
  // Clicking the scene deselects the light and samples a color
  if (selectedLight >= 0) {
    selectedLight = -1;
    updateLightMarkers();
  }
  handleCanvasClick(event);
});

// Light markers: click selects (3D-app style), drag aims, wheel adjusts distance.
// Delegated on the container because markers are rebuilt on every render.
const lightMarkersEl = document.getElementById('light-markers');
if (lightMarkersEl) {
  lightMarkersEl.addEventListener('pointerdown', e => {
    const markerEl = (e.target as HTMLElement).closest('.light-marker') as HTMLElement | null;
    if (!markerEl || markerEl.dataset.light === undefined) return;
    e.preventDefault();
    selectedLight = parseInt(markerEl.dataset.light, 10);
    draggedLight = selectedLight;
    // Which orbit hemisphere is the light on right now? Preserve it while dragging.
    const pz = lightPositions[draggedLight * 3 + 2];
    const distNow = Math.sqrt(
      lightPositions[draggedLight * 3] ** 2 +
      lightPositions[draggedLight * 3 + 1] ** 2 +
      pz * pz
    );
    dragBackHemi = distNow * distNow - pz * scene.cameraZ >= 0;
    // Relative drag baseline: cursor + the light's true projected position
    dragCursorStart = eventToCanvasPixels(e.clientX, e.clientY, false);
    const sp = engine.worldToScreen(lightPositions[draggedLight * 3], lightPositions[draggedLight * 3 + 1], lightPositions[draggedLight * 3 + 2]);
    dragProjStart = { x: sp.x, y: sp.y };
    updateLightMarkers();
    const move = (ev: PointerEvent) => dragLightTo(ev.clientX, ev.clientY);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      draggedLight = -1;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  lightMarkersEl.addEventListener('wheel', e => {
    const markerEl = (e.target as HTMLElement).closest('.light-marker') as HTMLElement | null;
    if (!markerEl || markerEl.dataset.light === undefined) return;
    e.preventDefault();
    const i = parseInt(markerEl.dataset.light, 10);
    if (lights[i].type === 'directional') return; // distance means nothing for a directional light
    const distEl = document.getElementById(`light${i + 1}Dist`) as HTMLInputElement | null;
    if (!distEl) return;
    distEl.value = (parseFloat(distEl.value) + (e.deltaY > 0 ? 0.1 : -0.1)).toFixed(2);
    updateScene(); // updateScene clamps the value to the slider's dynamic bounds
  }, { passive: false });
}

// Scroll on the render to dolly the camera
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const el = document.getElementById('cameraZ') as HTMLInputElement | null;
  if (!el) return;
  const min = parseFloat(el.min), max = parseFloat(el.max);
  el.value = Math.min(max, Math.max(min, parseFloat(el.value) - e.deltaY * 0.005)).toFixed(1);
  updateScene();
}, { passive: false });

// Initial render (updateScene triggers the render and gradient initialization)
updateScene();
