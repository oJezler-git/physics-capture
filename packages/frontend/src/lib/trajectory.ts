export interface Point2D {
  x: number;
  y: number;
}

/**
 * Convert frame pixel coordinates (image space) to canvas pixel coordinates (overlay space).
 */
export function toCanvas(
  frameX: number,
  frameY: number,
  imageWidth: number,
  imageHeight: number,
  canvasWidth: number,
  canvasHeight: number,
): Point2D {
  const scaleX = canvasWidth / imageWidth;
  const scaleY = canvasHeight / imageHeight;
  return {
    x: frameX * scaleX,
    y: frameY * scaleY,
  };
}

/**
 * Convert canvas pixel coordinates (overlay space) to frame pixel coordinates (image space).
 */
export function toFrame(
  canvasX: number,
  canvasY: number,
  imageWidth: number,
  imageHeight: number,
  canvasWidth: number,
  canvasHeight: number,
): Point2D {
  const scaleX = canvasWidth / imageWidth;
  const scaleY = canvasHeight / imageHeight;
  return {
    x: canvasX / scaleX,
    y: canvasY / scaleY,
  };
}

export function findNearestPoint<T extends Point2D>(
  query: Point2D,
  points: T[],
  maxDistancePx: number,
): T | null {
  const maxDistanceSquared = maxDistancePx ** 2;
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
