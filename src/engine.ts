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
  hex: string;    // sRGB hex (#rgb or #rrggbb, alpha ignored), decoded to linear on commit()
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
  /** Lens glow around the brightest light, part of every color the engine
   * produces: rendered pixels and shade() alike, so samples still match their
   * pixels. Being a screen effect, it makes colors depend on the camera
   * (cameraZ, fov, aspect), and points hidden on the back of the sphere get
   * none. Absent or strength 0: off. */
  bloom?: Bloom;
}

export interface Bloom {
  /** Glow strength; 0 turns bloom off. */
  strength: number;
  /** Linear brightness where the glow starts (soft knee). Default 0.8. */
  threshold?: number;
  /** Spread of the tightest glow layer, as a fraction of the view height.
   * Wider layers double it each step. Default 0.02. */
  radius?: number;
}

/** The engine's glow as a linear-RGB image, strength applied: GLOW_ROWS tall,
 * columns by aspect ratio, top row first. */
export interface GlowMap {
  readonly width: number;
  readonly height: number;
  readonly data: Float32Array;
}

export interface Hit {
  x: number; y: number; z: number;
  nx: number; ny: number; nz: number;
  t: number;
}

export interface RGB { r: number; g: number; b: number; }

export const MAX_LIGHT_DISTANCE = 12;
export const DEFAULT_PASS_SCALES = [4, 2, 1];
/** Fallback canvas size when createEngine is called without dimensions —
 * palette sampling via shade() is resolution-independent anyway. */
export const DEFAULT_ENGINE_SIZE = 400;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
/** Bloom is computed on a fixed grid this many rows tall, whatever the canvas
 * size, which keeps glowing palettes resolution independent. */
export const GLOW_ROWS = 128;
const GLOW_LEVELS = 5;

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

/** Decode #rgb, #rgba, #rrggbb or #rrggbbaa (alpha ignored, leading # optional)
 * to linear RGB. Throws on anything else: a silently black light is much
 * harder to track down than an error. */
export function hexToRgb(hex: string, out: Float32Array) {
  const m = /^#?([a-f\d]{3,4}|[a-f\d]{6}|[a-f\d]{8})$/i.exec(hex);
  if (!m) throw new TypeError(`ray-color: invalid hex color ${JSON.stringify(hex)}`);
  const h = m[1].length <= 4 ? m[1].replace(/./g, '$&$&') : m[1];
  out[0] = srgbToLinear(parseInt(h.slice(0, 2), 16) / 255);
  out[1] = srgbToLinear(parseInt(h.slice(2, 4), 16) / 255);
  out[2] = srgbToLinear(parseInt(h.slice(4, 6), 16) / 255);
  return out;
}

