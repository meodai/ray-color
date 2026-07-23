// Ray Color playground — direct-manipulation alternative to index.html.
// Same raycaster core; state lives here and the UI is a projection of it.

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d');
if (!ctx) throw new Error('Canvas 2D context unavailable');
const imageData = ctx.createImageData(canvas.width, canvas.height);

const passScales = [4, 2, 1];
const MAX_LIGHT_DISTANCE = 12;

// ---------------------------------------------------------------- state

interface Light {
  type: 'point' | 'area' | 'directional' | 'spot';
  yaw: number;    // degrees
  pitch: number;  // degrees
  dist: number;
  hex: string;
  intensity: number;
  angle: number;  // spot cone, degrees
}

const state = {
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

interface Sample {
  dir: Float32Array; // unit direction from sphere center (surface anchor)
  color: Float32Array;
  marker: HTMLElement;
}
let samples: Sample[] = [];
let selectedLight = -1;

// Flat arrays for the hot loops, rebuilt from `lights` by syncLights()
const sphereColor = new Float32Array(3);
const wallColor = new Float32Array(3);
const lightPositions = new Float32Array(9);
const lightColors = new Float32Array(9);
const lightIntensities = new Float32Array(3);
const lightAngles = new Float32Array(3);
const directionalDirs = new Array(3).fill(null).map(() => new Float32Array(3));
const spotAxes = new Array(3).fill(null).map(() => new Float32Array(3));

function hexToRgb(hex: string, out: Float32Array) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (result) {
    out[0] = parseInt(result[1], 16) / 255;
    out[1] = parseInt(result[2], 16) / 255;
    out[2] = parseInt(result[3], 16) / 255;
  }
  return out;
}

function syncLights() {
  hexToRgb(state.sphereHex, sphereColor);
  hexToRgb(state.wallHex, wallColor);
  for (let i = 0; i < 3; i++) {
    const l = lights[i];
    l.dist = Math.min(MAX_LIGHT_DISTANCE, Math.max(state.sphereRadius, l.dist));
    const yaw = l.yaw * Math.PI / 180;
    const pitch = l.pitch * Math.PI / 180;
    const dx = Math.cos(pitch) * Math.cos(yaw);
    const dy = Math.sin(pitch);
    const dz = Math.cos(pitch) * Math.sin(yaw);
    lightPositions[i * 3] = dx * l.dist;
    lightPositions[i * 3 + 1] = dy * l.dist;
    lightPositions[i * 3 + 2] = dz * l.dist;
    hexToRgb(l.hex, lightColors.subarray(i * 3, i * 3 + 3));
    lightIntensities[i] = l.intensity;
    lightAngles[i] = l.angle;
    directionalDirs[i][0] = dx;
    directionalDirs[i][1] = dy;
    directionalDirs[i][2] = dz;
    const alen = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    spotAxes[i][0] = -dx / alen;
    spotAxes[i][1] = -dy / alen;
    spotAxes[i][2] = -dz / alen;
  }
}

// ---------------------------------------------------------------- camera cache

let cachedTanFov = 0, cachedAspectRatio = 1, cachedAspectTanFov = 0;
let rayDirectionCache: Float32Array | null = null;
let cacheWidth = 0, cacheHeight = 0, cachedRayFOV = -1;

function updateCache() {
  cachedTanFov = Math.tan(((state.fov * Math.PI) / 180) / 2);
  cachedAspectRatio = canvas.width / canvas.height;
  cachedAspectTanFov = cachedAspectRatio * cachedTanFov;
  if (cacheWidth === canvas.width && cacheHeight === canvas.height &&
      cachedRayFOV === state.fov && rayDirectionCache) {
    return;
  }
  cacheWidth = canvas.width;
  cacheHeight = canvas.height;
  cachedRayFOV = state.fov;
  rayDirectionCache = new Float32Array(cacheWidth * cacheHeight * 3);
  for (let y = 0; y < cacheHeight; y++) {
    for (let x = 0; x < cacheWidth; x++) {
      const idx = (y * cacheWidth + x) * 3;
      const px = (2 * ((x + 0.5) / cacheWidth) - 1) * cachedAspectTanFov;
      const py = -(2 * ((y + 0.5) / cacheHeight) - 1) * cachedTanFov;
      const len = Math.sqrt(px * px + py * py + 1);
      rayDirectionCache[idx] = px / len;
      rayDirectionCache[idx + 1] = py / len;
      rayDirectionCache[idx + 2] = 1 / len;
    }
  }
}

