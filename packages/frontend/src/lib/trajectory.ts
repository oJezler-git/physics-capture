export interface Point2D {
  x: number;
  y: number;
}

export function toCanvas(
  frameX: number,
  frameY: number,
  imageWidth: number,
  imageHeight: number,
  canvasWidth: number,
  canvasHeight: number,
): Point2D {
  return {
    x: frameX * (canvasWidth / imageWidth),
    y: frameY * (canvasHeight / imageHeight),
  };
}

export function toFrame(
  canvasX: number,
  canvasY: number,
  imageWidth: number,
  imageHeight: number,
  canvasWidth: number,
  canvasHeight: number,
): Point2D {
  return {
    x: canvasX / (canvasWidth / imageWidth),
    y: canvasY / (canvasHeight / imageHeight),
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
