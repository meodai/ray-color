// Renders row bands of the settled CPU frame off the main thread. Each worker
// keeps one engine and syncs it to the scene once per frame, so the bands of
// one frame share a single commit (and a single bloom rebuild).
import { createEngine, type Engine } from '../engine.js';
import type { BandJob, BandResult } from './render-pool.js';

let engine: Engine | null = null;
let syncedFrame = -1;

function replaceContents(target: object, source: object) {
  for (const k of Object.keys(target)) delete (target as Record<string, unknown>)[k];
  Object.assign(target, source);
}

self.onmessage = (e: MessageEvent<BandJob>) => {
  const { frame, width, height, scene, lights, y0, y1 } = e.data;
  if (!engine || engine.width !== width || engine.height !== height || engine.lights.length !== lights.length) {
    engine = createEngine(width, height, scene, lights);
  } else if (frame !== syncedFrame) {
    replaceContents(engine.scene, scene);
    lights.forEach((l, i) => replaceContents(engine!.lights[i], l));
    engine.commit();
  }
  syncedFrame = frame;
  const band = new Uint8ClampedArray((y1 - y0) * width * 4);
  engine.renderRows(band, y0, y1);
  const result: BandResult = { frame, y0, band };
  (self as unknown as Worker).postMessage(result, [band.buffer]);
};
