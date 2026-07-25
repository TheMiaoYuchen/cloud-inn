export interface ViewportSize {
  width: number;
  height: number;
  resolution: number;
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
