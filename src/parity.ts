// Parity harness: renders a set of scenes with the CPU engine (the source of
// truth) and the WebGL2 preview renderer, then compares the two buffers.
//
// The GL preview is a f32 approximation of the f64 CPU engine, so the check
// is not bit-exactness. The contract it enforces:
//   - away from geometric/shadow edges, every channel is within ±1 of the CPU
//   - edge pixels (where sub-LSB ray differences legitimately flip between
//     surfaces or shadow samples) are excused via an edge mask derived from
//     the CPU image, but their count is reported
//
// Results land in the DOM and on window.__parity for automation.

import { createEngine, sampleLineDirs, sampleCircleDirs, distributions, toSRGB8, type Scene, type Light } from './engine';
import { createGlPreview } from './gl-preview';
import { PRESETS } from './presets';

const W = 256;
const H = 256;

// The playground's scene presets double as the parity test scenes — copied
// per run because the engine mutates scene/lights in place.
const CASES = structuredClone(PRESETS);

// Edge mask: a pixel is an "edge" if any channel differs from a 4-neighbour
// by more than the refineEdges threshold (24) in EITHER image, dilated by one
// pixel so both sides of the discontinuity are excused. The union matters:
// discontinuities that shift sub-pixel between f64 and f32 (mirrored-sphere
// silhouettes on reflective walls, shadow-sample flips) only read as an edge
// in one of the two renders.
function edgeMask(imgs: Uint8ClampedArray[], w: number, h: number, threshold = 24): Uint8Array {
  const raw = new Uint8Array(w * h);
  for (const img of imgs) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        for (const j of [x + 1 < w ? i + 4 : -1, y + 1 < h ? i + w * 4 : -1]) {
          if (j < 0) continue;
          if (Math.abs(img[i] - img[j]) > threshold ||
              Math.abs(img[i + 1] - img[j + 1]) > threshold ||
              Math.abs(img[i + 2] - img[j + 2]) > threshold) {
            raw[y * w + x] = 1;
            raw[j / 4 | 0] = 1;
          }
        }
      }
    }
  }
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let e = 0;
      for (let dy = -1; dy <= 1 && !e; dy++) {
        for (let dx = -1; dx <= 1 && !e; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && nx < w && ny >= 0 && ny < h && raw[ny * w + nx]) e = 1;
        }
      }
      mask[y * w + x] = e;
    }
  }
  return mask;
}

// Room-corner seam mask: pixels whose primary ray lands within ~a pixel of a
// wall-wall seam. There the two walls' hit distances tie within rounding, so
// f64 and f32 legitimately pick different walls (different reflectivity and
// normal) — a surface-identity discontinuity, excused like other edges.
function seamMask(scene: Scene, w: number, h: number, eps = 0.03): Uint8Array {
  const mask = new Uint8Array(w * h);
  const tanFov = Math.tan(((scene.fov * Math.PI) / 180) / 2);
  const aspectTanFov = (w / h) * tanFov;
  const r = scene.sphereRadius;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = (2 * ((x + 0.5) / w) - 1) * aspectTanFov;
      const py = -(2 * ((y + 0.5) / h) - 1) * tanFov;
      const len = Math.sqrt(px * px + py * py + 1);
      const dx = px / len, dy = py / len, dz = 1 / len;
      const oz = scene.cameraZ;
      // Sphere pixels can't be on a wall seam
      const b = 2 * oz * dz, c = oz * oz - r * r;
      const disc = b * b - 4 * c;
      if (disc >= 0 && (-b - Math.sqrt(disc)) / 2 > 0) continue;
      // Nearest wall hit (same walls as intersectRoom)
      let minT = Infinity, hx = 0, hy = 0, hz = 0;
      if (Math.abs(dz) > 1e-6) {
        const t = (2 - oz) / dz;
        if (t > 0) {
          const ix = dx * t, iy = dy * t;
          if (Math.abs(ix) <= 2 && Math.abs(iy) <= 2 && t < minT) { minT = t; hx = ix; hy = iy; hz = 2; }
        }
      }
      for (const side of [-2, 2]) {
        if (Math.abs(dx) > 1e-6) {
          const t = side / dx;
          if (t > 0) {
            const iy = dy * t, iz = oz + dz * t;
            if (Math.abs(iy) <= 2 && Math.abs(iz) <= 2 && t < minT) { minT = t; hx = side; hy = iy; hz = iz; }
          }
        }
        if (Math.abs(dy) > 1e-6) {
          const t = side / dy;
          if (t > 0) {
            const ix = dx * t, iz = oz + dz * t;
            if (Math.abs(ix) <= 2 && Math.abs(iz) <= 2 && t < minT) { minT = t; hx = ix; hy = side; hz = iz; }
          }
        }
      }
      if (minT === Infinity) continue;
      // On the wall, the hit coordinate along the wall axis is ±2 — near-seam
      // means a SECOND coordinate is also within eps of ±2
      let near = 0;
      if (2 - Math.abs(hx) < eps) near++;
      if (2 - Math.abs(hy) < eps) near++;
      if (2 - Math.abs(hz) < eps) near++;
      if (near >= 2) mask[y * w + x] = 1;
    }
  }
  return mask;
}

interface CaseResult {
  name: string;
  maxDelta: number;
  offEdgeMax: number;
  offEdgeBad: number;   // off-edge pixels with any channel delta > 1
  edgeBad: number;      // edge pixels with any channel delta > 1
  edgePixels: number;
  pixels: number;
  pass: boolean;
  worst: Array<{ x: number; y: number; d: number; cpu: number[]; gpu: number[] }>;
}

