import { describe, expect, it } from 'vitest';
import { extrinsicsToCameraPose } from './cameraPose';

describe('extrinsicsToCameraPose', () => {
  it('converts OpenCV stereo extrinsics to world camera center', () => {
    const pose = extrinsicsToCameraPose(
      [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      [-120, 0, 0],
    );

    expect(pose.position[0]).toBeCloseTo(0.12, 6);
    expect(pose.position[1]).toBeCloseTo(0, 6);
    expect(pose.position[2]).toBeCloseTo(0, 6);
    expect(pose.quaternion[0]).toBeCloseTo(0, 6);
    expect(pose.quaternion[1]).toBeCloseTo(0, 6);
    expect(pose.quaternion[2]).toBeCloseTo(0, 6);
    expect(pose.quaternion[3]).toBeCloseTo(1, 6);
  });

  it('falls back safely for malformed inputs', () => {
    const pose = extrinsicsToCameraPose(undefined, undefined);
    expect(pose).toEqual({
      position: [0, 0, 0],
      quaternion: [0, 0, 0, 1],
    });
  });
});
