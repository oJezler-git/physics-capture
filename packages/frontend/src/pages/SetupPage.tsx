import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import QRCode from 'qrcode';
import { useSessionStore } from '../stores/sessionStore';
import { wsClient } from '../lib/wsClient';
import { Plus, Camera, Smartphone, ArrowRight, Trash2, AlertCircle } from 'lucide-react';
import { BallMassConfig } from '../types';

export const SetupPage = () => {
  const navigate = useNavigate();
  const { 
    experimentId, 
    cameras, 
    ballConfigs, 
    createExperiment, 
    setBallConfig, 
    advancePhase 
  } = useSessionStore();

  const [qrCodeUrl, setQrCodeUrl] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const roomCode = experimentId ? experimentId.slice(0, 6).toUpperCase() : '';

  // Generate QR code when experimentId changes
  useEffect(() => {
    if (experimentId) {
      // In production, this would be the actual LAN IP of the Node server
      const lanIp = window.location.hostname; 
      const phoneUrl = `http://${lanIp}:3000/phone?room=${roomCode}`;
      
      QRCode.toDataURL(phoneUrl, { width: 256, margin: 2 }, (err, url) => {
        if (!err) setQrCodeUrl(url);
      });

      // Join the room as PC
      wsClient.send({ type: 'join', room: roomCode, role: 'pc' });
    }
  }, [experimentId, roomCode]);

  const handleNewSession = async () => {
    setLoading(true);
    setError(null);
    try {
      // Mocking the POST /api/experiments call as the backend might not be ready
      // In a real scenario: const res = await fetch('/api/experiments', { method: 'POST' });
      // const data = await res.json();
      // createExperiment(data.experimentId);
      
      // For now, generating a local UUID-like string
      const mockId = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
      createExperiment(mockId);
      
      // Initialize with 2 balls by default as per common physics experiments
      setBallConfig(0, { ballId: 0, mass_g: 50, uncertainty_g: 1 });
      setBallConfig(1, { ballId: 1, mass_g: 50, uncertainty_g: 1 });
    } catch (err) {
      setError('Failed to create new session. Is the server running?');
    } finally {
      setLoading(false);
    }
  };

  const updateBallMass = (index: number, field: keyof BallMassConfig, value: number) => {
    const current = ballConfigs[index] || { ballId: index, mass_g: 0, uncertainty_g: 0 };
    setBallConfig(index, { ...current, [field]: value });
  };

  const addBall = () => {
    if (ballConfigs.length < 3) {
      setBallConfig(ballConfigs.length, { ballId: ballConfigs.length, mass_g: 50, uncertainty_g: 1 });
    }
  };

  const removeBall = (index: number) => {
    // SessionStore needs a way to remove or we just filter locally and reset all
    // For now, we'll just not show it in the UI if we wanted to be simple
  };

  const canProceed = experimentId && cameras.length > 0 && ballConfigs.length > 0;

  return (
    <div className="max-w-4xl mx-auto space-y-8 animate-in fade-in duration-500">
      <header className="flex justify-between items-end">
        <div>
          <h1 className="text-4xl font-bold tracking-tight text-white">Setup Session</h1>
          <p className="text-slate-400 mt-2">Initialize experiment and connect recording devices.</p>
        </div>
        {!experimentId && (
          <button 
            onClick={handleNewSession}
            disabled={loading}
            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-800 text-white px-6 py-3 rounded-lg font-semibold transition-all shadow-lg shadow-indigo-500/20"
          >
            {loading ? 'Creating...' : <><Plus size={20} /> New Session</>}
          </button>
        )}
      </header>

      {error && (
        <div className="bg-red-500/10 border border-red-500/50 text-red-400 p-4 rounded-lg flex items-center gap-3">
          <AlertCircle size={20} />
          <span>{error}</span>
        </div>
      )}

      {experimentId && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          {/* Left Column: Connection */}
          <section className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-6">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold flex items-center gap-2">
                <Smartphone className="text-indigo-400" size={24} />
                Connect Phones
              </h2>
              <span className="bg-indigo-500/20 text-indigo-400 px-3 py-1 rounded-full text-sm font-mono font-bold">
                CODE: {roomCode}
              </span>
            </div>

            <div className="flex flex-col items-center justify-center p-4 bg-white rounded-xl shadow-inner">
              {qrCodeUrl ? (
                <img src={qrCodeUrl} alt="Join QR Code" className="w-48 h-48" />
              ) : (
                <div className="w-48 h-48 bg-slate-100 animate-pulse rounded-lg" />
              )}
              <p className="text-slate-600 text-sm mt-4 text-center">
                Scan with phone camera to join as a recording device
              </p>
            </div>

            <div className="space-y-3">
              <h3 className="text-sm font-medium text-slate-400 uppercase tracking-wider">Connected Devices</h3>
              {cameras.length === 0 ? (
                <div className="text-center py-8 border-2 border-dashed border-slate-800 rounded-xl text-slate-500 italic">
                  Waiting for devices to join...
                </div>
              ) : (
                <div className="grid gap-2">
                  {cameras.map(cam => (
                    <div key={cam.id} className="flex items-center justify-between p-3 bg-slate-800/50 rounded-lg border border-slate-700">
                      <div className="flex items-center gap-3">
                        {cam.type === 'pc' ? <Camera size={18} className="text-emerald-400" /> : <Smartphone size={18} className="text-indigo-400" />}
                        <span className="font-medium">{cam.label}</span>
                      </div>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full uppercase font-bold ${
                        cam.status === 'live' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-yellow-500/20 text-yellow-400'
                      }`}>
                        {cam.status}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          {/* Right Column: Configuration */}
          <section className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-6">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold flex items-center gap-2">
                <Trash2 className="text-indigo-400" size={24} />
                Ball Setup
              </h2>
              <button 
                onClick={addBall}
                disabled={ballConfigs.length >= 3}
                className="text-xs bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-300 px-2 py-1 rounded border border-slate-700 transition-colors"
              >
                + Add Ball
              </button>
            </div>

            <div className="space-y-4">
              {ballConfigs.map((config, idx) => (
                <div key={idx} className="p-4 bg-slate-800/30 border border-slate-800 rounded-xl space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-bold text-slate-500">BALL #{idx + 1}</span>
                    <div className={`w-3 h-3 rounded-full ${['bg-red-500', 'bg-blue-500', 'bg-green-500'][idx]}`} />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <label className="text-xs text-slate-400">Mass (g)</label>
                      <input 
                        type="number" 
                        value={config.mass_g}
                        onChange={(e) => updateBallMass(idx, 'mass_g', parseFloat(e.target.value))}
                        className="w-full bg-slate-950 border border-slate-700 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-indigo-500 transition-colors"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-slate-400">Uncertainty (±g)</label>
                      <input 
                        type="number" 
                        value={config.uncertainty_g}
                        onChange={(e) => updateBallMass(idx, 'uncertainty_g', parseFloat(e.target.value))}
                        className="w-full bg-slate-950 border border-slate-700 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-indigo-500 transition-colors"
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="pt-4 border-t border-slate-800">
              <button 
                disabled={!canProceed}
                onClick={() => {
                  advancePhase();
                  navigate('/calibration');
                }}
                className="w-full flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-800 disabled:text-slate-500 text-white px-6 py-4 rounded-xl font-bold transition-all shadow-lg"
              >
                Proceed to Calibration <ArrowRight size={20} />
              </button>
              {!canProceed && experimentId && (
                <p className="text-[10px] text-slate-500 mt-3 text-center">
                  * At least one recording device must be connected to proceed.
                </p>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
};
