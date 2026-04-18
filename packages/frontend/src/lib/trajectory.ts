export interface Point2D {
  x: number;
  y: number;
}

/**
 * Converts normalized coordinates (0-1) to pixel coordinates (e.g. for Canvas drawing)
 */
export function toCanvas(
  normalizedX: number,
  normalizedY: number,
  canvasWidth: number,
  canvasHeight: number,
): Point2D {
  return {
    x: normalizedX * canvasWidth,
    y: normalizedY * canvasHeight,
  };
}

/**
 * Converts pixel coordinates (e.g. from mouse click) to normalized coordinates (0-1)
 */
export function toNormalized(
  canvasX: number,
  canvasY: number,
  canvasWidth: number,
  canvasHeight: number,
): Point2D {
  return {
    x: canvasX / canvasWidth,
    y: canvasY / canvasHeight,
  };
}

export function findNearestPoint<T extends Point2D>(
  query: Point2D,
  points: T[],
  maxDistanceNormalized: number,
): T | null {
  const maxDistanceSquared = maxDistanceNormalized ** 2;
  let closest: T | null = null;
  let closestDistance = Number.POSITIVE_INFINITY;

  for (const point of points) {
    const dx = point.x - query.x;
    const dy = point.y - query.y;
    const distanceSquared = dx * dx + dy * dy;

    if (distanceSquared <= maxDistanceSquared && distanceSquared < closestDistance) {
      closest = point;
      closestDistance = distanceSquared;
    }
  }

  return closest;
}
