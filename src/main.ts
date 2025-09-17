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
let samples: any[] = [];
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
let cacheWidth = 0, cacheHeight = 0;

function updateCache() {
  cachedFovRad = (cameraFOV * Math.PI) / 180;
  cachedTanFov = Math.tan(cachedFovRad / 2);
  cachedAspectRatio = canvas.width / canvas.height;
  cachedAspectTanFov = cachedAspectRatio * cachedTanFov;

  // Rebuild ray direction cache when dimensions OR FOV changes
  // This ensures cache is always in sync with current settings
  if (cacheWidth !== canvas.width || cacheHeight !== canvas.height || !rayDirectionCache) {
    cacheWidth = canvas.width;
    cacheHeight = canvas.height;
    rayDirectionCache = new Float32Array(cacheWidth * cacheHeight * 3);
  }

  // Always rebuild the ray cache when FOV changes
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
      // Use cached normalized direction (points outward), incoming is opposite
      let Lx = -directionalDirs[i][0];
      let Ly = -directionalDirs[i][1];
      let Lz = -directionalDirs[i][2];
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
        // Spot axis: from light toward origin (0,0,0) consistent with earlier logic
        let Ax = -lightX, Ay = -lightY, Az = -lightZ;
        const alen = Math.sqrt(Ax * Ax + Ay * Ay + Az * Az) || 1;
        Ax /= alen; Ay /= alen; Az /= alen;
        // Angle between -L (from hit to light) and axis OR simply L·(-axis)? Use reverse: ( -L )·A = -(L·A)
        // We want the light to cover region where L is roughly -axis (hit in front of light)
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
    const numSamples = 4;
    let indirectR = 0, indirectG = 0, indirectB = 0;
    const sampleDirs = [
      { x: 1, y: 0, z: 0 },
      { x: -1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 0, y: -1, z: 0 },
    ];
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
        for (let i = 0; i < 1; i++) {
          const lightX = lightPositions[i * 3];
          const lightY = lightPositions[i * 3 + 1];
          const lightZ = lightPositions[i * 3 + 2];
          const wlX = lightX - wallHit.x;
          const wlY = lightY - wallHit.y;
          const wlZ = lightZ - wallHit.z;
          const wlLen = Math.sqrt(wlX * wlX + wlY * wlY + wlZ * wlZ);
          const wlInvLen = 1 / wlLen;
          const wallDiffuse = Math.max(0, (wallHit.nx * wlX + wallHit.ny * wlY + wallHit.nz * wlZ) * wlInvLen);
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
    colorR += indirectR * indirectIntensity * 0.25;
    colorG += indirectG * indirectIntensity * 0.25;
    colorB += indirectB * indirectIntensity * 0.25;
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
    const colorInput = document.getElementById(`light${i + 1}Color`) as HTMLInputElement;
    if (type === 'directional') {
      // Draw small arrow: base at projected point, direction opposite to light direction
      const dir = directionalDirs[i];
      const arrow = document.createElement('div');
      arrow.className = 'marker light-marker';
      arrow.style.left = `${screenPos.x}px`;
      arrow.style.top = `${screenPos.y}px`;
      arrow.style.backgroundColor = colorInput ? colorInput.value : '#fff';
      arrow.style.transform = `translate(-50%, -50%) rotate(${Math.atan2(-dir[1], -dir[0])}rad)`;
      arrow.style.width = '10px';
      arrow.style.height = '10px';
      arrow.style.clipPath = 'polygon(0 50%, 70% 0, 70% 30%, 100% 30%, 100% 70%, 70% 70%, 70% 100%)';
      markersContainer.appendChild(arrow);
    } else {
      const marker = document.createElement('div');
      marker.className = 'marker light-marker';
      marker.style.left = `${screenPos.x}px`;
      marker.style.top = `${screenPos.y}px`;
      marker.style.backgroundColor = colorInput ? colorInput.value : '#fff';
      markersContainer.appendChild(marker);
    }
  }
}

function updateSamplesList() {
  const list = document.getElementById('samples-list');
  if (!list) return;
  list.innerHTML = '';
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

function handleCanvasClick(event: MouseEvent) {
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
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
  const sphereHit = intersectSphere(0, 0, cameraZ, dirX, dirY, dirZ, sphereRadius);
  if (sphereHit) {
    const color = calculateLighting(
      sphereHit.x, sphereHit.y, sphereHit.z,
      sphereHit.nx, sphereHit.ny, sphereHit.nz,
      sphereColor[0], sphereColor[1], sphereColor[2]
    );
    const marker = document.createElement('div');
    marker.className = 'marker sample-marker';
    marker.style.left = `${x}px`;
    marker.style.top = `${y}px`;
  const sm = document.getElementById('sample-markers');
  if (sm) sm.appendChild(marker);
    samples.push({
      position: { x, y },
      color: new Float32Array([color.r, color.g, color.b]),
      marker: marker
    });
    updateSamplesList();
  }
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
  // Dynamic distance slider bounds: min = sphere radius, max = sphere radius * 6 (slightly bigger as requested)
  const distInputs = document.querySelectorAll('input[data-dynamic-dist]') as NodeListOf<HTMLInputElement>;
  const minDist = sphereRadius;
  const maxDist = sphereRadius * 6;
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
    const angleControl = document.getElementById(`light${i + 1}Angle`) as HTMLElement;
    const angleLabel = angleControl.previousElementSibling as HTMLElement;
    if (lightTypes[i] === 'spot') {
      angleControl.style.display = 'inline-block';
      angleLabel.style.display = 'inline-block';
    } else {
      angleControl.style.display = 'none';
      angleLabel.style.display = 'none';
    }
  }
  samples.forEach(sample => {
    let dirX, dirY, dirZ;
    const x = sample.position.x;
    const y = sample.position.y;
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
    const sphereHit = intersectSphere(0, 0, cameraZ, dirX, dirY, dirZ, sphereRadius);
    if (sphereHit) {
      const color = calculateLighting(
        sphereHit.x, sphereHit.y, sphereHit.z,
        sphereHit.nx, sphereHit.ny, sphereHit.nz,
        sphereColor[0], sphereColor[1], sphereColor[2]
      );
      sample.color[0] = color.r;
      sample.color[1] = color.g;
      sample.color[2] = color.b;
    }
  });
  updateSamplesList();
  requestRender();
}

// UI visibility helper removed (all lights use spherical controls)

// Add event listeners
document.querySelectorAll('input').forEach(input => {
  input.addEventListener('input', updateScene);
});
document.querySelectorAll('select').forEach(select => {
  select.addEventListener('change', updateScene);
});
canvas.addEventListener('click', handleCanvasClick);

// Listeners for spherical controls
for (let i = 1; i <= 3; i++) {
  const yaw = document.getElementById(`light${i}Yaw`);
  const pitch = document.getElementById(`light${i}Pitch`);
  const dist = document.getElementById(`light${i}Dist`);
  if (yaw) yaw.addEventListener('input', updateScene);
  if (pitch) pitch.addEventListener('input', updateScene);
  if (dist) dist.addEventListener('input', updateScene);
  const typeSel = document.getElementById(`light${i}Type`);
  if (typeSel) typeSel.addEventListener('change', updateScene);
}

// Initial render
updateScene(); // Initialize UI state
requestRender();
