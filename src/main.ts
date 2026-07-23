// Moved from <script> in index.html
const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d');
if (!ctx) throw new Error('Canvas 2D context unavailable');
const imageData = ctx.createImageData(canvas.width, canvas.height);
const resolutionDisplay = document.getElementById('resolution');
const fpsDisplay = document.getElementById('fps');

// Optimization 1: More aggressive progressive rendering
const passScales = [4, 2, 1];


// Vector operations using typed arrays
function vec3Set(out: Float32Array, x: number, y: number, z: number) {
  out[0] = x; out[1] = y; out[2] = z;
  return out;
}

// Scene state using typed arrays
let cameraZ = -3;
let cameraFOV = 30;
let sphereRadius = 0.8;
let sphereColor = new Float32Array([1.0, 1.0, 1.0]);
let wallColor = new Float32Array([.75, .75, .75]);
let indirectIntensity = 0.3;
let lightSize = 0.15;
const MAX_LIGHT_DISTANCE = 12;
interface ColorSample {
  // Float64 to match the renderer's precision exactly — float32 rounding
  // shows up as off-by-one channel values after sRGB encoding
  dir: Float64Array; // unit direction from sphere center — anchors the sample to the surface
  color: Float64Array;
  marker: HTMLElement;
}
let samples: ColorSample[] = [];
let areaSampleQuality = 6; // user adjustable
// All lights now use spherical controls (yaw/pitch + distance). Directional lights ignore distance for shading

// Cached normalized axes/directions
const directionalDirs = new Array(3).fill(null).map(() => new Float32Array(3));
const spotAxes = new Array(3).fill(null).map(() => new Float32Array(3));
// Orthonormal basis perpendicular to each light's axis — area lights sample
// on a disk FACING the target, not a fixed horizontal one
const areaU = new Array(3).fill(null).map(() => new Float32Array(3));
const areaV = new Array(3).fill(null).map(() => new Float32Array(3));
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

// Light arrays
const lightPositions = new Float32Array(9); // 3 lights x 3 components
const lightColors = new Float32Array(9);    // 3 lights x 3 components
const lightIntensities = new Float32Array(3);
const lightTypes = ['area', 'area', 'area']; // Default to area lights
const lightAngles = new Float32Array([30, 30, 30]); // Spot light angles

// Initialize lights
vec3Set(lightPositions.subarray(0, 3), 1, 1, -1);
vec3Set(lightPositions.subarray(3, 6), -1, 1, -1);
vec3Set(lightPositions.subarray(6, 9), 0, 1.5, -1);
vec3Set(lightColors.subarray(0, 3), 1, 0, 0);
vec3Set(lightColors.subarray(3, 6), 0, 1, 0);
vec3Set(lightColors.subarray(6, 9), 0, 0, 1);
lightIntensities[0] = lightIntensities[1] = lightIntensities[2] = 0.6;

// Optimization 3: Cache calculations
let cachedFovRad: number, cachedTanFov: number, cachedAspectRatio: number, cachedAspectTanFov: number;
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
  cachedFovRad = (cameraFOV * Math.PI) / 180;
  cachedTanFov = Math.tan(cachedFovRad / 2);
  cachedAspectRatio = canvas.width / canvas.height;
  cachedAspectTanFov = cachedAspectRatio * cachedTanFov;

  // Rebuild ray directions only when dimensions or FOV actually changed
  if (cacheWidth === canvas.width && cacheHeight === canvas.height &&
      cachedRayFOV === cameraFOV && rayDirectionCache) {
    return;
  }
  cacheWidth = canvas.width;
  cacheHeight = canvas.height;
  cachedRayFOV = cameraFOV;
  rayDirectionCache = new Float32Array(cacheWidth * cacheHeight * 3);
  gbKind = new Uint8Array(cacheWidth * cacheHeight);
  gbData = new Float64Array(cacheWidth * cacheHeight * 6);
  gbStamp = new Uint32Array(cacheWidth * cacheHeight);

  for (let y = 0; y < cacheHeight; y++) {
    for (let x = 0; x < cacheWidth; x++) {
      const idx = (y * cacheWidth + x) * 3;
      const px = (2 * ((x + 0.5) / cacheWidth) - 1) * cachedAspectTanFov;
      const py = -(2 * ((y + 0.5) / cacheHeight) - 1) * cachedTanFov;
      // Inline normalization
      const len = Math.sqrt(px * px + py * py + 1);
      rayDirectionCache[idx] = px / len;
      rayDirectionCache[idx + 1] = py / len;
      rayDirectionCache[idx + 2] = 1 / len;
    }
  }
}

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

  const gradientStops = stops.join(', ');
  document.documentElement.style.setProperty('--stops', gradientStops);
}


