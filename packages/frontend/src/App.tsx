import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { wsClient } from './lib/wsClient';
import { peerManager } from './lib/webrtc';
import { SetupPage } from './pages/SetupPage';
import { CalibrationPage } from './pages/CalibrationPage';
import { RecordingPage } from './pages/RecordingPage';
import { TrackingPage } from './pages/TrackingPage';
import { ResultsPage } from './pages/ResultsPage';
import { PhonePage } from './pages/PhonePage';

function ConnectionStatus() {
  const [status, setStatus] = useState<'connected' | 'reconnecting' | 'disconnected'>('disconnected');

  useEffect(() => {
    const checkStatus = () => {
      // @ts-ignore - reaching into private state for status display
      const connected = wsClient.isConnected;
      // @ts-ignore
      const attempts = wsClient.reconnectAttempts;
      
      if (connected) setStatus('connected');
      else if (attempts > 0) setStatus('reconnecting');
      else setStatus('disconnected');
    };

    const interval = setInterval(checkStatus, 1000);
    return () => clearInterval(interval);
  }, []);

  const colors = {
    connected: 'bg-green-500',
    reconnecting: 'bg-yellow-500',
    disconnected: 'bg-red-500',
  };

  return (
    <>
      {status === 'disconnected' && (
        <div className="fixed top-0 left-0 right-0 bg-red-600 text-white text-center py-2 text-sm font-bold z-[60]">
          Server Offline - Please ensure the backend is running
        </div>
      )}
      <div className="fixed top-4 right-4 flex items-center gap-2 px-3 py-1 rounded-full bg-slate-800 text-white text-xs font-medium z-50 shadow-lg border border-slate-700">
        <div className={`w-2 h-2 rounded-full ${colors[status]} shadow-sm`} />
        <span className="capitalize">{status}</span>
      </div>
    </>
  );
}

function App() {
  useEffect(() => {
    wsClient.connect();
    // peerManager is initialized on import, but we could add explicit init here if needed
    return () => {
      peerManager.cleanup();
    };
  }, []);

  return (
    <BrowserRouter>
      <div className="min-h-screen bg-slate-950 text-slate-50 font-sans selection:bg-indigo-500/30">
        <ConnectionStatus />
        
        <main className="container mx-auto px-4 py-8">
          <Routes>
            <Route path="/" element={<Navigate to="/setup" replace />} />
            <Route path="/setup" element={<SetupPage />} />
            <Route path="/calibration" element={<CalibrationPage />} />
            <Route path="/recording" element={<RecordingPage />} />
            <Route path="/tracking" element={<TrackingPage />} />
            <Route path="/results" element={<ResultsPage />} />
            <Route path="/phone" element={<PhonePage />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}

export default App;
