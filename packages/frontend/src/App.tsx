import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { wsClient } from './lib/wsClient';
import { peerManager } from './lib/webrtc';
import { ToastViewport } from './components/ToastViewport';
import { SetupPage } from './pages/SetupPage';
import { CalibrationPage } from './pages/CalibrationPage';
import { RecordingPage } from './pages/RecordingPage';
import { TrackingPage } from './pages/TrackingPage';
import { ResultsPage } from './pages/ResultsPage';
import { PhonePage } from './pages/PhonePage';
import { DebugPage } from './pages/DebugPage';
import { useSessionStore } from './stores/sessionStore';
import { useCalibrationStore } from './stores/calibrationStore';
import { useTrackingStore } from './stores/trackingStore';
import { useResultsStore } from './stores/resultsStore';

const phaseOrder = ['setup', 'calibration', 'recording', 'tracking', 'results'] as const;
type GuardPhase = (typeof phaseOrder)[number];

const routeForPhase = (phase: GuardPhase) => `/${phase}`;

function ConnectionStatus() {
  const [status, setStatus] = useState<'connected' | 'reconnecting' | 'disconnected'>(
    'disconnected',
  );

  useEffect(() => {
    const checkStatus = () => {
      const connected = wsClient.connected;
      const attempts = wsClient.reconnectCount;

      if (connected) setStatus('connected');
      else if (attempts > 0) setStatus('reconnecting');
      else setStatus('disconnected');
    };

    const interval = setInterval(checkStatus, 1000);
    return () => clearInterval(interval);
  }, []);

  const tones = {
    connected: {
      dot: 'bg-emerald-400',
      ring: 'border-emerald-400/40',
      text: 'text-emerald-200',
      label: 'online',
    },
    reconnecting: {
      dot: 'bg-amber-300',
      ring: 'border-amber-300/40',
      text: 'text-amber-100',
      label: 'recovering',
    },
    disconnected: {
      dot: 'bg-rose-400',
      ring: 'border-rose-400/40',
      text: 'text-rose-100',
      label: 'offline',
    },
  };
  const tone = tones[status];

  return (
    <>
      {status === 'disconnected' && (
        <div className="fixed left-0 right-0 top-0 z-[60] border-b border-rose-500/35 bg-rose-900/75 py-2 text-center text-xs font-semibold uppercase tracking-[0.18em] text-rose-100 backdrop-blur-xl">
          Signaling offline. Start backend services to continue.
        </div>
      )}
      <div
        className={`fixed right-4 top-4 z-50 flex items-center gap-2 rounded-full border bg-slate-950/75 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] shadow-xl backdrop-blur-xl ${tone.ring} ${tone.text}`}
      >
        <div className={`h-2.5 w-2.5 rounded-full ${tone.dot}`} />
        <span>{tone.label}</span>
      </div>
    </>
  );
}

function PhaseGuard({ phase, children }: { phase: GuardPhase; children: ReactElement }) {
  const { phase: sessionPhase, experimentId } = useSessionStore();
  const { status: calibrationStatus, rulerScaleFactor } = useCalibrationStore();
  const { frameCount } = useTrackingStore();
  const { physicsResult } = useResultsStore();

  const requestedIndex = phaseOrder.indexOf(phase);
  const currentIndex = phaseOrder.indexOf(sessionPhase);
  if (requestedIndex > currentIndex) {
    return <Navigate to={routeForPhase(sessionPhase)} replace />;
  }

  if (phase !== 'setup' && !experimentId) {
    return <Navigate to="/setup" replace />;
  }

  if (phase === 'recording' && calibrationStatus !== 'complete' && rulerScaleFactor === null) {
    return <Navigate to="/calibration" replace />;
  }

  if (phase === 'tracking' && frameCount === 0) {
    return <Navigate to="/recording" replace />;
  }


  return children;
}

function App() {
  useEffect(() => {
    wsClient.connect();
    // peerManager is initialized on import, but we could add explicit init here if needed
    return () => {
      peerManager.cleanup();
    };
  }, []);

  function AppChrome() {
    const location = useLocation();
    const isPhoneRoute = location.pathname === '/phone';

    const isFullBleed = location.pathname === '/debug' || location.pathname === '/tracking';

    return (
      <div className="relative min-h-screen overflow-hidden selection:bg-orange-300/25">
        <div className="pointer-events-none absolute -left-28 top-[-8rem] h-[24rem] w-[24rem] rounded-full bg-sky-400/10 blur-3xl" />
        <div className="pointer-events-none absolute bottom-[-12rem] right-[-8rem] h-[28rem] w-[28rem] rounded-full bg-orange-500/10 blur-3xl" />
        {!isPhoneRoute ? <ConnectionStatus /> : null}
        <ToastViewport />

        <main className={`relative z-10 w-full min-h-screen ${isFullBleed ? '' : 'mx-auto max-w-[1500px] px-4 pb-10 pt-8 sm:px-8 sm:pt-10'}`}>
          <Routes>
            <Route path="/" element={<Navigate to="/setup" replace />} />
            <Route
              path="/setup"
              element={
                <PhaseGuard phase="setup">
                  <SetupPage />
                </PhaseGuard>
              }
            />
            <Route
              path="/calibration"
              element={
                <PhaseGuard phase="calibration">
                  <CalibrationPage />
                </PhaseGuard>
              }
            />
            <Route
              path="/recording"
              element={
                <PhaseGuard phase="recording">
                  <RecordingPage />
                </PhaseGuard>
              }
            />
            <Route
              path="/tracking"
              element={
                <PhaseGuard phase="tracking">
                  <TrackingPage />
                </PhaseGuard>
              }
            />
            <Route
              path="/results"
              element={
                <PhaseGuard phase="results">
                  <ResultsPage />
                </PhaseGuard>
              }
            />
            <Route path="/phone" element={<PhonePage />} />
            <Route path="/debug" element={<DebugPage />} />
          </Routes>
        </main>
      </div>
    );
  }

  return (
    <BrowserRouter>
      <AppChrome />
    </BrowserRouter>
  );
}

export default App;