/** Does hexToRgb accept this string? */
export const isHexColor = (hex: string) => /^#?([a-f\d]{3,4}|[a-f\d]{6}|[a-f\d]{8})$/i.test(hex);

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
  if (Math.PI - theta < 1e-6) {
    // antipodal: every great circle joins a and b, so the arc is undefined
    // (the weights below would collapse to a zero vector). Take the one
    // through a's deterministic tangent u, the same basis circles use.
    circleBasis(a, cbU, cbV);
    const c = Math.cos(t * Math.PI), s = Math.sin(t * Math.PI);
    out[0] = c * a[0] + s * cbU[0];
    out[1] = c * a[1] + s * cbU[1];
    out[2] = c * a[2] + s * cbU[2];
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

/** Deterministic tangent basis (u, v) of the circle plane for a center anchor.
 * Angle 0 lies along u; angles grow toward v. u = normalize(up x center), so
 * the basis turns continuously as the center moves; only the poles themselves
 * (where up x center vanishes) fall back to the x axis as helper. */
export function circleBasis(center: ArrayLike<number>, u: Float64Array, v: Float64Array) {
  let ux = center[2], uy = 0, uz = -center[0];
  let ulen = Math.sqrt(ux * ux + uz * uz);
  if (ulen < 1e-12) {
    ux = 0; uy = -center[2]; uz = center[1];
    ulen = Math.sqrt(uy * uy + uz * uz) || 1;
  }
  u[0] = ux / ulen; u[1] = uy / ulen; u[2] = uz / ulen;
  v[0] = center[1] * u[2] - center[2] * u[1];
  v[1] = center[2] * u[0] - center[0] * u[2];
  v[2] = center[0] * u[1] - center[1] * u[0];
}

const cbU = new Float64Array(3);
const cbV = new Float64Array(3);

/** Point on the circle of angular radius rho around a center anchor, at angle phi.
 * The circle's tangent basis is derived deterministically from the center. */
export function circleDir(center: ArrayLike<number>, rho: number, phi: number, out: Float64Array = new Float64Array(3)) {
  circleBasis(center, cbU, cbV);
  const cosR = Math.cos(rho), sinR = Math.sin(rho);
  const cp = Math.cos(phi), sp = Math.sin(phi);
  out[0] = cosR * center[0] + sinR * (cp * cbU[0] + sp * cbV[0]);
  out[1] = cosR * center[1] + sinR * (cp * cbU[1] + sp * cbV[1]);
  out[2] = cosR * center[2] + sinR * (cp * cbU[2] + sp * cbV[2]);
  return out;
}

/** Options for the shape samplers. A bare Distribution is still accepted in
 * the same position as shorthand for { spacing }. */
export interface SampleOptions {
  spacing?: Distribution;
  /** Rigid rotation of the whole sample set about the shape's central axis
   * (circle center / line geodesic midpoint), in degrees. */
  rotate?: number;
}

const sampleOpts = (o?: Distribution | SampleOptions): SampleOptions =>
  typeof o === 'function' ? { spacing: o } : o ?? {};

/** Rotate a unit direction about a unit axis (right-handed, radians), in place. */
export function rotateAboutAxis(d: Float64Array, axis: ArrayLike<number>, rad: number) {
  const c = Math.cos(rad), s = Math.sin(rad);
  const dot = axis[0] * d[0] + axis[1] * d[1] + axis[2] * d[2];
  const cx = axis[1] * d[2] - axis[2] * d[1];
  const cy = axis[2] * d[0] - axis[0] * d[2];
  const cz = axis[0] * d[1] - axis[1] * d[0];
  const k = dot * (1 - c);
  d[0] = d[0] * c + cx * s + axis[0] * k;
  d[1] = d[1] * c + cy * s + axis[1] * k;
  d[2] = d[2] * c + cz * s + axis[2] * k;
  return d;
}

/** Rigidly rotate a group of unit directions about a center axis, in degrees,
 * in place. center defaults to the group's normalized mean direction; a
 * balanced group (zero mean, e.g. antipodal pairs) has no centroid, so an
 * explicit center is required there. */
export function rotateDirs(dirs: Float64Array[], deg: number, center?: ArrayLike<number>): Float64Array[] {
  let ax = center;
  if (!ax) {
    let x = 0, y = 0, z = 0;
    for (const d of dirs) { x += d[0]; y += d[1]; z += d[2]; }
    const l = Math.hypot(x, y, z);
    if (l < 1e-9) throw new Error('rotateDirs: group has no centroid — pass an explicit center');
    ax = [x / l, y / l, z / l];
  }
  const rad = deg * Math.PI / 180;
  for (const d of dirs) rotateAboutAxis(d, ax, rad);
  return dirs;
}

/** N surface anchors along the geodesic from a to b (endpoints included; a
 * single sample sits at the spaced midpoint).
 * rotate swings the whole set about the geodesic midpoint — 180 reverses it. */
export function sampleLineDirs(a: ArrayLike<number>, b: ArrayLike<number>, count: number, opts?: Distribution | SampleOptions): Float64Array[] {
  const { spacing = distributions.linear, rotate = 0 } = sampleOpts(opts);
  const n = Math.max(0, Math.floor(count) || 0);
  const dirs: Float64Array[] = [];
  for (let k = 0; k < n; k++) {
    dirs.push(slerp(a, b, spacing(n === 1 ? 0.5 : k / (n - 1))));
  }
  if (rotate) {
    const m = slerp(a, b, 0.5);
    const rad = rotate * Math.PI / 180;
    for (const d of dirs) rotateAboutAxis(d, m, rad);
  }
  return dirs;
}

/** N surface anchors around a circle (end-exclusive, so no seam duplicate).
 * rotate spins the whole set around the circle without moving it. */
export function sampleCircleDirs(center: ArrayLike<number>, rho: number, count: number, opts?: Distribution | SampleOptions): Float64Array[] {
  const { spacing = distributions.linear, rotate = 0 } = sampleOpts(opts);
  const n = Math.max(0, Math.floor(count) || 0);
  const phase = rotate * Math.PI / 180;
  const dirs: Float64Array[] = [];
  for (let k = 0; k < n; k++) {
    dirs.push(circleDir(center, rho, phase + spacing(k / n) * 2 * Math.PI));
  }
  return dirs;
}

// ---------------------------------------------------------------- bloom helpers

// RGB grids, row-major, top row first

function downsample(src: Float64Array, w: number, h: number, nw: number, nh: number) {
  const out = new Float64Array(nw * nh * 3);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const x0 = Math.min(w - 1, x * 2), x1 = Math.min(w - 1, x * 2 + 1);
      const y0 = Math.min(h - 1, y * 2), y1 = Math.min(h - 1, y * 2 + 1);
      const o = (y * nw + x) * 3;
      for (let c = 0; c < 3; c++) {
        out[o + c] = (src[(y0 * w + x0) * 3 + c] + src[(y0 * w + x1) * 3 + c] +
          src[(y1 * w + x0) * 3 + c] + src[(y1 * w + x1) * 3 + c]) * 0.25;
      }
    }
  }
  return out;
}