// ---------------------------------------------------------------- raycaster core

function intersectSphere(originX: number, originY: number, originZ: number, dirX: number, dirY: number, dirZ: number, radius: number) {
  const a = dirX * dirX + dirY * dirY + dirZ * dirZ;
  const b = 2 * (originX * dirX + originY * dirY + originZ * dirZ);
  const c = originX * originX + originY * originY + originZ * originZ - radius * radius;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sqrtD = Math.sqrt(disc);
  let t = (-b - sqrtD) / (2 * a);
  if (t < 0) t = (-b + sqrtD) / (2 * a);
  if (t < 0) return null;
  const hitX = originX + dirX * t;
  const hitY = originY + dirY * t;
  const hitZ = originZ + dirZ * t;
  const invRadius = 1 / radius;
  return { x: hitX, y: hitY, z: hitZ, nx: hitX * invRadius, ny: hitY * invRadius, nz: hitZ * invRadius, t };
}

function intersectRoom(originX: number, originY: number, originZ: number, dirX: number, dirY: number, dirZ: number) {
  const bounds = 2;
  let minT = Infinity;
  let nX = 0, nY = 0, nZ = 0;
  if (Math.abs(dirZ) > 1e-6) {
    const t = (bounds - originZ) / dirZ;
    if (t > 0) {
      const hx = originX + dirX * t, hy = originY + dirY * t;
      if (Math.abs(hx) <= bounds && Math.abs(hy) <= bounds && t < minT) { minT = t; nX = 0; nY = 0; nZ = -1; }
    }
  }
  if (Math.abs(dirX) > 1e-6) {
    for (const side of [-bounds, bounds]) {
      const t = (side - originX) / dirX;
      if (t > 0) {
        const hy = originY + dirY * t, hz = originZ + dirZ * t;
        if (Math.abs(hy) <= bounds && Math.abs(hz) <= bounds && t < minT) { minT = t; nX = side < 0 ? 1 : -1; nY = 0; nZ = 0; }
      }
    }
  }
  if (Math.abs(dirY) > 1e-6) {
    for (const side of [-bounds, bounds]) {
      const t = (side - originY) / dirY;
      if (t > 0) {
        const hx = originX + dirX * t, hz = originZ + dirZ * t;
        if (Math.abs(hx) <= bounds && Math.abs(hz) <= bounds && t < minT) { minT = t; nX = 0; nY = side < 0 ? 1 : -1; nZ = 0; }
      }
    }
  }
  if (minT === Infinity) return null;
  return {
    x: originX + dirX * minT, y: originY + dirY * minT, z: originZ + dirZ * minT,
    nx: nX, ny: nY, nz: nZ, t: minT
  };
}

const indirectDirs = [
  { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 },
  { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 },
];

