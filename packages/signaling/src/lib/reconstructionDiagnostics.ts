type CheckStatus = "pass" | "warn" | "fail";

export interface ReconstructionDiagnosticCheck {
  id: string;
  label: string;
  status: CheckStatus;
  value?: string;
  details?: string;
}

export interface ReconstructionDiagnostics {
  overallConfidence: number;
  verdict: "high" | "medium" | "low";
  issues: string[];
  checks: ReconstructionDiagnosticCheck[];
  metrics: {
    mode: "SINGLE_CAMERA_PLANAR" | "STEREO_3D";
    baselineMm: number | null;
    stereoReprojectionPx: number | null;
    syncRmsMs: number | null;
    syncIsMock: boolean;
    avgTrackConfidence: number | null;
    frameCoverageCam0: number | null;
    frameCoverageCam1: number | null;
    triangulationFlaggedPct: number | null;
    maxLineDeviationM: number | null;
    gtRmseM: number | null;
  };
}

interface SyncStatusLike {
  isMock: boolean;
  rmsMs?: number;
}

interface TrackFrame {
  frame_idx: number;
  confidence?: number;
}

interface TrackBall {
  ball_id: number;
  camera_id: number;
  frames: TrackFrame[];
}

interface PositionsFrame {
  frame: number;
  balls: Array<{
    ball_id: number;
    x_m: number;
    y_m: number;
    z_m: number;
    flagged?: boolean;
  }>;
}

