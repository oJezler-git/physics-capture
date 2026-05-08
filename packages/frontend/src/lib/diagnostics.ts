import type { PhysicsResult } from '../types';

export const formatWithUncertainty = (value: number, uncertainty: number, digits = 3) =>
  `${value.toFixed(digits)} +/- ${uncertainty.toFixed(digits)}`;

export const percent = (value: number | null | undefined) =>
  typeof value === 'number' ? `${(value * 100).toFixed(1)}%` : 'n/a';

export const buildFallbackDiagnostics = (result: PhysicsResult | null) => {
  if (!result) return null;
  if (result.reconstructionDiagnostics) return result.reconstructionDiagnostics;

  const mode = result.reconstruction3d?.mode ?? 'SINGLE_CAMERA_PLANAR';
  const isStereo = mode === 'STEREO_3D';
  const extrinsics = result.reconstruction3d?.stereoExtrinsics as
    | { baseline_mm?: number; reprojection_error_px?: number }
    | undefined;
  const baselineMm = typeof extrinsics?.baseline_mm === 'number' ? extrinsics.baseline_mm : null;
  const reprojPx =
    typeof extrinsics?.reprojection_error_px === 'number' ? extrinsics.reprojection_error_px : null;
  const syncIsMock = Boolean(result.syncStatus?.isMock ?? true);

  return {
    overallConfidence: isStereo ? 0.55 : 0.35,
    verdict: (isStereo ? 'medium' : 'low') as 'high' | 'medium' | 'low',
    issues: [
      'Using fallback diagnostics because backend response is missing reconstructionDiagnostics.',
      'Restart signaling server to enable full diagnostics scoring.',
    ],
    checks: [
      {
        id: 'payload-version',
        label: 'Diagnostics payload',
        status: 'warn' as const,
        value: 'missing',
        details:
          'Backend response has no reconstructionDiagnostics yet. Showing compatibility fallback.',
      },
      {
        id: 'stereo-mode',
        label: 'Stereo mode enabled',
        status: (isStereo ? 'pass' : 'fail') as 'pass' | 'warn' | 'fail',
        value: mode,
      },
      {
        id: 'sync-source',
        label: 'Sync source',
        status: (syncIsMock ? 'warn' : 'pass') as 'pass' | 'warn' | 'fail',
        value: syncIsMock ? 'mock' : 'measured',
      },
      ...(baselineMm === null
        ? []
        : [
            {
              id: 'baseline',
              label: 'Stereo baseline',
              status: (baselineMm < 60 ? 'warn' : 'pass') as 'pass' | 'warn' | 'fail',
              value: `${baselineMm.toFixed(1)} mm`,
            },
          ]),
      ...(reprojPx === null
        ? []
        : [
            {
              id: 'reprojection',
              label: 'Stereo reprojection error',
              status: (reprojPx > 1.2 ? 'fail' : reprojPx > 0.6 ? 'warn' : 'pass') as
                | 'pass'
                | 'warn'
                | 'fail',
              value: `${reprojPx.toFixed(3)} px`,
            },
          ]),
    ],
    metrics: {
      mode,
      baselineMm,
      stereoReprojectionPx: reprojPx,
      syncRmsMs: result.syncStatus?.rmsMs ?? null,
      syncIsMock,
      avgTrackConfidence: null,
      frameCoverageCam0: null,
      frameCoverageCam1: null,
      triangulationFlaggedPct: null,
      maxLineDeviationM: null,
      gtRmseM: null,
      gtRmseXm: null,
      gtRmseYm: null,
      gtRmseZm: null,
      gtBiasXm: null,
      gtBiasYm: null,
      gtBiasZm: null,
      gtWorstFrame: null,
      gtWorstFrameErrorM: null,
      reprojRmseCam0Px: null,
      reprojRmseCam1Px: null,
      reprojWorstFrame: null,
      reprojWorstErrorPx: null,
    },
  };
};