function calculateLighting(
  hitX: number, hitY: number, hitZ: number,
  normalX: number, normalY: number, normalZ: number,
  objColorR: number, objColorG: number, objColorB: number,
  enableIndirect = true
): { r: number, g: number, b: number } {
  let colorR = 0, colorG = 0, colorB = 0;
  const radius = state.sphereRadius;

  for (let i = 0; i < 3; i++) {
    const lightType = lights[i].type;
    const lightX = lightPositions[i * 3];
    const lightY = lightPositions[i * 3 + 1];
    const lightZ = lightPositions[i * 3 + 2];
    const intensity = lightIntensities[i];
    let lightContribR = 0, lightContribG = 0, lightContribB = 0;
    if (intensity <= 0 || (lightColors[i * 3] === 0 && lightColors[i * 3 + 1] === 0 && lightColors[i * 3 + 2] === 0)) {
      continue;
    }
    const bias = radius * 0.001 + 1e-4;

    if (lightType === 'directional') {
      const Lx = directionalDirs[i][0];
      const Ly = directionalDirs[i][1];
      const Lz = directionalDirs[i][2];
      const shadowHit = intersectSphere(hitX + normalX * bias, hitY + normalY * bias, hitZ + normalZ * bias, Lx, Ly, Lz, radius);
      if (!shadowHit) {
        const NdotL = Math.max(0, normalX * Lx + normalY * Ly + normalZ * Lz);
        lightContribR = lightColors[i * 3] * NdotL * intensity;
        lightContribG = lightColors[i * 3 + 1] * NdotL * intensity;
        lightContribB = lightColors[i * 3 + 2] * NdotL * intensity;
      }
    } else if (lightType === 'spot') {
      let Lx = lightX - hitX, Ly = lightY - hitY, Lz = lightZ - hitZ;
      const dist = Math.sqrt(Lx * Lx + Ly * Ly + Lz * Lz);
      if (dist > 0) {
        Lx /= dist; Ly /= dist; Lz /= dist;
        const Ax = spotAxes[i][0], Ay = spotAxes[i][1], Az = spotAxes[i][2];
        const LdotAxis = -(Lx * Ax + Ly * Ay + Lz * Az);
        const cosAngle = Math.cos((lightAngles[i] * Math.PI) / 180);
        if (LdotAxis > cosAngle) {
          const shadowHit = intersectSphere(hitX + normalX * bias, hitY + normalY * bias, hitZ + normalZ * bias, Lx, Ly, Lz, radius);
          if (!shadowHit || shadowHit.t >= dist) {
            const edge = (LdotAxis - cosAngle) / (1 - cosAngle);
            const falloff = edge * edge * (3 - 2 * edge);
            const NdotL = Math.max(0, normalX * Lx + normalY * Ly + normalZ * Lz);
            const att = 1 / Math.max(0.01, dist * dist);
            lightContribR = lightColors[i * 3] * NdotL * intensity * falloff * att;
            lightContribG = lightColors[i * 3 + 1] * NdotL * intensity * falloff * att;
            lightContribB = lightColors[i * 3 + 2] * NdotL * intensity * falloff * att;
          }
        }
      }
    } else { // point / area
      const shadowSamples = (lightType === 'area' && state.lightSize > 0) ? state.areaQuality : 1;
      let accumR = 0, accumG = 0, accumB = 0;
      for (let s = 0; s < shadowSamples; s++) {
        let sampleX = lightX, sampleY = lightY, sampleZ = lightZ;
        if (lightType === 'area' && state.lightSize > 0) {
          const u = (s + 0.5) / shadowSamples;
          const v = (s * 37 % shadowSamples + 0.5) / shadowSamples;
          const r = Math.sqrt(u) * state.lightSize;
          const theta = 2 * Math.PI * v;
          sampleX += Math.cos(theta) * r;
          sampleY += Math.sin(theta) * r;
        }
        let Lx = sampleX - hitX, Ly = sampleY - hitY, Lz = sampleZ - hitZ;
        const dist = Math.sqrt(Lx * Lx + Ly * Ly + Lz * Lz);
        if (dist === 0) continue;
        Lx /= dist; Ly /= dist; Lz /= dist;
        const shadowHit = intersectSphere(hitX + normalX * bias, hitY + normalY * bias, hitZ + normalZ * bias, Lx, Ly, Lz, radius);
        if (shadowHit && shadowHit.t < dist) continue;
        const NdotL = Math.max(0, normalX * Lx + normalY * Ly + normalZ * Lz);
        const att = 1 / Math.max(0.01, dist * dist);
        accumR += lightColors[i * 3] * NdotL * att;
        accumG += lightColors[i * 3 + 1] * NdotL * att;
        accumB += lightColors[i * 3 + 2] * NdotL * att;
      }
      const scale = intensity / shadowSamples;
      lightContribR = accumR * scale;
      lightContribG = accumG * scale;
      lightContribB = accumB * scale;
    }
    colorR += lightContribR;
    colorG += lightContribG;
    colorB += lightContribB;
  }

  if (enableIndirect && state.indirect > 0) {
    let indirectR = 0, indirectG = 0, indirectB = 0;
    for (let s = 0; s < indirectDirs.length; s++) {
      const dir = indirectDirs[s];
      const dot = normalX * dir.x + normalY * dir.y + normalZ * dir.z;
      if (dot <= 0) continue;
      const wallHit = intersectRoom(hitX + normalX * 0.001, hitY + normalY * 0.001, hitZ + normalZ * 0.001, dir.x, dir.y, dir.z);
      if (wallHit) {
        let wallLightR = 0, wallLightG = 0, wallLightB = 0;
        for (let i = 0; i < 3; i++) {
          const wlX = lightPositions[i * 3] - wallHit.x;
          const wlY = lightPositions[i * 3 + 1] - wallHit.y;
          const wlZ = lightPositions[i * 3 + 2] - wallHit.z;
          const wlInvLen = 1 / Math.sqrt(wlX * wlX + wlY * wlY + wlZ * wlZ);
          const wallDiffuse = Math.max(0, (wallHit.nx * wlX + wallHit.ny * wlY + wallHit.nz * wlZ) * wlInvLen);
          wallLightR += lightColors[i * 3] * wallDiffuse * lightIntensities[i];
          wallLightG += lightColors[i * 3 + 1] * wallDiffuse * lightIntensities[i];
          wallLightB += lightColors[i * 3 + 2] * wallDiffuse * lightIntensities[i];
        }
        const dx = wallHit.x - hitX, dy = wallHit.y - hitY, dz = wallHit.z - hitZ;
        const attenuation = dot / (1 + Math.sqrt(dx * dx + dy * dy + dz * dz) * 0.5);
        indirectR += wallColor[0] * wallLightR * attenuation;
        indirectG += wallColor[1] * wallLightG * attenuation;
        indirectB += wallColor[2] * wallLightB * attenuation;
      }
    }
    const indirectScale = state.indirect / indirectDirs.length;
    colorR += indirectR * indirectScale;
    colorG += indirectG * indirectScale;
    colorB += indirectB * indirectScale;
  }
  return { r: colorR * objColorR, g: colorG * objColorG, b: colorB * objColorB };
}

