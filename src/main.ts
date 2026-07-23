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
  dir: Float32Array; // unit direction from sphere center — anchors the sample to the surface
  color: Float32Array;
  marker: HTMLElement;
}
let samples: ColorSample[] = [];
let areaSampleQuality = 6; // user adjustable
// All lights now use spherical controls (yaw/pitch + distance). Directional lights ignore distance for shading

// Cached normalized axes/directions
const directionalDirs = new Array(3).fill(null).map(() => new Float32Array(3));
const spotAxes = new Array(3).fill(null).map(() => new Float32Array(3));

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

function hexToRgb(hex: string, out: Float32Array) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (result) {
    out[0] = parseInt(result[1], 16) / 255;
    out[1] = parseInt(result[2], 16) / 255;
    out[2] = parseInt(result[3], 16) / 255;
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
    const r = Math.floor(sample.color[0] * 255);
    const g = Math.floor(sample.color[1] * 255);
    const b = Math.floor(sample.color[2] * 255);
    const color = `rgb(${r}, ${g}, ${b})`;
    const startPercent = (i * seg);
    const endPercent = (i === samples.length - 1) ? 100 : ((i + 1) * seg);
    stops.push(`${color} ${startPercent}% ${endPercent}%`);
  }

  const gradientStops = stops.join(', ');
  document.documentElement.style.setProperty('--stops', gradientStops);
}


// Optimization 5: Early ray termination with bounding checks
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
  return {
    x: hitX, y: hitY, z: hitZ,
    nx: hitX * invRadius,
    ny: hitY * invRadius,
    nz: hitZ * invRadius,
    t
  };
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
  return {
    x: originX + dirX * minT,
    y: originY + dirY * minT,
    z: originZ + dirZ * minT,
    nx: hitNormalX,
    ny: hitNormalY,
    nz: hitNormalZ,
    t: minT
  };
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
      const shadowHit = intersectSphere(
        hitX + normalX * bias,
        hitY + normalY * bias,
        hitZ + normalZ * bias,
        Lx, Ly, Lz,
        sphereRadius
      );
      if (!shadowHit) {
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
          const shadowHit = intersectSphere(
            hitX + normalX * bias,
            hitY + normalY * bias,
            hitZ + normalZ * bias,
            Lx, Ly, Lz,
            sphereRadius
          );
            if (!shadowHit || shadowHit.t >= dist) {
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
          // Uniform disk sample in local plane (simple XY perturbation)
          const u = (s + 0.5) / shadowSamples; // stratified
          const v = (s * 37 % shadowSamples + 0.5) / shadowSamples; // permuted index for decorrelation
          const r = Math.sqrt(u) * lightSize; // sqrt for uniform
          const theta = 2 * Math.PI * v;
          sampleX += Math.cos(theta) * r;
          sampleY += Math.sin(theta) * r;
          // simple tilt into Z for some variation (optional)
        }
        let Lx = sampleX - hitX;
        let Ly = sampleY - hitY;
        let Lz = sampleZ - hitZ;
        const dist = Math.sqrt(Lx * Lx + Ly * Ly + Lz * Lz);
        if (dist === 0) continue;
        Lx /= dist; Ly /= dist; Lz /= dist;
        const shadowHit = intersectSphere(
          hitX + normalX * bias,
          hitY + normalY * bias,
          hitZ + normalZ * bias,
          Lx, Ly, Lz,
          sphereRadius
        );
        if (shadowHit && shadowHit.t < dist) continue; // occluded
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
          let wallDiffuse;
          if (lightTypes[i] === 'directional') {
            // Directional lights are pure directions — distance must not leak in
            wallDiffuse = Math.max(0, wallHit.nx * directionalDirs[i][0] + wallHit.ny * directionalDirs[i][1] + wallHit.nz * directionalDirs[i][2]);
          } else {
            const wlX = lightPositions[i * 3] - wallHit.x;
            const wlY = lightPositions[i * 3 + 1] - wallHit.y;
            const wlZ = lightPositions[i * 3 + 2] - wallHit.z;
            const wlInvLen = 1 / Math.sqrt(wlX * wlX + wlY * wlY + wlZ * wlZ);
            wallDiffuse = Math.max(0, (wallHit.nx * wlX + wallHit.ny * wlY + wallHit.nz * wlZ) * wlInvLen);
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
  return {
    r: colorR * objColorR,
    g: colorG * objColorG,
    b: colorB * objColorB
  };
}

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
    colorBox.style.backgroundColor = `rgb(${Math.floor(sample.color[0] * 255)}, ${Math.floor(sample.color[1] * 255)}, ${Math.floor(sample.color[2] * 255)})`;
    const text = document.createElement('div');
    text.textContent = `RGB(${Math.floor(sample.color[0] * 255)}, ${Math.floor(sample.color[1] * 255)}, ${Math.floor(sample.color[2] * 255)})`;
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

function renderPass(scale: number) {
  const startTime = performance.now();
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
      const sphereHit = intersectSphere(0, 0, cameraZ, dirX, dirY, dirZ, sphereRadius);
      // Early culling: only compute room intersection if no sphere hit or sphere farther
      let roomHit = null;
      if (!sphereHit) {
        roomHit = intersectRoom(0, 0, cameraZ, dirX, dirY, dirZ);
      } else {
        // quick conservative test: sphereHit distance vs min possible plane distance (cameraZ to +Z wall along dir)
        // If direction points away from most planes we still may skip; keep simple for now.
      }
      let color;
      if (sphereHit && (!roomHit || sphereHit.t < (roomHit as any)?.t)) {
        color = calculateLighting(
          sphereHit.x, sphereHit.y, sphereHit.z,
          sphereHit.nx, sphereHit.ny, sphereHit.nz,
          sphereColor[0], sphereColor[1], sphereColor[2]
        );
      } else if (!sphereHit && roomHit) {
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
        color = { r: 0, g: 0, b: 0 };
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
  if (resolutionDisplay) (resolutionDisplay as HTMLElement).textContent = `Resolution: ${Math.floor(100 / scale)}%`;
  const frameTime = performance.now() - startTime;
  if (fpsDisplay) (fpsDisplay as HTMLElement).textContent = `Frame: ${frameTime.toFixed(1)}ms`;
}

// Map a pointer event to canvas pixel coordinates (canvas may be CSS-scaled).
// clamp keeps the point on the canvas — needed for pixel lookups, not for aiming.
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
function sampleColorAt(dir: Float32Array) {
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
  const dir = new Float32Array([hit.nx, hit.ny, hit.nz]);
  const color = sampleColorAt(dir);
  const marker = document.createElement('div');
  marker.className = 'marker sample-marker';
  const sample: ColorSample = {
    dir,
    color: new Float32Array([color.r, color.g, color.b]),
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
  for (let pass = 0; pass < passScales.length; pass++) {
    renderPass(passScales[pass]);
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
    } else if (lightTypes[i] === 'spot') {
      let ax = -lightPositions[i * 3];
      let ay = -lightPositions[i * 3 + 1];
      let az = -lightPositions[i * 3 + 2];
      const alen = Math.sqrt(ax*ax + ay*ay + az*az) || 1;
      spotAxes[i][0] = ax / alen;
      spotAxes[i][1] = ay / alen;
      spotAxes[i][2] = az / alen;
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
