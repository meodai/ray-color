// ray-color/view/software — registers <ray-color-view> with the f64 CPU
// renderer only. No WebGL2 preview, no shader source in the bundle.
import { defineRayColorView } from './view/element';

export { RayColorViewElement, RayColorLightElement, RayColorShapeElement, defineRayColorView } from './view/element';
export { ViewCore } from './view/core';
export type { ViewCoreOptions, SampleMode, SpacingName, SurfaceShape, ShapeInit, InputKind, GlFactory } from './view/core';

defineRayColorView(null);
