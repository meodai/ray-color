// Shadow-DOM stylesheet for <ray-color-view> — the viewport styles that used
// to live in the playground's style.css, scoped to the component. Theme hooks:
// the host page can set --bg / --text (and --s-line) and they flow through;
// without them the component falls back to its own light-dark pair.
export const VIEW_STYLES = `
:host {
  display: block;
  width: 100%;
  --rcv-white: #fff;
  --rcv-bg: var(--bg, light-dark(#fff, #292f2f));
  --rcv-text: var(--text, light-dark(#292f2f, #fff));
  --rcv-line: var(--s-line, 1px);
  /* Overlay theming — set these on the element (or any ancestor) to restyle
     the gizmo and shape strokes without touching the component:
       --rc-stroke         main stroke color (paths, rings, dots)
       --rc-stroke-back    the faded through-the-sphere portions
       --rc-casing         contrast casing behind the main strokes
       --rc-stroke-width   main stroke width
       --rc-casing-width   casing stroke width */
  --rcv-stroke: var(--rc-stroke, rgba(255, 255, 255, 0.9));
  --rcv-stroke-back: var(--rc-stroke-back, rgba(255, 255, 255, 0.25));
  --rcv-casing: var(--rc-casing, rgba(0, 0, 0, 0.5));
  --rcv-stroke-width: var(--rc-stroke-width, 1.5px);
  --rcv-casing-width: var(--rc-casing-width, 3px);
}

.viewport {
  position: relative;
  width: 100%;
  touch-action: none;
  -webkit-user-select: none;
  user-select: none;
  -webkit-touch-callout: none;
}

.render-canvas {
  position: relative;
  z-index: 1;
  display: block;
  width: 100%;
  border: var(--rcv-line) solid var(--rcv-text);
  image-rendering: auto;
}

/* WebGL2 preview overlay: covers the render canvas exactly while interacting;
   hidden once the settled CPU render lands, so the frame at rest is always
   the f64 one. */
.gl-canvas {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 1; /* above the render canvas via DOM order, below the overlays */
  display: block;
  width: 100%;
  border: var(--rcv-line) solid var(--rcv-text);
  pointer-events: none;
}

.gl-canvas:not(.gl-visible) {
  display: none;
}

.gizmo {
  position: absolute;
  inset: 0;
  /* above the shape svg; the marker/handle layers (same z, later in DOM) stay on top */
  z-index: 3;
  width: 100%;
  height: 100%;
  pointer-events: none;
  overflow: visible; /* keep rotation arcs usable for edge-clamped lights */
}

.shape-svg {
  position: absolute;
  inset: 0;
  z-index: 2;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.shape-handles {
  position: absolute;
  inset: 0;
  z-index: 3;
  pointer-events: none;
}

.shape-path-casing {
  fill: none;
  stroke: var(--rcv-casing);
  stroke-width: var(--rcv-casing-width);
  stroke-linecap: round;
}

.shape-path {
  fill: none;
  stroke: var(--rcv-stroke);
  stroke-width: var(--rcv-stroke-width);
  stroke-linecap: round;
}

.shape-path--back {
  stroke: var(--rcv-stroke-back);
  stroke-width: calc(var(--rcv-stroke-width) * 0.67);
  stroke-dasharray: 2 4;
}

.shape-dot {
  stroke: var(--rcv-stroke);
  stroke-width: calc(var(--rcv-stroke-width) * 0.67);
  paint-order: stroke;
}

/* the dark separator ring outside each dot's white ring (same role as the
   path casing) — wide enough to peek ~1.5px past the white stroke */
.shape-dot-casing {
  fill: none;
  stroke: var(--rcv-casing);
  stroke-width: calc(var(--rcv-stroke-width) * 0.67 + 1.5px);
}

.shape-dot--back {
  opacity: .3;
}

.shape-handle {
  position: absolute;
  width: .65rem;
  height: .65rem;
  border-radius: 0; /* square = editable geometry, round = color sample */
  background: var(--rcv-bg);
  pointer-events: auto;
  cursor: grab;
  box-shadow:
    inset 0 0 0 1.5px var(--rcv-white),
    inset 0 0 0 3px rgba(0, 0, 0, 0.55);
}

/* Generous invisible hit area around each handle */
.shape-handle::after {
  content: '';
  position: absolute;
  inset: -8px;
}

.shape-handle:active {
  cursor: grabbing;
}

.shape-handle--grip {
  border-radius: 50%;
  width: .55rem;
  height: .55rem;
}

.shape-handle--rot {
  width: .4rem;
  height: .4rem;
}

.shape-handle--behind {
  opacity: .45;
}

.light-layer,
.sample-layer {
  position: absolute;
  inset: 0;
  z-index: 3;
  pointer-events: none;
}

.gizmo-line-casing {
  fill: none;
  stroke: var(--rcv-casing);
  stroke-width: var(--rcv-casing-width);
  stroke-linecap: round;
}

.gizmo-line {
  fill: none;
  stroke: var(--rcv-stroke);
  stroke-width: calc(var(--rcv-stroke-width) * 0.67);
  stroke-dasharray: 4 3;
  stroke-linecap: round;
}

.gizmo-line--hidden {
  fill: none;
  stroke: var(--rcv-stroke-back);
  stroke-width: calc(var(--rcv-stroke-width) * 0.67);
  stroke-dasharray: 2 4;
}

.gizmo-area {
  fill: none;
  stroke: var(--rcv-stroke);
  stroke-dasharray: 3 3;
}

/* light editing wins pointer priority over the shape handles */
.viewport.light-editing .gizmo,
.viewport.light-editing .light-layer {
  z-index: 4;
}

/* while a light's orbit gizmos are up, the shape keeps only its control
   points and color dots — the connecting strokes get out of the way */
.shape-svg .shape-path,
.shape-svg .shape-path-casing,
.shape-svg .shape-path--back {
  transition: opacity 0.15s linear;
}

.viewport.light-editing .shape-svg .shape-path,
.viewport.light-editing .shape-svg .shape-path-casing,
.viewport.light-editing .shape-svg .shape-path--back {
  opacity: 0;
}

/* same for the loose points' rotation ring — only the samples themselves stay */
.samples-rot {
  transition: opacity 0.15s linear;
}

.viewport.light-editing .samples-rot {
  opacity: 0;
  pointer-events: none;
}

/* Invisible wide twin of each orbit ring: the grabbable part */
.gizmo-orbit-hit {
  fill: none;
  stroke: transparent;
  stroke-width: 16;
  cursor: grab;
  touch-action: none;
}

.gizmo-orbit-hit:active {
  cursor: grabbing;
}

.marker {
  position: absolute;
  pointer-events: none;
  transform: translate(-50%, -50%) scale(calc(.35 + var(--scale, 1) * .65));
  border-radius: 50%;
}

.light-marker {
  width: .7rem;
  height: .7rem;
  pointer-events: auto;
  cursor: grab;
  touch-action: none;
  box-shadow:
    0 0 0 1.5px var(--rcv-white),
    0 0 0 2.5px rgba(0, 0, 0, 0.4);
}

.light-marker:active {
  cursor: grabbing;
}

.light-marker--directional {
  border-radius: 0;
  transform: translate(-50%, -50%) rotate(45deg) scale(calc(.35 + var(--scale, 1) * .65));
}

.marker--offscreen {
  opacity: .55;
}

/* Centroid of loose sample points: dashed ring with a knob dot riding it —
   drag anywhere on it to spin the whole constellation */
.samples-rot {
  width: 1.15rem;
  height: 1.15rem;
  border: 1.5px dashed var(--rcv-white);
  background: transparent;
  pointer-events: auto;
  cursor: grab;
  transform: translate(-50%, -50%) rotate(var(--spin, 0deg));
  filter: drop-shadow(0 0 1px rgba(0, 0, 0, .6));
}

.samples-rot::before {
  content: '';
  position: absolute;
  inset: -8px;
}

.samples-rot::after {
  content: '';
  position: absolute;
  top: -0.15rem;
  left: 50%;
  width: .3rem;
  height: .3rem;
  margin-left: -0.15rem;
  border-radius: 50%;
  background: var(--rcv-white);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, .35);
}

.samples-rot:active {
  cursor: grabbing;
}

.samples-rot[hidden] {
  display: none;
}

/* Little chevrons flanking the intensity grip along its radial axis —
   they read as "drag in / out" */
.light-chev {
  position: absolute;
  top: 50%;
  left: 50%;
  width: .18rem;
  height: .18rem;
  border-top: 1px solid var(--rcv-white);
  border-right: 1px solid var(--rcv-white);
  pointer-events: none;
  filter: drop-shadow(0 0 1px rgba(0, 0, 0, .55));
}

.light-chev--out {
  transform: translate(-50%, -50%) rotate(var(--ga, 0deg)) translateX(.55rem) rotate(45deg);
}

.light-chev--in {
  transform: translate(-50%, -50%) rotate(var(--ga, 0deg)) translateX(-.55rem) rotate(-135deg);
}

/* Circular light menu: round cells riding the intensity ring opposite the
   grip — same double-outline language as the markers */
.light-ctrl {
  position: absolute;
  width: 1.1rem;
  height: 1.1rem;
  border-radius: 50%;
  transform: translate(-50%, -50%);
  pointer-events: auto;
  cursor: pointer;
  background: var(--rcv-bg);
  color: var(--rcv-text);
  box-shadow:
    0 0 0 1.5px var(--rcv-white),
    0 0 0 2.5px rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform 0.15s cubic-bezier(0.3, 0.7, 0, 1);
}

.light-ctrl:hover {
  transform: translate(-50%, -50%) scale(1.18);
}

/* generous invisible hit area, like the shape handles */
.light-ctrl::before {
  content: '';
  position: absolute;
  inset: -6px;
  border-radius: 50%;
}

.light-ctrl svg {
  width: 0.75rem;
  height: 0.75rem;
  display: block;
  pointer-events: none;
}

/* the native dropdown opens from an invisible select covering the cell */
.light-ctrl__select {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  cursor: pointer;
  appearance: none;
  border: 0;
  padding: 0;
}

/* invisible anchor for the native color picker */
.light-color-input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  border: 0;
  padding: 0;
  pointer-events: none;
}

/* Hollow ring: the light sits behind the sphere */
.light-marker--occluded {
  background: transparent;
  border: 2px solid;
  opacity: .85;
}

.marker--selected {
  box-shadow:
    0 0 0 1.5px var(--rcv-white),
    0 0 0 2.5px rgba(0, 0, 0, 0.4),
    0 0 0 5px rgba(255, 255, 255, 0.35);
}

/* .marker's blanket pointer-events: none is written after .shape-handle's
   auto and was silently winning — restate it here, after the base rule */
.marker.shape-handle {
  pointer-events: auto;
}

.sample-marker {
  width: .6rem;
  height: .6rem;
  pointer-events: auto;
  cursor: grab;
  touch-action: none;
  box-shadow:
    inset 0 0 0 1px var(--rcv-white),
    0 0 0 1px rgba(0, 0, 0, 0.4);
}

.sample-marker:active {
  cursor: grabbing;
}

.marker--behind {
  opacity: .25;
  pointer-events: none;
}

/* Render-only mode: no gizmos, no interaction */
.viewport.no-controls .gizmo,
.viewport.no-controls .shape-svg,
.viewport.no-controls .shape-handles,
.viewport.no-controls .light-layer,
.viewport.no-controls .sample-layer {
  display: none;
}
`;
