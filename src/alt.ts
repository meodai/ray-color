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
  // Float64 to match the renderer's precision exactly — float32 rounding
  // shows up as off-by-one channel values after sRGB encoding
  dir: Float64Array; // unit direction from sphere center (surface anchor)
  color: Float64Array;
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
// Orthonormal basis perpendicular to each light's axis — area lights sample
// on a disk FACING the target, not a fixed horizontal one
const areaU = new Array(3).fill(null).map(() => new Float32Array(3));
const areaV = new Array(3).fill(null).map(() => new Float32Array(3));
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

// sRGB <-> linear: inputs (color pickers) are decoded to linear light for the
// shading math; results are encoded back to sRGB only when written to pixels.
const srgbToLinear = (s: number) => s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);

// Linear -> 8-bit sRGB via LUT (4096 steps is sub-LSB across the curve)
const SRGB_LUT = new Uint8Array(4096);
for (let i = 0; i < 4096; i++) {
  const c = i / 4095;
  const s = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  SRGB_LUT[i] = Math.min(255, Math.round(s * 255));
}
const toSRGB8 = (c: number) => SRGB_LUT[c >= 1 ? 4095 : c <= 0 ? 0 : (c * 4095 + 0.5) | 0];

function hexToRgb(hex: string, out: Float32Array) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (result) {
    out[0] = srgbToLinear(parseInt(result[1], 16) / 255);
    out[1] = srgbToLinear(parseInt(result[2], 16) / 255);
    out[2] = srgbToLinear(parseInt(result[3], 16) / 255);
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
    const ax = -dx / alen, ay = -dy / alen, az = -dz / alen;
    spotAxes[i][0] = ax;
    spotAxes[i][1] = ay;
    spotAxes[i][2] = az;
    // Disk basis: u = normalize(helper x axis), v = axis x u
    const hy = Math.abs(ay) > 0.99 ? 0 : 1;
    const hx = 1 - hy;
    let ux = hy * az;
    let uy = -hx * az;
    let uz = hx * ay - hy * ax;
    const ulen = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
    ux /= ulen; uy /= ulen; uz /= ulen;
    areaU[i][0] = ux; areaU[i][1] = uy; areaU[i][2] = uz;
    areaV[i][0] = ay * uz - az * uy;
    areaV[i][1] = az * ux - ax * uz;
    areaV[i][2] = ax * uy - ay * ux;
  }
}

// ---------------------------------------------------------------- camera cache

let cachedTanFov = 0, cachedAspectRatio = 1, cachedAspectTanFov = 0;
let rayDirectionCache: Float32Array | null = null;
let cacheWidth = 0, cacheHeight = 0, cachedRayFOV = -1;

// G-buffer: per-pixel primary-hit cache (kind, position, normal). Valid while
// the camera and sphere geometry are unchanged — light edits then skip all
// primary intersection work and only re-shade.
let gbKind: Uint8Array = new Uint8Array(0);   // 0 miss · 1 sphere · 2 wall
let gbData: Float64Array = new Float64Array(0); // x y z nx ny nz per pixel (f64 = exact re-shades)
let gbStamp: Uint32Array = new Uint32Array(0);
let geomStamp = 1;
let gbCameraZ = NaN, gbFov = NaN, gbRadius = NaN;

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
  gbKind = new Uint8Array(cacheWidth * cacheHeight);
  gbData = new Float64Array(cacheWidth * cacheHeight * 6);
  gbStamp = new Uint32Array(cacheWidth * cacheHeight);
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

// Reusable hit records — the hot loops run millions of intersections per
// second, so hits are written into scratch objects instead of fresh ones.
// Callers must consume a hit before the next call of the same function.
const sphereHitScratch = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, t: 0 };
const roomHitScratch = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, t: 0 };

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
  const s = sphereHitScratch;
  s.x = hitX; s.y = hitY; s.z = hitZ;
  s.nx = hitX * invRadius; s.ny = hitY * invRadius; s.nz = hitZ * invRadius;
  s.t = t;
  return s;
}

