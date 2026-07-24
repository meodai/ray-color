// Scene presets — shared between the playground (settings drawer) and the
// CPU/GL parity harness (parity.html), which uses them as its test scenes:
// together they cover every light type, mirror walls, heavy indirect, high
// area-sample counts and occlusion.
//
// Apply with copies (structuredClone) — the engine mutates scene and lights.

import type { Scene, Light } from './engine';

/** Sampling shape shipped with a preset, chosen so the palette it produces
 * reads well immediately. Directions are unit vectors on the sphere; lines
 * pair with smoothstep spacing, circles with linear. */
export interface PresetShape {
  kind: 'line' | 'circle';
  a: [number, number, number];
  b?: [number, number, number]; // line end
  rho?: number;                 // circle angular radius (radians)
  count: number;
  spacing?: 'linear' | 'smoothstep';
}

export interface ScenePreset {
  name: string;
  scene: Scene;
  lights: Light[];
  shape: PresetShape;
}

const unit = (x: number, y: number, z: number): [number, number, number] => {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
};

const baseScene = (): Scene => ({
  cameraZ: -9,
  fov: 30,
  sphereRadius: 1.2,
  sphereHex: '#ffffff',
  wallHex: '#999999',
  indirect: 0.3,
  areaQuality: 6,
  wallReflect: { back: 0, left: 0, right: 0, top: 0, bottom: 0 },
});

// Distances keep every light's MARKER inside the view frustum (a directional
// light's dist is purely cosmetic — it only places the marker); point/spot/
// area intensities are scaled by dist² relative to their original authoring
// so the sphere reads the same.
const light = (over: Partial<Light>): Light => ({
  type: 'directional',
  yaw: -150, pitch: 48, dist: 2,
  hex: '#ff0000', intensity: 0.95, angle: 30, size: 0.15,
  ...over,
});

export const PRESETS: ScenePreset[] = [
  {
    name: 'Tricolor studio',
    scene: baseScene(),
    lights: [
      light({}),
      light({ yaw: -125, pitch: -40, hex: '#fff700', intensity: 0.3 }),
      light({ yaw: -39, pitch: -35, hex: '#00ffb3', intensity: 0.2 }),
    ],
    // The playground's own default circle
    shape: { kind: 'circle', a: [0, 0, -1], rho: Math.asin(0.8), count: 7 },
  },
  {
    name: 'Mixed fixtures',
    scene: baseScene(),
    lights: [
      light({ type: 'point', yaw: 20, pitch: 30, dist: 2.5, hex: '#88aaff', intensity: 2.3 }),
      light({ type: 'spot', yaw: -100, pitch: 10, dist: 5, hex: '#ffaa00', intensity: 8, angle: 22 }),
      light({ type: 'area', yaw: -170, pitch: -30, dist: 2.2, hex: '#ff4488', intensity: 2.2, size: 0.6 }),
    ],
    // Pink area glow into the blue point light: pink-gold-slate sweep
    shape: { kind: 'line', a: unit(-0.75, -0.45, -0.5), b: unit(0.7, 0.55, -0.45), count: 7, spacing: 'smoothstep' },
  },
  {
    name: 'Mirror box',
    // Hand-tuned in the playground (settings log): a full mirror room —
    // every wall at reflectivity 1 — which is also the harshest CPU/GL
    // parity case for mirrored-silhouette edges
    scene: { ...baseScene(), wallHex: '#b39784', wallReflect: { back: 1, left: 1, right: 1, top: 1, bottom: 1 } },
    lights: [
      light({ type: 'point', yaw: 45, pitch: 45, dist: 1.6, hex: '#ffffff', intensity: 4.5 }),
      light({ type: 'point', yaw: -140, pitch: -20, dist: 2.4, hex: '#ff8800', intensity: 1.9 }),
      light({ type: 'directional', yaw: 10, pitch: -60, hex: '#3355ff', intensity: 0.85 }),
    ],
    // Ring around the warm hot spot: salmon-sienna-plum-orchid-peach
    shape: { kind: 'circle', a: unit(-0.5, -0.15, -0.85), rho: 0.582, count: 7 },
  },
  {
    name: 'Blue hour',
    scene: { ...baseScene(), indirect: 1, wallHex: '#4488cc', sphereHex: '#ffddaa' },
    lights: [
      light({ type: 'spot', yaw: 60, pitch: 50, dist: 3, hex: '#ffffff', intensity: 5, angle: 35 }),
      light({ type: 'area', yaw: -60, pitch: -45, dist: 2.4, hex: '#ff2200', intensity: 1.8, size: 0.9 }),
      light({ type: 'point', yaw: 170, pitch: 0, dist: 2.2, hex: '#22ff66', intensity: 0.4 }),
    ],
    // Top rim (white spot) down to the red area pole: tan-oxblood-vermilion
    shape: { kind: 'line', a: unit(0.454, 0.891, -0.1), b: unit(0.354, -0.707, -0.612), count: 7, spacing: 'smoothstep' },
  },
  {
    name: 'Full house',
    scene: { ...baseScene(), areaQuality: 16, indirect: 0.7, fov: 45, sphereRadius: 1.5, cameraZ: -7, wallHex: '#778899', wallReflect: { back: 0.4, left: 0.4, right: 0.4, top: 0.4, bottom: 0.4 } },
    lights: [
      // Area light above the top wall (y > 2) — see Mirror box note
      light({ type: 'area', yaw: 100, pitch: 60, dist: 3.5, hex: '#ffee88', intensity: 4.9, size: 1.2 }),
      // Wider cone than the original dist-6 authoring: at dist 2.4 the
      // sphere subtends ~39°, so 40° keeps it fully covered
      light({ type: 'spot', yaw: -30, pitch: -10, dist: 2.4, hex: '#8844ff', intensity: 1.9, angle: 40 }),
      light({ type: 'directional', yaw: -90, pitch: 20, hex: '#00aaff', intensity: 0.4 }),
    ],
    // Off-center ring through the gold top light and violet spot wash
    shape: { kind: 'circle', a: unit(-0.1, 0.35, -0.93), rho: Math.asin(0.7), count: 7 },
  },
  {
    name: 'Eclipse',
    // The white point light behind the sphere blazes the walls into a halo
    // while the face stays dark; the two directionals sit just past the
    // silhouette (yaw 90° ± ~20°), so a red and a gold corona wrap onto the
    // visible rim — a point light can't do that (its lit cap ends acos(r/d)
    // short of the terminator), a directional wraps by exactly its yaw offset.
    scene: { ...baseScene(), indirect: 0.7 },
    lights: [
      light({ type: 'point', yaw: 90, pitch: 0, dist: 4, hex: '#ffffff', intensity: 10 }),
      light({ type: 'directional', yaw: 108, pitch: 10, hex: '#ff2200', intensity: 1.6 }),
      light({ type: 'directional', yaw: 70, pitch: -8, hex: '#ffcc66', intensity: 1.3 }),
    ],
    // Ring hugging the silhouette where the corona wraps around
    shape: { kind: 'circle', a: unit(0, 0.03, -1), rho: Math.asin(0.98), count: 9 },
  },
];
