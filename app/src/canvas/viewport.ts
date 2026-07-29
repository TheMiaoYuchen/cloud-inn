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

function clampAxis(offset: number, viewportSize: number, scaledWorldSize: number): number {
  if (scaledWorldSize <= viewportSize) return (viewportSize - scaledWorldSize) / 2;
  return Math.min(0, Math.max(viewportSize - scaledWorldSize, offset));
}

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
    x: clampAxis(transform.x, viewport.width, world.width * scale),
    y: clampAxis(transform.y, viewport.height, world.height * scale),
    scale,
  };
}

export function initialViewportTransform(
  viewport: ViewportBounds,
  world: ViewportBounds,
): ViewportTransform {
  const fitScale = Math.min(
    viewport.width / Math.max(1, world.width),
    viewport.height / Math.max(1, world.height),
  );
  const scale = Math.min(MAX_FLOW_SCALE, Math.max(MIN_FLOW_SCALE, fitScale));
  return clampViewportTransform(
    {
      x: (viewport.width - world.width * scale) / 2,
      y: (viewport.height - world.height * scale) / 2,
      scale,
    },
    viewport,
    world,
  );
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
