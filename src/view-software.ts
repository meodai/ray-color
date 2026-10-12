// ray-color/view/software — registers <ray-color-view> with the f64 CPU
// renderer only. No WebGL2 preview, no shader source in the bundle.
import { defineRayColorView } from './view/element.js';

export { RayColorViewElement, RayColorLightElement, RayColorShapeElement, defineRayColorView } from './view/element.js';
export { LIGHT_TYPE_ICONS } from './view/icons.js';
export type { PaletteColor, RayColorViewEventMap } from './view/element.js';
export type { SampleMode, SpacingName, SurfaceShape, ShapeInit, InputKind, GlFactory } from './view/core.js';

defineRayColorView(null);
