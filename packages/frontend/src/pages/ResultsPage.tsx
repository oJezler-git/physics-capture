import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CartesianGrid,
  Legend,
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
import { LoadingSkeleton } from '../components/LoadingSkeleton';
import type { PhysicsResult } from '../types';

const BALL_COLORS = ['#4cc3ff', '#9ad46f', '#ff7244'];

const formatWithUncertainty = (value: number, uncertainty: number, digits = 3) =>
  `${value.toFixed(digits)} +/- ${uncertainty.toFixed(digits)}`;

export const ResultsPage = () => {
  const { experimentId, ballConfigs } = useSessionStore();
  const { physicsResult, status, requestPhysics, onPhysicsResult, onPhysicsFailed } =
    useResultsStore();
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const exportRef = useRef<HTMLDivElement>(null);

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
        throw new Error(`Physics request failed (${response.status})`);
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
      handleComputePhysics();
    }
  }, [experimentId, physicsResult, status]);

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
    <div className="mx-auto max-w-7xl space-y-6 rise-in">
      <header className="surface-panel space-y-4 p-7">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="eyebrow">Phase 05 - Results</p>
            <h1 className="mt-1 text-3xl sm:text-4xl">Collision Output Report</h1>
            <p className="subtle-copy mt-2">
              Momentum, energy and velocity bands with uncertainty propagation.
            </p>
          </div>
          <button onClick={handleComputePhysics} disabled={status === 'computing'} className="btn-main">
            {status === 'computing' ? 'Computing...' : 'Compute Physics'}
          </button>
        </div>
      </header>

      {error ? (
        <div className="rounded-xl border border-rose-400/35 bg-rose-500/10 px-4 py-2 text-sm text-rose-100">
          {error}
        </div>
      ) : null}

      {!physicsResult ? (
        <div className="surface-panel p-10 text-center text-slate-400">
          {status === 'computing' ? (
            <LoadingSkeleton lines={5} className="mx-auto max-w-xl text-left" />
          ) : (
            'Run physics to generate collision metrics and exportable reports.'
          )}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-3">
            <button onClick={handleExportCsv} className="btn-alt py-2">
              Export CSV
            </button>
            <button onClick={handleExportJson} className="btn-alt py-2">
              Export JSON
            </button>
            <button onClick={handleExportPdf} disabled={isExportingPdf} className="btn-alt py-2">
              {isExportingPdf ? 'Rendering PDF...' : 'Export PDF'}
            </button>
          </div>

          <div ref={exportRef} className="surface-panel space-y-6 p-6">
            <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <article className="metric-card">
                <p className="eyebrow">Momentum Conserved</p>
                <p className="mt-2 text-lg font-semibold text-slate-100">
                  {formatWithUncertainty(
                    physicsResult.system.momentum_conserved_pct.value,
                    physicsResult.system.momentum_conserved_pct.uncertainty,
                    2,
                  )}
                  %
                </p>
              </article>
              <article className="metric-card">
                <p className="eyebrow">Coefficient of Restitution</p>
                <p className="mt-2 text-lg font-semibold text-slate-100">
                  {formatWithUncertainty(
                    physicsResult.system.coeff_of_restitution.value,
                    physicsResult.system.coeff_of_restitution.uncertainty,
                    3,
                  )}
                </p>
              </article>
              <article className="metric-card">
                <p className="eyebrow">Collision Frame</p>
                <p className="mt-2 text-lg font-semibold text-slate-100">
                  {physicsResult.system.collision_frame_idx}
                </p>
              </article>
              <article className="metric-card">
                <p className="eyebrow">Total KE Before (J)</p>
                <p className="mt-2 text-lg font-semibold text-slate-100">
                  {formatWithUncertainty(
                    physicsResult.system.ke_before_total.value,
                    physicsResult.system.ke_before_total.uncertainty,
                    4,
                  )}
                </p>
              </article>
            </section>

            <section className="surface-soft p-4">
              <h2 className="text-xl">Velocity vs Time</h2>
              <div className="mt-4 space-y-6">
                {chartSeries.map((series) => (
                  <div key={`chart-${series.ballId}`} className="h-[230px] w-full">
                    <p className="mb-2 text-sm font-semibold text-slate-200">Ball {series.ballId + 1}</p>
                    <ResponsiveContainer>
                      <LineChart
                        data={series.rows}
                        margin={{ top: 10, right: 12, left: 0, bottom: 4 }}
                      >
                        <CartesianGrid strokeDasharray="4 4" stroke="#25364e" />
                        <XAxis
                          dataKey="timeMs"
                          stroke="#8aa0c2"
                          tickFormatter={(value) => `${(value / 1000).toFixed(2)}s`}
                        />
                        <YAxis stroke="#8aa0c2" unit=" m/s" />
                        <Tooltip
                          contentStyle={{ background: '#07101c', border: '1px solid #2a3a51' }}
                          labelFormatter={(value) => `t=${(Number(value) / 1000).toFixed(3)} s`}
                        />
                        <Legend />
                        <Line
                          type="monotone"
                          dataKey="velocity"
                          stroke={series.color}
                          dot={false}
                          strokeWidth={2.2}
                          name="velocity"
                          isAnimationActive={false}
                        />
                        <Line
                          type="monotone"
                          dataKey="vLow"
                          stroke={series.color}
                          strokeDasharray="4 4"
                          dot={false}
                          strokeWidth={1}
                          name="-sigma"
                          isAnimationActive={false}
                        />
                        <Line
                          type="monotone"
                          dataKey="vHigh"
                          stroke={series.color}
                          strokeDasharray="4 4"
                          dot={false}
                          strokeWidth={1}
                          name="+sigma"
                          isAnimationActive={false}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                ))}
              </div>
            </section>

            <section className="grid gap-6 lg:grid-cols-2">
              <article className="surface-soft p-4">
                <h3 className="text-lg">Momentum Table</h3>
                <table className="mt-3 w-full text-sm text-slate-200">
                  <thead className="text-xs uppercase tracking-[0.14em] text-slate-500">
                    <tr>
                      <th className="py-2 text-left">Ball</th>
                      <th className="py-2 text-left">Before (kg*m/s)</th>
                      <th className="py-2 text-left">After (kg*m/s)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {physicsResult.balls.map((ball) => (
                      <tr key={`momentum-${ball.ballId}`} className="border-t border-slate-800">
                        <td className="py-2">Ball {ball.ballId + 1}</td>
                        <td className="py-2">
                          {formatWithUncertainty(ball.p_before.value, ball.p_before.uncertainty)}
                        </td>
                        <td className="py-2">
                          {formatWithUncertainty(ball.p_after.value, ball.p_after.uncertainty)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </article>

              <article className="surface-soft p-4">
                <h3 className="text-lg">Energy Table</h3>
                <table className="mt-3 w-full text-sm text-slate-200">
                  <thead className="text-xs uppercase tracking-[0.14em] text-slate-500">
                    <tr>
                      <th className="py-2 text-left">Ball</th>
                      <th className="py-2 text-left">Before (J)</th>
                      <th className="py-2 text-left">After (J)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {physicsResult.balls.map((ball) => (
                      <tr key={`energy-${ball.ballId}`} className="border-t border-slate-800">
                        <td className="py-2">Ball {ball.ballId + 1}</td>
                        <td className="py-2">
                          {formatWithUncertainty(
                            ball.ke_before.value,
                            ball.ke_before.uncertainty,
                            4,
                          )}
                        </td>
                        <td className="py-2">
                          {formatWithUncertainty(ball.ke_after.value, ball.ke_after.uncertainty, 4)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </article>
            </section>
          </div>
        </>
      )}
    </div>
  );
};
