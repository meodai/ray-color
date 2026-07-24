// Scene presets — shared between the playground (settings drawer) and the
// CPU/GL parity harness (parity.html), which uses them as its test scenes:
// together they cover every light type, mirror walls, heavy indirect, high
// area-sample counts and occlusion.
//
// Apply with copies (structuredClone) — the engine mutates scene and lights.

import type { Scene, Light } from './engine';

export interface ScenePreset {
  name: string;
  scene: Scene;
  lights: Light[];
}

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

const light = (over: Partial<Light>): Light => ({
  type: 'directional',
  yaw: -150, pitch: 48, dist: 6,
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
  },
  {
    name: 'Mixed fixtures',
    scene: baseScene(),
    lights: [
      light({ type: 'point', yaw: 20, pitch: 30, dist: 4, hex: '#88aaff', intensity: 6 }),
      light({ type: 'spot', yaw: -100, pitch: 10, dist: 5, hex: '#ffaa00', intensity: 8, angle: 22 }),
      light({ type: 'area', yaw: -170, pitch: -30, dist: 3, hex: '#ff4488', intensity: 4, size: 0.6 }),
    ],
  },
  {
    name: 'Mirror box',
    scene: { ...baseScene(), wallHex: '#bb8866', wallReflect: { back: 0.8, left: 0.5, right: 0, top: 0.25, bottom: 1 } },
    lights: [
      light({ type: 'point', yaw: 45, pitch: 45, dist: 4, hex: '#ffffff', intensity: 8 }),
      light({ type: 'point', yaw: -140, pitch: -20, dist: 3, hex: '#00ffcc', intensity: 3 }),
      light({ type: 'directional', yaw: 10, pitch: -60, hex: '#3355ff', intensity: 0.5 }),
    ],
  },
  {
    name: 'Blue hour',
    scene: { ...baseScene(), indirect: 1, wallHex: '#4488cc', sphereHex: '#ffddaa' },
    lights: [
      light({ type: 'spot', yaw: 60, pitch: 50, dist: 6, hex: '#ffffff', intensity: 20, angle: 35 }),
      light({ type: 'area', yaw: -60, pitch: -45, dist: 4, hex: '#ff2200', intensity: 5, size: 0.9 }),
      light({ type: 'point', yaw: 170, pitch: 0, dist: 5, hex: '#22ff66', intensity: 2 }),
    ],
  },
  {
    name: 'Full house',
    scene: { ...baseScene(), areaQuality: 16, indirect: 0.7, fov: 45, sphereRadius: 1.5, cameraZ: -7, wallHex: '#778899', wallReflect: { back: 0.4, left: 0.4, right: 0.4, top: 0.4, bottom: 0.4 } },
    lights: [
      light({ type: 'area', yaw: 100, pitch: 60, dist: 5, hex: '#ffee88', intensity: 10, size: 1.2 }),
      light({ type: 'spot', yaw: -30, pitch: -10, dist: 6, hex: '#8844ff', intensity: 12, angle: 18 }),
      light({ type: 'directional', yaw: -90, pitch: 20, hex: '#00aaff', intensity: 0.4 }),
    ],
  },
  {
    name: 'Eclipse',
    scene: baseScene(),
    lights: [
      light({ type: 'point', yaw: 90, pitch: 0, dist: 4, hex: '#ffffff', intensity: 10 }),
      light({ type: 'point', yaw: 90, pitch: 5, dist: 1.3, hex: '#ff0000', intensity: 4 }),
      light({ type: 'directional', yaw: 90, pitch: 0, hex: '#00ff00', intensity: 0.8 }),
    ],
  },
];
