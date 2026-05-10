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
    gtRmseXm: number | null;
    gtRmseYm: number | null;
    gtRmseZm: number | null;
    gtBiasXm: number | null;
    gtBiasYm: number | null;
    gtBiasZm: number | null;
    gtWorstFrame: number | null;
    gtWorstFrameErrorM: number | null;
    gtDepthFitScale: number | null;
    gtDepthFitOffsetM: number | null;
    gtDepthFitRmseZm: number | null;
    gtDepthFitImprovementPct: number | null;
    reprojRmseCam0Px: number | null;
    reprojRmseCam1Px: number | null;
    reprojWorstFrame: number | null;
    reprojWorstErrorPx: number | null;
  };
}

interface SyncStatusLike {
  isMock: boolean;
  rmsMs?: number;
}

interface TrackFrame {
  frame_idx: number;
  x_px?: number;
  y_px?: number;
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

interface CameraIntrinsicsLike {
  camera_id?: number;
  fx?: number;
  fy?: number;
  cx?: number;
  cy?: number;
  k1?: number;
  k2?: number;
  p1?: number;
  p2?: number;
  k3?: number;
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const toFiniteNumber = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

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
  return n > 0 ? Math.sqrt(sse / n) : null;
};

const computeGtAxisMetrics = (
  positions3d: PositionsLike | null,
  positions3dGt: PositionsLike | null,
) => {
  if (!positions3d?.frames?.length || !positions3dGt?.frames?.length) {
    return {
      rmseX: null,
      rmseY: null,
      rmseZ: null,
      biasX: null,
      biasY: null,
      biasZ: null,
      worstFrame: null,
      worstFrameError: null,
    } as const;
  }
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
  let sseX = 0;
  let sseY = 0;
  let sseZ = 0;
  let sumX = 0;
  let sumY = 0;
  let sumZ = 0;
  const perFrameSse = new Map<number, { sse: number; n: number }>();
  for (const frame of positions3d.frames) {
    for (const ball of frame.balls ?? []) {
      const gt = gtByKey.get(`${frame.frame}:${ball.ball_id}`);
      if (!gt) continue;
      const dx = ball.x_m - gt.x;
      const dy = ball.y_m - gt.y;
      const dz = ball.z_m - gt.z;
      sseX += dx * dx;
      sseY += dy * dy;
      sseZ += dz * dz;
      sumX += dx;
      sumY += dy;
      sumZ += dz;
      n += 1;
      const prev = perFrameSse.get(frame.frame) ?? { sse: 0, n: 0 };
      prev.sse += dx * dx + dy * dy + dz * dz;
      prev.n += 1;
      perFrameSse.set(frame.frame, prev);
    }
  }
  if (n === 0) {
    return {
      rmseX: null,
      rmseY: null,
      rmseZ: null,
      biasX: null,
      biasY: null,
      biasZ: null,
      worstFrame: null,
      worstFrameError: null,
    } as const;
  }
  let worstFrame: number | null = null;
  let worstError = -1;
  for (const [frame, value] of perFrameSse.entries()) {
    const rmse = Math.sqrt(value.sse / Math.max(1, value.n));
    if (rmse > worstError) {
      worstError = rmse;
      worstFrame = frame;
    }
  }
  return {
    rmseX: Math.sqrt(sseX / n),
    rmseY: Math.sqrt(sseY / n),
    rmseZ: Math.sqrt(sseZ / n),
    biasX: sumX / n,
    biasY: sumY / n,
    biasZ: sumZ / n,
    worstFrame,
    worstFrameError: worstError >= 0 ? worstError : null,
  } as const;
};

const computeGtDepthFit = (
  positions3d: PositionsLike | null,
  positions3dGt: PositionsLike | null,
) => {
  if (!positions3d?.frames?.length || !positions3dGt?.frames?.length) {
    return {
      scale: null,
      offsetM: null,
      rmseZFitM: null,
      improvementPct: null,
    } as const;
  }
  const gtByKey = new Map<string, number>();
  for (const frame of positions3dGt.frames) {
    for (const ball of frame.balls ?? []) {
      gtByKey.set(`${frame.frame}:${ball.ball_id}`, ball.z_m);
    }
  }
  const pairsByBall = new Map<number, Array<{ z: number; zGt: number }>>();
  for (const frame of positions3d.frames) {
    for (const ball of frame.balls ?? []) {
      const zGt = gtByKey.get(`${frame.frame}:${ball.ball_id}`);
      if (zGt === undefined) continue;
      if (!pairsByBall.has(ball.ball_id)) pairsByBall.set(ball.ball_id, []);
      pairsByBall.get(ball.ball_id)?.push({ z: ball.z_m, zGt });
    }
  }
  const allPairs = [...pairsByBall.values()].flat();
  if (allPairs.length < 2) {
    return {
      scale: null,
      offsetM: null,
      rmseZFitM: null,
      improvementPct: null,
    } as const;
  }

  // Fit slope in a centered per-ball space to avoid inter-ball intercept bias
  // collapsing the global slope toward zero.
  let nCentered = 0;
  let sumXXCentered = 0;
  let sumXYCentered = 0;
  const meanByBall = new Map<number, { zMean: number; zGtMean: number }>();
  for (const [ballId, pairs] of pairsByBall.entries()) {
    if (pairs.length < 2) continue;
    const zMean = pairs.reduce((acc, p) => acc + p.z, 0) / pairs.length;
    const zGtMean = pairs.reduce((acc, p) => acc + p.zGt, 0) / pairs.length;
    meanByBall.set(ballId, { zMean, zGtMean });
  }
  for (const [ballId, pairs] of pairsByBall.entries()) {
    const means = meanByBall.get(ballId);
    if (!means) continue;
    for (const pair of pairs) {
      const x = pair.z - means.zMean;
      const y = pair.zGt - means.zGtMean;
      sumXXCentered += x * x;
      sumXYCentered += x * y;
      nCentered += 1;
    }
  }
  if (nCentered < 2 || Math.abs(sumXXCentered) < 1e-12) {
    return {
      scale: null,
      offsetM: null,
      rmseZFitM: null,
      improvementPct: null,
    } as const;
  }
  const scale = sumXYCentered / sumXXCentered;

  // Offset computed on full data after slope is fixed.
  const offsetM =
    allPairs.reduce((acc, p) => acc + (p.zGt - scale * p.z), 0) /
    allPairs.length;
  const zMeanAll = allPairs.reduce((acc, p) => acc + p.z, 0) / allPairs.length;
  const zGtMeanAll =
    allPairs.reduce((acc, p) => acc + p.zGt, 0) / allPairs.length;
  let cov = 0;
  let varX = 0;
  let varY = 0;
  let sseRaw = 0;
  let sseFit = 0;
  for (const pair of allPairs) {
    const dx = pair.z - zMeanAll;
    const dy = pair.zGt - zGtMeanAll;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
    sseRaw += (pair.z - pair.zGt) * (pair.z - pair.zGt);
    const zFit = scale * pair.z + offsetM;
    sseFit += (zFit - pair.zGt) * (zFit - pair.zGt);
  }
  const rmseRaw = Math.sqrt(sseRaw / allPairs.length);
  const rmseZFitM = Math.sqrt(sseFit / allPairs.length);
  const improvementPct =
    rmseRaw > 1e-12 ? Math.max(0, (1 - rmseZFitM / rmseRaw) * 100) : 0;
  const corr = varX > 1e-12 && varY > 1e-12 ? cov / Math.sqrt(varX * varY) : 0;
  // Reliability guard for pathological fits.
  if (!Number.isFinite(scale) || Math.abs(corr) < 0.2) {
    return {
      scale: null,
      offsetM: null,
      rmseZFitM: null,
      improvementPct: null,
    } as const;
  }
  return {
    scale,
    offsetM,
    rmseZFitM,
    improvementPct,
  } as const;
};

const projectPoint = (
  P: number[][],
  x: number,
  y: number,
  z: number,
): { u: number; v: number } | null => {
  if (!Array.isArray(P) || P.length !== 3) return null;
  if (P.some((row) => !Array.isArray(row) || row.length !== 4)) return null;
  const r0 = P[0][0] * x + P[0][1] * y + P[0][2] * z + P[0][3];
  const r1 = P[1][0] * x + P[1][1] * y + P[1][2] * z + P[1][3];
  const r2 = P[2][0] * x + P[2][1] * y + P[2][2] * z + P[2][3];
  if (
    !Number.isFinite(r0) ||
    !Number.isFinite(r1) ||
    !Number.isFinite(r2) ||
    Math.abs(r2) < 1e-9
  )
    return null;
  return { u: r0 / r2, v: r1 / r2 };
};

const distortPoint = (
  point: { u: number; v: number },
  intrinsics: CameraIntrinsicsLike | null | undefined,
): { u: number; v: number } => {
  if (!intrinsics) return point;
  const fx = toFiniteNumber(intrinsics.fx);
  const fy = toFiniteNumber(intrinsics.fy);
  const cx = toFiniteNumber(intrinsics.cx);
  const cy = toFiniteNumber(intrinsics.cy);
  if (fx === null || fy === null || cx === null || cy === null) return point;
  const k1 = toFiniteNumber(intrinsics.k1) ?? 0;
  const k2 = toFiniteNumber(intrinsics.k2) ?? 0;
  const p1 = toFiniteNumber(intrinsics.p1) ?? 0;
  const p2 = toFiniteNumber(intrinsics.p2) ?? 0;
  const k3 = toFiniteNumber(intrinsics.k3) ?? 0;

  const x = (point.u - cx) / fx;
  const y = (point.v - cy) / fy;
  const r2 = x * x + y * y;
  const r4 = r2 * r2;
  const r6 = r4 * r2;
  const radial = 1 + k1 * r2 + k2 * r4 + k3 * r6;
  const xDist = x * radial + 2 * p1 * x * y + p2 * (r2 + 2 * x * x);
  const yDist = y * radial + p1 * (r2 + 2 * y * y) + 2 * p2 * x * y;
  return {
    u: xDist * fx + cx,
    v: yDist * fy + cy,
  };
};

const computeReprojectionMetrics = (
  positions3d: PositionsLike | null,
  stereoExtrinsics: any,
  tracksData: { balls?: TrackBall[] } | null,
  intrinsicsByCamera: Map<number, CameraIntrinsicsLike>,
) => {
  const P0 = stereoExtrinsics?.P0;
  const P1 = stereoExtrinsics?.P1;
  if (
    !positions3d?.frames?.length ||
    !Array.isArray(tracksData?.balls) ||
    !P0 ||
    !P1
  ) {
    return {
      rmseCam0: null,
      rmseCam1: null,
      worstFrame: null,
      worstError: null,
    } as const;
  }

  const trackLookup = new Map<string, { x: number; y: number }>();
  for (const ball of tracksData.balls ?? []) {
    for (const frame of ball.frames ?? []) {
      const x = toFiniteNumber(frame.x_px);
      const y = toFiniteNumber(frame.y_px);
      if (x === null || y === null) continue;
      trackLookup.set(`${ball.camera_id}:${ball.ball_id}:${frame.frame_idx}`, {
        x,
        y,
      });
    }
  }

  let n0 = 0;
  let sse0 = 0;
  let n1 = 0;
  let sse1 = 0;
  let worstFrame: number | null = null;
  let worstErr = -1;
  // Some calibrations serialize projection matrices with translation in mm
  // while positions_3d is in metres. Evaluate both and choose lower SSE.
  const evaluateScale = (xyzScale: number) => {
    let localN0 = 0;
    let localSse0 = 0;
    let localN1 = 0;
    let localSse1 = 0;
    let localWorstFrame: number | null = null;
    let localWorstErr = -1;
    for (const frame of positions3d.frames ?? []) {
      for (const ball of frame.balls ?? []) {
        const x = ball.x_m * xyzScale;
        const y = ball.y_m * xyzScale;
        const z = ball.z_m * xyzScale;
        const p0Base = projectPoint(P0, x, y, z);
        const p1Base = projectPoint(P1, x, y, z);
        const p0 = p0Base
          ? distortPoint(p0Base, intrinsicsByCamera.get(0) ?? null)
          : null;
        const p1 = p1Base
          ? distortPoint(p1Base, intrinsicsByCamera.get(1) ?? null)
          : null;
        const t0 = trackLookup.get(`0:${ball.ball_id}:${frame.frame}`);
        const t1 = trackLookup.get(`1:${ball.ball_id}:${frame.frame}`);
        if (p0 && t0) {
          const e = Math.hypot(p0.u - t0.x, p0.v - t0.y);
          localSse0 += e * e;
          localN0 += 1;
          if (e > localWorstErr) {
            localWorstErr = e;
            localWorstFrame = frame.frame;
          }
        }
        if (p1 && t1) {
          const e = Math.hypot(p1.u - t1.x, p1.v - t1.y);
          localSse1 += e * e;
          localN1 += 1;
          if (e > localWorstErr) {
            localWorstErr = e;
            localWorstFrame = frame.frame;
          }
        }
      }
    }
    return {
      n0: localN0,
      sse0: localSse0,
      n1: localN1,
      sse1: localSse1,
      worstFrame: localWorstFrame,
      worstErr: localWorstErr,
    } as const;
  };

  const inMeters = evaluateScale(1);
  const inMillimeters = evaluateScale(1000);
  const inMetersTotalSse = inMeters.sse0 + inMeters.sse1;
  const inMillimetersTotalSse = inMillimeters.sse0 + inMillimeters.sse1;
  const selected =
    inMillimeters.n0 + inMillimeters.n1 > 0 &&
    inMillimetersTotalSse < inMetersTotalSse
      ? inMillimeters
      : inMeters;
  n0 = selected.n0;
  sse0 = selected.sse0;
  n1 = selected.n1;
  sse1 = selected.sse1;
  worstFrame = selected.worstFrame;
  worstErr = selected.worstErr;

  return {
    rmseCam0: n0 > 0 ? Math.sqrt(sse0 / n0) : null,
    rmseCam1: n1 > 0 ? Math.sqrt(sse1 / n1) : null,
    worstFrame,
    worstError: worstErr >= 0 ? worstErr : null,
  } as const;
};

export const buildReconstructionDiagnostics = ({
  mode,
  stereoExtrinsics,
  syncStatus,
  tracksData,
  positions3d,
  positions3dGt,
  intrinsics,
}: {
  mode: "SINGLE_CAMERA_PLANAR" | "STEREO_3D";
  stereoExtrinsics: any;
  syncStatus: SyncStatusLike;
  tracksData: { balls?: TrackBall[] } | null;
  positions3d: PositionsLike | null;
  positions3dGt: PositionsLike | null;
  intrinsics?: CameraIntrinsicsLike[] | null;
}): ReconstructionDiagnostics => {
  const checks: ReconstructionDiagnosticCheck[] = [];
  const issues: string[] = [];
  let score = 1.0;

  const baselineMm = toFiniteNumber(stereoExtrinsics?.baseline_mm);
  const stereoReprojectionPx = toFiniteNumber(
    stereoExtrinsics?.reprojection_error_px,
  );
  const syncRmsMs = toFiniteNumber(syncStatus.rmsMs);

  const trackBalls = Array.isArray(tracksData?.balls) ? tracksData.balls : [];
  const confidences = trackBalls.flatMap((ball) =>
    (ball.frames ?? [])
      .map((frame) => frame.confidence)
      .filter((v): v is number => Number.isFinite(v)),
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
  const gtAxis = computeGtAxisMetrics(positions3d, positions3dGt);
  const gtDepthFit = computeGtDepthFit(positions3d, positions3dGt);
  const intrinsicsByCamera = new Map<number, CameraIntrinsicsLike>();
  for (const i of intrinsics ?? []) {
    const id = toFiniteNumber(i?.camera_id);
    if (id === null) continue;
    intrinsicsByCamera.set(id, i);
  }
  const reproj = computeReprojectionMetrics(
    positions3d,
    stereoExtrinsics,
    tracksData,
    intrinsicsByCamera,
  );

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
    score -= 0.18;
  } else if (avgTrackConfidence < 0.75) {
    checks.push({
      id: "track-confidence",
      label: "Tracking confidence",
      status: "fail",
      value: avgTrackConfidence.toFixed(3),
    });
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
    checks.push({
      id: "linearity",
      label: "Trajectory linearity check",
      status: maxLineDeviationM > 0.06 ? "warn" : "pass",
      value: formatM(maxLineDeviationM),
      details:
        maxLineDeviationM > 0.06
          ? "Curvature exceeds expected straight-line motion envelope."
          : undefined,
    });
    if (maxLineDeviationM > 0.06) score -= 0.12;
  }

  if (gtRmseM !== null) {
    if (gtRmseM > 0.05) {
      checks.push({
        id: "gt-rmse",
        label: "Synthetic ground-truth RMSE",
        status: "fail",
        value: formatM(gtRmseM),
      });
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
  if (gtAxis.worstFrame !== null && gtAxis.worstFrameError !== null) {
    checks.push({
      id: "gt-worst-frame",
      label: "Worst GT error frame",
      status: gtAxis.worstFrameError > 0.05 ? "warn" : "pass",
      value: `f${gtAxis.worstFrame} · ${formatM(gtAxis.worstFrameError)}`,
    });
  }
  if (gtAxis.rmseX !== null && gtAxis.rmseY !== null && gtAxis.rmseZ !== null) {
    checks.push({
      id: "gt-axis",
      label: "GT RMSE axis split",
      status: "pass",
      value: `x:${formatM(gtAxis.rmseX)} y:${formatM(gtAxis.rmseY)} z:${formatM(gtAxis.rmseZ)}`,
    });
  }
  if (
    gtDepthFit.scale !== null &&
    gtDepthFit.offsetM !== null &&
    gtDepthFit.rmseZFitM !== null &&
    gtDepthFit.improvementPct !== null
  ) {
    checks.push({
      id: "gt-depth-fit",
      label: "GT depth bias fit (z' = a*z + b)",
      status: gtDepthFit.improvementPct > 20 ? "warn" : "pass",
      value: `a:${gtDepthFit.scale.toFixed(4)} b:${formatM(gtDepthFit.offsetM)} rmse_z:${formatM(gtDepthFit.rmseZFitM)} (${gtDepthFit.improvementPct.toFixed(1)}%)`,
      details:
        gtDepthFit.improvementPct > 20
          ? "Large post-fit improvement suggests systematic depth scale/offset bias."
          : undefined,
    });
  }

  if (reproj.rmseCam0 !== null && reproj.rmseCam1 !== null) {
    const maxReproj = Math.max(reproj.rmseCam0, reproj.rmseCam1);
    checks.push({
      id: "reproj-residual",
      label: "2D reprojection residual",
      status: maxReproj > 3 ? "warn" : "pass",
      value: `cam0:${formatPx(reproj.rmseCam0)} cam1:${formatPx(reproj.rmseCam1)}`,
    });
    if (maxReproj > 3) score -= 0.08;
  }
  if (reproj.worstFrame !== null && reproj.worstError !== null) {
    checks.push({
      id: "reproj-worst-frame",
      label: "Worst reprojection frame",
      status: reproj.worstError > 5 ? "warn" : "pass",
      value: `f${reproj.worstFrame} · ${formatPx(reproj.worstError)}`,
    });
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
      gtRmseXm: gtAxis.rmseX,
      gtRmseYm: gtAxis.rmseY,
      gtRmseZm: gtAxis.rmseZ,
      gtBiasXm: gtAxis.biasX,
      gtBiasYm: gtAxis.biasY,
      gtBiasZm: gtAxis.biasZ,
      gtWorstFrame: gtAxis.worstFrame,
      gtWorstFrameErrorM: gtAxis.worstFrameError,
      gtDepthFitScale: gtDepthFit.scale,
      gtDepthFitOffsetM: gtDepthFit.offsetM,
      gtDepthFitRmseZm: gtDepthFit.rmseZFitM,
      gtDepthFitImprovementPct: gtDepthFit.improvementPct,
      reprojRmseCam0Px: reproj.rmseCam0,
      reprojRmseCam1Px: reproj.rmseCam1,
      reprojWorstFrame: reproj.worstFrame,
      reprojWorstErrorPx: reproj.worstError,
    },
  };
};