interface PositionsLike {
  frames?: PositionsFrame[];
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

const formatPct = (value: number) => `${(value * 100).toFixed(1)}%`;
const formatMm = (value: number) => `${value.toFixed(1)} mm`;
const formatPx = (value: number) => `${value.toFixed(3)} px`;
const formatM = (value: number) => `${value.toFixed(4)} m`;
const formatMs = (value: number) => `${value.toFixed(2)} ms`;

const computeMaxLineDeviation = (
  positions3d: PositionsLike | null,
): number | null => {
  if (!positions3d?.frames?.length) return null;
  const byBall = new Map<number, Array<{ x: number; y: number; z: number }>>();
  for (const frame of positions3d.frames) {
    for (const ball of frame.balls ?? []) {
      if (!byBall.has(ball.ball_id)) byBall.set(ball.ball_id, []);
      byBall.get(ball.ball_id)?.push({ x: ball.x_m, y: ball.y_m, z: ball.z_m });
    }
  }

  let maxDeviation = 0;
  for (const points of byBall.values()) {
    if (points.length < 3) continue;
    const start = points[0];
    const end = points[points.length - 1];
    const vx = end.x - start.x;
    const vy = end.y - start.y;
    const vz = end.z - start.z;
    const vNorm = Math.hypot(vx, vy, vz);
    if (vNorm < 1e-9) continue;
    for (const p of points) {
      const wx = p.x - start.x;
      const wy = p.y - start.y;
      const wz = p.z - start.z;
      const cx = wy * vz - wz * vy;
      const cy = wz * vx - wx * vz;
      const cz = wx * vy - wy * vx;
      const distance = Math.hypot(cx, cy, cz) / vNorm;
      maxDeviation = Math.max(maxDeviation, distance);
    }
  }
  return Number.isFinite(maxDeviation) ? maxDeviation : null;
};

const computeGtRmse = (
  positions3d: PositionsLike | null,
  positions3dGt: PositionsLike | null,
): number | null => {
  if (!positions3d?.frames?.length || !positions3dGt?.frames?.length)
    return null;
  const gtByKey = new Map<string, { x: number; y: number; z: number }>();
  for (const frame of positions3dGt.frames) {
    for (const ball of frame.balls ?? []) {
      gtByKey.set(`${frame.frame}:${ball.ball_id}`, {
        x: ball.x_m,
        y: ball.y_m,
        z: ball.z_m,
      });
    }
  }

  let n = 0;
  let sse = 0;
  for (const frame of positions3d.frames) {
    for (const ball of frame.balls ?? []) {
      const gt = gtByKey.get(`${frame.frame}:${ball.ball_id}`);
      if (!gt) continue;
      const dx = ball.x_m - gt.x;
      const dy = ball.y_m - gt.y;
      const dz = ball.z_m - gt.z;
      sse += dx * dx + dy * dy + dz * dz;
      n += 1;
    }
  }
  if (n === 0) return null;
  return Math.sqrt(sse / n);
};

export const buildReconstructionDiagnostics = ({
  mode,
  stereoExtrinsics,
  syncStatus,
  tracksData,
  positions3d,
  positions3dGt,
}: {
  mode: "SINGLE_CAMERA_PLANAR" | "STEREO_3D";
  stereoExtrinsics: any;
  syncStatus: SyncStatusLike;
  tracksData: { balls?: TrackBall[] } | null;
  positions3d: PositionsLike | null;
  positions3dGt: PositionsLike | null;
}): ReconstructionDiagnostics => {
  const checks: ReconstructionDiagnosticCheck[] = [];
  const issues: string[] = [];

  let score = 1.0;

  const baselineMm =
    stereoExtrinsics?.baseline_mm &&
    Number.isFinite(stereoExtrinsics.baseline_mm)
      ? Number(stereoExtrinsics.baseline_mm)
      : null;
  const stereoReprojectionPx =
    stereoExtrinsics?.reprojection_error_px &&
    Number.isFinite(stereoExtrinsics.reprojection_error_px)
      ? Number(stereoExtrinsics.reprojection_error_px)
      : null;
  const syncRmsMs = Number.isFinite(syncStatus.rmsMs)
    ? Number(syncStatus.rmsMs)
    : null;

  const trackBalls = Array.isArray(tracksData?.balls) ? tracksData!.balls : [];
  const confidences = trackBalls.flatMap((ball) =>
    (ball.frames ?? [])
      .map((frame) => frame.confidence)
      .filter((value): value is number => Number.isFinite(value)),
  );
  const avgTrackConfidence =
    confidences.length > 0
      ? confidences.reduce((acc, value) => acc + value, 0) / confidences.length
      : null;

  const frameCountByCamera = new Map<number, Set<number>>();
  for (const ball of trackBalls) {
    if (!frameCountByCamera.has(ball.camera_id))
      frameCountByCamera.set(ball.camera_id, new Set());
    for (const frame of ball.frames ?? []) {
      if (Number.isFinite(frame.frame_idx))
        frameCountByCamera.get(ball.camera_id)?.add(frame.frame_idx);
    }
  }
  const cam0Coverage = frameCountByCamera.get(0)?.size ?? 0;
  const cam1Coverage = frameCountByCamera.get(1)?.size ?? 0;
  const maxCoverage = Math.max(cam0Coverage, cam1Coverage, 0);
  const frameCoverageCam0 = maxCoverage > 0 ? cam0Coverage / maxCoverage : null;
  const frameCoverageCam1 = maxCoverage > 0 ? cam1Coverage / maxCoverage : null;

  const triPoints =
    positions3d?.frames?.flatMap((frame) => frame.balls ?? []) ?? [];
  const triFlagged = triPoints.filter((point) => point.flagged).length;
  const triangulationFlaggedPct =
    triPoints.length > 0 ? triFlagged / Math.max(1, triPoints.length) : null;
  const maxLineDeviationM = computeMaxLineDeviation(positions3d);
  const gtRmseM = computeGtRmse(positions3d, positions3dGt);

  if (mode !== "STEREO_3D") {
    checks.push({
      id: "stereo-mode",
      label: "Stereo mode enabled",
      status: "fail",
      value: mode,
      details: "3D triangulation is unavailable in single-camera planar mode.",
    });
    issues.push(
      "Physics ran in single-camera mode, so 3D depth is not triangulated.",
    );
    score -= 0.45;
  } else {
    checks.push({
      id: "stereo-mode",
      label: "Stereo mode enabled",
      status: "pass",
      value: mode,
    });
  }

  if (baselineMm === null) {
    checks.push({
      id: "baseline",
      label: "Stereo baseline",
      status: "fail",
      details: "Missing baseline_mm in stereo_extrinsics.json.",
    });
    issues.push(
      "Stereo baseline is missing; camera geometry cannot be trusted.",
    );
    score -= 0.25;
  } else if (baselineMm < 60) {
    checks.push({
      id: "baseline",
      label: "Stereo baseline",
      status: "warn",
      value: formatMm(baselineMm),
      details: "Small baseline weakens depth accuracy at distance.",
    });
    issues.push(
      `Stereo baseline is small (${formatMm(baselineMm)}), reducing depth precision.`,
    );
    score -= 0.12;
  } else {
    checks.push({
      id: "baseline",
      label: "Stereo baseline",
      status: "pass",
      value: formatMm(baselineMm),
    });
  }

  if (stereoReprojectionPx === null) {
    checks.push({
      id: "stereo-reproj",
      label: "Stereo reprojection error",
      status: "warn",
      details: "No reprojection error found in stereo extrinsics.",
    });
    score -= 0.08;
  } else if (stereoReprojectionPx > 1.2) {
    checks.push({
      id: "stereo-reproj",
      label: "Stereo reprojection error",
      status: "fail",
      value: formatPx(stereoReprojectionPx),
      details: "Large reprojection error suggests weak calibration.",
    });
    issues.push(
      `Stereo calibration reprojection error is high (${formatPx(stereoReprojectionPx)}).`,
    );
    score -= 0.18;
  } else if (stereoReprojectionPx > 0.6) {
    checks.push({
      id: "stereo-reproj",
      label: "Stereo reprojection error",
      status: "warn",
      value: formatPx(stereoReprojectionPx),
    });
    score -= 0.08;
  } else {
    checks.push({
      id: "stereo-reproj",
      label: "Stereo reprojection error",
      status: "pass",
      value: formatPx(stereoReprojectionPx),
    });
  }

  if (syncStatus.isMock) {
    checks.push({
      id: "sync",
      label: "Cross-camera sync quality",
      status: "warn",
      value: "mock sync",
      details: "timestamps were synthesized instead of decoded.",
    });
    issues.push(
      "Sync data is mock; timing drift between cameras may be hidden.",
    );
    score -= 0.15;
  } else if (syncRmsMs !== null && syncRmsMs > 4) {
    checks.push({
      id: "sync",
      label: "Cross-camera sync quality",
      status: "warn",
      value: formatMs(syncRmsMs),
    });
    score -= 0.08;
  } else {
    checks.push({
      id: "sync",
      label: "Cross-camera sync quality",
      status: "pass",
      value: syncRmsMs !== null ? formatMs(syncRmsMs) : "ok",
    });
  }

  if (avgTrackConfidence === null) {
    checks.push({
      id: "track-confidence",
      label: "Tracking confidence",
      status: "fail",
      details: "No tracking confidence found in tracks.json.",
    });
    issues.push("No track confidence data available for diagnostics.");
    score -= 0.18;
  } else if (avgTrackConfidence < 0.75) {
    checks.push({
      id: "track-confidence",
      label: "Tracking confidence",
      status: "fail",
      value: avgTrackConfidence.toFixed(3),
    });
    issues.push(
      `Low mean tracker confidence (${avgTrackConfidence.toFixed(3)}).`,
    );
    score -= 0.2;
  } else if (avgTrackConfidence < 0.9) {
    checks.push({
      id: "track-confidence",
      label: "Tracking confidence",
      status: "warn",
      value: avgTrackConfidence.toFixed(3),
    });
    score -= 0.08;
  } else {
    checks.push({
      id: "track-confidence",
      label: "Tracking confidence",
      status: "pass",
      value: avgTrackConfidence.toFixed(3),
    });
  }

  if (mode === "STEREO_3D") {
    const stereoOverlap =
      frameCoverageCam0 !== null && frameCoverageCam1 !== null
        ? Math.min(frameCoverageCam0, frameCoverageCam1)
        : null;
    if (stereoOverlap === null) {
      checks.push({
        id: "coverage",
        label: "Stereo frame overlap",
        status: "fail",
        details: "Cannot compute overlap across cam0/cam1 tracks.",
      });
      score -= 0.2;
    } else if (stereoOverlap < 0.7) {
      checks.push({
        id: "coverage",
        label: "Stereo frame overlap",
        status: "fail",
        value: formatPct(stereoOverlap),
      });
      issues.push(
        `Low frame overlap between cameras (${formatPct(stereoOverlap)}).`,
      );
      score -= 0.2;
    } else if (stereoOverlap < 0.9) {
      checks.push({
        id: "coverage",
        label: "Stereo frame overlap",
        status: "warn",
        value: formatPct(stereoOverlap),
      });
      score -= 0.1;
    } else {
      checks.push({
        id: "coverage",
        label: "Stereo frame overlap",
        status: "pass",
        value: formatPct(stereoOverlap),
      });
    }
  }

  if (triangulationFlaggedPct !== null) {
    if (triangulationFlaggedPct > 0.15) {
      checks.push({
        id: "triangulation-flags",
        label: "Triangulation flagged points",
        status: "fail",
        value: formatPct(triangulationFlaggedPct),
      });
      issues.push(
        `Many 3D points were flagged (${formatPct(triangulationFlaggedPct)}).`,
      );
      score -= 0.18;
    } else if (triangulationFlaggedPct > 0.05) {
      checks.push({
        id: "triangulation-flags",
        label: "Triangulation flagged points",
        status: "warn",
        value: formatPct(triangulationFlaggedPct),
      });
      score -= 0.08;
    } else {
      checks.push({
        id: "triangulation-flags",
        label: "Triangulation flagged points",
        status: "pass",
        value: formatPct(triangulationFlaggedPct),
      });
    }
  }

  if (maxLineDeviationM !== null) {
    if (maxLineDeviationM > 0.06) {
      checks.push({
        id: "linearity",
        label: "Trajectory linearity check",
        status: "warn",
        value: formatM(maxLineDeviationM),
        details: "Curvature exceeds expected straight-line motion envelope.",
      });
      issues.push(
        `Trajectory curvature is elevated (max deviation ${formatM(maxLineDeviationM)}).`,
      );
      score -= 0.12;
    } else {
      checks.push({
        id: "linearity",
        label: "Trajectory linearity check",
        status: "pass",
        value: formatM(maxLineDeviationM),
      });
    }
  }

  if (gtRmseM !== null) {
    if (gtRmseM > 0.05) {
      checks.push({
        id: "gt-rmse",
        label: "Synthetic ground-truth RMSE",
        status: "fail",
        value: formatM(gtRmseM),
      });
      issues.push(
        `3D reconstruction diverges from synthetic ground truth (RMSE ${formatM(gtRmseM)}).`,
      );
      score -= 0.22;
    } else if (gtRmseM > 0.02) {
      checks.push({
        id: "gt-rmse",
        label: "Synthetic ground-truth RMSE",
        status: "warn",
        value: formatM(gtRmseM),
      });
      score -= 0.1;
    } else {
      checks.push({
        id: "gt-rmse",
        label: "Synthetic ground-truth RMSE",
        status: "pass",
        value: formatM(gtRmseM),
      });
    }
  }

  const overallConfidence = clamp01(score);
  const verdict =
    overallConfidence >= 0.8
      ? "high"
      : overallConfidence >= 0.55
        ? "medium"
        : "low";

  return {
    overallConfidence,
    verdict,
    issues,
    checks,
    metrics: {
      mode,
      baselineMm,
      stereoReprojectionPx,
      syncRmsMs,
      syncIsMock: Boolean(syncStatus.isMock),
      avgTrackConfidence,
      frameCoverageCam0,
      frameCoverageCam1,
      triangulationFlaggedPct,
      maxLineDeviationM,
      gtRmseM,
    },
  };
};
