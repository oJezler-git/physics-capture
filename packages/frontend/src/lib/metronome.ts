export interface MetronomeCalibrationResult {
  medianIntervalMs: number;
  jitterMs: number;
  speedPxPerFrame: number;
}

export function calibrateMetronome(
  timestamps: number[],
  speedPxPerSecond: number,
): MetronomeCalibrationResult {
  if (timestamps.length < 2) {
    throw new Error('At least two timestamps are required for calibration');
  }

  const intervals = timestamps.slice(1).map((time, index) => time - timestamps[index]);
  const sortedIntervals = [...intervals].sort((a, b) => a - b);
  const medianIntervalMs = sortedIntervals[Math.floor(sortedIntervals.length / 2)];

  const deviations = intervals
    .map((interval) => Math.abs(interval - medianIntervalMs))
    .sort((a, b) => a - b);
  const jitterMs = deviations[Math.floor(deviations.length / 2)];

  return {
    medianIntervalMs,
    jitterMs,
    speedPxPerFrame: speedPxPerSecond / (1000 / medianIntervalMs),
  };
}
