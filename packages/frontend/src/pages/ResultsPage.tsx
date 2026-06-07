import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useResultsStore } from '../stores/resultsStore';
import { useSessionStore } from '../stores/sessionStore';
import { downloadBlob, exportCSV, exportJSON, exportPDF } from '../lib/export';
import { Button } from '../components/ui/Button';
import { FrameScrubber } from '../components/FrameScrubber';
import { ThreeDScene } from '../components/ThreeDScene';
import type { PhysicsResult } from '../types';
import { useTrackingStore } from '../stores/trackingStore';

const BALL_COLORS = ['#10b981', '#3b82f6', '#f43f5e'];

const formatWithUncertainty = (value: number, uncertainty: number, digits = 3) =>
  `${value.toFixed(digits)} +/- ${uncertainty.toFixed(digits)}`;

export const ResultsPage = () => {
  const { experimentId, ballConfigs } = useSessionStore();
  const { physicsResult, status, requestPhysics, onPhysicsResult, onPhysicsFailed } =
    useResultsStore();
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);
  const autoRequestedForExperimentId = useRef<string | null>(null);
  const currentFrame = useTrackingStore((state) => state.currentFrame);
  const setFrame = useTrackingStore((state) => state.setFrame);

  const chartSeries = useMemo(
    () =>
      physicsResult?.velocityTimeSeries.map((series) => ({
        ballId: series.ballId,
        color: BALL_COLORS[series.ballId % BALL_COLORS.length],
        rows: series.points.map((point) => ({
          timeMs: point.time_ms,
          velocity: point.v,
          vLow: point.v - point.v_uncertainty,
          vHigh: point.v + point.v_uncertainty,
        })),
      })) ?? [],
    [physicsResult],
  );

  const handleComputePhysics = async () => {
    if (!experimentId) {
      setError('Create an experiment before computing physics.');
      return;
    }

    requestPhysics();
    setError(null);

    try {
      const response = await fetch(`/api/experiments/${experimentId}/physics`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ massConfigs: ballConfigs }),
      });

      if (!response.ok) {
        let errorMessage = `Physics request failed (${response.status})`;
        try {
          const payload = (await response.json()) as { error?: unknown };
          if (typeof payload?.error === 'string' && payload.error.trim()) {
            errorMessage = payload.error;
          }
        } catch {
          // Ignore non-JSON bodies.
        }
        throw new Error(errorMessage);
      }

      const result = (await response.json()) as PhysicsResult;
      onPhysicsResult(result);
    } catch (requestError) {
      const message =
        requestError instanceof Error ? requestError.message : 'Unable to compute physics';
      onPhysicsFailed(message);
      setError(message);
    }
  };

  useEffect(() => {
    if (!physicsResult && status === 'idle' && experimentId) {
      if (autoRequestedForExperimentId.current === experimentId) return;
      autoRequestedForExperimentId.current = experimentId;
      handleComputePhysics();
    }
  }, [experimentId, physicsResult, status]);

  const trajectoryFrameCount = useMemo(() => {
    if (!physicsResult) return 0;
    const maxByBall = physicsResult.balls.map(
      (ball) => Math.max(...(ball.trajectory3d?.map((point) => point.frameIdx) ?? [0])) + 1,
    );
    return Math.max(0, ...maxByBall);
  }, [physicsResult]);

  const flaggedFrames = useMemo(() => {
    if (!physicsResult) return [];
    const flagged = new Set<number>();
    physicsResult.balls.forEach((ball) =>
      (ball.trajectory3d ?? []).forEach((point) => {
        if (point.flagged) flagged.add(point.frameIdx);
      }),
    );
    return [...flagged].sort((left, right) => left - right);
  }, [physicsResult]);

  useEffect(() => {
    if (!isPlaying || trajectoryFrameCount <= 1) return;
    const timer = window.setInterval(() => {
      setFrame((previousFrame) => {
        if (previousFrame >= trajectoryFrameCount - 1) return 0;
        return previousFrame + 1;
      });
    }, 33);
    return () => window.clearInterval(timer);
  }, [isPlaying, trajectoryFrameCount, setFrame]);

  const handleExportCsv = () => {
    if (!physicsResult) return;
    const content = exportCSV(physicsResult);
    downloadBlob(new Blob([content], { type: 'text/csv;charset=utf-8' }), 'physics-results.csv');
  };

  const handleExportJson = () => {
    if (!physicsResult) return;
    const content = exportJSON(physicsResult);
    downloadBlob(
      new Blob([content], { type: 'application/json;charset=utf-8' }),
      'physics-results.json',
    );
  };

  const handleExportPdf = async () => {
    if (!physicsResult || !exportRef.current) return;

    setIsExportingPdf(true);
    try {
      const blob = await exportPDF(exportRef.current);
      downloadBlob(blob, 'physics-results.pdf');
    } finally {
      setIsExportingPdf(false);
    }
  };

  return (
    <div className="mx-auto max-w-7xl py-6 px-4 sm:px-6 lg:px-8 space-y-6">
      <header className="surface-panel flex flex-wrap items-center justify-between gap-5 p-5 transition-all duration-300 glitch-in stagger-1">
        <div className="space-y-1">
          <p className="eyebrow">Collision Analysis</p>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl sm:text-3xl">Final Report</h1>
            {physicsResult?.syncStatus && (
              <div
                className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                  physicsResult.syncStatus.isMock
                    ? 'bg-amber-500/10 text-amber-500 border border-amber-500/20'
                    : 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/20'
                }`}
              >
                {physicsResult.syncStatus.isMock ? (
                  <span>Estimated (30 FPS)</span>
                ) : (
                  <span>Scientific Grade ({physicsResult.syncStatus.trueFps?.toFixed(2)} FPS)</span>
                )}
              </div>
            )}
          </div>
          <p className="subtle-copy max-w-2xl text-xs">
            Momentum, energy and velocity bands with uncertainty propagation.
            {physicsResult?.syncStatus && !physicsResult.syncStatus.isMock && (
              <span className="ml-1 text-emerald-500/60">
                (Timing jitter: {physicsResult.syncStatus.rmsMs?.toFixed(2)}ms RMS)
              </span>
            )}
          </p>
        </div>
        <div className="flex gap-3">
          <Button
            variant="alt"
            onClick={handleComputePhysics}
            disabled={status === 'computing'}
            className="px-5 py-2 text-xs"
          >
            {status === 'computing' ? 'Recomputing...' : 'Recompute'}
          </Button>
          {physicsResult && (
            <div className="flex gap-2">
              <Button variant="alt" onClick={handleExportCsv} className="px-4 py-2 text-[10px]">
                CSV
              </Button>
              <Button variant="alt" onClick={handleExportJson} className="px-4 py-2 text-[10px]">
                JSON
              </Button>
              <Button
                variant="main"
                onClick={handleExportPdf}
                disabled={isExportingPdf}
                className="px-6 py-2 text-xs"
              >
                {isExportingPdf ? 'Saving...' : 'Export PDF'}
              </Button>
            </div>
          )}
        </div>
      </header>

      {error && (
        <div className="rounded-xl border border-[var(--accent)] bg-[var(--accent)]/10 px-4 py-3 text-xs font-medium text-[var(--accent)]">
          {error}
        </div>
      )}

      {!physicsResult ? (
        <div className="surface-panel p-12 text-center text-slate-500 glitch-in stagger-2">
          {status === 'computing' ? (
            <div className="flex flex-col items-center gap-4">
              <div className="w-8 h-8 border-3 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
              <p className="eyebrow">Generating Physics Model...</p>
            </div>
          ) : (
            <p className="eyebrow">Run physics to generate collision metrics.</p>
          )}
        </div>
      ) : (
        <div className="space-y-6">
          <section className="grid gap-4 md:grid-cols-2 lg:grid-cols-4 glitch-in stagger-2">
            <article className="surface-panel p-4 border-l-4 border-l-[var(--accent)]">
              <p className="eyebrow text-[9px]">Momentum Conserved</p>
              <p className="mt-2 text-xl font-bold text-slate-100">
                {formatWithUncertainty(
                  physicsResult.system.momentum_conserved_pct.value,
                  physicsResult.system.momentum_conserved_pct.uncertainty,
                  2,
                )}
                %
              </p>
            </article>
            <article className="surface-panel p-4 border-l-4 border-l-sky-500">
              <p className="eyebrow text-[9px]">Restitution Coeff (e)</p>
              <p className="mt-2 text-xl font-bold text-slate-100">
                {formatWithUncertainty(
                  physicsResult.system.coeff_of_restitution.value,
                  physicsResult.system.coeff_of_restitution.uncertainty,
                  3,
                )}
              </p>
            </article>
            <article className="surface-panel p-4 border-l-4 border-l-emerald-500">
              <p className="eyebrow text-[9px]">Collision Point</p>
              <p className="mt-2 text-xl font-bold text-slate-100">
                Frame {physicsResult.system.collision_frame_idx}
              </p>
            </article>
            <article className="surface-panel p-4 border-l-4 border-l-amber-500">
              <p className="eyebrow text-[9px]">System KE (Pre-Collision)</p>
              <p className="mt-2 text-xl font-bold text-slate-100">
                {physicsResult.system.ke_before_total.value.toFixed(4)} J
              </p>
            </article>
          </section>

          <div ref={exportRef} className="grid gap-6 lg:grid-cols-[1fr_350px] items-start">
            <div className="space-y-6">
              {trajectoryFrameCount > 0 && (
                <section className="space-y-3">
                  <ThreeDScene
                    balls={physicsResult.balls}
                    currentFrame={Math.min(currentFrame, Math.max(trajectoryFrameCount - 1, 0))}
                    reconstruction3d={physicsResult.reconstruction3d}
                  />
                  <FrameScrubber
                    currentFrame={Math.min(currentFrame, Math.max(trajectoryFrameCount - 1, 0))}
                    frameCount={Math.max(trajectoryFrameCount, 1)}
                    onFrameChange={setFrame}
                    isPlaying={isPlaying}
                    onPlayToggle={() => setIsPlaying((playing) => !playing)}
                    flaggedFrames={flaggedFrames}
                    variant="compact"
                  />
                </section>
              )}
              <section className="surface-panel p-5 glitch-in stagger-3">
                <div className="mb-4 flex items-center justify-between">
                  <h2 className="text-lg">Velocity Dynamics</h2>
                  <span className="ui-pill text-[9px]">Time-Series Uncertainty</span>
                </div>
                <div className="space-y-8">
                  {chartSeries.map((series) => (
                    <div key={`chart-${series.ballId}`} className="h-[200px] w-full">
                      <div className="flex items-center gap-2 mb-2">
                        <div
                          className="w-2 h-2 rounded-full"
                          style={{ backgroundColor: series.color }}
                        />
                        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                          Ball {series.ballId + 1} Velocity (m/s)
                        </p>
                      </div>
                      <ResponsiveContainer>
                        <LineChart
                          data={series.rows}
                          margin={{ top: 5, right: 5, left: -20, bottom: 0 }}
                        >
                          <CartesianGrid strokeDasharray="3 3" stroke="#25364e" vertical={false} />
                          <XAxis
                            dataKey="timeMs"
                            stroke="#475569"
                            fontSize={9}
                            tickFormatter={(value) => `${(value / 1000).toFixed(2)}s`}
                          />
                          <YAxis stroke="#475569" fontSize={9} unit="m/s" />
                          <Tooltip
                            contentStyle={{
                              background: '#0f172a',
                              border: '1px solid #334155',
                              borderRadius: '8px',
                              fontSize: '10px',
                            }}
                            labelFormatter={(value) => `t = ${(Number(value) / 1000).toFixed(3)}s`}
                          />
                          <Line
                            type="monotone"
                            dataKey="velocity"
                            stroke={series.color}
                            dot={false}
                            strokeWidth={2}
                            isAnimationActive={false}
                          />
                          <Line
                            type="monotone"
                            dataKey="vLow"
                            stroke={series.color}
                            strokeDasharray="4 4"
                            dot={false}
                            strokeWidth={1}
                            opacity={0.3}
                            isAnimationActive={false}
                          />
                          <Line
                            type="monotone"
                            dataKey="vHigh"
                            stroke={series.color}
                            strokeDasharray="4 4"
                            dot={false}
                            strokeWidth={1}
                            opacity={0.3}
                            isAnimationActive={false}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  ))}
                </div>
              </section>
            </div>

            <aside className="space-y-6" style={{ animationDelay: '150ms' }}>
              <section className="surface-panel p-5 glitch-in stagger-3">
                <h3 className="text-sm font-bold uppercase tracking-wider text-slate-400 mb-4">
                  Momentum Flow
                </h3>
                <div className="space-y-3">
                  {physicsResult.balls.map((ball) => (
                    <article
                      key={`p-${ball.ballId}`}
                      className="surface-soft p-3 rounded-xl border border-[var(--line)]"
                    >
                      <div className="flex justify-between mb-2">
                        <span className="text-[9px] font-bold uppercase text-slate-500">
                          Ball {ball.ballId + 1}
                        </span>
                        <div
                          className="w-1.5 h-1.5 rounded-full"
                          style={{ backgroundColor: BALL_COLORS[ball.ballId % BALL_COLORS.length] }}
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <p className="text-[8px] uppercase text-slate-500 mb-1">Before</p>
                          <p className="text-xs font-mono text-slate-200">
                            {ball.p_before.value.toFixed(3)}
                          </p>
                        </div>
                        <div>
                          <p className="text-[8px] uppercase text-slate-500 mb-1">After</p>
                          <p className="text-xs font-mono text-slate-200">
                            {ball.p_after.value.toFixed(3)}
                          </p>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              </section>

              <section className="surface-panel p-5 glitch-in stagger-4">
                <h3 className="text-sm font-bold uppercase tracking-wider text-slate-400 mb-4">
                  Energy (J)
                </h3>
                <div className="space-y-3">
                  {physicsResult.balls.map((ball) => (
                    <article
                      key={`ke-${ball.ballId}`}
                      className="surface-soft p-3 rounded-xl border border-[var(--line)]"
                    >
                      <div className="flex justify-between mb-2">
                        <span className="text-[9px] font-bold uppercase text-slate-500">
                          Ball {ball.ballId + 1}
                        </span>
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <p className="text-[8px] uppercase text-slate-500 mb-1">Pre</p>
                          <p className="text-xs font-mono text-emerald-400">
                            {ball.ke_before.value.toFixed(4)}
                          </p>
                        </div>
                        <div>
                          <p className="text-[8px] uppercase text-slate-500 mb-1">Post</p>
                          <p className="text-xs font-mono text-rose-400">
                            {ball.ke_after.value.toFixed(4)}
                          </p>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            </aside>
          </div>
        </div>
      )}
    </div>
  );
};