// Reusable hit records — the hot loops run millions of intersections per
// second, so hits are written into scratch objects instead of fresh ones.
// Callers must consume a hit before the next call of the same function.
const sphereHitScratch = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, t: 0 };
const roomHitScratch = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, t: 0 };

function intersectSphere(originX: number, originY: number, originZ: number, dirX: number, dirY: number, dirZ: number, radius: number) {
  const a = dirX * dirX + dirY * dirY + dirZ * dirZ; // usually 1 for normalized dirs
  const b = 2 * (originX * dirX + originY * dirY + originZ * dirZ);
  const c = originX * originX + originY * originY + originZ * originZ - radius * radius;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sqrtD = Math.sqrt(disc);
  let t = (-b - sqrtD) / (2 * a); // near root
  if (t < 0) t = (-b + sqrtD) / (2 * a); // far root (for inside sphere)
  if (t < 0) return null; // both behind
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
  const bounds = 2; // roomSize / 2
  let minT = Infinity;
  let hitNormalX = 0, hitNormalY = 0, hitNormalZ = 0;

  // Back wall (z = bounds)
  if (Math.abs(dirZ) > 1e-6) {
    const t = (bounds - originZ) / dirZ;
    if (t > 0) {
      const hitX = originX + dirX * t;
      const hitY = originY + dirY * t;
      if (Math.abs(hitX) <= bounds && Math.abs(hitY) <= bounds && t < minT) {
        minT = t;
        hitNormalX = 0; hitNormalY = 0; hitNormalZ = -1;
      }
    }
  }
  // Left wall (x = -bounds)
  if (Math.abs(dirX) > 1e-6) {
    const t = (-bounds - originX) / dirX;
    if (t > 0) {
      const hitY = originY + dirY * t;
      const hitZ = originZ + dirZ * t;
      if (Math.abs(hitY) <= bounds && Math.abs(hitZ) <= bounds && t < minT) {
        minT = t;
        hitNormalX = 1; hitNormalY = 0; hitNormalZ = 0;
      }
    }
  }
  // Right wall (x = bounds)
  if (Math.abs(dirX) > 1e-6) {
    const t = (bounds - originX) / dirX;
    if (t > 0) {
      const hitY = originY + dirY * t;
      const hitZ = originZ + dirZ * t;
      if (Math.abs(hitY) <= bounds && Math.abs(hitZ) <= bounds && t < minT) {
        minT = t;
        hitNormalX = -1; hitNormalY = 0; hitNormalZ = 0;
      }
    }
  }
  // Top wall (y = bounds)
  if (Math.abs(dirY) > 1e-6) {
    const t = (bounds - originY) / dirY;
    if (t > 0) {
      const hitX = originX + dirX * t;
      const hitZ = originZ + dirZ * t;
      if (Math.abs(hitX) <= bounds && Math.abs(hitZ) <= bounds && t < minT) {
        minT = t;
        hitNormalX = 0; hitNormalY = -1; hitNormalZ = 0;
      }
    }
  }
  // Bottom wall (y = -bounds)
  if (Math.abs(dirY) > 1e-6) {
    const t = (-bounds - originY) / dirY;
    if (t > 0) {
      const hitX = originX + dirX * t;
      const hitZ = originZ + dirZ * t;
      if (Math.abs(hitX) <= bounds && Math.abs(hitZ) <= bounds && t < minT) {
        minT = t;
        hitNormalX = 0; hitNormalY = 1; hitNormalZ = 0;
      }
    }
  }
  if (minT === Infinity) return null;
  const s = roomHitScratch;
  s.x = originX + dirX * minT;
  s.y = originY + dirY * minT;
  s.z = originZ + dirZ * minT;
  s.nx = hitNormalX; s.ny = hitNormalY; s.nz = hitNormalZ;
  s.t = minT;
  return s;
}


