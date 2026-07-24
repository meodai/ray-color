// ray-color — a tiny raycaster engine for generative color palettes.
//
// One sphere in a five-sided room, three lights. You don't edit colors,
// you edit the conditions: sample points on the sphere's surface and the
// palette stays coherent because every color lives in the same world.
//
// This module is DOM-free: it renders into any Uint8ClampedArray and can be
// used headlessly to generate palettes without a canvas.
//
// Guarantees the engine keeps:
// - deterministic: the same scene always produces the same colors
// - linear-light shading, sRGB only at the 8-bit boundary
// - a sampled anchor (`shade`) matches its rendered pixel bit-for-bit

export type LightType = 'point' | 'area' | 'directional' | 'spot';

export interface Light {
  type: LightType;
  yaw: number;    // degrees
  pitch: number;  // degrees
  dist: number;   // clamped to [sphereRadius, MAX_LIGHT_DISTANCE] on commit()
  hex: string;    // sRGB hex, decoded to linear on commit()
  intensity: number;
  angle: number;  // spot cone, degrees
  size: number;   // area emitter radius (world units); 0 = point-like
  /** Optional cartesian position (world units, sphere at origin). When set it
   * takes precedence: commit() derives yaw/pitch/dist from it and writes them
   * back so both parameterizations stay in sync. Note the usual distance
   * clamp still applies — a position inside the sphere is pushed to its
   * surface along the same direction. */
  position?: ArrayLike<number>;
}

/** Convert a cartesian position to the spherical light parameterization. */
export function positionToAngles(x: number, y: number, z: number) {
  const dist = Math.sqrt(x * x + y * y + z * z);
  const pitch = dist > 0 ? Math.asin(Math.max(-1, Math.min(1, y / dist))) * 180 / Math.PI : 0;
  const yaw = Math.atan2(z, x) * 180 / Math.PI;
  return { yaw, pitch, dist };
}

export interface Scene {
  cameraZ: number;
  fov: number;         // degrees
  sphereRadius: number;
  sphereHex: string;
  wallHex: string;
  indirect: number;    // 0..1
  areaQuality: number; // shadow samples per area light
  /** Per-wall mirror reflectivity, 0 (matte) .. 1 (full mirror). Reflective
   * walls mirror the sphere/room visually AND act as virtual light sources:
   * lights bounce off them onto the sphere, tinted by the wall color. */
  wallReflect: { back: number; left: number; right: number; top: number; bottom: number };
}

export interface Hit {
  x: number; y: number; z: number;
  nx: number; ny: number; nz: number;
  t: number;
}

export interface RGB { r: number; g: number; b: number; }

export const MAX_LIGHT_DISTANCE = 12;
export const DEFAULT_PASS_SCALES = [4, 2, 1];
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

// ---------------------------------------------------------------- color space

// sRGB <-> linear: inputs (color pickers) are decoded to linear light for the
// shading math; results are encoded back to sRGB only when written to pixels.
export const srgbToLinear = (s: number) => s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);

// Linear -> 8-bit sRGB via LUT (4096 steps is sub-LSB across the curve)
const SRGB_LUT = new Uint8Array(4096);
for (let i = 0; i < 4096; i++) {
  const c = i / 4095;
  const s = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  SRGB_LUT[i] = Math.min(255, Math.round(s * 255));
}
export const toSRGB8 = (c: number) => SRGB_LUT[c >= 1 ? 4095 : c <= 0 ? 0 : (c * 4095 + 0.5) | 0];

export function hexToRgb(hex: string, out: Float32Array) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (result) {
    out[0] = srgbToLinear(parseInt(result[1], 16) / 255);
    out[1] = srgbToLinear(parseInt(result[2], 16) / 255);
    out[2] = srgbToLinear(parseInt(result[3], 16) / 255);
  }
  return out;
}

// ---------------------------------------------------------------- surface shapes
// Shapes drawn on the sphere sample N colors along themselves. A "line" is a
// geodesic arc between two surface anchors; a circle has a center anchor and
// an angular radius. Point spacing along the shape is pluggable: any
// monotonic (0..1) -> (0..1) function works as a Distribution.