function compare(name: string, scene: Scene, cpu: Uint8ClampedArray, gpu: Uint8ClampedArray): CaseResult {
  const mask = edgeMask([cpu, gpu], W, H);
  const seams = seamMask(scene, W, H);
  for (let p = 0; p < W * H; p++) if (seams[p]) mask[p] = 1;
  let maxDelta = 0, offEdgeMax = 0, offEdgeBad = 0, edgeBad = 0, edgePixels = 0;
  for (let p = 0; p < W * H; p++) {
    const i = p * 4;
    const d = Math.max(
      Math.abs(cpu[i] - gpu[i]),
      Math.abs(cpu[i + 1] - gpu[i + 1]),
      Math.abs(cpu[i + 2] - gpu[i + 2]),
    );
    if (d > maxDelta) maxDelta = d;
    if (mask[p]) {
      edgePixels++;
      if (d > 1) edgeBad++;
    } else {
      if (d > offEdgeMax) offEdgeMax = d;
      if (d > 1) offEdgeBad++;
    }
  }
  // Worst off-edge offenders with coordinates + both colors, for debugging
  const worst: Array<{ x: number; y: number; d: number; cpu: number[]; gpu: number[] }> = [];
  for (let p = 0; p < W * H; p++) {
    if (mask[p]) continue;
    const i = p * 4;
    const d = Math.max(
      Math.abs(cpu[i] - gpu[i]),
      Math.abs(cpu[i + 1] - gpu[i + 1]),
      Math.abs(cpu[i + 2] - gpu[i + 2]),
    );
    if (d > 1) {
      worst.push({ x: p % W, y: (p / W) | 0, d, cpu: [cpu[i], cpu[i + 1], cpu[i + 2]], gpu: [gpu[i], gpu[i + 1], gpu[i + 2]] });
    }
  }
  worst.sort((a, b) => b.d - a.d);
  return {
    name, maxDelta, offEdgeMax, offEdgeBad, edgeBad, edgePixels,
    pixels: W * H,
    pass: offEdgeBad === 0,
    worst: worst.slice(0, 8),
  };
}

function showPair(name: string, cpu: Uint8ClampedArray, gpu: Uint8ClampedArray) {
  // Amplified diff (×8) as a third panel
  const diff = new Uint8ClampedArray(W * H * 4);
  for (let p = 0; p < W * H; p++) {
    const i = p * 4;
    diff[i] = Math.min(255, Math.abs(cpu[i] - gpu[i]) * 8);
    diff[i + 1] = Math.min(255, Math.abs(cpu[i + 1] - gpu[i + 1]) * 8);
    diff[i + 2] = Math.min(255, Math.abs(cpu[i + 2] - gpu[i + 2]) * 8);
    diff[i + 3] = 255;
  }
  const wrap = document.createElement('div');
  wrap.className = 'pair';
  const label = document.createElement('span');
  label.textContent = name;
  for (const buf of [cpu, gpu, diff]) {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(buf), W, H), 0, 0);
    wrap.appendChild(c);
  }
  wrap.appendChild(label);
  document.getElementById('pairs')!.appendChild(wrap);
}

// Console bisection helpers: render an arbitrary case on both paths and diff
(window as any).__parityDebug = {
  createEngine, createGlPreview, CASES, W, H,
  sampleLineDirs, sampleCircleDirs, distributions, toSRGB8,
  check(scene: Scene, lights: Light[]) {
    const engine = createEngine(W, H, scene, lights);
    engine.commit();
    engine.beginFrame();
    const cpu = new Uint8ClampedArray(W * H * 4);
    engine.renderPass(cpu, 1);
    const glp = createGlPreview(W, H, { preserveDrawingBuffer: true })!;
    glp.draw(scene, lights);
    const gpu = glp.readPixels();
    glp.dispose();
    return compare('probe', scene, cpu, gpu);
  },
};

async function run() {
  const results: CaseResult[] = [];
  const glp = createGlPreview(W, H, { preserveDrawingBuffer: true });
  if (!glp) {
    document.getElementById('status')!.textContent = 'FAIL: WebGL2 unavailable';
    (window as any).__parity = { done: true, error: 'webgl2 unavailable', results };
    return;
  }
  for (const c of CASES) {
    const engine = createEngine(W, H, c.scene, c.lights);
    engine.commit();
    engine.beginFrame();
    const cpu = new Uint8ClampedArray(W * H * 4);
    engine.renderPass(cpu, 1);
    glp.draw(c.scene, c.lights);
    const gpu = glp.readPixels();
    results.push(compare(c.name, c.scene, cpu, gpu));
    showPair(c.name, cpu, gpu);
    await new Promise(r => setTimeout(r));
  }
  const allPass = results.every(r => r.pass);
  const table = document.getElementById('results')!;
  table.innerHTML = '<tr><th>scene</th><th>max Δ</th><th>off-edge max Δ</th><th>off-edge Δ>1</th><th>edge Δ>1</th><th>edge px</th><th>verdict</th></tr>' +
    results.map(r =>
      `<tr><td>${r.name}</td><td>${r.maxDelta}</td><td>${r.offEdgeMax}</td><td>${r.offEdgeBad}</td><td>${r.edgeBad} / ${r.edgePixels}</td><td>${(100 * r.edgePixels / r.pixels).toFixed(1)}%</td><td class="${r.pass ? 'pass' : 'fail'}">${r.pass ? 'PASS' : 'FAIL'}</td></tr>`
    ).join('');
  const status = document.getElementById('status')!;
  status.textContent = allPass ? `PASS — ${results.length} scenes` : 'FAIL';
  status.className = allPass ? 'pass' : 'fail';
  (window as any).__parity = { done: true, allPass, results };
  console.log('[parity]', allPass ? 'PASS' : 'FAIL', JSON.stringify(results));
}

run();