/** Separable Gaussian; outside the grid counts as black (no light comes from
 * beyond the frame). */
function blur(src: Float64Array, w: number, h: number, sigma: number) {
  const r = Math.ceil(sigma * 3);
  const k = new Float64Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) sum += (k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)));
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Float64Array(src.length);
  const out = new Float64Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0, b = 0, c = 0;
      for (let i = Math.max(-r, -x); i <= Math.min(r, w - 1 - x); i++) {
        const s = (y * w + x + i) * 3, wt = k[i + r];
        a += src[s] * wt; b += src[s + 1] * wt; c += src[s + 2] * wt;
      }
      const o = (y * w + x) * 3;
      tmp[o] = a; tmp[o + 1] = b; tmp[o + 2] = c;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0, b = 0, c = 0;
      for (let i = Math.max(-r, -y); i <= Math.min(r, h - 1 - y); i++) {
        const s = ((y + i) * w + x) * 3, wt = k[i + r];
        a += tmp[s] * wt; b += tmp[s + 1] * wt; c += tmp[s + 2] * wt;
      }
      const o = (y * w + x) * 3;
      out[o] = a; out[o + 1] = b; out[o + 2] = c;
    }
  }
  return out;
}

/** Bilinear lookup at normalized (u, v) with texel centers at (i + 0.5) / w
 * and clamp-to-edge, the same convention as a GPU texture. */
function bilinear(src: Float64Array, w: number, h: number, u: number, v: number, out: Float64Array) {
  const fx = Math.min(w - 1, Math.max(0, u * w - 0.5));
  const fy = Math.min(h - 1, Math.max(0, v * h - 0.5));
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const tx = fx - x0, ty = fy - y0;
  const i00 = (y0 * w + x0) * 3, i10 = (y0 * w + x1) * 3, i01 = (y1 * w + x0) * 3, i11 = (y1 * w + x1) * 3;
  for (let c = 0; c < 3; c++) {
    const top = src[i00 + c] + (src[i10 + c] - src[i00 + c]) * tx;
    const bot = src[i01 + c] + (src[i11 + c] - src[i01 + c]) * tx;
    out[c] = top + (bot - top) * ty;
  }
  return out;
}