function renderPass(scale: number) {
  const width = canvas.width;
  const height = canvas.height;
  const useCache = (scale === 1 && rayDirectionCache);
  for (let y = 0; y < height; y += scale) {
    for (let x = 0; x < width; x += scale) {
      let dirX, dirY, dirZ;
      if (useCache && rayDirectionCache) {
        const idx = (y * width + x) * 3;
        dirX = rayDirectionCache[idx];
        dirY = rayDirectionCache[idx + 1];
        dirZ = rayDirectionCache[idx + 2];
      } else {
        const px = (2 * ((x + 0.5) / width) - 1) * cachedAspectTanFov;
        const py = -(2 * ((y + 0.5) / height) - 1) * cachedTanFov;
        const len = Math.sqrt(px * px + py * py + 1);
        dirX = px / len;
        dirY = py / len;
        dirZ = 1 / len;
      }
      const sphereHit = intersectSphere(0, 0, state.cameraZ, dirX, dirY, dirZ, state.sphereRadius);
      let color;
      if (sphereHit) {
        color = calculateLighting(sphereHit.x, sphereHit.y, sphereHit.z, sphereHit.nx, sphereHit.ny, sphereHit.nz, sphereColor[0], sphereColor[1], sphereColor[2]);
      } else {
        const roomHit = intersectRoom(0, 0, state.cameraZ, dirX, dirY, dirZ);
        if (roomHit) {
          color = calculateLighting(roomHit.x, roomHit.y, roomHit.z, roomHit.nx, roomHit.ny, roomHit.nz, wallColor[0], wallColor[1], wallColor[2], false);
          color.r *= 0.5;
          color.g *= 0.5;
          color.b *= 0.5;
        } else {
          color = { r: 0, g: 0, b: 0 };
        }
      }
      const r = Math.min(255, color.r * 255) | 0;
      const g = Math.min(255, color.g * 255) | 0;
      const b = Math.min(255, color.b * 255) | 0;
      for (let py = 0; py < scale && y + py < height; py++) {
        for (let px = 0; px < scale && x + px < width; px++) {
          const idx = ((y + py) * width + (x + px)) * 4;
          imageData.data[idx] = r;
          imageData.data[idx + 1] = g;
          imageData.data[idx + 2] = b;
          imageData.data[idx + 3] = 255;
        }
      }
    }
  }
  ctx!.putImageData(imageData, 0, 0);
}

