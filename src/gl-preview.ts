// WebGL2 preview renderer — a fragment-shader port of the CPU engine's
// shading, used by the playground for realtime feedback while dragging.
//
// This is a PREVIEW, not the product: palettes, samples and exports always
// come from the f64 CPU engine (`shade()` / `renderPass()`), which keeps the
// library's bit-exactness guarantees. The shader mirrors the CPU math in f32,
// including the 4096-step sRGB LUT quantization, so frames agree with the CPU
// render within ±1 per channel away from geometric/shadow edges (verified by
// parity.html).
//
// Playground-only: not part of the published library build.

import {
  type Scene, type Light,
  hexToRgb, positionToAngles, MAX_LIGHT_DISTANCE,
} from './engine';

const MAX_LIGHTS = 4;
const MAX_AREA_SAMPLES = 32;

const VERT = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// Every constant and branch below mirrors engine.ts — when editing one side,
// edit the other and re-run parity.html.
const FRAG = `#version 300 es
precision highp float;
precision highp int;

const int ML = ${MAX_LIGHTS};
const int MAS = ${MAX_AREA_SAMPLES};
const float GOLDEN_ANGLE = 3.14159265358979 * (3.0 - 2.2360679774997896);
const float INF = 1e30;
const float BOUNDS = 2.0;

uniform vec2 uResolution;
uniform float uCameraZ;
uniform float uTanFov;
uniform float uAspectTanFov;
uniform float uSphereRadius;
uniform vec3 uSphereColor;
uniform vec3 uWallColor;
uniform float uIndirect;
uniform int uAreaSamples;          // resolved per-frame: clamp(areaQuality, 1, MAS)
uniform float uWallReflect[5];     // back, left, right, top, bottom
uniform int uLightCount;
uniform int uLightType[ML];        // 0 point · 1 area · 2 directional · 3 spot
uniform vec3 uLightPos[ML];
uniform vec3 uLightColor[ML];      // linear
uniform float uLightIntensity[ML];
uniform float uLightCosAngle[ML];  // cos(spot angle)
uniform float uLightSize[ML];
uniform vec3 uLightDir[ML];        // unit direction toward the light (directional)
uniform vec3 uSpotAxis[ML];
uniform vec3 uAreaU[ML];
uniform vec3 uAreaV[ML];

out vec4 fragColor;

// Mirror-wall planes, same order as uWallReflect
const int WALL_AXIS[5] = int[5](2, 0, 0, 1, 1);
const float WALL_S[5] = float[5](2.0, -2.0, 2.0, 2.0, -2.0);

const vec3 INDIRECT_DIRS[6] = vec3[6](
  vec3(1, 0, 0), vec3(-1, 0, 0),
  vec3(0, 1, 0), vec3(0, -1, 0),
  vec3(0, 0, 1), vec3(0, 0, -1)
);

// d must be unit length (all callers normalize). The discriminant uses the
// perpendicular-distance form: the CPU's b*b - 4*a*c is fine in f64 but
// catastrophically cancels in f32 for rays that graze the sphere, which
// makes tangent hits (mirrored silhouettes on reflective walls) noisy.
float sphereT(vec3 o, vec3 d, float radius) {
  float b2 = dot(o, d); // half-b with a = 1
  vec3 perp = o - b2 * d;
  float disc4 = radius * radius - dot(perp, perp); // = disc / 4
  if (disc4 < 0.0) return INF;
  float sq = sqrt(disc4);
  float t = -b2 - sq;
  if (t < 0.0) t = -b2 + sq;
  if (t < 0.0) return INF;
  return t;
}

// wallId: 0 back · 1 left · 2 right · 3 top · 4 bottom (matches uWallReflect)
// Panel bounds are padded by an epsilon: in f32, rays that graze a corner
// seam land at |coord| = 2 + ulp and would fail BOTH adjacent walls' checks,
// rendering black seams the f64 CPU engine doesn't have.
const float SEAM_EPS = 1e-4;
bool roomHit(vec3 o, vec3 d, out vec3 pos, out vec3 n, out int wallId) {
  float minT = INF;
  n = vec3(0.0);
  wallId = -1;
  const float B = BOUNDS + SEAM_EPS;
  if (abs(d.z) > 1e-6) {
    float t = (BOUNDS - o.z) / d.z;
    if (t > 0.0) {
      vec2 h = o.xy + d.xy * t;
      if (abs(h.x) <= B && abs(h.y) <= B && t < minT) {
        minT = t; n = vec3(0.0, 0.0, -1.0); wallId = 0;
      }
    }
  }
  if (abs(d.x) > 1e-6) {
    for (int i = 0; i < 2; i++) {
      float side = i == 0 ? -BOUNDS : BOUNDS;
      float t = (side - o.x) / d.x;
      if (t > 0.0) {
        vec2 h = o.yz + d.yz * t;
        if (abs(h.x) <= B && abs(h.y) <= B && t < minT) {
          minT = t; n = vec3(side < 0.0 ? 1.0 : -1.0, 0.0, 0.0); wallId = side < 0.0 ? 1 : 2;
        }
      }
    }
  }
  if (abs(d.y) > 1e-6) {
    for (int i = 0; i < 2; i++) {
      float side = i == 0 ? -BOUNDS : BOUNDS;
      float t = (side - o.y) / d.y;
      if (t > 0.0) {
        vec2 h = o.xz + d.xz * t;
        if (abs(h.x) <= B && abs(h.y) <= B && t < minT) {
          minT = t; n = vec3(0.0, side < 0.0 ? 1.0 : -1.0, 0.0); wallId = side < 0.0 ? 4 : 3;
        }
      }
    }
  }
  if (minT >= INF) return false;
  pos = o + d * minT;
  return true;
}

vec3 calcLighting(vec3 hit, vec3 n, vec3 objColor, bool enableIndirect) {
  vec3 color = vec3(0.0);
  float radius = uSphereRadius;
  float bias = radius * 0.001 + 1e-4;
  vec3 biased = hit + n * bias;

  for (int i = 0; i < ML; i++) {
    if (i >= uLightCount) break;
    float inten = uLightIntensity[i];
    vec3 lcol = uLightColor[i];
    if (inten <= 0.0 || (lcol.r == 0.0 && lcol.g == 0.0 && lcol.b == 0.0)) continue;
    int type = uLightType[i];

    if (type == 2) { // directional
      vec3 L = uLightDir[i];
      if (sphereT(biased, L, radius) >= INF) {
        float NdotL = max(0.0, dot(n, L));
        color += lcol * NdotL * inten;
      }
    } else if (type == 3) { // spot
      vec3 L = uLightPos[i] - hit;
      float dist = length(L);
      if (dist > 0.0) {
        L /= dist;
        float LdotAxis = -dot(L, uSpotAxis[i]);
        float cosAngle = uLightCosAngle[i];
        if (LdotAxis > cosAngle) {
          if (sphereT(biased, L, radius) >= dist) {
            float edge = (LdotAxis - cosAngle) / (1.0 - cosAngle);
            float falloff = edge * edge * (3.0 - 2.0 * edge);
            float NdotL = max(0.0, dot(n, L));
            float att = 1.0 / max(0.01, dist * dist);
            color += lcol * NdotL * inten * falloff * att;
          }
        }
      }
    } else { // point / area
      int samples = (type == 1 && uLightSize[i] > 0.0) ? uAreaSamples : 1;
      vec3 accum = vec3(0.0);
      for (int s = 0; s < MAS; s++) {
        if (s >= samples) break;
        vec3 samplePos = uLightPos[i];
        if (type == 1 && uLightSize[i] > 0.0) {
          // Deterministic golden-angle spiral on the disk facing the target
          float r = sqrt((float(s) + 0.5) / float(samples)) * uLightSize[i];
          float theta = float(s) * GOLDEN_ANGLE;
          samplePos += uAreaU[i] * (cos(theta) * r) + uAreaV[i] * (sin(theta) * r);
        }
        vec3 L = samplePos - hit;
        float dist = length(L);
        if (dist == 0.0) continue;
        L /= dist;
        if (sphereT(biased, L, radius) < dist) continue;
        float NdotL = max(0.0, dot(n, L));
        float att = 1.0 / max(0.01, dist * dist);
        accum += lcol * NdotL * att;
      }
      color += accum * (inten / float(samples));
    }
  }

  // Virtual mirror lights from reflective walls
  if (uWallReflect[0] > 0.0 || uWallReflect[1] > 0.0 || uWallReflect[2] > 0.0 ||
      uWallReflect[3] > 0.0 || uWallReflect[4] > 0.0) {
    for (int w = 0; w < 5; w++) {
      float rho = uWallReflect[w];
      if (rho <= 0.0) continue;
      int a = WALL_AXIS[w];
      float ws = WALL_S[w];
      // Axis selection via mask vectors — dynamic vector component writes
      // (v[a] = x) miscompile on some ANGLE backends
      vec3 am = vec3(a == 0 ? 1.0 : 0.0, a == 1 ? 1.0 : 0.0, a == 2 ? 1.0 : 0.0);
      vec3 keep = vec3(1.0) - am;
      float hitA = dot(hit, am);
      // A wall never lights itself via its own mirror image. The CPU excludes
      // this through t <= 0 falling out of f64 round-off; in f32 the sign of
      // (ws - hitA) ~ ±ulp flips the other way, so make the exclusion explicit.
      if (abs(hitA - ws) < 1e-3) continue;
      for (int i = 0; i < ML; i++) {
        if (i >= uLightCount) break;
        float inten = uLightIntensity[i];
        if (inten <= 0.0) continue;
        vec3 tint = uLightColor[i] * uWallColor * rho * inten;
        if (tint.r == 0.0 && tint.g == 0.0 && tint.b == 0.0) continue;

        if (uLightType[i] == 2) { // directional
          vec3 vDir = uLightDir[i] * (keep - am); // component a negated
          float da = dot(vDir, am);
          if (da == 0.0) continue;
          float t = (ws - hitA) / da;
          if (t <= 0.0) continue;
          vec3 panel = abs(hit + vDir * t) * keep;
          if (panel.x > BOUNDS || panel.y > BOUNDS || panel.z > BOUNDS) continue;
          float NdotL = dot(n, vDir);
          if (NdotL <= 0.0) continue;
          if (sphereT(biased, vDir, radius) < INF) continue;
          color += tint * NdotL;
        } else {
          // point-like virtual light: mirror the position across the wall plane
          vec3 vPos = uLightPos[i] + am * (2.0 * ws - 2.0 * dot(uLightPos[i], am));
          vec3 L = vPos - hit;
          float dist = length(L);
          if (dist == 0.0) continue;
          L /= dist;
          float La = dot(L, am);
          if (La == 0.0) continue;
          float t = (ws - hitA) / La;
          if (t <= 0.0 || t >= dist) continue;
          vec3 panel = abs(hit + L * t) * keep;
          if (panel.x > BOUNDS || panel.y > BOUNDS || panel.z > BOUNDS) continue;
          float NdotL = dot(n, L);
          if (NdotL <= 0.0) continue;
          if (sphereT(biased, L, radius) < dist) continue;
          float att = 1.0 / max(0.01, dist * dist);
          color += tint * NdotL * att;
        }
      }
    }
  }

  if (enableIndirect && uIndirect > 0.0) {
    vec3 indirect = vec3(0.0);
    for (int s = 0; s < 6; s++) {
      vec3 dir = INDIRECT_DIRS[s];
      float d = dot(n, dir);
      if (d <= 0.0) continue;
      vec3 wPos, wN;
      int wallId;
      if (!roomHit(hit + n * 0.001, dir, wPos, wN, wallId)) continue;
      vec3 wallLight = vec3(0.0);
      for (int i = 0; i < ML; i++) {
        if (i >= uLightCount) break;
        float wallDiffuse = 0.0;
        if (uLightType[i] == 2) {
          // Directional lights are pure directions — no distance, no falloff
          wallDiffuse = max(0.0, dot(wN, uLightDir[i]));
        } else {
          vec3 wl = uLightPos[i] - wPos;
          float wlLen = length(wl);
          if (wlLen > 0.0) {
            float inv = 1.0 / wlLen;
            wallDiffuse = max(0.0, dot(wN, wl) * inv) / max(0.01, wlLen * wlLen);
            if (uLightType[i] == 3) {
              // Respect the cone: bounce only where the spot actually shines
              float LdotAxis = -dot(wl * inv, uSpotAxis[i]);
              float cosAngle = uLightCosAngle[i];
              if (LdotAxis <= cosAngle) {
                wallDiffuse = 0.0;
              } else {
                float edge = (LdotAxis - cosAngle) / (1.0 - cosAngle);
                wallDiffuse *= edge * edge * (3.0 - 2.0 * edge);
              }
            }
          }
        }
        wallLight += uLightColor[i] * wallDiffuse * uLightIntensity[i];
      }
      float attenuation = d / (1.0 + length(wPos - hit) * 0.5);
      indirect += uWallColor * wallLight * attenuation;
    }
    color += indirect * (uIndirect / 6.0);
  }
  return color * objColor;
}

vec3 shadeWallPx(vec3 pos, vec3 n, int wallId, vec3 inDir) {
  vec3 base = calcLighting(pos, n, uWallColor, false) * 0.5;
  float rho = uWallReflect[wallId];
  if (rho > 0.0) {
    vec3 r = inDir - 2.0 * dot(inDir, n) * n;
    vec3 o = pos + n * 1e-4;
    vec3 refl = vec3(0.0);
    float t = sphereT(o, r, uSphereRadius);
    if (t < INF) {
      // shade the mirrored sphere point at normal * radius (exactness convention)
      vec3 sn = (o + r * t) / uSphereRadius;
      refl = calcLighting(sn * uSphereRadius, sn, uSphereColor, true);
    } else {
      vec3 wPos, wN;
      int wid;
      if (roomHit(o, r, wPos, wN, wid)) {
        // mirrored walls stay matte — one bounce only
        refl = calcLighting(wPos, wN, uWallColor, false) * 0.5;
      }
    }
    base = base * (1.0 - rho) + refl * rho;
  }
  return base;
}

// Linear -> sRGB with the CPU LUT's 4096-step quantization, so both paths
// round identically at the 8-bit boundary
vec3 encodeSRGB(vec3 c) {
  vec3 q = floor(clamp(c, 0.0, 1.0) * 4095.0 + 0.5) / 4095.0;
  vec3 lo = q * 12.92;
  vec3 hi = 1.055 * pow(q, vec3(1.0 / 2.4)) - 0.055;
  return mix(hi, lo, step(q, vec3(0.0031308)));
}

void main() {
  // gl_FragCoord is bottom-left origin with the +0.5 pixel-center built in,
  // which lands on exactly the CPU's (x + 0.5) / w and flipped-y expressions
  float sx = (2.0 * (gl_FragCoord.x / uResolution.x) - 1.0) * uAspectTanFov;
  float sy = (2.0 * (gl_FragCoord.y / uResolution.y) - 1.0) * uTanFov;
  vec3 dir = normalize(vec3(sx, sy, 1.0));
  vec3 o = vec3(0.0, 0.0, uCameraZ);

  vec3 color = vec3(0.0);
  float t = sphereT(o, dir, uSphereRadius);
  if (t < INF) {
    // Shade at normal * radius — the same reconstruction the CPU uses
    vec3 n = (o + dir * t) / uSphereRadius;
    color = calcLighting(n * uSphereRadius, n, uSphereColor, true);
  } else {
    vec3 wPos, wN;
    int wallId;
    if (roomHit(o, dir, wPos, wN, wallId)) {
      color = shadeWallPx(wPos, wN, wallId, dir);
    }
  }
  fragColor = vec4(encodeSRGB(color), 1.0);
}`;

