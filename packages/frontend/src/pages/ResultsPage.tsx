import { useMemo, useRef, useState } from 'react';
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
import { Download, FileSpreadsheet, FileText, Sigma, Zap } from 'lucide-react';
import { useResultsStore } from '../stores/resultsStore';
import { useSessionStore } from '../stores/sessionStore';
import { downloadBlob, exportCSV, exportJSON, exportPDF } from '../lib/export';
import { LoadingSkeleton } from '../components/LoadingSkeleton';
import type { PhysicsResult } from '../types';

const BALL_COLORS = ['#3b82f6', '#10b981', '#f59e0b'];

const buildMockResult = (experimentId: string): PhysicsResult => ({
  experimentId,
  computedAt: Date.now(),
  balls: [
    {
      ballId: 0,
      mass_kg: { value: 0.05, uncertainty: 0.001 },
      v_before: { value: 1.2, uncertainty: 0.05 },
      v_after: { value: -0.7, uncertainty: 0.06 },
      p_before: { value: 0.06, uncertainty: 0.003 },
      p_after: { value: -0.035, uncertainty: 0.003 },
      ke_before: { value: 0.036, uncertainty: 0.003 },
      ke_after: { value: 0.012, uncertainty: 0.001 },
    },
    {
      ballId: 1,
      mass_kg: { value: 0.05, uncertainty: 0.001 },
      v_before: { value: -0.4, uncertainty: 0.04 },
      v_after: { value: 0.9, uncertainty: 0.05 },
      p_before: { value: -0.02, uncertainty: 0.002 },
      p_after: { value: 0.045, uncertainty: 0.003 },
      ke_before: { value: 0.004, uncertainty: 0.0005 },
      ke_after: { value: 0.02, uncertainty: 0.002 },
    },
  ],
  system: {
    p_before_total: { value: 0.04, uncertainty: 0.004 },
    p_after_total: { value: 0.01, uncertainty: 0.004 },
    ke_before_total: { value: 0.04, uncertainty: 0.004 },
    ke_after_total: { value: 0.032, uncertainty: 0.003 },
    momentum_conserved_pct: { value: 97.1, uncertainty: 1.4 },
    coeff_of_restitution: { value: 0.82, uncertainty: 0.03 },
    collision_frame_idx: 126,
  },
  velocityTimeSeries: [
    {
      ballId: 0,
      points: Array.from({ length: 20 }, (_, index) => ({
        time_ms: index * 12,
        v: 1.2 - index * 0.1,
        v_uncertainty: 0.05,
      })),
    },
    {
      ballId: 1,
      points: Array.from({ length: 20 }, (_, index) => ({
        time_ms: index * 12,
        v: -0.4 + index * 0.07,
        v_uncertainty: 0.04,
      })),
    },
  ],
});

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
      if (window.location.hostname === 'localhost') {
        onPhysicsResult(buildMockResult(experimentId));
      } else {
        const message =
          requestError instanceof Error ? requestError.message : 'Unable to compute physics';
        onPhysicsFailed(message);
        setError(message);
      }
    }
  };

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
    <div className="mx-auto max-w-7xl space-y-6">
      <header className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-white">Results</h1>
            <p className="mt-2 text-sm text-slate-400">
              Momentum, energy, and velocity outputs with uncertainty bands.
            </p>
          </div>
          <button
            onClick={handleComputePhysics}
            disabled={status === 'computing'}
            className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-3 text-sm font-bold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-700"
          >
            <Zap size={16} /> {status === 'computing' ? 'Computing...' : 'Compute Physics'}
          </button>
        </div>
      </header>

      {error ? (
        <div className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      {!physicsResult ? (
        <div className="rounded-2xl border border-dashed border-slate-700 bg-slate-900/60 p-10 text-center text-slate-400">
          {status === 'computing' ? (
            <LoadingSkeleton lines={5} className="mx-auto max-w-xl text-left" />
          ) : (
            'Run physics to generate collision metrics and exportable reports.'
          )}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-3">
            <button
              onClick={handleExportCsv}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-4 py-2 text-sm text-slate-100 transition hover:bg-slate-800"
            >
              <FileSpreadsheet size={15} /> Export CSV
            </button>
            <button
              onClick={handleExportJson}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-4 py-2 text-sm text-slate-100 transition hover:bg-slate-800"
            >
              <FileText size={15} /> Export JSON
            </button>
            <button
              onClick={handleExportPdf}
              disabled={isExportingPdf}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-4 py-2 text-sm text-slate-100 transition hover:bg-slate-800 disabled:opacity-50"
            >
              <Download size={15} /> {isExportingPdf ? 'Rendering PDF...' : 'Export PDF'}
            </button>
          </div>

          <div
            ref={exportRef}
            className="space-y-6 rounded-2xl border border-slate-800 bg-slate-950/80 p-6"
          >
            <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <article className="rounded-xl border border-slate-800 bg-slate-900 p-4">
                <p className="text-xs uppercase tracking-wider text-slate-500">
                  Momentum Conserved
                </p>
                <p className="mt-2 text-xl font-bold text-white">
                  {formatWithUncertainty(
                    physicsResult.system.momentum_conserved_pct.value,
                    physicsResult.system.momentum_conserved_pct.uncertainty,
                    2,
                  )}
                  %
                </p>
              </article>
              <article className="rounded-xl border border-slate-800 bg-slate-900 p-4">
                <p className="text-xs uppercase tracking-wider text-slate-500">
                  Coefficient of Restitution
                </p>
                <p className="mt-2 text-xl font-bold text-white">
                  {formatWithUncertainty(
                    physicsResult.system.coeff_of_restitution.value,
                    physicsResult.system.coeff_of_restitution.uncertainty,
                    3,
                  )}
                </p>
              </article>
              <article className="rounded-xl border border-slate-800 bg-slate-900 p-4">
                <p className="text-xs uppercase tracking-wider text-slate-500">Collision Frame</p>
                <p className="mt-2 text-xl font-bold text-white">
                  {physicsResult.system.collision_frame_idx}
                </p>
              </article>
              <article className="rounded-xl border border-slate-800 bg-slate-900 p-4">
                <p className="inline-flex items-center gap-1 text-xs uppercase tracking-wider text-slate-500">
                  <Sigma size={12} /> Total KE Before
                </p>
                <p className="mt-2 text-xl font-bold text-white">
                  {formatWithUncertainty(
                    physicsResult.system.ke_before_total.value,
                    physicsResult.system.ke_before_total.uncertainty,
                    4,
                  )}{' '}
                  J
                </p>
              </article>
            </section>

            <section className="rounded-xl border border-slate-800 bg-slate-900 p-4">
              <h2 className="mb-4 text-base font-semibold text-white">Velocity vs Time</h2>
              <div className="space-y-6">
                {chartSeries.map((series) => (
                  <div key={`chart-${series.ballId}`} className="h-[220px] w-full">
                    <p className="mb-2 text-sm font-semibold text-slate-300">
                      Ball {series.ballId + 1}
                    </p>
                    <ResponsiveContainer>
                      <LineChart
                        data={series.rows}
                        margin={{ top: 10, right: 12, left: 0, bottom: 4 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                        <XAxis
                          dataKey="timeMs"
                          stroke="#94a3b8"
                          tickFormatter={(value) => `${(value / 1000).toFixed(2)}s`}
                        />
                        <YAxis stroke="#94a3b8" unit=" m/s" />
                        <Tooltip
                          contentStyle={{ background: '#0f172a', border: '1px solid #334155' }}
                          labelFormatter={(value) => `t=${(Number(value) / 1000).toFixed(3)} s`}
                        />
                        <Legend />
                        <Line
                          type="monotone"
                          dataKey="velocity"
                          stroke={series.color}
                          dot={false}
                          strokeWidth={2}
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
              <article className="rounded-xl border border-slate-800 bg-slate-900 p-4">
                <h3 className="mb-3 text-sm font-semibold text-white">Momentum Table</h3>
                <table className="w-full text-sm text-slate-200">
                  <thead className="text-xs uppercase tracking-wider text-slate-500">
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

              <article className="rounded-xl border border-slate-800 bg-slate-900 p-4">
                <h3 className="mb-3 text-sm font-semibold text-white">Energy Table</h3>
                <table className="w-full text-sm text-slate-200">
                  <thead className="text-xs uppercase tracking-wider text-slate-500">
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
