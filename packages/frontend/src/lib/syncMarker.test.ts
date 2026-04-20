import { computeCadenceMetrics, grayDecode, grayEncode, hammingDistance, phaseForFrame } from './syncMarker';

describe('syncMarker gray code', () => {
  it('adjacent values differ by exactly 1 bit (10-bit Gray)', () => {
    const bits = 10;
    for (let n = 0; n < (1 << bits) - 1; n++) {
      const a = grayEncode(n, bits);
      const b = grayEncode(n + 1, bits);
      expect(hammingDistance(a, b)).toBe(1);
    }
  });

  it('round-trips through Gray encode/decode', () => {
    const bits = 10;
    for (let n = 0; n < 1 << bits; n++) {
      const gray = grayEncode(n, bits);
      expect(grayDecode(gray)).toBe(n);
    }
  });
});

describe('syncMarker phase', () => {
  it('wraps phase into [0, 2π)', () => {
    const tau = Math.PI * 2;
    const step = tau / 32;
    for (let frame = 0; frame < 512; frame++) {
      const phase = phaseForFrame(frame, step);
      expect(phase).toBeGreaterThanOrEqual(0);
      expect(phase).toBeLessThan(tau);
    }
  });

  it('returns to phase 0 after a full cycle when step is 2π/N', () => {
    const tau = Math.PI * 2;
    const step = tau / 32;
    expect(phaseForFrame(0, step)).toBeCloseTo(0, 12);
    expect(phaseForFrame(32, step)).toBeCloseTo(0, 12);
    expect(phaseForFrame(64, step)).toBeCloseTo(0, 12);
  });
});

describe('syncMarker cadence metrics', () => {
  it('reports stable interval and near-zero jitter for perfect cadence', () => {
    const interval = 1000 / 60;
    const intervals = Array.from({ length: 120 }, () => interval);
    const metrics = computeCadenceMetrics(intervals);
    expect(metrics.intervalMs).toBeCloseTo(interval, 6);
    expect(metrics.jitterMs).toBeCloseTo(0, 6);
  });
});

