// Light-type icons, shared by the viewport's circular light menu and any
// host chrome (the playground's control rail reuses them). Stroke/fill
// follow currentColor so they can be tinted.
export const LIGHT_TYPE_ICONS: Record<string, string> = {
  point: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2" fill="currentColor"/><path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3M3.4 3.4l2.1 2.1M10.5 10.5l2.1 2.1M12.6 3.4l-2.1 2.1M5.5 10.5l-2.1 2.1" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/></svg>',
  area: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="5" cy="8" r="3.4" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.5 4.5l2.3-1.4M11.3 8h3.2M10.5 11.5l2.3 1.4" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/></svg>',
  directional: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4h7M2 8h7M2 12h7" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/><path d="M9.5 2.4L14 4l-4.5 1.6zM9.5 6.4L14 8l-4.5 1.6zM9.5 10.4L14 12l-4.5 1.6z" fill="currentColor"/></svg>',
  spot: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 8L12 3.8M2.5 8L12 12.2" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/><ellipse cx="12.2" cy="8" rx="1.7" ry="4.3" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
};
