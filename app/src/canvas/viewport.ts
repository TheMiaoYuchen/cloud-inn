export interface ViewportSize {
  width: number;
  height: number;
  resolution: number;
}

export interface ViewportPoint {
  x: number;
  y: number;
}

export interface ViewportTransform extends ViewportPoint {
  scale: number;
}

export interface ViewportBounds {
  width: number;
  height: number;
}

const MIN_FLOW_SCALE = 0.5;
const MAX_FLOW_SCALE = 3;

export function fitViewport(
  width: number,
  height: number,
  devicePixelRatio: number,
): ViewportSize {
  return {
    width: Math.max(1, Math.floor(width)),
    height: Math.max(1, Math.floor(height)),
    resolution: Math.min(2, Math.max(1, devicePixelRatio)),
  };
}

export function clampViewportTransform(
  transform: ViewportTransform,
  viewport: ViewportBounds,
  world: ViewportBounds,
): ViewportTransform {
  const scale = Math.min(MAX_FLOW_SCALE, Math.max(MIN_FLOW_SCALE, transform.scale));
  return {
    x: Math.min(viewport.width, Math.max(viewport.width - world.width * scale, transform.x)),
    y: Math.min(viewport.height, Math.max(viewport.height - world.height * scale, transform.y)),
    scale,
  };
}

export function pointInViewport(
  point: ViewportPoint,
  transform: ViewportTransform,
  viewport: ViewportBounds,
  padding = 0,
): boolean {
  const screenX = point.x * transform.scale + transform.x;
  const screenY = point.y * transform.scale + transform.y;
  return screenX >= -padding && screenX <= viewport.width + padding
    && screenY >= -padding && screenY <= viewport.height + padding;
}
