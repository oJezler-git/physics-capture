import { calibrateMetronome } from './metronome';

describe('calibrateMetronome', () => {
  it('computes speed from stable 60Hz timestamps', () => {
    const interval = 1000 / 60;
    const timestamps = Array.from({ length: 120 }, (_, index) => index * interval);

    const result = calibrateMetronome(timestamps, 400);

    expect(result.speedPxPerFrame).toBeCloseTo(400 / 60, 3);
    expect(result.jitterMs).toBeCloseTo(0, 3);
  });

  it('reports high jitter when cadence is unstable', () => {
    const intervals = [16, 19, 13, 20, 12, 18, 14, 21, 11, 19];
    const timestamps = [0];
    for (const value of intervals) {
      timestamps.push(timestamps[timestamps.length - 1] + value);
    }

    const result = calibrateMetronome(timestamps, 400);

    expect(result.jitterMs).toBeGreaterThan(2);
  });
});
