# ray-color

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
generate palettes headlessly, no canvas required.

```ts
import {
  createEngine, sampleCircleDirs, distributions, toSRGB8,
} from 'ray-color';

const engine = createEngine(400, 400,
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

`sampleLineDirs(a, b, count, spacing)` walks the geodesic arc between two
surface directions; `sampleCircleDirs(center, rho, count, spacing)` walks a
circle of angular radius `rho` around a center direction. Both take a
`Distribution` — any `(t: number) => number` mapping over [0, 1] — to space
the points; `distributions.linear` and `distributions.smoothstep` ship with
the library.

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
npm run dev      # playground at localhost:5173
npm run build    # typecheck + bundle
```

Not on npm yet — the engine lives in `src/engine.ts` and the playground
(`src/main.ts`, `index.html`) is a thin consumer of its public API.

## License

[MIT](LICENSE) — except the sound effects in `public/sfx/`, which are
commercial sounds purchased on itch.io and not covered by this license
(see [public/sfx/README.md](public/sfx/README.md)).