// Shadow rays only need the hit distance — no hit point, no allocation
function sphereShadowT(originX: number, originY: number, originZ: number, dirX: number, dirY: number, dirZ: number, radius: number) {
  const a = dirX * dirX + dirY * dirY + dirZ * dirZ;
  const b = 2 * (originX * dirX + originY * dirY + originZ * dirZ);
  const c = originX * originX + originY * originY + originZ * originZ - radius * radius;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return Infinity;
  const sqrtD = Math.sqrt(disc);
  let t = (-b - sqrtD) / (2 * a);
  if (t < 0) t = (-b + sqrtD) / (2 * a);
  if (t < 0) return Infinity;
  return t;
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
  const s = roomHitScratch;
  s.x = originX + dirX * minT;
  s.y = originY + dirY * minT;
  s.z = originZ + dirZ * minT;
  s.nx = nX; s.ny = nY; s.nz = nZ;
  s.t = minT;
  return s;
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
      const shadowT = sphereShadowT(hitX + normalX * bias, hitY + normalY * bias, hitZ + normalZ * bias, Lx, Ly, Lz, radius);
      if (shadowT === Infinity) {
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
          const shadowT = sphereShadowT(hitX + normalX * bias, hitY + normalY * bias, hitZ + normalZ * bias, Lx, Ly, Lz, radius);
          if (shadowT >= dist) {
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
          // Deterministic golden-angle spiral on the disk facing the target
          const r = Math.sqrt((s + 0.5) / shadowSamples) * state.lightSize;
          const theta = s * GOLDEN_ANGLE;
          const ox = Math.cos(theta) * r;
          const oy = Math.sin(theta) * r;
          sampleX += areaU[i][0] * ox + areaV[i][0] * oy;
          sampleY += areaU[i][1] * ox + areaV[i][1] * oy;
          sampleZ += areaU[i][2] * ox + areaV[i][2] * oy;
        }
        let Lx = sampleX - hitX, Ly = sampleY - hitY, Lz = sampleZ - hitZ;
        const dist = Math.sqrt(Lx * Lx + Ly * Ly + Lz * Lz);
        if (dist === 0) continue;
        Lx /= dist; Ly /= dist; Lz /= dist;
        const shadowT = sphereShadowT(hitX + normalX * bias, hitY + normalY * bias, hitZ + normalZ * bias, Lx, Ly, Lz, radius);
        if (shadowT < dist) continue;
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
          const type = lights[i].type;
          let wallDiffuse = 0;
          if (type === 'directional') {
            // Directional lights are pure directions — no distance, no falloff
            wallDiffuse = Math.max(0, wallHit.nx * directionalDirs[i][0] + wallHit.ny * directionalDirs[i][1] + wallHit.nz * directionalDirs[i][2]);
          } else {
            const wlX = lightPositions[i * 3] - wallHit.x;
            const wlY = lightPositions[i * 3 + 1] - wallHit.y;
            const wlZ = lightPositions[i * 3 + 2] - wallHit.z;
            const wlLen = Math.sqrt(wlX * wlX + wlY * wlY + wlZ * wlZ);
            if (wlLen > 0) {
              const inv = 1 / wlLen;
              // Same inverse-square attenuation as the direct pass
              wallDiffuse = Math.max(0, (wallHit.nx * wlX + wallHit.ny * wlY + wallHit.nz * wlZ) * inv) / Math.max(0.01, wlLen * wlLen);
              if (type === 'spot') {
                // Respect the cone: bounce only where the spot actually shines
                const LdotAxis = -((wlX * inv) * spotAxes[i][0] + (wlY * inv) * spotAxes[i][1] + (wlZ * inv) * spotAxes[i][2]);
                const cosAngle = Math.cos((lightAngles[i] * Math.PI) / 180);
                if (LdotAxis <= cosAngle) {
                  wallDiffuse = 0;
                } else {
                  const edge = (LdotAxis - cosAngle) / (1 - cosAngle);
                  wallDiffuse *= edge * edge * (3 - 2 * edge);
                }
              }
            }
          }
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
  shadeScratch.r = colorR * objColorR;
  shadeScratch.g = colorG * objColorG;
  shadeScratch.b = colorB * objColorB;
  return shadeScratch;
}

// Shading result scratch — consumed immediately by every caller
const shadeScratch = { r: 0, g: 0, b: 0 };

// skipStride: pixels whose coordinates are multiples of it were already
// computed exactly by the previous (coarser) pass — leave them untouched
function renderPass(scale: number, skipStride = 0) {
  const width = canvas.width;
  const height = canvas.height;
  for (let y = 0; y < height; y += scale) {
    for (let x = 0; x < width; x += scale) {
      if (skipStride !== 0 && x % skipStride === 0 && y % skipStride === 0) continue;
      const pix = y * width + x;
      let color;
      if (gbStamp[pix] === geomStamp) {
        // Geometry unchanged since last render: re-shade the cached hit
        const kind = gbKind[pix];
        if (kind === 1) {
          const o = pix * 6;
          color = calculateLighting(gbData[o], gbData[o + 1], gbData[o + 2], gbData[o + 3], gbData[o + 4], gbData[o + 5], sphereColor[0], sphereColor[1], sphereColor[2]);
        } else if (kind === 2) {
          const o = pix * 6;
          color = calculateLighting(gbData[o], gbData[o + 1], gbData[o + 2], gbData[o + 3], gbData[o + 4], gbData[o + 5], wallColor[0], wallColor[1], wallColor[2], false);
          color.r *= 0.5;
          color.g *= 0.5;
          color.b *= 0.5;
        } else {
          color = shadeScratch;
          color.r = 0; color.g = 0; color.b = 0;
        }
      } else {
        const ri = pix * 3;
        const dirX = rayDirectionCache![ri];
        const dirY = rayDirectionCache![ri + 1];
        const dirZ = rayDirectionCache![ri + 2];
        const o = pix * 6;
        const sphereHit = intersectSphere(0, 0, state.cameraZ, dirX, dirY, dirZ, state.sphereRadius);
        if (sphereHit) {
          // Shade at normal * radius — the exact reconstruction samples use,
          // so a sampled color always matches its rendered pixel bit-for-bit
          const hx = sphereHit.nx * state.sphereRadius;
          const hy = sphereHit.ny * state.sphereRadius;
          const hz = sphereHit.nz * state.sphereRadius;
          gbKind[pix] = 1;
          gbData[o] = hx; gbData[o + 1] = hy; gbData[o + 2] = hz;
          gbData[o + 3] = sphereHit.nx; gbData[o + 4] = sphereHit.ny; gbData[o + 5] = sphereHit.nz;
          color = calculateLighting(hx, hy, hz, sphereHit.nx, sphereHit.ny, sphereHit.nz, sphereColor[0], sphereColor[1], sphereColor[2]);
        } else {
          const roomHit = intersectRoom(0, 0, state.cameraZ, dirX, dirY, dirZ);
          if (roomHit) {
            gbKind[pix] = 2;
            gbData[o] = roomHit.x; gbData[o + 1] = roomHit.y; gbData[o + 2] = roomHit.z;
            gbData[o + 3] = roomHit.nx; gbData[o + 4] = roomHit.ny; gbData[o + 5] = roomHit.nz;
            color = calculateLighting(roomHit.x, roomHit.y, roomHit.z, roomHit.nx, roomHit.ny, roomHit.nz, wallColor[0], wallColor[1], wallColor[2], false);
            color.r *= 0.5;
            color.g *= 0.5;
            color.b *= 0.5;
          } else {
            gbKind[pix] = 0;
            color = shadeScratch;
            color.r = 0; color.g = 0; color.b = 0;
          }
        }
        gbStamp[pix] = geomStamp;
      }
      const r = toSRGB8(color.r);
      const g = toSRGB8(color.g);
      const b = toSRGB8(color.b);
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
  // Invalidate the G-buffer when anything that shapes primary rays changed
  if (gbCameraZ !== state.cameraZ || gbFov !== state.fov || gbRadius !== state.sphereRadius) {
    geomStamp++;
    gbCameraZ = state.cameraZ;
    gbFov = state.fov;
    gbRadius = state.sphereRadius;
  }
  for (let pass = 0; pass < passScales.length; pass++) {
    renderPass(passScales[pass], pass === 0 ? 0 : passScales[pass - 1]);
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

function sampleColorAt(dir: Float64Array) {
  const r = state.sphereRadius;
  return calculateLighting(dir[0] * r, dir[1] * r, dir[2] * r, dir[0], dir[1], dir[2], sphereColor[0], sphereColor[1], sphereColor[2]);
}

function pointerToLightAngles(x: number, y: number, dist: number, backHemi = false) {
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
    // Near root = camera-side hemisphere, far root = behind: keep the light
    // on the hemisphere it was on when the drag started
    let t = backHemi ? (-b + sqrtD) / 2 : (-b - sqrtD) / 2;
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
      const vz = wz - state.cameraZ;
      const dl = Math.sqrt(wx * wx + wy * wy + vz * vz) || 1;
      const occ = intersectSphere(0, 0, state.cameraZ, wx / dl, wy / dl, vz / dl, state.sphereRadius);
      const hidden = !!occ && occ.t < dl - 1e-2;
      const p = worldToScreen(wx, wy, wz);
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
    const r = (state.lightSize / (screenPos.z * cachedTanFov)) * (canvas.height / 2);
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
  const hit = castRayAt(x, y);
  if (!hit) return;
  const dir = new Float64Array([hit.nx, hit.ny, hit.nz]);
  const color = sampleColorAt(dir);
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
  const sp = worldToScreen(lightPositions[draggedLight * 3], lightPositions[draggedLight * 3 + 1], lightPositions[draggedLight * 3 + 2]);
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
  const res = pointerToLightAngles(x, y, l.dist, dragBackHemi);
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
