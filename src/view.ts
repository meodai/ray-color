// ray-color/view — registers <ray-color-view> with both renderers: the
// WebGL2 preview fronts interaction, the f64 CPU engine lands the settled
// frame (and is always the one palettes sample from). Machines without
// WebGL2 fall back to CPU-only automatically; renderer="software" opts out.
import { createGlPreview } from './gl-preview';
import { defineRayColorView } from './view/element';

export { RayColorViewElement, RayColorLightElement, RayColorShapeElement, defineRayColorView } from './view/element';
export { ViewCore } from './view/core';
export { LIGHT_TYPE_ICONS } from './view/icons';
export type { ViewCoreOptions, SampleMode, SpacingName, SurfaceShape, ShapeInit, InputKind, GlFactory } from './view/core';

defineRayColorView(createGlPreview);