export interface GlPreview {
  readonly canvas: HTMLCanvasElement;
  /** Upload the current scene/lights and render one frame. Reads the same
   * mutable objects the engine does; call after values change (no commit()
   * needed — light positions are derived the same way commit() derives them,
   * without mutating the lights). */
  draw(scene: Scene, lights: Light[]): void;
  resize(width: number, height: number): void;
  /** Current frame as top-down RGBA (same layout as ImageData) — for tests. */
  readPixels(): Uint8ClampedArray;
  dispose(): void;
}

const TYPE_CODE: Record<Light['type'], number> = { point: 0, area: 1, directional: 2, spot: 3 };

/** Returns null when WebGL2 is unavailable — callers fall back to CPU-only. */
export function createGlPreview(
  width: number,
  height: number,
  opts: { canvas?: HTMLCanvasElement; preserveDrawingBuffer?: boolean } = {},
): GlPreview | null {
  const canvas = opts.canvas ?? document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    depth: false,
    stencil: false,
    antialias: false,
    preserveDrawingBuffer: opts.preserveDrawingBuffer ?? false,
    powerPreference: 'high-performance',
  });
  if (!gl) return null;

  function compile(type: number, src: string) {
    const sh = gl!.createShader(type)!;
    gl!.shaderSource(sh, src);
    gl!.compileShader(sh);
    if (!gl!.getShaderParameter(sh, gl!.COMPILE_STATUS)) {
      const log = gl!.getShaderInfoLog(sh);
      gl!.deleteShader(sh);
      throw new Error(`ray-color gl-preview shader: ${log}`);
    }
    return sh;
  }

  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`ray-color gl-preview link: ${log}`);
  }
  gl.useProgram(program);
  const loc = (name: string) => gl.getUniformLocation(program, name);

  const uResolution = loc('uResolution');
  const uCameraZ = loc('uCameraZ');
  const uTanFov = loc('uTanFov');
  const uAspectTanFov = loc('uAspectTanFov');
  const uSphereRadius = loc('uSphereRadius');
  const uSphereColor = loc('uSphereColor');
  const uWallColor = loc('uWallColor');
  const uIndirect = loc('uIndirect');
  const uAreaSamples = loc('uAreaSamples');
  const uWallReflect = loc('uWallReflect[0]');
  const uLightCount = loc('uLightCount');
  const uLightType = loc('uLightType[0]');
  const uLightPos = loc('uLightPos[0]');
  const uLightColor = loc('uLightColor[0]');
  const uLightIntensity = loc('uLightIntensity[0]');
  const uLightCosAngle = loc('uLightCosAngle[0]');
  const uLightSize = loc('uLightSize[0]');
  const uLightDir = loc('uLightDir[0]');
  const uSpotAxis = loc('uSpotAxis[0]');
  const uAreaU = loc('uAreaU[0]');
  const uAreaV = loc('uAreaV[0]');

  // Flat upload scratch (avoids per-frame allocation)
  const colScratch = new Float32Array(3);
  const types = new Int32Array(MAX_LIGHTS);
  const positions = new Float32Array(MAX_LIGHTS * 3);
  const colors = new Float32Array(MAX_LIGHTS * 3);
  const intensities = new Float32Array(MAX_LIGHTS);
  const cosAngles = new Float32Array(MAX_LIGHTS);
  const sizes = new Float32Array(MAX_LIGHTS);
  const dirs = new Float32Array(MAX_LIGHTS * 3);
  const axes = new Float32Array(MAX_LIGHTS * 3);
  const areaU = new Float32Array(MAX_LIGHTS * 3);
  const areaV = new Float32Array(MAX_LIGHTS * 3);
  const wallReflect = new Float32Array(5);

  function draw(scene: Scene, lights: Light[]) {
    const count = Math.min(lights.length, MAX_LIGHTS);
    // Same derivation commit() performs, without mutating the lights
    for (let i = 0; i < count; i++) {
      const l = lights[i];
      let { yaw, pitch, dist } = l;
      if (l.position) ({ yaw, pitch, dist } = positionToAngles(l.position[0], l.position[1], l.position[2]));
      dist = Math.min(MAX_LIGHT_DISTANCE, Math.max(scene.sphereRadius, dist));
      const yr = yaw * Math.PI / 180;
      const pr = pitch * Math.PI / 180;
      const dx = Math.cos(pr) * Math.cos(yr);
      const dy = Math.sin(pr);
      const dz = Math.cos(pr) * Math.sin(yr);
      positions[i * 3] = dx * dist;
      positions[i * 3 + 1] = dy * dist;
      positions[i * 3 + 2] = dz * dist;
      hexToRgb(l.hex, colScratch);
      colors.set(colScratch, i * 3);
      types[i] = TYPE_CODE[l.type];
      intensities[i] = l.intensity;
      cosAngles[i] = Math.cos((l.angle * Math.PI) / 180);
      sizes[i] = l.size;
      dirs[i * 3] = dx; dirs[i * 3 + 1] = dy; dirs[i * 3 + 2] = dz;
      const ax = -dx, ay = -dy, az = -dz;
      axes[i * 3] = ax; axes[i * 3 + 1] = ay; axes[i * 3 + 2] = az;
      // Disk basis: u = normalize(helper x axis), v = axis x u
      const hy = Math.abs(ay) > 0.99 ? 0 : 1;
      const hx = 1 - hy;
      let ux = hy * az;
      let uy = -hx * az;
      let uz = hx * ay - hy * ax;
      const ulen = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
      ux /= ulen; uy /= ulen; uz /= ulen;
      areaU[i * 3] = ux; areaU[i * 3 + 1] = uy; areaU[i * 3 + 2] = uz;
      areaV[i * 3] = ay * uz - az * uy;
      areaV[i * 3 + 1] = az * ux - ax * uz;
      areaV[i * 3 + 2] = ax * uy - ay * ux;
    }
    hexToRgb(scene.sphereHex, colScratch);
    gl!.uniform3fv(uSphereColor, colScratch);
    hexToRgb(scene.wallHex, colScratch);
    gl!.uniform3fv(uWallColor, colScratch);
    const w = scene.wallReflect;
    wallReflect[0] = w.back; wallReflect[1] = w.left; wallReflect[2] = w.right;
    wallReflect[3] = w.top; wallReflect[4] = w.bottom;

    const tanFov = Math.tan(((scene.fov * Math.PI) / 180) / 2);
    gl!.uniform2f(uResolution, canvas.width, canvas.height);
    gl!.uniform1f(uCameraZ, scene.cameraZ);
    gl!.uniform1f(uTanFov, tanFov);
    gl!.uniform1f(uAspectTanFov, (canvas.width / canvas.height) * tanFov);
    gl!.uniform1f(uSphereRadius, scene.sphereRadius);
    gl!.uniform1f(uIndirect, scene.indirect);
    gl!.uniform1i(uAreaSamples, Math.max(1, Math.min(MAX_AREA_SAMPLES, scene.areaQuality)));
    gl!.uniform1fv(uWallReflect, wallReflect);
    gl!.uniform1i(uLightCount, count);
    gl!.uniform1iv(uLightType, types);
    gl!.uniform3fv(uLightPos, positions);
    gl!.uniform3fv(uLightColor, colors);
    gl!.uniform1fv(uLightIntensity, intensities);
    gl!.uniform1fv(uLightCosAngle, cosAngles);
    gl!.uniform1fv(uLightSize, sizes);
    gl!.uniform3fv(uLightDir, dirs);
    gl!.uniform3fv(uSpotAxis, axes);
    gl!.uniform3fv(uAreaU, areaU);
    gl!.uniform3fv(uAreaV, areaV);

    gl!.viewport(0, 0, canvas.width, canvas.height);
    gl!.drawArrays(gl!.TRIANGLES, 0, 3);
  }

  function resize(w: number, h: number) {
    canvas.width = w;
    canvas.height = h;
  }

  function readPixels(): Uint8ClampedArray {
    const w = canvas.width, h = canvas.height;
    const raw = new Uint8Array(w * h * 4);
    gl!.readPixels(0, 0, w, h, gl!.RGBA, gl!.UNSIGNED_BYTE, raw);
    // GL rows are bottom-up; flip to ImageData's top-down layout
    const out = new Uint8ClampedArray(w * h * 4);
    const rowBytes = w * 4;
    for (let y = 0; y < h; y++) {
      out.set(raw.subarray(y * rowBytes, (y + 1) * rowBytes), (h - 1 - y) * rowBytes);
    }
    return out;
  }

  function dispose() {
    gl!.deleteProgram(program);
    gl!.getExtension('WEBGL_lose_context')?.loseContext();
  }

  return { canvas, draw, resize, readPixels, dispose };
}