function calculateLighting(
  hitX: number, hitY: number, hitZ: number,
  normalX: number, normalY: number, normalZ: number,
  objColorR: number, objColorG: number, objColorB: number,
  enableIndirect = true
): { r: number, g: number, b: number } {
  let colorR = 0, colorG = 0, colorB = 0;

  // Direct lighting from various light types
  for (let i = 0; i < 3; i++) {
    const lightType = lightTypes[i];
    const lightX = lightPositions[i * 3];
    const lightY = lightPositions[i * 3 + 1];
    const lightZ = lightPositions[i * 3 + 2];
    const intensity = lightIntensities[i];

    let lightContribR = 0, lightContribG = 0, lightContribB = 0;
    // Skip lights with no contribution
    if (intensity <= 0 || (lightColors[i * 3] === 0 && lightColors[i * 3 + 1] === 0 && lightColors[i * 3 + 2] === 0)) {
      continue;
    }

    const bias = sphereRadius * 0.001 + 1e-4; // scaled bias to reduce acne

    if (lightType === 'directional') {
      // Cached direction points from the origin toward the light marker,
      // which is exactly the direction from a surface toward the light
      let Lx = directionalDirs[i][0];
      let Ly = directionalDirs[i][1];
      let Lz = directionalDirs[i][2];
      const shadowT = sphereShadowT(
        hitX + normalX * bias,
        hitY + normalY * bias,
        hitZ + normalZ * bias,
        Lx, Ly, Lz,
        sphereRadius
      );
      if (shadowT === Infinity) {
        const NdotL = Math.max(0, normalX * Lx + normalY * Ly + normalZ * Lz);
        lightContribR = lightColors[i * 3] * NdotL * intensity;
        lightContribG = lightColors[i * 3 + 1] * NdotL * intensity;
        lightContribB = lightColors[i * 3 + 2] * NdotL * intensity;
      }
    } else if (lightType === 'spot') {
      // L = lightPos - hit
      let Lx = lightX - hitX;
      let Ly = lightY - hitY;
      let Lz = lightZ - hitZ;
      const dist = Math.sqrt(Lx * Lx + Ly * Ly + Lz * Lz);
      if (dist > 0) {
        Lx /= dist; Ly /= dist; Lz /= dist;
        // Cached spot axis points from the light toward the origin.
        // A hit is inside the cone when -L (light-to-hit) aligns with the axis.
        const Ax = spotAxes[i][0], Ay = spotAxes[i][1], Az = spotAxes[i][2];
        const LdotAxis = -(Lx * Ax + Ly * Ay + Lz * Az);
        const angleRad = (lightAngles[i] * Math.PI) / 180;
        const cosAngle = Math.cos(angleRad);
        if (LdotAxis > cosAngle) {
          const shadowT = sphereShadowT(
            hitX + normalX * bias,
            hitY + normalY * bias,
            hitZ + normalZ * bias,
            Lx, Ly, Lz,
            sphereRadius
          );
            if (shadowT >= dist) {
              const edge = (LdotAxis - cosAngle) / (1 - cosAngle);
              // Smoothstep falloff (3x^2 - 2x^3)
              const falloff = edge * edge * (3 - 2 * edge);
              const NdotL = Math.max(0, normalX * Lx + normalY * Ly + normalZ * Lz);
              // inverse square attenuation with clamp
              const att = 1 / Math.max(0.01, dist * dist);
              lightContribR = lightColors[i * 3] * NdotL * intensity * falloff * att;
              lightContribG = lightColors[i * 3 + 1] * NdotL * intensity * falloff * att;
              lightContribB = lightColors[i * 3 + 2] * NdotL * intensity * falloff * att;
            }
        }
      }
    } else { // point / area treated similarly (area uses multiple samples)
      const shadowSamples = (lightType === 'area' && lightSize > 0) ? areaSampleQuality : 1;
      let accumR = 0, accumG = 0, accumB = 0;
      for (let s = 0; s < shadowSamples; s++) {
        let sampleX = lightX;
        let sampleY = lightY;
        let sampleZ = lightZ;
        if (lightType === 'area' && lightSize > 0) {
          // Deterministic golden-angle spiral on the disk facing the target
          const r = Math.sqrt((s + 0.5) / shadowSamples) * lightSize;
          const theta = s * GOLDEN_ANGLE;
          const ox = Math.cos(theta) * r;
          const oy = Math.sin(theta) * r;
          sampleX += areaU[i][0] * ox + areaV[i][0] * oy;
          sampleY += areaU[i][1] * ox + areaV[i][1] * oy;
          sampleZ += areaU[i][2] * ox + areaV[i][2] * oy;
        }
        let Lx = sampleX - hitX;
        let Ly = sampleY - hitY;
        let Lz = sampleZ - hitZ;
        const dist = Math.sqrt(Lx * Lx + Ly * Ly + Lz * Lz);
        if (dist === 0) continue;
        Lx /= dist; Ly /= dist; Lz /= dist;
        const shadowT = sphereShadowT(
          hitX + normalX * bias,
          hitY + normalY * bias,
          hitZ + normalZ * bias,
          Lx, Ly, Lz,
          sphereRadius
        );
        if (shadowT < dist) continue; // occluded
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

  if (enableIndirect && indirectIntensity > 0) {
    let indirectR = 0, indirectG = 0, indirectB = 0;
    const sampleDirs = [
      { x: 1, y: 0, z: 0 },
      { x: -1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 0, y: -1, z: 0 },
      { x: 0, y: 0, z: 1 },
      { x: 0, y: 0, z: -1 },
    ];
    const numSamples = sampleDirs.length;
    for (let s = 0; s < numSamples; s++) {
      const dir = sampleDirs[s];
      const dot = normalX * dir.x + normalY * dir.y + normalZ * dir.z;
      if (dot <= 0) continue;
      const wallHit = intersectRoom(
        hitX + normalX * 0.001,
        hitY + normalY * 0.001,
        hitZ + normalZ * 0.001,
        dir.x, dir.y, dir.z
      );
      if (wallHit) {
        let wallLightR = 0, wallLightG = 0, wallLightB = 0;
        for (let i = 0; i < 3; i++) {
          let wallDiffuse = 0;
          if (lightTypes[i] === 'directional') {
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
              if (lightTypes[i] === 'spot') {
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
        const distance = Math.sqrt(
          (wallHit.x - hitX) * (wallHit.x - hitX) +
          (wallHit.y - hitY) * (wallHit.y - hitY) +
          (wallHit.z - hitZ) * (wallHit.z - hitZ)
        );
        const attenuation = dot / (1 + distance * 0.5);
        indirectR += wallColor[0] * wallLightR * attenuation;
        indirectG += wallColor[1] * wallLightG * attenuation;
        indirectB += wallColor[2] * wallLightB * attenuation;
      }
    }
    const indirectScale = indirectIntensity / numSamples;
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

function worldToScreen(pointX: number, pointY: number, pointZ: number) {
  const relativeZ = pointZ - cameraZ;
  const x = (pointX / (relativeZ * cachedTanFov * cachedAspectRatio) + 1) * canvas.width / 2;
  const y = (-pointY / (relativeZ * cachedTanFov) + 1) * canvas.height / 2;
  return { x, y, z: relativeZ };
}

let selectedLight = -1;

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
    const type = lightTypes[i];
    const lx = lightPositions[i * 3];
    const ly = lightPositions[i * 3 + 1];
    const lz = lightPositions[i * 3 + 2];
    const screenPos = worldToScreen(lx, ly, lz);
    if (screenPos.z <= 0) continue;
    // Keep offscreen lights grabbable by clamping them to the canvas edge,
    // sliding along the aim line so the marker stays on it
    const { x: cx, y: cy } = clampToCanvasAlongLine(screenPos.x, screenPos.y);

    // Calculate normalized scale based on Z distance (0 = far, 1 = near)
    // Using a reasonable range: 0.5 to 8 units from camera
    const minZ = 0.5;
    const maxZ = 8;
    const normalizedScale = Math.max(0, Math.min(1, (maxZ - screenPos.z) / (maxZ - minZ)));

    const colorInput = document.getElementById(`light${i + 1}Color`) as HTMLInputElement;
    const marker = document.createElement('div');
    marker.className = `marker light-marker${type === 'directional' ? ' light-marker--directional' : ''}`;
    marker.dataset.light = String(i);
    if (cx !== screenPos.x || cy !== screenPos.y) marker.classList.add('marker--offscreen');
    if (i === selectedLight) marker.classList.add('marker--selected');
    // Percent positioning keeps markers aligned even if the canvas is CSS-scaled
    marker.style.left = `${(cx / canvas.width) * 100}%`;
    marker.style.top = `${(cy / canvas.height) * 100}%`;
    // Hollow ring = the light is behind the sphere
    const vz = lz - cameraZ;
    const camDist = Math.sqrt(lx * lx + ly * ly + vz * vz) || 1;
    const occHit = intersectSphere(0, 0, cameraZ, lx / camDist, ly / camDist, vz / camDist, sphereRadius);
    if (occHit && occHit.t < camDist - 1e-3) {
      marker.classList.add('light-marker--occluded');
      marker.style.borderColor = colorInput ? colorInput.value : '#fff';
    } else {
      marker.style.backgroundColor = colorInput ? colorInput.value : '#fff';
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
  const screenPos = worldToScreen(lightPositions[i * 3], lightPositions[i * 3 + 1], lightPositions[i * 3 + 2]);
  if (screenPos.z <= 0) {
    label.hidden = true;
    return;
  }
  const { x: cx, y: cy } = clampToCanvasAlongLine(screenPos.x, screenPos.y);
  const type = lightTypes[i];
  const NS = 'http://www.w3.org/2000/svg';

  // Directional and spot lights aim at the origin — draw the aim line to
  // where the ray meets the sphere's surface, splitting off the portion the
  // sphere itself occludes (drawn as a faint trace)
  if (type === 'directional' || type === 'spot') {
    const lx = lightPositions[i * 3], ly = lightPositions[i * 3 + 1], lz = lightPositions[i * 3 + 2];
    const llen = Math.sqrt(lx * lx + ly * ly + lz * lz) || 1;
    const s = sphereRadius / llen;
    const ex = lx * s, ey = ly * s, ez = lz * s;
    const N = 32;
    let visD = '', hidD = '', pv = false, ph = false;
    for (let k = 0; k <= N; k++) {
      const t = k / N;
      const wx = lx + (ex - lx) * t;
      const wy = ly + (ey - ly) * t;
      const wz = lz + (ez - lz) * t;
      const vz = wz - cameraZ;
      const dl = Math.sqrt(wx * wx + wy * wy + vz * vz) || 1;
      const occ = intersectSphere(0, 0, cameraZ, wx / dl, wy / dl, vz / dl, sphereRadius);
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
  if (type === 'area' && lightSize > 0) {
    const r = (lightSize / (screenPos.z * cachedTanFov)) * (canvas.height / 2);
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

// skipStride: pixels whose coordinates are multiples of it were already
// computed exactly by the previous (coarser) pass — leave them untouched
function renderPass(scale: number, skipStride = 0) {
  const startTime = performance.now();
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
          color = calculateLighting(
            gbData[o], gbData[o + 1], gbData[o + 2],
            gbData[o + 3], gbData[o + 4], gbData[o + 5],
            sphereColor[0], sphereColor[1], sphereColor[2]
          );
        } else if (kind === 2) {
          const o = pix * 6;
          color = calculateLighting(
            gbData[o], gbData[o + 1], gbData[o + 2],
            gbData[o + 3], gbData[o + 4], gbData[o + 5],
            wallColor[0], wallColor[1], wallColor[2],
            false
          );
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
        const sphereHit = intersectSphere(0, 0, cameraZ, dirX, dirY, dirZ, sphereRadius);
        if (sphereHit) {
          // Shade at normal * radius — the exact reconstruction samples use,
          // so a sampled color always matches its rendered pixel bit-for-bit
          const hx = sphereHit.nx * sphereRadius;
          const hy = sphereHit.ny * sphereRadius;
          const hz = sphereHit.nz * sphereRadius;
          gbKind[pix] = 1;
          gbData[o] = hx; gbData[o + 1] = hy; gbData[o + 2] = hz;
          gbData[o + 3] = sphereHit.nx; gbData[o + 4] = sphereHit.ny; gbData[o + 5] = sphereHit.nz;
          color = calculateLighting(
            hx, hy, hz,
            sphereHit.nx, sphereHit.ny, sphereHit.nz,
            sphereColor[0], sphereColor[1], sphereColor[2]
          );
        } else {
          const roomHit = intersectRoom(0, 0, cameraZ, dirX, dirY, dirZ);
          if (roomHit) {
            gbKind[pix] = 2;
            gbData[o] = roomHit.x; gbData[o + 1] = roomHit.y; gbData[o + 2] = roomHit.z;
            gbData[o + 3] = roomHit.nx; gbData[o + 4] = roomHit.ny; gbData[o + 5] = roomHit.nz;
            color = calculateLighting(
              roomHit.x, roomHit.y, roomHit.z,
              roomHit.nx, roomHit.ny, roomHit.nz,
              wallColor[0], wallColor[1], wallColor[2],
              false
            );
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
  if (resolutionDisplay) (resolutionDisplay as HTMLElement).textContent = `Resolution: ${Math.floor(100 / scale)}%`;
  const frameTime = performance.now() - startTime;
  if (fpsDisplay) (fpsDisplay as HTMLElement).textContent = `Frame: ${frameTime.toFixed(1)}ms`;
}

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

// Cast the ray for a canvas pixel against the sphere; returns the hit or null
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
  return intersectSphere(0, 0, cameraZ, dirX, dirY, dirZ, sphereRadius);
}

// Lit color of the surface point the unit direction points at
function sampleColorAt(dir: Float64Array) {
  return calculateLighting(
    dir[0] * sphereRadius, dir[1] * sphereRadius, dir[2] * sphereRadius,
    dir[0], dir[1], dir[2],
    sphereColor[0], sphereColor[1], sphereColor[2]
  );
}

// Reproject a sample's surface point to the screen; dim it when it faces away
function updateSampleMarker(sample: ColorSample) {
  const wx = sample.dir[0] * sphereRadius;
  const wy = sample.dir[1] * sphereRadius;
  const wz = sample.dir[2] * sphereRadius;
  const screenPos = worldToScreen(wx, wy, wz);
  sample.marker.style.left = `${(screenPos.x / canvas.width) * 100}%`;
  sample.marker.style.top = `${(screenPos.y / canvas.height) * 100}%`;
  // Point is visible when its normal faces the camera: dot(normal, P - camera) < 0
  const facing = sphereRadius - sample.dir[2] * cameraZ;
  sample.marker.classList.toggle('marker--behind', facing >= 0);
}

function moveSampleTo(sample: ColorSample, x: number, y: number) {
  const hit = castRayAt(x, y);
  if (hit) { // only follow the pointer while it stays on the sphere
    sample.dir[0] = hit.nx;
    sample.dir[1] = hit.ny;
    sample.dir[2] = hit.nz;
    const color = sampleColorAt(sample.dir);
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
  const hit = castRayAt(x, y);
  if (!hit) return;
  const dir = new Float64Array([hit.nx, hit.ny, hit.nz]);
  const color = sampleColorAt(dir);
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

// Place a light on its orbit (radius = distance) under the pointer:
// intersect the pixel ray with the orbit sphere. When the pointer is outside
// the orbit's silhouette, GROW the orbit to reach it — dragging outward pulls
// the light further away instead of pinning it to the old radius.
function pointerToLightAngles(x: number, y: number, dist: number, backHemi = false) {
  const px = (2 * ((x + 0.5) / canvas.width) - 1) * cachedAspectTanFov;
  const py = -(2 * ((y + 0.5) / canvas.height) - 1) * cachedTanFov;
  const len = Math.sqrt(px * px + py * py + 1);
  const dx = px / len, dy = py / len, dz = 1 / len;
  const b = 2 * cameraZ * dz;
  const disc = b * b - 4 * (cameraZ * cameraZ - dist * dist);
  let X, Y, Z;
  let newDist = dist;
  if (disc >= 0) {
    const sqrtD = Math.sqrt(disc);
    // Near root = camera-side hemisphere, far root = behind: keep the light
    // on the hemisphere it was on when the drag started
    let t = backHemi ? (-b + sqrtD) / 2 : (-b - sqrtD) / 2;
    if (t < 0) t = (-b + sqrtD) / 2; // camera inside the orbit sphere
    X = dx * t;
    Y = dy * t;
    Z = cameraZ + dz * t;
  } else {
    // Pointer ray misses the orbit sphere: place the light at the ray's
    // closest point to the origin, extending the distance to match
    const t = -cameraZ * dz;
    X = dx * t;
    Y = dy * t;
    Z = cameraZ + dz * t;
    newDist = Math.sqrt(X * X + Y * Y + Z * Z) || dist;
  }
  const pitch = Math.asin(Math.max(-1, Math.min(1, Y / newDist))) * 180 / Math.PI;
  const yaw = Math.atan2(Z, X) * 180 / Math.PI;
  return { yaw, pitch, dist: newDist };
}

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
  const { yaw, pitch, dist: newDist } = pointerToLightAngles(x, y, dist, dragBackHemi);
  const yawEl = document.getElementById(`light${draggedLight + 1}Yaw`) as HTMLInputElement | null;
  const pitchEl = document.getElementById(`light${draggedLight + 1}Pitch`) as HTMLInputElement | null;
  if (yawEl) yawEl.value = Math.round(yaw).toString();
  if (pitchEl) pitchEl.value = Math.round(Math.max(-89, Math.min(89, pitch))).toString();
  if (distEl && newDist !== dist) {
    distEl.value = Math.min(MAX_LIGHT_DISTANCE, Math.max(sphereRadius, newDist)).toFixed(2);
  }
  updateScene();
}

async function startRender() {
  updateCache();
  // Invalidate the G-buffer when anything that shapes primary rays changed
  if (gbCameraZ !== cameraZ || gbFov !== cameraFOV || gbRadius !== sphereRadius) {
    geomStamp++;
    gbCameraZ = cameraZ;
    gbFov = cameraFOV;
    gbRadius = sphereRadius;
  }
  for (let pass = 0; pass < passScales.length; pass++) {
    renderPass(passScales[pass], pass === 0 ? 0 : passScales[pass - 1]);
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

function updateScene() {
  cameraZ = parseFloat((document.getElementById('cameraZ') as HTMLInputElement).value);
  cameraFOV = parseFloat((document.getElementById('cameraFOV') as HTMLInputElement).value);
  sphereRadius = parseFloat((document.getElementById('sphereRadius') as HTMLInputElement).value);
  // Distance bounds: a light can't sit inside the sphere, and 12 units is far
  // enough that inverse-square attenuation has faded it to almost nothing
  const distInputs = document.querySelectorAll('input[data-dynamic-dist]') as NodeListOf<HTMLInputElement>;
  const minDist = sphereRadius;
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
  hexToRgb((document.getElementById('sphereColor') as HTMLInputElement).value, sphereColor);
  hexToRgb((document.getElementById('wallColor') as HTMLInputElement).value, wallColor);
  indirectIntensity = parseFloat((document.getElementById('indirectIntensity') as HTMLInputElement).value);
  lightSize = parseFloat((document.getElementById('lightSize') as HTMLInputElement).value);
  const aqEl = document.getElementById('areaQuality') as HTMLInputElement | null;
  if (aqEl) areaSampleQuality = Math.max(1, parseInt(aqEl.value, 10) || 1);
  for (let i = 0; i < 3; i++) {
    lightTypes[i] = (document.getElementById(`light${i + 1}Type`) as HTMLSelectElement).value;
    const yawEl = document.getElementById(`light${i + 1}Yaw`) as HTMLInputElement | null;
    const pitchEl = document.getElementById(`light${i + 1}Pitch`) as HTMLInputElement | null;
    const distEl = document.getElementById(`light${i + 1}Dist`) as HTMLInputElement | null;
    const yawDeg = yawEl ? parseFloat(yawEl.value) : 0;
    const pitchDeg = pitchEl ? parseFloat(pitchEl.value) : 0;
    const dist = distEl ? parseFloat(distEl.value) : 2;
    const yaw = yawDeg * Math.PI / 180;
    const pitch = pitchDeg * Math.PI / 180;
    const dx = Math.cos(pitch) * Math.cos(yaw);
    const dy = Math.sin(pitch);
    const dz = Math.cos(pitch) * Math.sin(yaw);
    // For directional lights we store the direction only (distance slider won't affect shading); we still store scaled for marker
    vec3Set(lightPositions.subarray(i * 3, i * 3 + 3), dx * dist, dy * dist, dz * dist);
    hexToRgb((document.getElementById(`light${i + 1}Color`) as HTMLInputElement).value, lightColors.subarray(i * 3, i * 3 + 3));
    lightIntensities[i] = parseFloat((document.getElementById(`light${i + 1}I`) as HTMLInputElement).value);
    lightAngles[i] = parseFloat((document.getElementById(`light${i + 1}Angle`) as HTMLInputElement).value);
    if (lightTypes[i] === 'directional') {
      let dx = lightPositions[i * 3];
      let dy = lightPositions[i * 3 + 1];
      let dz = lightPositions[i * 3 + 2];
      const len = Math.sqrt(dx*dx + dy*dy + dz*dz) || 1;
      directionalDirs[i][0] = dx / len;
      directionalDirs[i][1] = dy / len;
      directionalDirs[i][2] = dz / len;
    }
    // Light axis (toward the origin) + perpendicular disk basis — used by
    // spot cones and by area-light sampling for every light type
    {
      let ax = -lightPositions[i * 3];
      let ay = -lightPositions[i * 3 + 1];
      let az = -lightPositions[i * 3 + 2];
      const alen = Math.sqrt(ax*ax + ay*ay + az*az) || 1;
      ax /= alen; ay /= alen; az /= alen;
      spotAxes[i][0] = ax;
      spotAxes[i][1] = ay;
      spotAxes[i][2] = az;
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
    // Cone angle only applies to spot lights; distance has no effect on directional shading
    const angleWrap = document.getElementById(`light${i + 1}AngleControl`);
    if (angleWrap) angleWrap.hidden = lightTypes[i] !== 'spot';
    const distWrap = distEl ? distEl.closest('.control') : null;
    if (distWrap) distWrap.classList.toggle('control--inactive', lightTypes[i] === 'directional');
    if (distEl) distEl.disabled = lightTypes[i] === 'directional';
  }
  // Refresh the camera/ray cache first, then re-light and reproject the
  // surface-anchored samples — they stay on their spot when the camera moves
  updateCache();
  samples.forEach(sample => {
    const color = sampleColorAt(sample.dir);
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
    dragBackHemi = distNow * distNow - pz * cameraZ >= 0;
    // Relative drag baseline: cursor + the light's true projected position
    dragCursorStart = eventToCanvasPixels(e.clientX, e.clientY, false);
    const sp = worldToScreen(lightPositions[draggedLight * 3], lightPositions[draggedLight * 3 + 1], lightPositions[draggedLight * 3 + 2]);
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
    if (lightTypes[i] === 'directional') return; // distance means nothing for a directional light
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