// ---------------------------------------------------------------- engine

export interface Engine {
  readonly width: number;
  readonly height: number;
  readonly scene: Scene;
  readonly lights: Light[];
  /** Positions derived from yaw/pitch/dist on the last commit() — read-only. */
  readonly lightPositions: Float32Array;
  /** Sync internal state from scene/lights after mutating them (createEngine
   * commits once itself). Clamps each light's dist in place. */
  commit(): void;
  /** Call once before a progressive pass sequence (invalidates hit caches). */
  beginFrame(): void;
  /** Render one progressive pass into an RGBA buffer (width*height*4). */
  renderPass(out: Uint8ClampedArray, scale: number, skipStride?: number): void;
  /** Anti-alias a finished full-res buffer: re-render only pixels that differ
   * strongly from a neighbor (geometric edges) with a 2x2 sub-pixel grid,
   * averaged in linear light. Returns the number of refined pixels. */
  refineEdges(out: Uint8ClampedArray, threshold?: number): number;
  /** Cast the pixel ray against the sphere. Returns a SCRATCH hit — copy what you keep.
   * Null on a miss or for a pixel outside the canvas. */
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
  /** The current bloom glow (null when bloom is off), for renderers that
   * want to add the exact same glow, like the WebGL preview. */
  glow(): GlowMap | null;
}

/** Palette-only form: resolution doesn't affect shade(), so it defaults. */
export function createEngine(scene: Scene, lights: Light[]): Engine;
export function createEngine(width: number, height: number, scene: Scene, lights: Light[]): Engine;
export function createEngine(a: number | Scene, b: number | Light[], c?: Scene, d?: Light[]): Engine {
  return typeof a === 'number'
    ? createEngineSized(a, b as number, c!, d!)
    : createEngineSized(DEFAULT_ENGINE_SIZE, DEFAULT_ENGINE_SIZE, a, b as Light[]);
}

