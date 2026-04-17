import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { wsClient } from '../lib/wsClient';
import {
  Smartphone,
  Wifi,
  WifiOff,
  Circle,
  CheckCircle2,
  AlertCircle,
  Loader2,
} from 'lucide-react';

type RecordState = 'idle' | 'recording' | 'uploading' | 'done' | 'error';

export const PhonePage = () => {
  const [searchParams] = useSearchParams();
  const room = searchParams.get('room');

  const videoRef = useRef<HTMLVideoElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const phoneClientIdRef = useRef<string>('');

  const [status, setStatus] = useState<'connecting' | 'connected' | 'error'>('connecting');
  const [recordState, setRecordState] = useState<RecordState>('idle');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [errorMessage, setErrorMessage] = useState('');
  const [visibilityWarning, setVisibilityWarning] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [debugLog, setDebugLog] = useState<string[]>([]);

  const experimentIdRef = useRef<string | null>(null);

  const getPhoneClientId = (targetRoom: string) => {
    const key = `physics-capture:phone-client:${targetRoom}`;
    const existing = window.localStorage.getItem(key);
    if (existing) return existing;

    const generated =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? `phone-${crypto.randomUUID().slice(0, 8)}`
        : `phone-${Math.random().toString(36).slice(2, 10)}`;
    window.localStorage.setItem(key, generated);
    return generated;
  };

  const dbg = (msg: string) => {
    console.log('[Phone]', msg);
    setDebugLog((prev) => [...prev.slice(-19), `${new Date().toISOString().slice(11, 23)} ${msg}`]);
  };

  const joinRoom = useCallback(() => {
    if (!room || !wsClient.connected || !phoneClientIdRef.current) return;
    const label = `${navigator.platform} Phone`;
    dbg(`WS connected, joining room ${room}`);
    wsClient.send({
      type: 'join',
      roomId: room,
      role: 'phone',
      clientId: phoneClientIdRef.current,
      label,
    });
    setStatus('connected');
  }, [room]);

  useEffect(() => {
    if (!room) {
      setStatus('error');
      setErrorMessage('Missing room code in URL');
      return;
    }

    let cancelled = false;
    phoneClientIdRef.current = getPhoneClientId(room);

    // Initialize camera and WebSocket
    init(() => cancelled);

    return () => {
      cancelled = true;
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
      peerConnectionRef.current?.close();
      peerConnectionRef.current = null;
      window.removeEventListener('ws:webrtc', handleWebRTC);
      window.removeEventListener('ws:record', handleRecordCommand);
    };
  }, [room]);

  useEffect(() => {
    if (!room) return;

    const onWsOpen = () => {
      joinRoom();
    };

    window.addEventListener('ws:open', onWsOpen);
    joinRoom();

    return () => {
      window.removeEventListener('ws:open', onWsOpen);
    };
  }, [room, joinRoom]);

  useEffect(() => {
    const onVisibilityChange = () => {
      const shouldWarn = document.hidden && recordState === 'recording';
      setVisibilityWarning(shouldWarn);
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [recordState]);

  const init = async (isCancelled: () => boolean) => {
    try {
      dbg(`Protocol: ${window.location.protocol}`);
      dbg(`isSecureContext: ${window.isSecureContext}`);
      dbg(`mediaDevices available: ${!!navigator.mediaDevices}`);

      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        throw new Error(
          'Camera access requires a secure page. Open this link over HTTPS (or localhost).',
        );
      }

      // 1. Get Camera
      dbg('Requesting camera...');
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment',
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30 },
        },
        audio: false,
      });
      if (isCancelled()) {
        mediaStream.getTracks().forEach((t) => t.stop());
        return;
      }
      dbg('Camera granted');
      setStream(mediaStream);
      localStreamRef.current = mediaStream;
      if (videoRef.current) videoRef.current.srcObject = mediaStream;

      // 2. Join room immediately when websocket is already online.
      if (!isCancelled()) joinRoom();

      // 3. Listen for commands
      window.addEventListener('ws:webrtc', handleWebRTC);
      window.addEventListener('ws:record', handleRecordCommand);
    } catch (err: any) {
      dbg(`ERROR: ${err.name}: ${err.message}`);
      setStatus('error');
      setErrorMessage(`${err.name}: ${err.message}`);
    }
  };

  const handleWebRTC = async (event: any) => {
    const { type, data } = event.detail;

    if (type === 'peer:answer') {
      await peerConnectionRef.current?.setRemoteDescription(new RTCSessionDescription(data));
    } else if (type === 'peer:ice') {
      await peerConnectionRef.current?.addIceCandidate(new RTCIceCandidate(data));
    }
  };

  // Simplified: Phone initiates the offer when it joins to provide preview to PC
  useEffect(() => {
    if (status === 'connected' && stream && !peerConnectionRef.current) {
      setupPeerConnection();
    }
  }, [status, stream]);

  const setupPeerConnection = async () => {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });
    peerConnectionRef.current = pc;

    stream!.getTracks().forEach((track) => pc.addTrack(track, stream!));

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        wsClient.send({
          type: 'peer:ice',
          data: { ...event.candidate.toJSON(), peerId: phoneClientIdRef.current } as any,
          to: 'pc',
        });
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    wsClient.send({
      type: 'peer:offer',
      data: { ...offer, peerId: phoneClientIdRef.current } as any,
      to: 'pc',
    });
  };

  const handleRecordCommand = (event: any) => {
    const { type, data } = event.detail;
    experimentIdRef.current = data.experimentId;

    if (type === 'record:start') {
      startRecording();
    } else if (type === 'record:stop') {
      stopRecording();
    }
  };

  const startRecording = () => {
    if (!stream) return;

    chunksRef.current = [];
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9'
      : 'video/mp4';

    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 100_000_000, // 100 Mbps target for high quality
    });

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };

    recorder.onstop = uploadRecording;

    recorder.start(1000); // 1s chunks
    mediaRecorderRef.current = recorder;
    setRecordState('recording');
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
  };

  const uploadRecording = async () => {
    setRecordState('uploading');
    const blob = new Blob(chunksRef.current, { type: mediaRecorderRef.current?.mimeType });
    const experimentId = experimentIdRef.current;

    const formData = new FormData();
    formData.append('video', blob, `recording_${Date.now()}.webm`);

    try {
      const xhr = new XMLHttpRequest();
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          setUploadProgress(Math.round((e.loaded / e.total) * 100));
        }
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          setRecordState('done');
        } else {
          throw new Error('Upload failed');
        }
      };

      xhr.onerror = () => {
        throw new Error('Upload failed');
      };

      // In production, this would be the actual API endpoint
      xhr.open('POST', `/api/upload/${experimentId}/phone`);
      xhr.send(formData);

    } catch (err: any) {
      setRecordState('error');
      setErrorMessage(err.message || 'Upload failed');
    }
  };

  return (
    <div className="fixed inset-0 bg-black text-white flex flex-col overflow-hidden font-sans">
      {/* Header */}
      <div className="p-4 flex items-center justify-between bg-slate-900/80 backdrop-blur-md z-10 border-b border-white/10">
        <div className="flex items-center gap-2">
          <Smartphone size={20} className="text-indigo-400" />
          <span className="font-bold tracking-tight">PHYC-CAP PHONE</span>
        </div>
        <div className="flex items-center gap-2">
          {status === 'connected' ? (
            <div className="flex items-center gap-1.5 px-2 py-1 bg-emerald-500/20 rounded-full">
              <Wifi size={14} className="text-emerald-400" />
              <span className="text-[10px] font-bold text-emerald-400 uppercase">Live</span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 px-2 py-1 bg-red-500/20 rounded-full">
              <WifiOff size={14} className="text-red-400" />
              <span className="text-[10px] font-bold text-red-400 uppercase">Offline</span>
            </div>
          )}
        </div>
      </div>

      {/* Main Preview */}
      <div className="flex-1 relative bg-slate-950 flex items-center justify-center">
        <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />

        {/* Framing Guide Overlay */}
        <div className="absolute inset-0 pointer-events-none border-[40px] border-black/20">
          <div className="w-full h-full border-2 border-dashed border-white/30 rounded-lg flex items-start p-6">
            <div className="bg-black/40 backdrop-blur-sm px-3 py-2 rounded border border-white/10">
              <p className="text-[10px] uppercase font-bold tracking-widest text-white/70">
                Framing Guide
              </p>
              <p className="text-xs text-white/90 mt-0.5">Keep sync dot in this area</p>
            </div>
          </div>
        </div>

        {/* Status Overlays */}
        {recordState === 'recording' && (
          <div className="absolute top-8 left-1/2 -translate-x-1/2 bg-red-600 px-4 py-1.5 rounded-full flex items-center gap-2 shadow-lg animate-pulse">
            <Circle size={12} fill="white" className="text-white" />
            <span className="text-sm font-bold tracking-widest uppercase">Recording</span>
          </div>
        )}

        {visibilityWarning ? (
          <div className="absolute top-24 left-1/2 z-20 -translate-x-1/2 rounded-xl border border-amber-500/50 bg-amber-500/15 px-4 py-2 text-xs font-semibold text-amber-100">
            Recording paused risk: keep this tab visible during capture.
          </div>
        ) : null}

        {(recordState === 'uploading' || recordState === 'done' || recordState === 'error') && (
          <div className="absolute inset-0 bg-slate-950/90 backdrop-blur-sm flex items-center justify-center p-8 z-20">
            <div className="max-w-xs w-full space-y-6 text-center">
              {recordState === 'uploading' && (
                <>
                  <Loader2 size={48} className="text-indigo-400 animate-spin mx-auto" />
                  <div className="space-y-2">
                    <h3 className="text-xl font-bold">Uploading Data</h3>
                    <p className="text-slate-400 text-sm">
                      Transferring high-speed capture to master session...
                    </p>
                  </div>
                  <div className="w-full bg-slate-800 h-2 rounded-full overflow-hidden">
                    <div
                      className="bg-indigo-500 h-full transition-all duration-300 ease-out"
                      style={{ width: `${uploadProgress}%` }}
                    />
                  </div>
                  <span className="text-2xl font-mono font-bold">{uploadProgress}%</span>
                </>
              )}

              {recordState === 'done' && (
                <>
                  <div className="w-20 h-20 bg-emerald-500/20 rounded-full flex items-center justify-center mx-auto border border-emerald-500/50">
                    <CheckCircle2 size={40} className="text-emerald-400" />
                  </div>
                  <div className="space-y-2">
                    <h3 className="text-2xl font-bold text-white">Capture Synced</h3>
                    <p className="text-slate-400">Ready for next recording.</p>
                  </div>
                  <button
                    onClick={() => setRecordState('idle')}
                    className="w-full bg-slate-800 hover:bg-slate-700 py-3 rounded-xl font-bold transition-colors"
                  >
                    Done
                  </button>
                </>
              )}

              {recordState === 'error' && (
                <>
                  <div className="w-20 h-20 bg-red-500/20 rounded-full flex items-center justify-center mx-auto border border-red-500/50">
                    <AlertCircle size={40} className="text-red-400" />
                  </div>
                  <div className="space-y-2">
                    <h3 className="text-2xl font-bold text-white">Sync Failed</h3>
                    <p className="text-red-400/80 text-sm">{errorMessage}</p>
                  </div>
                  <button
                    onClick={uploadRecording}
                    className="w-full bg-indigo-600 py-3 rounded-xl font-bold transition-colors"
                  >
                    Retry Upload
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Footer / Controls */}
      <div className="p-8 bg-slate-900 border-t border-white/5 flex flex-col items-center gap-4">
        {recordState === 'idle' && (
          <>
            <div className="w-16 h-16 rounded-full border-4 border-white/20 flex items-center justify-center">
              <div className="w-12 h-12 bg-white/10 rounded-full" />
            </div>
            <p className="text-slate-500 text-[10px] uppercase font-bold tracking-widest">
              Awaiting Master Command
            </p>
          </>
        )}

        {status === 'error' && (
          <div className="text-center space-y-2">
            <p className="text-red-400 font-bold">System Error</p>
            <p className="text-slate-500 text-xs">{errorMessage}</p>
            <button
              onClick={() => window.location.reload()}
              className="text-indigo-400 text-sm underline pt-2"
            >
              Reload App
            </button>
          </div>
        )}

        {debugLog.length > 0 && (
          <div className="w-full mt-2 rounded-lg bg-black/60 border border-slate-700 p-2 max-h-32 overflow-y-auto">
            {debugLog.map((line, i) => (
              <p key={i} className="text-[10px] font-mono text-slate-400 leading-4">
                {line}
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
