import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import QRCode from 'qrcode';
import { useSessionStore } from '../stores/sessionStore';
import { wsClient } from '../lib/wsClient';
import { Button } from '../components/ui/Button';
import type { RecordingMode } from '../types';

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
    if (configuredHost) {
      source = 'env';
      host = configuredHost;
    } else if (autoDetectedHost) {
      source = 'auto';
      host = autoDetectedHost;
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
  const {
    experimentId,
    cameras,
    recordingMode,
    createExperiment,
    setBallConfig,
    setRecordingMode,
    advancePhase,
  } = useSessionStore();

  const [qrCodeUrl, setQrCodeUrl] = useState<string>('');
  const [copied, setCopied] = useState<'url' | 'code' | 'session' | null>(null);
  const [autoDetectedHost, setAutoDetectedHost] = useState('');
  const initializedRef = useRef(false);

  useEffect(() => {
    if (initializedRef.current || experimentId) return;
    initializedRef.current = true;

    const nextId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
    createExperiment(nextId);
    setBallConfig(0, { ballId: 0, mass_g: 50, uncertainty_g: 1 });
    setBallConfig(1, { ballId: 1, mass_g: 50, uncertainty_g: 1 });
  }, [createExperiment, experimentId, setBallConfig]);

  useEffect(() => {
    if (!isLoopbackHostname(window.location.hostname)) return;
    if (parseHost(import.meta.env.VITE_APP_HOST || '')) return;

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
  if (recordingMode) params.set('recording', recordingMode);
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

  const recordingProfiles: Array<{
    mode: RecordingMode;
    label: string;
    description: string;
    disabled?: boolean;
  }> = [
    {
      mode: 'legacy',
      label: 'Legacy',
      description: 'Original lower-bitrate path. Small files, weakest detail.',
    },
    {
      mode: 'browser-high',
      label: 'Browser High',
      description: 'Recommended browser-only path with higher capture quality.',
    },
    {
      mode: 'future-extreme',
      label: 'Extreme',
      description: 'Future frame-capture path. Not implemented yet.',
      disabled: true,
    },
  ];

  const canProceed = Boolean(experimentId);

  return (
    <div className="mx-auto max-w-7xl py-6 px-4 sm:px-6 lg:px-8 space-y-6">
      <header className="surface-panel flex flex-wrap items-center justify-between gap-5 p-5 glitch-in stagger-1">
        <div className="space-y-1">
          <p className="eyebrow">Step 1/3</p>
          <h1 className="text-2xl sm:text-3xl">Setup</h1>
          <p className="subtle-copy max-w-2xl text-xs">
            Pair recording phone(s) or continue with local files.
          </p>
        </div>
        <div className="flex items-center gap-4">
          <div className="ui-pill hidden sm:flex">Session active</div>
          <Button
            variant="main"
            disabled={!canProceed}
            onClick={() => {
              advancePhase();
              navigate('/calibration');
            }}
            className="px-6 py-2"
          >
            Continue to Calibration
          </Button>
        </div>
      </header>

      {experimentId && (
        <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
          {/* Left Column: QR Code & Technical Details */}
          <section className="surface-panel flex flex-col gap-5 p-5 glitch-in stagger-2">
            <div className="surface-soft flex flex-col items-center justify-center gap-3 p-5 text-center">
              {qrCodeUrl ? (
                <div
                  className="rounded-[1rem] border bg-white p-1.5 shadow-sm"
                  style={{ borderColor: 'var(--line)' }}
                >
                  <img src={qrCodeUrl} alt="Join QR code" className="h-40 w-40" />
                </div>
              ) : (
                <div
                  className="h-40 w-40 animate-pulse bg-[var(--bg-panel)] border rounded-[1rem]"
                  style={{ borderColor: 'var(--line)' }}
                />
              )}
              <div className="w-full">
                <p className="eyebrow">Quick Code</p>
                <div className="mt-1 flex items-center justify-center gap-2">
                  <p className="font-mono text-xl font-bold tracking-widest text-[var(--accent)]">
                    {inviteCode}
                  </p>
                  <Button
                    variant="alt"
                    onClick={() => copyText(inviteCode, 'code')}
                    className="px-2.5 py-1 text-[10px]"
                  >
                    {copied === 'code' ? '✓' : 'Copy'}
                  </Button>
                </div>
              </div>
            </div>

            <div className="surface-soft p-5 space-y-3">
              <p className="eyebrow">Technical Details</p>

              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] uppercase tracking-wider text-slate-500 font-medium">
                    Session Key
                  </span>
                  <Button
                    onClick={() => copyText(sessionId, 'session')}
                    className="text-[10px] text-[var(--accent)] hover:underline"
                  >
                    Copy
                  </Button>
                </div>
                <p className="font-mono text-[10px] text-slate-300 truncate" title={sessionId}>
                  {sessionId}
                </p>
              </div>

              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] uppercase tracking-wider text-slate-500 font-medium">
                    Invite URL
                  </span>
                  <Button
                    onClick={() => copyText(phoneUrl, 'url')}
                    className="text-[10px] text-[var(--accent)] hover:underline"
                  >
                    Copy
                  </Button>
                </div>
                <p className="font-mono text-[10px] text-slate-400 truncate" title={phoneUrl}>
                  {phoneUrl}
                </p>
              </div>

              <div className="space-y-1 pt-1 border-t border-[var(--line)]">
                <span className="text-[10px] uppercase tracking-wider text-slate-500 font-medium block">
                  WebSocket
                </span>
                <p className="font-mono text-[10px] text-slate-400 truncate" title={wsUrl}>
                  {wsUrl}
                </p>
                <p className="text-[9px] text-slate-600 mt-1">
                  Source:{' '}
                  {connection.source === 'auto'
                    ? 'LAN Auto'
                    : connection.source === 'env'
                      ? 'Env Override'
                      : 'Browser'}
                </p>
              </div>
            </div>
          </section>

          {/* Right Column: Recording Profile & Connected Devices */}
          <div
            className="flex flex-col gap-6 glitch-in stagger-2"
            style={{ animationDelay: '100ms' }}
          >
            <section className="surface-panel p-5 space-y-3">
              <p className="eyebrow">Recording Profile</p>
              <div className="grid gap-3 sm:grid-cols-3">
                {recordingProfiles.map((profile) => (
                  <Button
                    key={profile.mode}
                    type="button"
                    disabled={profile.disabled}
                    onClick={() => setRecordingMode(profile.mode)}
                    className={`border p-4 text-left transition-all rounded-xl flex flex-col gap-1.5 ${
                      recordingMode === profile.mode
                        ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)] shadow-sm'
                        : 'border-[var(--line)] bg-[var(--bg-panel)] text-slate-400 hover:border-slate-500 hover:text-slate-200'
                    } ${profile.disabled ? 'cursor-not-allowed opacity-40' : ''}`}
                  >
                    <div
                      className={`text-xs font-semibold tracking-wide ${recordingMode === profile.mode ? 'text-[var(--accent)]' : 'text-slate-200'}`}
                    >
                      {profile.label}
                    </div>
                    <div className="text-[11px] leading-relaxed opacity-80 hidden md:block">
                      {profile.description}
                    </div>
                  </Button>
                ))}
              </div>
            </section>

            <section className="surface-panel p-5 flex flex-col">
              <div className="mb-3 flex items-center justify-between">
                <p className="eyebrow">Connected Devices</p>
                <span className="ui-pill">{cameras.length} linked</span>
              </div>

              <div className="surface-soft p-5 rounded-xl">
                {cameras.length === 0 ? (
                  <div className="flex flex-col items-center justify-center text-center space-y-4 py-8">
                    <div className="h-10 w-10 rounded-full border border-dashed border-slate-600 flex items-center justify-center animate-spin-slow">
                      <span className="h-2 w-2 rounded-full bg-slate-500" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-slate-300">
                        Waiting for phones to join...
                      </p>
                      <p className="text-[11px] text-slate-500 mt-1 max-w-[220px] mx-auto">
                        Scan the QR code or open the Invite URL on a mobile device.
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {cameras.map((camera, index) => (
                      <div
                        key={camera.id}
                        className="rounded-xl border border-[var(--line)] bg-[var(--bg-base)] p-3.5 flex flex-col gap-3 shadow-sm"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <span
                              className="h-2 w-2 rounded-full shadow-sm"
                              style={{
                                background: ballTone[index % ballTone.length],
                                boxShadow: `0 0 8px ${ballTone[index % ballTone.length]}`,
                              }}
                            />
                            <span className="text-sm font-semibold tracking-wide text-slate-200 truncate max-w-[120px]">
                              {camera.label}
                            </span>
                          </div>
                          <span
                            className={`px-2 py-0.5 rounded-md border text-[9px] font-bold uppercase tracking-wider shrink-0 ${
                              camera.status === 'live'
                                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                                : 'border-amber-500/30 bg-amber-500/10 text-amber-400'
                            }`}
                          >
                            {camera.status}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
          </div>
        </div>
      )}
    </div>
  );
};