async function startRender() {
  updateCache();
  for (let pass = 0; pass < passScales.length; pass++) {
    renderPass(passScales[pass]);
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

function worldToScreen(px: number, py: number, pz: number) {
  const relativeZ = pz - state.cameraZ;
  return {
    x: (px / (relativeZ * cachedTanFov * cachedAspectRatio) + 1) * canvas.width / 2,
    y: (-py / (relativeZ * cachedTanFov) + 1) * canvas.height / 2,
    z: relativeZ
  };
}

function eventToCanvasPixels(clientX: number, clientY: number, clamp = true) {
  const rect = canvas.getBoundingClientRect();
  let x = (clientX - rect.left) * (canvas.width / rect.width);
  let y = (clientY - rect.top) * (canvas.height / rect.height);
  if (clamp) {
    x = Math.min(canvas.width - 1, Math.max(0, x));
    y = Math.min(canvas.height - 1, Math.max(0, y));
  }
  return { x, y };
}

function castRayAt(x: number, y: number) {
  let dirX, dirY, dirZ;
  if (rayDirectionCache) {
    const idx = (Math.floor(y) * canvas.width + Math.floor(x)) * 3;
    dirX = rayDirectionCache[idx];
    dirY = rayDirectionCache[idx + 1];
    dirZ = rayDirectionCache[idx + 2];
  } else {
    const px = (2 * (x / canvas.width) - 1) * cachedAspectTanFov;
    const py = -(2 * (y / canvas.height) - 1) * cachedTanFov;
    const len = Math.sqrt(px * px + py * py + 1);
    dirX = px / len;
    dirY = py / len;
    dirZ = 1 / len;
  }
  return intersectSphere(0, 0, state.cameraZ, dirX, dirY, dirZ, state.sphereRadius);
}

function sampleColorAt(dir: Float32Array) {
  const r = state.sphereRadius;
  return calculateLighting(dir[0] * r, dir[1] * r, dir[2] * r, dir[0], dir[1], dir[2], sphereColor[0], sphereColor[1], sphereColor[2]);
}

function pointerToLightAngles(x: number, y: number, dist: number) {
  const px = (2 * ((x + 0.5) / canvas.width) - 1) * cachedAspectTanFov;
  const py = -(2 * ((y + 0.5) / canvas.height) - 1) * cachedTanFov;
  const len = Math.sqrt(px * px + py * py + 1);
  const dx = px / len, dy = py / len, dz = 1 / len;
  const b = 2 * state.cameraZ * dz;
  const disc = b * b - 4 * (state.cameraZ * state.cameraZ - dist * dist);
  let X, Y, Z;
  let newDist = dist;
  if (disc >= 0) {
    const sqrtD = Math.sqrt(disc);
    let t = (-b - sqrtD) / 2;
    if (t < 0) t = (-b + sqrtD) / 2;
    X = dx * t;
    Y = dy * t;
    Z = state.cameraZ + dz * t;
  } else {
    const t = -state.cameraZ * dz;
    X = dx * t;
    Y = dy * t;
    Z = state.cameraZ + dz * t;
    newDist = Math.sqrt(X * X + Y * Y + Z * Z) || dist;
  }
  const pitch = Math.asin(Math.max(-1, Math.min(1, Y / newDist))) * 180 / Math.PI;
  const yaw = Math.atan2(Z, X) * 180 / Math.PI;
  return { yaw, pitch, dist: newDist };
}

// ---------------------------------------------------------------- markers, gizmo, inspector

const lightLayer = document.getElementById('light-layer')!;
const sampleLayer = document.getElementById('sample-layer')!;
const gizmoSvg = document.getElementById('gizmo')!;
const inspector = document.getElementById('inspector')!;

// Is the sphere between the camera and this light?
function isLightOccluded(i: number) {
  const lx = lightPositions[i * 3];
  const ly = lightPositions[i * 3 + 1];
  const lz = lightPositions[i * 3 + 2];
  const vz = lz - state.cameraZ;
  const dist = Math.sqrt(lx * lx + ly * ly + vz * vz) || 1;
  const hit = intersectSphere(0, 0, state.cameraZ, lx / dist, ly / dist, vz / dist, state.sphereRadius);
  return !!hit && hit.t < dist - 1e-3;
}

function updateLightMarkers() {
  lightLayer.innerHTML = '';
  for (let i = 0; i < 3; i++) {
    const screenPos = worldToScreen(lightPositions[i * 3], lightPositions[i * 3 + 1], lightPositions[i * 3 + 2]);
    if (screenPos.z <= 0) continue;
    const cx = Math.max(0, Math.min(canvas.width, screenPos.x));
    const cy = Math.max(0, Math.min(canvas.height, screenPos.y));
    const normalizedScale = Math.max(0, Math.min(1, (8 - screenPos.z) / 7.5));
    const marker = document.createElement('div');
    marker.className = `marker light-marker${lights[i].type === 'directional' ? ' light-marker--directional' : ''}`;
    marker.dataset.light = String(i);
    if (cx !== screenPos.x || cy !== screenPos.y) marker.classList.add('marker--offscreen');
    if (i === selectedLight) marker.classList.add('marker--selected');
    marker.style.left = `${(cx / canvas.width) * 100}%`;
    marker.style.top = `${(cy / canvas.height) * 100}%`;
    // Hollow ring = the light is behind the sphere
    if (isLightOccluded(i)) {
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
  const screenPos = worldToScreen(lightPositions[i * 3], lightPositions[i * 3 + 1], lightPositions[i * 3 + 2]);
  if (screenPos.z <= 0) return;
  const cx = Math.max(0, Math.min(canvas.width, screenPos.x));
  const cy = Math.max(0, Math.min(canvas.height, screenPos.y));
  const NS = 'http://www.w3.org/2000/svg';
  const type = lights[i].type;
  if (type === 'directional' || type === 'spot') {
    for (const [width, cls] of [['3', 'gizmo-line-casing'], ['1', 'gizmo-line']] as const) {
      const line = document.createElementNS(NS, 'line');
      line.setAttribute('x1', cx.toFixed(1));
      line.setAttribute('y1', cy.toFixed(1));
      line.setAttribute('x2', (canvas.width / 2).toString());
      line.setAttribute('y2', (canvas.height / 2).toString());
      line.setAttribute('stroke-width', width);
      line.setAttribute('class', cls);
      gizmoSvg.appendChild(line);
    }
  }
  if (type === 'area' && state.lightSize > 0) {
    const r = (state.lightSize / (screenPos.z * cachedTanFov)) * (canvas.height / 2);
    const circle = document.createElementNS(NS, 'circle');
    circle.setAttribute('cx', cx.toFixed(1));
    circle.setAttribute('cy', cy.toFixed(1));
    circle.setAttribute('r', Math.max(2, r).toFixed(1));
    circle.setAttribute('class', 'gizmo-area');
    gizmoSvg.appendChild(circle);
  }

  // Cross-sphere rotation gizmo: a small wireframe sphere around the marker.
  // The equator ellipse scrubs yaw, the meridian ellipse scrubs pitch.
  const R = 26;         // sphere silhouette radius
  const SQUASH = 0.38;  // minor radius of the crossing ellipses

  const silhouette = document.createElementNS(NS, 'circle');
  silhouette.setAttribute('cx', cx.toFixed(1));
  silhouette.setAttribute('cy', cy.toFixed(1));
  silhouette.setAttribute('r', R.toString());
  silhouette.setAttribute('class', 'gizmo-sphere');
  gizmoSvg.appendChild(silhouette);

  const rings = [
    { axis: 'yaw', rx: R, ry: R * SQUASH },
    { axis: 'pitch', rx: R * SQUASH, ry: R },
  ] as const;
  for (const ring of rings) {
    for (const cls of ['gizmo-arc-casing', 'gizmo-arc']) {
      const el = document.createElementNS(NS, 'ellipse');
      el.setAttribute('cx', cx.toFixed(1));
      el.setAttribute('cy', cy.toFixed(1));
      el.setAttribute('rx', ring.rx.toFixed(1));
      el.setAttribute('ry', ring.ry.toFixed(1));
      el.setAttribute('class', cls);
      gizmoSvg.appendChild(el);
    }
    // Arrowheads at the ring's vertices, pointing along the drag axis
    const arrows = ring.axis === 'yaw'
      ? [[cx - ring.rx - 1, cy, 180], [cx + ring.rx + 1, cy, 0]]
      : [[cx, cy - ring.ry - 1, -90], [cx, cy + ring.ry + 1, 90]];
    for (const [ax, ay, rot] of arrows) {
      const head = document.createElementNS(NS, 'path');
      head.setAttribute('d', 'M 1.5 0 L -5 -3 L -5 3 Z');
      head.setAttribute('transform', `translate(${ax.toFixed(1)} ${ay.toFixed(1)}) rotate(${rot})`);
      head.setAttribute('class', 'gizmo-arrow');
      gizmoSvg.appendChild(head);
    }
    const hit = document.createElementNS(NS, 'ellipse');
    hit.setAttribute('cx', cx.toFixed(1));
    hit.setAttribute('cy', cy.toFixed(1));
    hit.setAttribute('rx', ring.rx.toFixed(1));
    hit.setAttribute('ry', ring.ry.toFixed(1));
    hit.setAttribute('class', `gizmo-hit gizmo-hit--${ring.axis}`);
    hit.dataset.handle = ring.axis;
    gizmoSvg.appendChild(hit);
  }
}

function updateSampleMarker(sample: Sample) {
  const r = state.sphereRadius;
  const screenPos = worldToScreen(sample.dir[0] * r, sample.dir[1] * r, sample.dir[2] * r);
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
  syncOutputs();
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
    const r = Math.floor(s.color[0] * 255), g = Math.floor(s.color[1] * 255), b = Math.floor(s.color[2] * 255);
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
  syncLights();
  updateCache();
  samples.forEach(sample => {
    const color = sampleColorAt(sample.dir);
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
  const hit = castRayAt(x, y);
  if (!hit) return;
  const dir = new Float32Array([hit.nx, hit.ny, hit.nz]);
  const color = sampleColorAt(dir);
  const marker = document.createElement('div');
  marker.className = 'marker sample-marker';
  const sample: Sample = { dir, color: new Float32Array([color.r, color.g, color.b]), marker };
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
    const hit = castRayAt(p.x, p.y);
    if (hit) {
      sample.dir[0] = hit.nx;
      sample.dir[1] = hit.ny;
      sample.dir[2] = hit.nz;
      const color = sampleColorAt(sample.dir);
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

lightLayer.addEventListener('pointerdown', e => {
  const markerEl = (e.target as HTMLElement).closest('.light-marker') as HTMLElement | null;
  if (!markerEl || markerEl.dataset.light === undefined) return;
  e.preventDefault();
  draggedLight = parseInt(markerEl.dataset.light, 10);
  dragMoved = false;
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
  const { x, y } = eventToCanvasPixels(clientX, clientY, false);
  const l = lights[draggedLight];
  const res = pointerToLightAngles(x, y, l.dist);
  l.yaw = Math.round(res.yaw);
  l.pitch = Math.round(Math.max(-89, Math.min(89, res.pitch)));
  if (res.dist !== l.dist) {
    l.dist = Math.min(MAX_LIGHT_DISTANCE, Math.max(state.sphereRadius, res.dist));
  }
  update();
}

// Axis-constrained scrubbing on the rotation arcs
gizmoSvg.addEventListener('pointerdown', e => {
  const axis = (e.target as SVGElement).dataset?.handle as 'yaw' | 'pitch' | undefined;
  if (!axis || selectedLight < 0) return;
  e.preventDefault();
  e.stopPropagation();
  const l = lights[selectedLight];
  const startX = e.clientX, startY = e.clientY;
  const startYaw = l.yaw, startPitch = l.pitch;
  const scale = canvas.width / canvas.getBoundingClientRect().width;
  const move = (ev: PointerEvent) => {
    if (axis === 'yaw') {
      const yaw = startYaw + (ev.clientX - startX) * scale * 0.5;
      l.yaw = Math.round(((yaw + 540) % 360) - 180); // wrap to [-180, 180]
    } else {
      l.pitch = Math.round(Math.max(-89, Math.min(89, startPitch - (ev.clientY - startY) * scale * 0.5)));
    }
    update();
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});

lightLayer.addEventListener('wheel', e => {
  const markerEl = (e.target as HTMLElement).closest('.light-marker') as HTMLElement | null;
  if (!markerEl || markerEl.dataset.light === undefined) return;
  e.preventDefault();
  const l = lights[parseInt(markerEl.dataset.light, 10)];
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

// ---------------------------------------------------------------- boot

syncOutputs();
update();
