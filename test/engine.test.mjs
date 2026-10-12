// Runs against the built package (npm test builds it first), so these check
// what actually ships.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  createEngine, sampleLineDirs, sampleCircleDirs, slerp, hexToRgb, toSRGB8, distributions, GLOW_ROWS,
} from '../lib/ray-color.js';

const W = 120, H = 90;

const makeScene = () => ({
  cameraZ: -9, fov: 30, sphereRadius: 1.2, sphereHex: '#ffffff', wallHex: '#999999',
  indirect: 0.3, areaQuality: 6,
  wallReflect: { back: 0.3, left: 0, right: 0.5, top: 0, bottom: 0.2 },
});
const makeLights = () => [
  { type: 'directional', yaw: -150, pitch: 48, dist: 6, hex: '#ff0000', intensity: 0.95, angle: 30, size: 0.15 },
  { type: 'area', yaw: 40, pitch: 10, dist: 4, hex: '#00ffb3', intensity: 1.2, angle: 30, size: 0.3 },
  { type: 'spot', yaw: -60, pitch: 30, dist: 5, hex: '#fff700', intensity: 2, angle: 25, size: 0 },
];

function render(engine, refine = true) {
  const buf = new Uint8ClampedArray(engine.width * engine.height * 4);
  const scales = [4, 2, 1];
  engine.beginFrame();
  scales.forEach((s, i) => engine.renderPass(buf, s, i ? scales[i - 1] : 0));
  if (refine) engine.refineEdges(buf);
  return buf;
}
const sha1 = buf => createHash('sha1').update(buf).digest('hex');
const hexOf = c => [c.r, c.g, c.b].map(v => toSRGB8(v).toString(16).padStart(2, '0')).join('');

test('rendering is deterministic and matches the reference frame', () => {
  const a = render(createEngine(W, H, makeScene(), makeLights()));
  const b = render(createEngine(W, H, makeScene(), makeLights()));
  assert.equal(sha1(a), sha1(b));
  // update deliberately when the shading model changes on purpose
  assert.equal(sha1(a), '0dba1dd7ae4236b633cbdc21305bce6366ed2e4d');
});

test('a sampled color matches its rendered pixel bit for bit', () => {
  const engine = createEngine(W, H, makeScene(), makeLights());
  const buf = render(engine, false);
  let checked = 0;
  for (let y = 0; y < H; y += 3) {
    for (let x = 0; x < W; x += 3) {
      const hit = engine.castRay(x, y);
      if (!hit) continue;
      const c = engine.shade([hit.nx, hit.ny, hit.nz]);
      const i = (y * W + x) * 4;
      assert.deepEqual([toSRGB8(c.r), toSRGB8(c.g), toSRGB8(c.b)], [buf[i], buf[i + 1], buf[i + 2]], `pixel ${x},${y}`);
      checked++;
    }
  }
  assert.ok(checked > 50);
});

test('palettes are deterministic and resolution independent', () => {
  const dirs = sampleCircleDirs([0, 0, -1], Math.asin(0.8), 7, { rotate: 20 });
  const a = createEngine(makeScene(), makeLights());
  const b = createEngine(37, 51, makeScene(), makeLights());
  assert.deepEqual(dirs.map(d => hexOf(a.shade(d))), dirs.map(d => hexOf(b.shade(d))));
});

test('createEngine commits, so shade works without an explicit commit()', () => {
  const engine = createEngine(makeScene(), makeLights());
  const c = engine.shade([0, 0, -1]);
  assert.ok(c.r + c.g + c.b > 0);
});

test('hex parsing accepts short and alpha forms and rejects junk', () => {
  const out = new Float32Array(3);
  const ref = Array.from(hexToRgb('#ffaa00', new Float32Array(3)));
  assert.deepEqual(Array.from(hexToRgb('#fa0', out)), ref);
  assert.deepEqual(Array.from(hexToRgb('fa0f', out)), ref);
  assert.deepEqual(Array.from(hexToRgb('#ffaa0080', out)), ref);
  for (const bad of ['', '#ff', '#ggg', 'red', '#fffff']) {
    assert.throws(() => hexToRgb(bad, out), TypeError, bad);
  }
  assert.throws(() => createEngine({ ...makeScene(), sphereHex: 'white' }, makeLights()), TypeError);
});

test('castRay returns null outside the canvas', () => {
  const engine = createEngine(W, H, makeScene(), makeLights());
  for (const [x, y] of [[-1, 10], [10, -1], [W, 10], [10, H], [NaN, 0]]) {
    assert.equal(engine.castRay(x, y), null, `${x},${y}`);
  }
  assert.ok(engine.castRay(W / 2, H / 2));
});

test('commit() alone picks up camera and radius changes', () => {
  const scene = makeScene();
  const engine = createEngine(W, H, scene, makeLights());
  render(engine);
  scene.cameraZ = -7;
  scene.sphereRadius = 1;
  engine.commit();
  const buf = new Uint8ClampedArray(W * H * 4);
  engine.renderPass(buf, 1);
  const fresh = new Uint8ClampedArray(W * H * 4);
  createEngine(W, H, { ...makeScene(), cameraZ: -7, sphereRadius: 1 }, makeLights()).renderPass(fresh, 1);
  assert.equal(sha1(buf), sha1(fresh));
});

