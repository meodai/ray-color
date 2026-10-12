/// <reference types="vite/client" />
// Splits the settled CPU frame into row bands rendered by a pool of workers.
// The engine is deterministic and shades every pixel independently, so the
// stitched frame is exactly what one engine would render on the main thread.
// Inlined so the package needs no separate worker file or bundler setup.
import RenderWorker from './render-worker?worker&inline';
import type { Scene, Light } from '../engine.js';

export interface BandJob {
  frame: number;
  width: number;
  height: number;
  scene: Scene;
  lights: Light[];
  y0: number;
  y1: number;
}

export interface BandResult {
  frame: number;
  y0: number;
  band: Uint8ClampedArray;
}

export type PoolOutcome = 'done' | 'superseded' | 'failed';

// Several bands per worker: the sphere rows cost far more than the wall-only
// rows, so small bands handed out on demand keep every worker busy
const BANDS_PER_WORKER = 4;

interface FrameState {
  frame: number;
  out: Uint8ClampedArray;
  width: number;
  queue: BandJob[];
  pending: number;
  resolve: (outcome: PoolOutcome) => void;
}

export class RenderPool {
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private current: FrameState | null = null;
  private frame = 0;
  private broken = false;

  /** Null where workers are unavailable (no Worker, or a CSP that blocks
   * blob workers); callers then render on the main thread. */
  static create(): RenderPool | null {
    if (typeof Worker === 'undefined') return null;
    const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
    try {
      return new RenderPool(Math.min(8, Math.max(1, cores - 1)));
    } catch {
      return null;
    }
  }

  private constructor(count: number) {
    for (let i = 0; i < count; i++) {
      const w = new RenderWorker();
      w.onmessage = (e: MessageEvent<BandResult>) => this.onBand(w, e.data);
      w.onerror = () => this.fail();
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  /** Render the whole frame into `out` (width*height*4). A newer call
   * supersedes this one, which then resolves 'superseded'. */
  render(width: number, height: number, scene: Scene, lights: Light[], out: Uint8ClampedArray): Promise<PoolOutcome> {
    if (this.broken) return Promise.resolve('failed');
    this.current?.resolve('superseded');
    const frame = ++this.frame;
    // bands go out over time; every one must see the scene as it was now
    scene = structuredClone(scene);
    lights = structuredClone(lights);
    const bands = Math.min(height, this.workers.length * BANDS_PER_WORKER);
    const queue: BandJob[] = [];
    for (let k = 0; k < bands; k++) {
      const y0 = Math.floor(k * height / bands), y1 = Math.floor((k + 1) * height / bands);
      if (y1 > y0) queue.push({ frame, width, height, scene, lights, y0, y1 });
    }
    return new Promise(resolve => {
      this.current = { frame, out, width, queue, pending: queue.length, resolve };
      while (this.idle.length && queue.length) this.idle.pop()!.postMessage(queue.shift());
    });
  }

  private onBand(worker: Worker, r: BandResult) {
    const cur = this.current;
    if (cur && r.frame === cur.frame) {
      cur.out.set(r.band, r.y0 * cur.width * 4);
      if (--cur.pending === 0) {
        this.current = null;
        cur.resolve('done');
      }
    }
    // stale bands from a superseded frame just free the worker
    const next = this.current?.queue.shift();
    if (next) worker.postMessage(next);
    else this.idle.push(worker);
  }

  /** Drop the frame in flight; bands already rendering finish unused. */
  cancel() {
    this.current?.resolve('superseded');
    this.current = null;
  }

  private fail() {
    this.broken = true;
    this.current?.resolve('failed');
    this.current = null;
  }

  dispose() {
    for (const w of this.workers) w.terminate();
    this.workers.length = this.idle.length = 0;
    this.current?.resolve('superseded');
    this.current = null;
  }
}