export type Distribution = (t: number) => number;

export const distributions = {
  linear: (t: number) => t,
  smoothstep: (t: number) => t * t * (3 - 2 * t),
} satisfies Record<string, Distribution>;

/** Spherical linear interpolation between two unit directions. */
export function slerp(a: ArrayLike<number>, b: ArrayLike<number>, t: number, out: Float64Array = new Float64Array(3)) {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  dot = Math.max(-1, Math.min(1, dot));
  const theta = Math.acos(dot);
  if (theta < 1e-6) {
    out[0] = a[0]; out[1] = a[1]; out[2] = a[2];
    return out;
  }
  const invSin = 1 / Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) * invSin;
  const wb = Math.sin(t * theta) * invSin;
  out[0] = wa * a[0] + wb * b[0];
  out[1] = wa * a[1] + wb * b[1];
  out[2] = wa * a[2] + wb * b[2];
  return out;
}

/** Point on the circle of angular radius rho around a center anchor, at angle phi.
 * The circle's tangent basis is derived deterministically from the center. */
export function circleDir(center: ArrayLike<number>, rho: number, phi: number, out: Float64Array = new Float64Array(3)) {
  const hy = Math.abs(center[1]) > 0.99 ? 0 : 1;
  const hx = 1 - hy;
  let ux = hy * center[2];
  let uy = -hx * center[2];
  let uz = hx * center[1] - hy * center[0];
  const ulen = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
  ux /= ulen; uy /= ulen; uz /= ulen;
  const vx = center[1] * uz - center[2] * uy;
  const vy = center[2] * ux - center[0] * uz;
  const vz = center[0] * uy - center[1] * ux;
  const cosR = Math.cos(rho), sinR = Math.sin(rho);
  const cp = Math.cos(phi), sp = Math.sin(phi);
  out[0] = cosR * center[0] + sinR * (cp * ux + sp * vx);
  out[1] = cosR * center[1] + sinR * (cp * uy + sp * vy);
  out[2] = cosR * center[2] + sinR * (cp * uz + sp * vz);
  return out;
}

/** N surface anchors along the geodesic from a to b (endpoints included). */
export function sampleLineDirs(a: ArrayLike<number>, b: ArrayLike<number>, count: number, spacing: Distribution = distributions.linear): Float64Array[] {
  const n = Math.max(2, count);
  const dirs: Float64Array[] = [];
  for (let k = 0; k < n; k++) {
    dirs.push(slerp(a, b, spacing(k / (n - 1))));
  }
  return dirs;
}

/** N surface anchors around a circle (end-exclusive, so no seam duplicate). */
export function sampleCircleDirs(center: ArrayLike<number>, rho: number, count: number, spacing: Distribution = distributions.linear): Float64Array[] {
  const n = Math.max(2, count);
  const dirs: Float64Array[] = [];
  for (let k = 0; k < n; k++) {
    dirs.push(circleDir(center, rho, spacing(k / n) * 2 * Math.PI));
  }
  return dirs;
}

// ---------------------------------------------------------------- engine

export interface Engine {
  readonly width: number;
  readonly height: number;
  readonly scene: Scene;
  readonly lights: Light[];
  /** Positions derived from yaw/pitch/dist on the last commit() — read-only. */
  readonly lightPositions: Float32Array;
  /** Sync internal state from scene/lights. Clamps each light's dist in place. */
  commit(): void;
  /** Call once before a progressive pass sequence (invalidates hit caches). */
  beginFrame(): void;
  /** Render one progressive pass into an RGBA buffer (width*height*4). */
  renderPass(out: Uint8ClampedArray, scale: number, skipStride?: number): void;
  /** Cast the pixel ray against the sphere. Returns a SCRATCH hit — copy what you keep. */
  castRay(x: number, y: number): Hit | null;
  /** Lit color of the surface point a unit direction points at. Returns a SCRATCH — copy what you keep. */
  shade(dir: ArrayLike<number>): RGB;
  worldToScreen(x: number, y: number, z: number): { x: number; y: number; z: number };
  /** Place a light's orbit under a canvas-pixel pointer position. */
  pointerToLightAngles(x: number, y: number, dist: number, backHemi?: boolean): { yaw: number; pitch: number; dist: number };
  /** Is the sphere between the camera and this light? */
  isLightOccluded(i: number): boolean;
  /** Is the sphere between the camera and this world-space point? */
  isPointOccluded(x: number, y: number, z: number, eps?: number): boolean;
  tanFov(): number;
}