test('changing the light count under an engine throws', () => {
  const lights = makeLights();
  const engine = createEngine(makeScene(), lights);
  lights.pop();
  assert.throws(() => engine.commit(), /3 lights, got 2/);
});

const unit = d => Math.abs(Math.hypot(d[0], d[1], d[2]) - 1) < 1e-9;

test('a line between antipodal directions stays on the sphere', () => {
  const dirs = sampleLineDirs([0, 0, -1], [0, 0, 1], 5);
  assert.ok(dirs.every(unit));
  assert.ok(Array.from(slerp([1, 0, 0], [-1, 0, 0], 0.5)).every(Number.isFinite));
});

test('circle samples move continuously as the center nears a pole', () => {
  let prev = null;
  for (let y = 0.98; y < 0.9999; y += 0.0001) {
    const [d] = sampleCircleDirs([0, y, Math.sqrt(1 - y * y)], 0.5, 4);
    if (prev) assert.ok(Math.hypot(d[0] - prev[0], d[1] - prev[1], d[2] - prev[2]) < 0.05, `jump at y=${y}`);
    prev = d;
  }
});

test('samplers return exactly count directions', () => {
  for (const n of [0, 1, 2, 7]) {
    assert.equal(sampleLineDirs([0, 0, -1], [1, 0, 0], n, distributions.smoothstep).length, n);
    assert.equal(sampleCircleDirs([0, 0, -1], 0.5, n).length, n);
  }
  const [mid] = sampleLineDirs([0, 0, -1], [1, 0, 0], 1);
  assert.deepEqual(Array.from(mid), Array.from(slerp([0, 0, -1], [1, 0, 0], 0.5)));
});

test('the view entries import without a DOM', async () => {
  for (const entry of ['view', 'view-software', 'view-webgl']) {
    const mod = await import(`../lib/${entry}.js`);
    assert.equal(typeof mod.defineRayColorView, 'function');
  }
});

const bloomScene = () => ({ ...makeScene(), bloom: { strength: 1.2, threshold: 0.6 } });
const hotLights = () => makeLights().map(l => ({ ...l, intensity: l.intensity * 6 }));

test('bloom changes the palette, deterministically and at any resolution', () => {
  const dirs = sampleCircleDirs([0, 0, -1], 0.9, 7);
  const glowing = dirs.map(d => hexOf(createEngine(bloomScene(), hotLights()).shade(d)));
  const plain = dirs.map(d => hexOf(createEngine(makeScene(), hotLights()).shade(d)));
  const other = createEngine(97, 97, bloomScene(), hotLights());
  assert.notDeepEqual(glowing, plain);
  assert.deepEqual(glowing, dirs.map(d => hexOf(other.shade(d))));
});

test('with bloom, a sampled color still matches its rendered pixel', () => {
  const engine = createEngine(W, H, bloomScene(), hotLights());
  const buf = render(engine, false);
  for (let y = 0; y < H; y += 3) {
    for (let x = 0; x < W; x += 3) {
      const hit = engine.castRay(x, y);
      if (!hit) continue;
      const c = engine.shade([hit.nx, hit.ny, hit.nz]);
      const i = (y * W + x) * 4;
      assert.deepEqual([toSRGB8(c.r), toSRGB8(c.g), toSRGB8(c.b)], [buf[i], buf[i + 1], buf[i + 2]], `pixel ${x},${y}`);
    }
  }
});

test('bloom leaves points on the hidden side of the sphere alone', () => {
  const back = [0, 0, 1];
  const a = createEngine(bloomScene(), hotLights()).shade(back);
  const b = createEngine(makeScene(), hotLights()).shade(back);
  assert.deepEqual({ ...a }, { ...b });
});

test('glow() is null without bloom and a grid of GLOW_ROWS rows with it', () => {
  assert.equal(createEngine(makeScene(), makeLights()).glow(), null);
  const g = createEngine(200, 100, bloomScene(), hotLights()).glow();
  assert.equal(g.height, GLOW_ROWS);
  assert.equal(g.width, GLOW_ROWS * 2);
  assert.equal(g.data.length, g.width * g.height * 3);
});

test('row bands from separate engines stitch into exactly the renderPass() frame', () => {
  const scene = { ...makeScene(), bloom: { strength: 1, threshold: 0.5 } };
  const full = createEngine(W, H, scene, makeLights());
  const a = new Uint8ClampedArray(W * H * 4);
  full.beginFrame();
  full.renderPass(a, 1);
  const b = new Uint8ClampedArray(W * H * 4);
  const cuts = [0, 1, 30, 31, 64, H];
  for (let k = 0; k < cuts.length - 1; k++) {
    const band = new Uint8ClampedArray((cuts[k + 1] - cuts[k]) * W * 4);
    createEngine(W, H, structuredClone(scene), makeLights()).renderRows(band, cuts[k], cuts[k + 1]);
    b.set(band, cuts[k] * W * 4);
  }
  assert.equal(sha1(b), sha1(a));
});
