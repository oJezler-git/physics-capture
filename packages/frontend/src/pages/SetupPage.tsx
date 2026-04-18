import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import QRCode from 'qrcode';
import { useSessionStore } from '../stores/sessionStore';
import { wsClient } from '../lib/wsClient';
import type { BallMassConfig } from '../types';

type ConnectionMode = 'local' | 'public';
type ConnectionSource = 'auto' | 'env' | 'browser';
type HostHintResponse = {
  preferredHost?: string | null;
};

const parseHost = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return '';

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      return new URL(trimmed).hostname;
    } catch {
      return trimmed;
    }
  }

  return trimmed.split(':')[0];
};

const isLoopbackHostname = (hostname: string) =>
  hostname === 'localhost' ||
  hostname === '0.0.0.0' ||
  hostname === '127.0.0.1' ||
  hostname === '::1';

const isLocalHostname = (hostname: string) => {
  if (!hostname) return false;
  if (isLoopbackHostname(hostname)) return true;
  if (hostname.endsWith('.local')) return true;
  if (/^127\./.test(hostname)) return true;
  if (/^10\./.test(hostname)) return true;
  if (/^192\.168\./.test(hostname)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)) return true;
  return false;
};

const withOptionalPort = (scheme: string, host: string, port: string) => {
  const defaultPort = scheme === 'https' || scheme === 'wss' ? '443' : '80';
  const hasPort = port && port !== defaultPort;
  return `${scheme}://${host}${hasPort ? `:${port}` : ''}`;
};

const normalizeSessionId = (value: string) => value.trim().toLowerCase();

const toInviteCode = (sessionId: string) => {
  const cleaned = sessionId.replace(/[^a-z0-9]/gi, '').toUpperCase();
  const padded = `${cleaned}XXXXXXXXXX`.slice(0, 10);
  return `${padded.slice(0, 5)}-${padded.slice(5, 10)}`;
};

const getConnectionDetails = (autoDetectedHost: string) => {
  const configuredHost = parseHost(import.meta.env.VITE_APP_HOST || '');
  const browserHost = window.location.hostname;

  let source: ConnectionSource = 'browser';
  let host = browserHost;
  if (isLoopbackHostname(browserHost)) {
    if (autoDetectedHost) {
      source = 'auto';
      host = autoDetectedHost;
    } else if (configuredHost) {
      source = 'env';
      host = configuredHost;
    }
  }

  const mode: ConnectionMode = isLocalHostname(host) ? 'local' : 'public';

  const isLocal = isLocalHostname(host);
  const protocol = isLocal ? window.location.protocol.slice(0, -1) : 'https';
  const wsProtocol = protocol === 'https' ? 'wss' : 'ws';
  const port =
    import.meta.env.VITE_APP_PORT || window.location.port || (protocol === 'https' ? '443' : '80');

  return {
    host,
    port,
    mode,
    source,
    protocol,
    wsProtocol,
    webOrigin: withOptionalPort(protocol, host, port),
    wsOrigin: withOptionalPort(wsProtocol, host, port),
  };
};

const ballTone = ['#4cc3ff', '#9ad46f', '#ff7244'];