function createEngineSized(width: number, height: number, scene: Scene, lights: Light[]): Engine {
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
  let cachedRayFOV = NaN;

  // Per-pixel buffers (~66 bytes a pixel), allocated on the first call that
  // touches pixels: a palette-only engine never needs them.
  let pixelBuffers = false;
  let rayDirectionCache = new Float32Array(0);
  // G-buffer: per-pixel primary-hit cache (kind, position, normal). Valid while
  // the camera and sphere geometry are unchanged — light edits then skip all
  // primary intersection work and only re-shade.
  let gbKind = new Uint8Array(0);   // 0 miss · 1 sphere · 2 wall
  let gbData = new Float64Array(0); // x y z nx ny nz (f64 = exact re-shades)
  let gbStamp = new Uint32Array(0);
  let geomStamp = 1;
  let gbCameraZ = NaN, gbFov = NaN, gbRadius = NaN;
  // Edge mask scratch for refineEdges (1 byte per pixel, reused per call)
  let aaEdge = new Uint8Array(0);

  function ensurePixelBuffers() {
    if (pixelBuffers) return;
    pixelBuffers = true;
    rayDirectionCache = new Float32Array(width * height * 3);
    gbKind = new Uint8Array(width * height);
    gbData = new Float64Array(width * height * 6);
    gbStamp = new Uint32Array(width * height);
    aaEdge = new Uint8Array(width * height);
    cachedRayFOV = NaN;
    updateCamera();
  }

  function commit() {
    if (lights.length !== lightCount) {
      throw new Error(`ray-color: engine was created with ${lightCount} lights, got ${lights.length}; create a new engine to add or remove lights`);
    }
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
    glowDirty = true;
    // so commit() + renderPass() without beginFrame() never re-shades hits
    // cached for an old camera or radius
    syncGeometry();
  }

  function updateCamera() {
    cachedTanFov = Math.tan(((scene.fov * Math.PI) / 180) / 2);
    cachedAspectRatio = width / height;
    cachedAspectTanFov = cachedAspectRatio * cachedTanFov;
    if (!pixelBuffers || cachedRayFOV === scene.fov) return;
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
    ensurePixelBuffers();
    updateCamera();
    syncGeometry();
  }

  // Invalidate the G-buffer when anything that shapes primary rays changed
  function syncGeometry() {
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
        // A wall never lights itself via its own mirror image. Without this
        // guard, points ON the wall decide inclusion by the rounding of
        // t = (wall.s - vHit[a]) / L[a] with a ±ulp numerator — luck that can
        // fall either way per scene. Sphere points are never on a wall plane,
        // so shade() (palette sampling) is unaffected.
        if (Math.abs(vHit[a] - wall.s) < 1e-3) continue;
        for (let i = 0; i < lightCount; i++) {
          const intensity = lightIntensities[i];
          if (intensity <= 0) continue;
          const tintR = lightColors[i * 3] * wallColor[0] * rho * intensity;
          const tintG = lightColors[i * 3 + 1] * wallColor[1] * rho * intensity;
          const tintB = lightColors[i * 3 + 2] * wallColor[2] * rho * intensity;
          if (tintR === 0 && tintG === 0 && tintB === 0) continue;

          if (lights[i].type === 'directional') {
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

  // ---------------------------------------------------------------- bloom
  // Threshold the HDR (unclipped) image on a fixed grid, blur it at
  // GLOW_LEVELS octaves (each level half the resolution of the last, blurred
  // with the same kernel, so the spread doubles), and sum the levels back at
  // grid resolution. Every color lookup then reads that one buffer with the
  // same bilinear filter, which keeps shade() and the pixels identical.

  const glowW = Math.max(1, Math.round(GLOW_ROWS * width / height));
  const glowH = GLOW_ROWS;
  let glowDirty = true;
  let glowData = new Float64Array(0);
  let glowMap: GlowMap | null = null;
  const glowScratch = new Float64Array(3);

  const bloomActive = () => !!scene.bloom && scene.bloom.strength > 0;

  /** Rebuild the glow if commit() invalidated it; false when bloom is off. */
  function ensureGlow() {
    if (!bloomActive()) return false;
    if (glowDirty) {
      buildGlow();
      glowDirty = false;
    }
    return true;
  }

  function buildGlow() {
    const b = scene.bloom!;
    const threshold = Math.max(0, b.threshold ?? 0.8);
    const knee = threshold * 0.5;
    const W = glowW, H = glowH;
    let level = new Float64Array(W * H * 3);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const px = (2 * ((x + 0.5) / W) - 1) * cachedAspectTanFov;
        const py = -(2 * ((y + 0.5) / H) - 1) * cachedTanFov;
        const len = Math.sqrt(px * px + py * py + 1);
        const c = traceRay(px / len, py / len, 1 / len);
        const m = Math.max(c.r, c.g, c.b);
        if (m <= 0) continue;
        // soft knee: ramps in quadratically around the threshold
        let soft = Math.min(2 * knee, Math.max(0, m - threshold + knee));
        soft = soft * soft / (4 * knee + 1e-4);
        const w = Math.max(soft, m - threshold) / m;
        const i = (y * W + x) * 3;
        level[i] = c.r * w; level[i + 1] = c.g * w; level[i + 2] = c.b * w;
      }
    }
    if (glowData.length !== W * H * 3) glowData = new Float64Array(W * H * 3);
    glowData.fill(0);
    const sigma = Math.max(0.5, (b.radius ?? 0.02) * H);
    const scale = b.strength / GLOW_LEVELS;
    let lw = W, lh = H;
    for (let k = 0; k < GLOW_LEVELS; k++) {
      if (k > 0) {
        const nw = Math.max(1, lw >> 1), nh = Math.max(1, lh >> 1);
        level = downsample(level, lw, lh, nw, nh);
        lw = nw; lh = nh;
      }
      const blurred = blur(level, lw, lh, sigma);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          bilinear(blurred, lw, lh, (x + 0.5) / W, (y + 0.5) / H, glowScratch);
          const i = (y * W + x) * 3;
          glowData[i] += glowScratch[0] * scale;
          glowData[i + 1] += glowScratch[1] * scale;
          glowData[i + 2] += glowScratch[2] * scale;
        }
      }
    }
    glowMap = null;
  }

  /** Glow at a normalized screen position (u right, v down, 0..1). */
  function glowAt(u: number, v: number) {
    if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1)) {
      glowScratch[0] = glowScratch[1] = glowScratch[2] = 0;
      return glowScratch;
    }
    return bilinear(glowData, glowW, glowH, u, v, glowScratch);
  }

  // Glow for a sphere surface point (radius-scaled normal), looked up where
  // the point lands on screen. shade() and the pixel path both come through
  // here with the same coordinates, so they read the same value.
  function sphereGlowAt(hx: number, hy: number, hz: number) {
    // hidden from the camera: not in the picture, so no glow
    if (hz * scene.cameraZ - (hx * hx + hy * hy + hz * hz) <= 0) {
      glowScratch[0] = glowScratch[1] = glowScratch[2] = 0;
      return glowScratch;
    }
    const relZ = hz - scene.cameraZ;
    return glowAt((hx / (relZ * cachedAspectTanFov) + 1) / 2, (-hy / (relZ * cachedTanFov) + 1) / 2);
  }

  function addGlow(c: RGB, g: Float64Array) {
    c.r += g[0]; c.g += g[1]; c.b += g[2];
  }

  function glow(): GlowMap | null {
    if (!ensureGlow()) return null;
    if (!glowMap) glowMap = { width: glowW, height: glowH, data: Float32Array.from(glowData) };
    return glowMap;
  }

  // ---------------------------------------------------------------- rendering

  // skipStride: pixels whose coordinates are multiples of it were already
  // computed exactly by the previous (coarser) pass — leave them untouched
  function renderPass(out: Uint8ClampedArray, scale: number, skipStride = 0) {
    ensurePixelBuffers();
    const bloom = ensureGlow();
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
        if (bloom) {
          if (gbKind[pix] === 1) {
            const o = pix * 6;
            addGlow(color, sphereGlowAt(gbData[o], gbData[o + 1], gbData[o + 2]));
          } else {
            addGlow(color, glowAt((x + 0.5) / width, (y + 0.5) / height));
          }
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

  // Shade an arbitrary (fractional-pixel) primary ray — the sub-pixel path
  // used by refineEdges. No G-buffer: edge pixels are re-traced every time.
  function shadeSubRay(px: number, py: number): RGB {
    const rx = (2 * (px / width) - 1) * cachedAspectTanFov;
    const ry = -(2 * (py / height) - 1) * cachedTanFov;
    const len = Math.sqrt(rx * rx + ry * ry + 1);
    const c = traceRay(rx / len, ry / len, 1 / len);
    if (bloomActive()) {
      addGlow(c, lastTraceSphere
        ? sphereGlowAt(lastHit[0], lastHit[1], lastHit[2])
        : glowAt(px / width, py / height));
    }
    return c;
  }

  // Shade a primary ray from the camera, without glow. Records whether it hit
  // the sphere (and where) for the glow lookup that may follow.
  let lastTraceSphere = false;
  const lastHit = new Float64Array(3);
  function traceRay(dirX: number, dirY: number, dirZ: number): RGB {
    const sphereHit = intersectSphere(0, 0, scene.cameraZ, dirX, dirY, dirZ, scene.sphereRadius);
    lastTraceSphere = !!sphereHit;
    if (sphereHit) {
      lastHit[0] = sphereHit.nx * scene.sphereRadius;
      lastHit[1] = sphereHit.ny * scene.sphereRadius;
      lastHit[2] = sphereHit.nz * scene.sphereRadius;
      return calculateLighting(
        lastHit[0], lastHit[1], lastHit[2],
        sphereHit.nx, sphereHit.ny, sphereHit.nz,
        sphereColor[0], sphereColor[1], sphereColor[2]);
    }
    const roomHit = intersectRoom(0, 0, scene.cameraZ, dirX, dirY, dirZ);
    if (roomHit) {
      return shadeWall(roomHit.x, roomHit.y, roomHit.z, roomHit.nx, roomHit.ny, roomHit.nz, dirX, dirY, dirZ);
    }
    shadeScratch.r = 0; shadeScratch.g = 0; shadeScratch.b = 0;
    return shadeScratch;
  }

  function refineEdges(out: Uint8ClampedArray, threshold = 24) {
    ensurePixelBuffers();
    ensureGlow();
    aaEdge.fill(0);
    // Detect first, refine after — refining in place would shift the very
    // contrasts the detection reads and cascade across the image
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        const pix = row + x;
        const i = pix * 4;
        if (x + 1 < width) {
          const j = i + 4;
          if (Math.abs(out[i] - out[j]) > threshold ||
              Math.abs(out[i + 1] - out[j + 1]) > threshold ||
              Math.abs(out[i + 2] - out[j + 2]) > threshold) {
            aaEdge[pix] = 1;
            aaEdge[pix + 1] = 1;
          }
        }
        if (y + 1 < height) {
          const j = i + width * 4;
          if (Math.abs(out[i] - out[j]) > threshold ||
              Math.abs(out[i + 1] - out[j + 1]) > threshold ||
              Math.abs(out[i + 2] - out[j + 2]) > threshold) {
            aaEdge[pix] = 1;
            aaEdge[pix + width] = 1;
          }
        }
      }
    }
    let refined = 0;
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        if (!aaEdge[row + x]) continue;
        let r = 0, g = 0, b = 0;
        for (let s = 0; s < 4; s++) {
          const c = shadeSubRay(x + 0.25 + (s & 1) * 0.5, y + 0.25 + (s >> 1) * 0.5);
          r += c.r; g += c.g; b += c.b;
        }
        const i = (row + x) * 4;
        out[i] = toSRGB8(r * 0.25);
        out[i + 1] = toSRGB8(g * 0.25);
        out[i + 2] = toSRGB8(b * 0.25);
        refined++;
      }
    }
    return refined;
  }

  // ---------------------------------------------------------------- sampling & camera

  function castRay(x: number, y: number) {
    const px = Math.floor(x), py = Math.floor(y);
    // out-of-range reads would be undefined -> NaN, which slips past every
    // `< 0` test in intersectSphere and comes back as a NaN "hit"
    if (!(px >= 0 && px < width && py >= 0 && py < height)) return null;
    ensurePixelBuffers();
    const idx = (py * width + px) * 3;
    const dirX = rayDirectionCache[idx];
    const dirY = rayDirectionCache[idx + 1];
    const dirZ = rayDirectionCache[idx + 2];
    return intersectSphere(0, 0, scene.cameraZ, dirX, dirY, dirZ, scene.sphereRadius);
  }

  function shade(dir: ArrayLike<number>) {
    const r = scene.sphereRadius;
    const hx = dir[0] * r, hy = dir[1] * r, hz = dir[2] * r;
    // before shading: a glow rebuild traces rays and reuses the shade scratch
    const bloom = ensureGlow();
    const c = calculateLighting(hx, hy, hz, dir[0], dir[1], dir[2], sphereColor[0], sphereColor[1], sphereColor[2]);
    if (bloom) addGlow(c, sphereGlowAt(hx, hy, hz));
    return c;
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

  // decode the scene up front: an uncommitted engine shades everything black
  commit();

  return {
    width,
    height,
    scene,
    lights,
    lightPositions,
    commit,
    beginFrame,
    renderPass,
    refineEdges,
    castRay,
    shade,
    worldToScreen,
    pointerToLightAngles,
    isLightOccluded,
    isPointOccluded,
    tanFov: () => cachedTanFov,
    glow,
  };
}
