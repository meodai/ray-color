# Ray Color

[![npm version](https://img.shields.io/npm/v/ray-color)](https://www.npmjs.com/package/ray-color)
[![gzipped size](https://img.shields.io/bundlephobia/minzip/ray-color?label=gzipped)](https://bundlephobia.com/package/ray-color)
![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)

Generative color palettes from a raytraced scene — **edit the conditions, not the colors.**

## The tennis ball

This started with a Philips Hue setup and a tennis ball lying on the table.
Every time the room lights changed, the ball turned into a completely new
palette: a red key light here, a cold fill there, a little bounce from the
tabletop — same ball, new colors, and they always *fit together*, because they
were all made of the same light in the same room.

ray-color simulates that room. One sphere, a five-sided box, up to three
colored lights. Instead of picking colors from a wheel, you place lights and
sample points off the sphere's surface. The palette stays coherent for the
same reason the tennis ball's did: every color is the same world seen from a
different angle.

## The playground

`npm run dev` starts the interactive demo:

- **Realtime preview**: while you drag, frames come from a WebGL2 port of the
  engine's shading (~0.1 ms/frame); the moment you stop, the f64 CPU render
  lands, so the settled image — and everything you sample or export — keeps
  the engine's bit-exactness guarantees. Falls back to CPU-only rendering
  where WebGL2 is unavailable.
- **Presets**: complete lighting setups in the scene drawer, a starting point
  for your own.
- **Sample** by clicking the sphere, or drag a **line** / **circle** across it
  and sample N points along the shape (linear or smoothstep spacing).
- **Drag everything**: lights, sample points, shape handles — dragging past
  the silhouette rolls onto the back of the sphere like a trackball.
- The left drawer collects the palette with color names, exports (copy, PNG,
  token-beam) and a live code snippet that reproduces the current palette
  with the library.
- The right drawer holds scene and per-light controls, including an orbit
  globe to aim lights and mirror-wall reflectivity.

## The library

`src/engine.ts` is DOM-free: it renders into any `Uint8ClampedArray` and can
generate palettes headlessly, no canvas required. The whole engine is about
**6 kB gzipped** (ESM + CJS) with **zero runtime dependencies**.

Sampling colors is resolution-independent, so for palettes you can skip the
dimensions entirely; pass `createEngine(width, height, scene, lights)` when
you actually render pixels.

```ts
import {
  createEngine, sampleCircleDirs, distributions, toSRGB8,
} from 'ray-color';

const engine = createEngine(
  {
    cameraZ: -9, fov: 30, sphereRadius: 1.2,
    sphereHex: '#ffffff', wallHex: '#999999',
    indirect: 0.3, areaQuality: 6,
    wallReflect: { back: 0, left: 0, right: 0, top: 0, bottom: 0 },
  },
  [
    { type: 'directional', yaw: -150, pitch: 48, dist: 6, hex: '#ff0000', intensity: 0.95, angle: 30, size: 0.15 },
    { type: 'point', position: [2.5, -3, 1], hex: '#fff700', intensity: 0.3, yaw: 0, pitch: 0, dist: 0, angle: 30, size: 0.4 },
  ],
);
engine.commit();

// sample 5 colors along a circle drawn on the sphere's surface
const dirs = sampleCircleDirs([0, 0, -1], Math.asin(0.8), 5, distributions.smoothstep);
const palette = dirs.map(d => {
  const c = engine.shade(d); // linear RGB
  return '#' + [c.r, c.g, c.b].map(v => toSRGB8(v).toString(16).padStart(2, '0')).join('');
});
```

### The room

The sphere sits at the origin. The camera is on the negative z axis
(`cameraZ: -9`) looking toward +z. The room is a five-sided box with walls at
±2 world units — `left`/`right` on x, `top`/`bottom` on y, `back` at z = 2 —
and the front side (toward the camera) open, like a stage.

### Positioning lights: yaw/pitch/dist or XYZ

Lights orbit the sphere and can be parameterized two ways:

- **Spherical** — `yaw` and `pitch` in degrees plus `dist` in world units.
  Handy for UIs (that's what the orbit globe edits).
- **Cartesian** — set `position: [x, y, z]` and it takes precedence:
  `commit()` derives yaw/pitch/dist from it *and writes them back* onto the
  light, so both parameterizations always stay in sync. The usual distance
  clamp still applies — `dist` is kept within
  `[sphereRadius, MAX_LIGHT_DISTANCE]`, so a position inside the sphere is
  pushed out to its surface along the same direction.

`positionToAngles(x, y, z)` is exported if you want the conversion without an
engine.

### Shape sampling

`sampleLineDirs(a, b, count, opts)` walks the geodesic arc between two
surface directions; `sampleCircleDirs(center, rho, count, opts)` walks a
circle of angular radius `rho` around a center direction. `opts` is either a
`Distribution` — any `(t: number) => number` mapping over [0, 1] — or an
options object `{ spacing?, rotate? }`. `spacing` spaces the points
(`distributions.linear` and `distributions.smoothstep` ship with the
library); `rotate` rigidly spins the whole sample set about the shape's
central axis in degrees — around the ring for a circle, around the geodesic
midpoint for a line (so `rotate: 180` reverses a line's palette). Animate it
to sweep a shape across the sphere without touching its anchors.

The same motion is available for loose direction sets:
`rotateDirs(dirs, deg, center?)` rigidly spins any group of unit directions
about a center axis (in place). `center` defaults to the group's normalized
mean direction; a balanced group (zero mean) has no centroid, so pass an
explicit center there.

## The web component

The playground's whole viewport — renderer, light gizmos, shape editing,
rotation grips — ships as `<ray-color-view>`, so you can drop the same
controls next to your own work to debug a scene or harvest palettes:

```js
import 'ray-color/view';           // WebGL2 preview + f64 CPU renderer (auto fallback)
import 'ray-color/view/software';  // CPU only — no shader code in the bundle
```

```html
<ray-color-view controls mode="circle" count="7" fov="30" camera-z="-9">
  <ray-color-light hex="#ffaa00" yaw="40"  pitch="10" dist="4" intensity="1.2"></ray-color-light>
  <ray-color-light hex="#0066ff" yaw="-60" pitch="30" dist="5" intensity="0.8"></ray-color-light>
  <ray-color-shape kind="circle" a="0 0 -1" rho="0.93" rotate="0"></ray-color-shape>
</ray-color-view>
```

The children are two-way: edit an attribute (in devtools, or via a framework
binding) and the scene follows; drag the on-screen controls and the
attributes update on release — `outerHTML` is always a reproducible scene.
`input` fires continuously while dragging, `change` once per gesture,
`palettechange` whenever the sampled colors move (`e.detail.colors` is
`[{ hex, rgb }]`). Without children it boots with a default scene; properties
(`view.scene`, `view.lights`, `view.shape`) expose the live objects — mutate
and call `view.update()`, same contract as the engine. The playground itself
runs on this element.

Drop the `controls` attribute for a render-only view. `renderer="software"`
opts out of the WebGL2 preview at runtime; the interactive preview is f32 on
the GPU, but the settled frame and every sampled color always come from the
f64 CPU engine.

The overlay styling is themable through CSS custom properties on the element
(or any ancestor):

```css
ray-color-view {
  --rc-stroke: oklch(85% 0.2 200);  /* gizmo + shape strokes, rings, dots */
  --rc-stroke-back: rgba(255 255 255 / .2); /* faded through-the-sphere parts */
  --rc-casing: rgba(0 0 0 / .6);    /* contrast casing behind the strokes */
  --rc-stroke-width: 2px;
  --rc-casing-width: 4px;
}
```

`--bg` / `--text` flow in the same way for the handle chrome and canvas
frame.

### Mirror walls

`scene.wallReflect` sets per-wall reflectivity (0 matte … 1 mirror).
Reflective walls do two things: they visually mirror the sphere and room
(one bounce), and they act as **virtual light sources** — every light is
mirrored across each reflective panel and illuminates the sphere from that
direction, tinted by the wall color. That's the tabletop bouncing warm light
back onto the tennis ball.

### Guarantees

- **Deterministic** — the same scene always produces the same colors
  (area-light sampling uses a fixed golden-angle pattern, no RNG).
- **Linear-light** — all shading math happens in linear RGB; sRGB only at
  the 8-bit boundary (`toSRGB8`).
- **Sample = pixel** — a color from `shade(dir)` matches the rendered pixel
  it points at bit-for-bit.

## Development

```sh
npm install
npm run dev        # playground at localhost:5173
npm run build      # typecheck + bundle the playground
npm run build:lib  # bundle the library to lib/ (ESM + CJS + types)
```

The engine lives in `src/engine.ts`; the playground (`src/main.ts`,
`index.html`) is a thin consumer of its public API. Only the engine is
published — `build:lib` runs automatically before `npm publish`.

## License

[MIT](LICENSE) — except the sound effects in `public/sfx/`, which are
commercial sounds purchased on itch.io and not covered by this license
(see [public/sfx/README.md](public/sfx/README.md)).
