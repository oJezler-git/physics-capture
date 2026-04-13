import { findNearestPoint, toCanvas, toFrame } from './trajectory';

describe('trajectory coordinate helpers', () => {
  it('round-trips points through toCanvas/toFrame', () => {
    for (let index = 0; index < 100; index++) {
      const point = {
        x: Math.random() * 1920,
        y: Math.random() * 1080,
      };

      const canvasPoint = toCanvas(point.x, point.y, 1920, 1080, 1280, 720);
      const framePoint = toFrame(canvasPoint.x, canvasPoint.y, 1920, 1080, 1280, 720);

      expect(framePoint.x).toBeCloseTo(point.x, 2);
      expect(framePoint.y).toBeCloseTo(point.y, 2);
    }
  });
});

describe('findNearestPoint', () => {
  it('returns the nearest point within max distance', () => {
    const result = findNearestPoint(
      { x: 105, y: 103 },
      [
        { x: 100, y: 100, id: 'a' },
        { x: 120, y: 110, id: 'b' },
      ],
      10,
    );

    expect(result?.id).toBe('a');
  });

  it('returns null when no point is nearby', () => {
    const result = findNearestPoint({ x: 200, y: 200 }, [{ x: 100, y: 100, id: 'a' }], 10);

    expect(result).toBeNull();
  });
});