export const SetupPage = () => {
  const navigate = useNavigate();
  const { experimentId, cameras, ballConfigs, createExperiment, setBallConfig, advancePhase } =
    useSessionStore();

  const [qrCodeUrl, setQrCodeUrl] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<'url' | 'code' | 'session' | null>(null);
  const [autoDetectedHost, setAutoDetectedHost] = useState('');

  useEffect(() => {
    if (!isLoopbackHostname(window.location.hostname)) return;

    const controller = new AbortController();

    const resolveHostHint = async () => {
      try {
        const response = await fetch('/api/network/host-hint', { signal: controller.signal });
        if (!response.ok) return;
        const data = (await response.json()) as HostHintResponse;
        const host = parseHost(data.preferredHost || '');
        if (!host || isLoopbackHostname(host)) return;
        setAutoDetectedHost(host);
      } catch {
        // Best-effort fallback to existing host logic.
      }
    };

    void resolveHostHint();
    return () => controller.abort();
  }, []);

  const connection = useMemo(() => getConnectionDetails(autoDetectedHost), [autoDetectedHost]);
  const sessionId = experimentId ? normalizeSessionId(experimentId) : '';
  const roomId = sessionId ? `exp-${sessionId}` : '';
  const inviteCode = sessionId ? toInviteCode(sessionId) : '';
  const params = new URLSearchParams();
  if (roomId) params.set('room', roomId);
  if (inviteCode) params.set('code', inviteCode);
  if (sessionId) params.set('sid', sessionId);
  const phoneUrl = `${connection.webOrigin}/phone${params.size ? `?${params.toString()}` : ''}`;
  const wsUrl = `${connection.wsOrigin}/ws`;

  useEffect(() => {
    if (!experimentId || !roomId) return;

    QRCode.toDataURL(phoneUrl, { width: 256, margin: 2 }, (qrError, url) => {
      if (!qrError) setQrCodeUrl(url);
    });

    wsClient.send({ type: 'join', roomId, clientId: 'pc', role: 'pc' });
  }, [experimentId, phoneUrl, roomId]);

  const copyText = async (value: string, target: 'url' | 'code' | 'session') => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(target);
      setTimeout(() => setCopied((current) => (current === target ? null : current)), 1500);
    } catch {
      // Ignore clipboard errors.
    }
  };

  const handleNewSession = async () => {
    setLoading(true);
    setError(null);
    try {
      const nextId =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
      createExperiment(nextId);
      setBallConfig(0, { ballId: 0, mass_g: 50, uncertainty_g: 1 });
      setBallConfig(1, { ballId: 1, mass_g: 50, uncertainty_g: 1 });
    } catch {
      setError('Could not create a new session. Check backend services and retry.');
    } finally {
      setLoading(false);
    }
  };

  const updateBallMass = (index: number, field: keyof BallMassConfig, value: number) => {
    const current = ballConfigs[index] || {
      ballId: index,
      mass_g: 0,
      uncertainty_g: 0,
    };
    setBallConfig(index, { ...current, [field]: value });
  };

  const addBall = () => {
    if (ballConfigs.length < 3) {
      setBallConfig(ballConfigs.length, {
        ballId: ballConfigs.length,
        mass_g: 50,
        uncertainty_g: 1,
      });
    }
  };

  const canProceed = experimentId && cameras.length > 0 && ballConfigs.length > 0;

  return (
    <div className="mx-auto max-w-7xl space-y-6 rise-in">
      <header className="surface-panel flex flex-wrap items-end justify-between gap-5 p-7">
        <div className="space-y-2">
          <p className="eyebrow">Phase 01 - Session Setup</p>
          <h1 className="text-3xl sm:text-4xl">Build Capture Session</h1>
          <p className="subtle-copy max-w-2xl">
            Pair recording phones with a canonical room ID, portable invite URL, and readable quick
            code.
          </p>
        </div>
        {!experimentId ? (
          <button onClick={handleNewSession} disabled={loading} className="btn-main">
            {loading ? 'Creating Session...' : 'Create Session'}
          </button>
        ) : (
          <div className="ui-pill">Session active</div>
        )}
      </header>

      {error ? (
        <div className="surface-soft border-rose-400/45 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
          {error}
        </div>
      ) : null}

      {experimentId ? (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.25fr_1fr]">
          <section className="surface-panel space-y-5 p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="eyebrow">Phone Handshake</p>
                <h2 className="mt-1 text-2xl">Device Entry Portal</h2>
              </div>
              <div className="flex flex-wrap gap-2">
                <span className="ui-pill border-sky-400/35 text-sky-100">Code {inviteCode}</span>
                <span
                  className={`ui-pill ${connection.mode === 'local' ? 'border-lime-400/35 text-lime-100' : 'border-orange-400/35 text-orange-100'}`}
                >
                  {connection.mode === 'local' ? 'Local Network' : 'Public Tunnel'}
                </span>
              </div>
            </div>

            <div className="grid gap-5 lg:grid-cols-[300px_1fr]">
              <div className="surface-soft flex flex-col items-center justify-center gap-3 border-slate-700/70 bg-slate-50 p-4">
                {qrCodeUrl ? (
                  <img src={qrCodeUrl} alt="Join QR code" className="h-56 w-56 rounded-lg" />
                ) : (
                  <div className="h-56 w-56 animate-pulse rounded-lg bg-slate-200" />
                )}
              </div>

              <div className="space-y-4">
                <div className="surface-soft space-y-3 p-4">
                  <p className="eyebrow">Invite Details</p>
                  <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Quick code</p>
                  <div className="flex items-center gap-2">
                    <p className="break-all font-mono text-sm text-slate-200">{inviteCode}</p>
                    <button
                      onClick={() => copyText(inviteCode, 'code')}
                      className="btn-alt px-2 py-1 text-[10px]"
                    >
                      {copied === 'code' ? 'Copied' : 'Copy'}
                    </button>
                  </div>

                  <p className="pt-1 text-xs uppercase tracking-[0.16em] text-slate-500">
                    Session key
                  </p>
                  <div className="flex items-center gap-2">
                    <p className="break-all font-mono text-xs text-slate-300">{sessionId}</p>
                    <button
                      onClick={() => copyText(sessionId, 'session')}
                      className="btn-alt px-2 py-1 text-[10px]"
                    >
                      {copied === 'session' ? 'Copied' : 'Copy'}
                    </button>
                  </div>

                  <p className="pt-1 text-xs uppercase tracking-[0.16em] text-slate-500">
                    Invite URL
                  </p>
                  <div className="flex items-start gap-2">
                    <p className="break-all text-xs text-slate-400">{phoneUrl}</p>
                    <button
                      onClick={() => copyText(phoneUrl, 'url')}
                      className="btn-alt mt-0.5 px-2 py-1 text-[10px]"
                    >
                      {copied === 'url' ? 'Copied' : 'Copy'}
                    </button>
                  </div>

                  <p className="text-sm text-slate-200 break-all">
                    WebSocket <span className="text-slate-400">{wsUrl}</span>
                  </p>
                  <p className="text-xs text-slate-500">
                    Host source{' '}
                    {connection.source === 'auto'
                      ? 'auto-detected LAN IP'
                      : connection.source === 'env'
                        ? 'VITE_APP_HOST override'
                        : 'browser URL'}
                  </p>
                </div>

                <div className="surface-soft p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <p className="eyebrow">Connected Devices</p>
                    <span className="ui-pill">{cameras.length} linked</span>
                  </div>
                  {cameras.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-slate-700 p-6 text-center text-sm text-slate-400">
                      Waiting for phones to join...
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {cameras.map((camera, index) => (
                        <div
                          key={camera.id}
                          className="rounded-xl border border-slate-700/80 bg-slate-950/70 px-3 py-2"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="flex items-center gap-3">
                              <span
                                className="h-2.5 w-2.5 rounded-full"
                                style={{ background: ballTone[index % ballTone.length] }}
                              />
                              <span className="text-sm font-semibold text-slate-100">
                                {camera.label}
                              </span>
                            </div>
                            <span
                              className={`ui-pill px-2 py-0.5 text-[10px] ${camera.status === 'live' ? 'border-lime-400/35 text-lime-100' : 'border-amber-300/35 text-amber-100'}`}
                            >
                              {camera.status}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </section>

          <section className="surface-panel space-y-5 p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="eyebrow">Mass Profile</p>
                <h2 className="mt-1 text-2xl">Ball Configuration</h2>
              </div>
              <button onClick={addBall} disabled={ballConfigs.length >= 3} className="btn-alt py-2">
                Add Ball
              </button>
            </div>

            <div className="space-y-3">
              {ballConfigs.map((config, index) => (
                <article key={index} className="surface-soft space-y-3 p-4">
                  <div className="flex items-center justify-between">
                    <span className="eyebrow text-[9px]">Ball {index + 1}</span>
                    <span
                      className="h-3 w-3 rounded-full"
                      style={{ background: ballTone[index % ballTone.length] }}
                    />
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="space-y-1">
                      <span className="text-xs text-slate-400">Mass (g)</span>
                      <input
                        type="number"
                        value={config.mass_g}
                        onChange={(event) =>
                          updateBallMass(index, 'mass_g', parseFloat(event.target.value))
                        }
                        className="field-shell"
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="text-xs text-slate-400">Uncertainty (+/- g)</span>
                      <input
                        type="number"
                        value={config.uncertainty_g}
                        onChange={(event) =>
                          updateBallMass(index, 'uncertainty_g', parseFloat(event.target.value))
                        }
                        className="field-shell"
                      />
                    </label>
                  </div>
                </article>
              ))}
            </div>

            <div className="pt-3">
              <button
                disabled={!canProceed}
                onClick={() => {
                  advancePhase();
                  navigate('/calibration');
                }}
                className="btn-main w-full"
              >
                Continue to Calibration
              </button>
              {!canProceed ? (
                <p className="mt-2 text-center text-xs text-slate-500">
                  At least one recording device must be connected.
                </p>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
};