export function createEngine(width: number, height: number, scene: Scene, lights: Light[]): Engine {
  // The light COUNT is fixed at creation (mutate lights in place + commit();
  // create a new engine to add or remove lights)
  const lightCount = lights.length;
  // Flat arrays for the hot loops, rebuilt from `lights` by commit()
  const sphereColor = new Float32Array(3);
  const wallColor = new Float32Array(3);
  const lightPositions = new Float32Array(lightCount * 3);
  const lightColors = new Float32Array(lightCount * 3);
  const lightIntensities = new Float32Array(lightCount);
  const lightAngles = new Float32Array(lightCount);
  const directionalDirs = new Array(lightCount).fill(null).map(() => new Float32Array(3));
  const spotAxes = new Array(lightCount).fill(null).map(() => new Float32Array(3));
  // Orthonormal basis perpendicular to each light's axis — area lights sample
  // on a disk FACING the target, not a fixed horizontal one
  const areaU = new Array(lightCount).fill(null).map(() => new Float32Array(3));
  const areaV = new Array(lightCount).fill(null).map(() => new Float32Array(3));

  // Camera cache
  let cachedTanFov = 0, cachedAspectRatio = 1, cachedAspectTanFov = 0;
  const rayDirectionCache = new Float32Array(width * height * 3);
  let cachedRayFOV = NaN;

  // G-buffer: per-pixel primary-hit cache (kind, position, normal). Valid while
  // the camera and sphere geometry are unchanged — light edits then skip all
  // primary intersection work and only re-shade.
  const gbKind = new Uint8Array(width * height);   // 0 miss · 1 sphere · 2 wall
  const gbData = new Float64Array(width * height * 6); // x y z nx ny nz (f64 = exact re-shades)
  const gbStamp = new Uint32Array(width * height);
  let geomStamp = 1;
  let gbCameraZ = NaN, gbFov = NaN, gbRadius = NaN;

  function commit() {
    hexToRgb(scene.sphereHex, sphereColor);
    hexToRgb(scene.wallHex, wallColor);
    for (let i = 0; i < lightCount; i++) {
      const l = lights[i];
      if (l.position) {
        const p = positionToAngles(l.position[0], l.position[1], l.position[2]);
        l.yaw = p.yaw;
        l.pitch = p.pitch;
        l.dist = p.dist;
      }
      l.dist = Math.min(MAX_LIGHT_DISTANCE, Math.max(scene.sphereRadius, l.dist));
      const yaw = l.yaw * Math.PI / 180;
      const pitch = l.pitch * Math.PI / 180;
      const dx = Math.cos(pitch) * Math.cos(yaw);
      const dy = Math.sin(pitch);
      const dz = Math.cos(pitch) * Math.sin(yaw);
      lightPositions[i * 3] = dx * l.dist;
      lightPositions[i * 3 + 1] = dy * l.dist;
      lightPositions[i * 3 + 2] = dz * l.dist;
      hexToRgb(l.hex, lightColors.subarray(i * 3, i * 3 + 3) as Float32Array);
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
    updateCamera();
  }

  function updateCamera() {
    cachedTanFov = Math.tan(((scene.fov * Math.PI) / 180) / 2);
    cachedAspectRatio = width / height;
    cachedAspectTanFov = cachedAspectRatio * cachedTanFov;
    if (cachedRayFOV === scene.fov) return;
    cachedRayFOV = scene.fov;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 3;
        const px = (2 * ((x + 0.5) / width) - 1) * cachedAspectTanFov;
        const py = -(2 * ((y + 0.5) / height) - 1) * cachedTanFov;
        const len = Math.sqrt(px * px + py * py + 1);
        rayDirectionCache[idx] = px / len;
        rayDirectionCache[idx + 1] = py / len;
        rayDirectionCache[idx + 2] = 1 / len;
      }
    }
  }

  function beginFrame() {
    updateCamera();
    // Invalidate the G-buffer when anything that shapes primary rays changed
    if (gbCameraZ !== scene.cameraZ || gbFov !== scene.fov || gbRadius !== scene.sphereRadius) {
      geomStamp++;
      gbCameraZ = scene.cameraZ;
      gbFov = scene.fov;
      gbRadius = scene.sphereRadius;
    }
  }

  // ---------------------------------------------------------------- intersections

  // Reusable hit records — the hot loops run millions of intersections per
  // second, so hits are written into scratch objects instead of fresh ones.
  // Callers must consume a hit before the next call of the same function.
  const sphereHitScratch: Hit = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, t: 0 };
  const roomHitScratch: Hit = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, t: 0 };

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

  // ---------------------------------------------------------------- shading

  const indirectDirs = [
    { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 },
    { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 },
  ];

  // Reflective walls as virtual light sources: each light mirrored across a
  // reflective wall plane illuminates diffuse surfaces, tinted by the wall
  // color and scaled by that wall's reflectivity. axis/s define the plane.
  const MIRROR_WALLS = [
    { axis: 2, s: 2, key: 'back' },
    { axis: 0, s: -2, key: 'left' },
    { axis: 0, s: 2, key: 'right' },
    { axis: 1, s: 2, key: 'top' },
    { axis: 1, s: -2, key: 'bottom' },
  ] as const;
  const vHit = new Float64Array(3);
  const vDir = new Float64Array(3);

  // Shading result scratch — consumed immediately by every caller
  const shadeScratch: RGB = { r: 0, g: 0, b: 0 };

  function calculateLighting(
    hitX: number, hitY: number, hitZ: number,
    normalX: number, normalY: number, normalZ: number,
    objColorR: number, objColorG: number, objColorB: number,
    enableIndirect = true
  ): RGB {
    let colorR = 0, colorG = 0, colorB = 0;
    const radius = scene.sphereRadius;

    for (let i = 0; i < lightCount; i++) {
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
        const shadowSamples = (lightType === 'area' && lights[i].size > 0) ? scene.areaQuality : 1;
        let accumR = 0, accumG = 0, accumB = 0;
        for (let s = 0; s < shadowSamples; s++) {
          let sampleX = lightX, sampleY = lightY, sampleZ = lightZ;
          if (lightType === 'area' && lights[i].size > 0) {
            // Deterministic golden-angle spiral on the disk facing the target
            const r = Math.sqrt((s + 0.5) / shadowSamples) * lights[i].size;
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

    // Virtual mirror lights from reflective walls
    const wrf = scene.wallReflect;
    if (wrf.back > 0 || wrf.left > 0 || wrf.right > 0 || wrf.top > 0 || wrf.bottom > 0) {
      vHit[0] = hitX; vHit[1] = hitY; vHit[2] = hitZ;
      const bias = radius * 0.001 + 1e-4;
      for (const wall of MIRROR_WALLS) {
        const rho = wrf[wall.key];
        if (rho <= 0) continue;
        const a = wall.axis;
        for (let i = 0; i < lightCount; i++) {
          const intensity = lightIntensities[i];
          if (intensity <= 0) continue;
          const tintR = lightColors[i * 3] * wallColor[0] * rho * intensity;
          const tintG = lightColors[i * 3 + 1] * wallColor[1] * rho * intensity;
          const tintB = lightColors[i * 3 + 2] * wallColor[2] * rho * intensity;
          if (tintR === 0 && tintG === 0 && tintB === 0) continue;

          if (lights[i].type === 'directional') {
            // mirror the direction across the wall plane
            vDir[0] = directionalDirs[i][0];
            vDir[1] = directionalDirs[i][1];
            vDir[2] = directionalDirs[i][2];
            vDir[a] = -vDir[a];
            if (vDir[a] === 0) continue;
            // the reflected path must actually meet this wall panel
            const t = (wall.s - vHit[a]) / vDir[a];
            if (t <= 0) continue;
            const u = (a + 1) % 3, w = (a + 2) % 3;
            if (Math.abs(vHit[u] + vDir[u] * t) > 2 || Math.abs(vHit[w] + vDir[w] * t) > 2) continue;
            const NdotL = normalX * vDir[0] + normalY * vDir[1] + normalZ * vDir[2];
            if (NdotL <= 0) continue;
            const shadowT = sphereShadowT(hitX + normalX * bias, hitY + normalY * bias, hitZ + normalZ * bias, vDir[0], vDir[1], vDir[2], radius);
            if (shadowT !== Infinity) continue;
            colorR += tintR * NdotL;
            colorG += tintG * NdotL;
            colorB += tintB * NdotL;
          } else {
            // point-like virtual light: mirror the position (spot cones and
            // area extents are approximated as points in the mirror)
            vDir[0] = lightPositions[i * 3];
            vDir[1] = lightPositions[i * 3 + 1];
            vDir[2] = lightPositions[i * 3 + 2];
            vDir[a] = 2 * wall.s - vDir[a];
            let Lx = vDir[0] - hitX, Ly = vDir[1] - hitY, Lz = vDir[2] - hitZ;
            const dist = Math.sqrt(Lx * Lx + Ly * Ly + Lz * Lz);
            if (dist === 0) continue;
            Lx /= dist; Ly /= dist; Lz /= dist;
            const La = a === 0 ? Lx : a === 1 ? Ly : Lz;
            if (La === 0) continue;
            const t = (wall.s - vHit[a]) / La;
            if (t <= 0 || t >= dist) continue;
            const u = (a + 1) % 3, w = (a + 2) % 3;
            const Lu = u === 0 ? Lx : u === 1 ? Ly : Lz;
            const Lw = w === 0 ? Lx : w === 1 ? Ly : Lz;
            if (Math.abs(vHit[u] + Lu * t) > 2 || Math.abs(vHit[w] + Lw * t) > 2) continue;
            const NdotL = normalX * Lx + normalY * Ly + normalZ * Lz;
            if (NdotL <= 0) continue;
            const shadowT = sphereShadowT(hitX + normalX * bias, hitY + normalY * bias, hitZ + normalZ * bias, Lx, Ly, Lz, radius);
            if (shadowT < dist) continue;
            const att = 1 / Math.max(0.01, dist * dist);
            colorR += tintR * NdotL * att;
            colorG += tintG * NdotL * att;
            colorB += tintB * NdotL * att;
          }
        }
      }
    }

    if (enableIndirect && scene.indirect > 0) {
      let indirectR = 0, indirectG = 0, indirectB = 0;
      for (let s = 0; s < indirectDirs.length; s++) {
        const dir = indirectDirs[s];
        const dot = normalX * dir.x + normalY * dir.y + normalZ * dir.z;
        if (dot <= 0) continue;
        const wallHit = intersectRoom(hitX + normalX * 0.001, hitY + normalY * 0.001, hitZ + normalZ * 0.001, dir.x, dir.y, dir.z);
        if (wallHit) {
          let wallLightR = 0, wallLightG = 0, wallLightB = 0;
          for (let i = 0; i < lightCount; i++) {
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
      const indirectScale = scene.indirect / indirectDirs.length;
      colorR += indirectR * indirectScale;
      colorG += indirectG * indirectScale;
      colorB += indirectB * indirectScale;
    }
    shadeScratch.r = colorR * objColorR;
    shadeScratch.g = colorG * objColorG;
    shadeScratch.b = colorB * objColorB;
    return shadeScratch;
  }

  // Wall shading with optional single-bounce mirror reflection.
  // Which wall was hit is identified by its normal.
  const wallShadeScratch: RGB = { r: 0, g: 0, b: 0 };

  function wallReflectivityAt(nx: number, ny: number, nz: number) {
    const w = scene.wallReflect;
    if (nz === -1) return w.back;
    if (nx === 1) return w.left;
    if (nx === -1) return w.right;
    if (ny === -1) return w.top;
    return w.bottom;
  }

  function shadeWall(
    hx: number, hy: number, hz: number,
    nx: number, ny: number, nz: number,
    ix: number, iy: number, iz: number // incident ray direction (unit)
  ): RGB {
    let c = calculateLighting(hx, hy, hz, nx, ny, nz, wallColor[0], wallColor[1], wallColor[2], false);
    let r = c.r * 0.5, g = c.g * 0.5, b = c.b * 0.5;
    const rho = wallReflectivityAt(nx, ny, nz);
    if (rho > 0) {
      const d = ix * nx + iy * ny + iz * nz;
      const rx = ix - 2 * d * nx;
      const ry = iy - 2 * d * ny;
      const rz = iz - 2 * d * nz;
      const eps = 1e-4;
      let rr = 0, rg = 0, rb = 0;
      const sHit = intersectSphere(hx + nx * eps, hy + ny * eps, hz + nz * eps, rx, ry, rz, scene.sphereRadius);
      if (sHit) {
        // shade the mirrored sphere point at normal * radius (exactness convention)
        const sx = sHit.nx * scene.sphereRadius;
        const sy = sHit.ny * scene.sphereRadius;
        const sz = sHit.nz * scene.sphereRadius;
        c = calculateLighting(sx, sy, sz, sHit.nx, sHit.ny, sHit.nz, sphereColor[0], sphereColor[1], sphereColor[2]);
        rr = c.r; rg = c.g; rb = c.b;
      } else {
        const wHit = intersectRoom(hx + nx * eps, hy + ny * eps, hz + nz * eps, rx, ry, rz);
        if (wHit) {
          // mirrored walls stay matte — one bounce only
          const wx = wHit.x, wy = wHit.y, wz = wHit.z;
          const wnx = wHit.nx, wny = wHit.ny, wnz = wHit.nz;
          c = calculateLighting(wx, wy, wz, wnx, wny, wnz, wallColor[0], wallColor[1], wallColor[2], false);
          rr = c.r * 0.5; rg = c.g * 0.5; rb = c.b * 0.5;
        }
      }
      r = r * (1 - rho) + rr * rho;
      g = g * (1 - rho) + rg * rho;
      b = b * (1 - rho) + rb * rho;
    }
    wallShadeScratch.r = r;
    wallShadeScratch.g = g;
    wallShadeScratch.b = b;
    return wallShadeScratch;
  }

  // ---------------------------------------------------------------- rendering

  // skipStride: pixels whose coordinates are multiples of it were already
  // computed exactly by the previous (coarser) pass — leave them untouched
  function renderPass(out: Uint8ClampedArray, scale: number, skipStride = 0) {
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
            const hx = gbData[o], hy = gbData[o + 1], hz = gbData[o + 2];
            const vz = hz - scene.cameraZ;
            const il = Math.sqrt(hx * hx + hy * hy + vz * vz) || 1;
            color = shadeWall(hx, hy, hz, gbData[o + 3], gbData[o + 4], gbData[o + 5], hx / il, hy / il, vz / il);
          } else {
            color = shadeScratch;
            color.r = 0; color.g = 0; color.b = 0;
          }
        } else {
          const ri = pix * 3;
          const dirX = rayDirectionCache[ri];
          const dirY = rayDirectionCache[ri + 1];
          const dirZ = rayDirectionCache[ri + 2];
          const o = pix * 6;
          const sphereHit = intersectSphere(0, 0, scene.cameraZ, dirX, dirY, dirZ, scene.sphereRadius);
          if (sphereHit) {
            // Shade at normal * radius — the exact reconstruction samples use,
            // so a sampled color always matches its rendered pixel bit-for-bit
            const hx = sphereHit.nx * scene.sphereRadius;
            const hy = sphereHit.ny * scene.sphereRadius;
            const hz = sphereHit.nz * scene.sphereRadius;
            gbKind[pix] = 1;
            gbData[o] = hx; gbData[o + 1] = hy; gbData[o + 2] = hz;
            gbData[o + 3] = sphereHit.nx; gbData[o + 4] = sphereHit.ny; gbData[o + 5] = sphereHit.nz;
            color = calculateLighting(hx, hy, hz, sphereHit.nx, sphereHit.ny, sphereHit.nz, sphereColor[0], sphereColor[1], sphereColor[2]);
          } else {
            const roomHit = intersectRoom(0, 0, scene.cameraZ, dirX, dirY, dirZ);
            if (roomHit) {
              gbKind[pix] = 2;
              gbData[o] = roomHit.x; gbData[o + 1] = roomHit.y; gbData[o + 2] = roomHit.z;
              gbData[o + 3] = roomHit.nx; gbData[o + 4] = roomHit.ny; gbData[o + 5] = roomHit.nz;
              color = shadeWall(roomHit.x, roomHit.y, roomHit.z, roomHit.nx, roomHit.ny, roomHit.nz, dirX, dirY, dirZ);
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
            out[idx] = r;
            out[idx + 1] = g;
            out[idx + 2] = b;
            out[idx + 3] = 255;
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------- sampling & camera

  function castRay(x: number, y: number) {
    const idx = (Math.floor(y) * width + Math.floor(x)) * 3;
    const dirX = rayDirectionCache[idx];
    const dirY = rayDirectionCache[idx + 1];
    const dirZ = rayDirectionCache[idx + 2];
    return intersectSphere(0, 0, scene.cameraZ, dirX, dirY, dirZ, scene.sphereRadius);
  }

  function shade(dir: ArrayLike<number>) {
    const r = scene.sphereRadius;
    return calculateLighting(dir[0] * r, dir[1] * r, dir[2] * r, dir[0], dir[1], dir[2], sphereColor[0], sphereColor[1], sphereColor[2]);
  }

  function worldToScreen(px: number, py: number, pz: number) {
    const relativeZ = pz - scene.cameraZ;
    return {
      x: (px / (relativeZ * cachedTanFov * cachedAspectRatio) + 1) * width / 2,
      y: (-py / (relativeZ * cachedTanFov) + 1) * height / 2,
      z: relativeZ
    };
  }

  function pointerToLightAngles(x: number, y: number, dist: number, backHemi = false) {
    const px = (2 * ((x + 0.5) / width) - 1) * cachedAspectTanFov;
    const py = -(2 * ((y + 0.5) / height) - 1) * cachedTanFov;
    const len = Math.sqrt(px * px + py * py + 1);
    const dx = px / len, dy = py / len, dz = 1 / len;
    const b = 2 * scene.cameraZ * dz;
    const disc = b * b - 4 * (scene.cameraZ * scene.cameraZ - dist * dist);
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
      Z = scene.cameraZ + dz * t;
    } else {
      const t = -scene.cameraZ * dz;
      X = dx * t;
      Y = dy * t;
      Z = scene.cameraZ + dz * t;
      newDist = Math.sqrt(X * X + Y * Y + Z * Z) || dist;
    }
    const pitch = Math.asin(Math.max(-1, Math.min(1, Y / newDist))) * 180 / Math.PI;
    const yaw = Math.atan2(Z, X) * 180 / Math.PI;
    return { yaw, pitch, dist: newDist };
  }

  function isPointOccluded(x: number, y: number, z: number, eps = 1e-2) {
    const vz = z - scene.cameraZ;
    const dist = Math.sqrt(x * x + y * y + vz * vz) || 1;
    const hit = intersectSphere(0, 0, scene.cameraZ, x / dist, y / dist, vz / dist, scene.sphereRadius);
    return !!hit && hit.t < dist - eps;
  }

  function isLightOccluded(i: number) {
    return isPointOccluded(lightPositions[i * 3], lightPositions[i * 3 + 1], lightPositions[i * 3 + 2], 1e-3);
  }

  return {
    width,
    height,
    scene,
    lights,
    lightPositions,
    commit,
    beginFrame,
    renderPass,
    castRay,
    shade,
    worldToScreen,
    pointerToLightAngles,
    isLightOccluded,
    isPointOccluded,
    tanFov: () => cachedTanFov,
  };
}
