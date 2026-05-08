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

const phaseOrder = ['setup', 'calibration', 'recording', 'tracking', 'results'] as const;
type GuardPhase = (typeof phaseOrder)[number];

const routeForPhase = (phase: GuardPhase) => `/${phase}`;

function PhaseGuard({ phase, children }: { phase: GuardPhase; children: ReactElement }) {
  const { phase: sessionPhase, experimentId } = useSessionStore();
  const { status: calibrationStatus, rulerScaleFactor } = useCalibrationStore();
  const { frameCount } = useTrackingStore();

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

    const [isWsConnected, setIsWsConnected] = useState(wsClient.connected);
    const [shouldShowOffline, setShouldShowOffline] = useState(false);

    useEffect(() => {
      let timeoutId: ReturnType<typeof setTimeout>;

      const interval = setInterval(() => {
        const connected = wsClient.connected;
        setIsWsConnected(connected);

        if (!connected) {
          if (!timeoutId) {
            timeoutId = setTimeout(() => {
              setShouldShowOffline(true);
            }, 3000);
          }
        } else {
          clearTimeout(timeoutId);
          timeoutId = null as any;
          setShouldShowOffline(false);
        }
      }, 500);

      return () => {
        clearInterval(interval);
        clearTimeout(timeoutId);
      };
    }, []);

    const isFullBleed = location.pathname === '/debug' || location.pathname === '/tracking';

    return (
      <div className="relative min-h-[100dvh] overflow-hidden selection:bg-[#FF2A00]/25 selection:text-white">
        {!isPhoneRoute && shouldShowOffline && (
          <div className="fixed left-0 right-0 top-0 z-[60] border-b border-rose-500/35 bg-rose-900/75 py-2 text-center text-xs font-semibold uppercase tracking-[0.18em] text-rose-100 backdrop-blur-xl animate-in slide-in-from-top-full duration-300">
            Signaling offline. Start backend services to continue.
          </div>
        )}

        <main
          className={`relative z-10 w-full min-h-[100dvh] ${isFullBleed ? '' : 'mx-auto max-w-[1500px] px-4 pb-10 pt-8 sm:px-8 sm:pt-10'}`}
        >
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
