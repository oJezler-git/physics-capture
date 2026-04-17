import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { wsClient } from '../lib/wsClient';

type RecordState = 'idle' | 'recording' | 'uploading' | 'done' | 'error';

interface WsDetail {
  type: string;
  data: any;
}

const normalizeSessionId = (value: string) => value.trim().toLowerCase();
const normalizeInviteCode = (value: string) =>
  value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

const resolveRoomId = (params: URLSearchParams) => {
  const explicitRoom = params.get('room')?.trim();
  if (explicitRoom) return explicitRoom;

  const sessionId = params.get('sid')?.trim();
  if (sessionId) return `exp-${normalizeSessionId(sessionId)}`;

  const inviteCode = params.get('code')?.trim();
  if (inviteCode) return `code-${normalizeInviteCode(inviteCode)}`;

  return null;
};

const resolveDisplayCode = (params: URLSearchParams) => {
  const inviteCode = params.get('code');
  if (inviteCode) return inviteCode;

  const roomId = resolveRoomId(params);
  if (!roomId) return '--';

  if (roomId.startsWith('exp-')) return roomId.slice(4, 14).toUpperCase();
  return roomId.slice(0, 10).toUpperCase();
};

const getStoredPhoneClientId = (roomId: string) => {
  const key = `physics-capture:phone-client:${roomId}`;
  const existing = window.localStorage.getItem(key);
  if (existing) return existing;

  const generated =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? `phone-${crypto.randomUUID().slice(0, 8)}`
      : `phone-${Math.random().toString(36).slice(2, 10)}`;
  window.localStorage.setItem(key, generated);
  return generated;
};

export const PhonePage = () => {
  const [searchParams] = useSearchParams();
  const roomId = useMemo(() => resolveRoomId(searchParams), [searchParams]);
  const displayCode = useMemo(() => resolveDisplayCode(searchParams), [searchParams]);

  const videoRef = useRef<HTMLVideoElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const experimentIdRef = useRef<string | null>(null);
  const clientIdRef = useRef<string>('');
  const joinIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [status, setStatus] = useState<'connecting' | 'connected' | 'error'>('connecting');
  const [recordState, setRecordState] = useState<RecordState>('idle');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [errorMessage, setErrorMessage] = useState('');
  const [visibilityWarning, setVisibilityWarning] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [debugLog, setDebugLog] = useState<string[]>([]);

  const dbg = (message: string) => {
    setDebugLog((prev) => [
      ...prev.slice(-19),
      `${new Date().toISOString().slice(11, 23)} ${message}`,
    ]);
  };

  useEffect(() => {
    if (!roomId) {
      setStatus('error');
      setErrorMessage('Missing invite details in URL.');
      return;
    }

    clientIdRef.current = getStoredPhoneClientId(roomId);
    void init(roomId);

    return () => {
      if (joinIntervalRef.current !== null) {
        clearInterval(joinIntervalRef.current);
        joinIntervalRef.current = null;
      }
      stream?.getTracks().forEach((track) => track.stop());
      peerConnectionRef.current?.close();
      wsClient.disconnect();
      window.removeEventListener('ws:webrtc', handleWebRTC as unknown as EventListener);
      window.removeEventListener('ws:record', handleRecordCommand as unknown as EventListener);
    };
  }, [roomId]);

  useEffect(() => {
    const onVisibilityChange = () => {
      const shouldWarn = document.hidden && recordState === 'recording';
      setVisibilityWarning(shouldWarn);
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [recordState]);

  const init = async (targetRoomId: string) => {
    try {
      dbg(`Protocol ${window.location.protocol}`);
      dbg(`Secure context ${window.isSecureContext}`);
      dbg(`Room ${targetRoomId}`);

      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        throw new Error('Camera access requires HTTPS or localhost.');
      }

      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment',
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 60, min: 60 },
        },
        audio: false,
      });

      const track = mediaStream.getVideoTracks()[0];
      const capabilities = (track as any).getCapabilities?.() || {};
      const settings = track.getSettings();
      
      const widthPct = Math.round(((settings.width || 0) / (capabilities.width?.max || 1)) * 100);
      const fpsPct = Math.round(((settings.frameRate || 0) / (capabilities.frameRate?.max || 1)) * 100);
      
      dbg(`Cap: ${capabilities.width?.max}x${capabilities.height?.max} @ ${capabilities.frameRate?.max}fps`);
      dbg(`Cam: ${settings.width}x${settings.height} @ ${settings.frameRate}fps`);
      dbg(`Util: Res ${widthPct}% | FPS ${fpsPct}%`);

      setStream(mediaStream);
      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
      }
      dbg('Camera granted');

      wsClient.connect();
      dbg('Connecting websocket');

      const checkWs = setInterval(() => {
        if (!wsClient.connected) return;

        clearInterval(checkWs);
        joinIntervalRef.current = null;
        const label = `${navigator.platform} Phone`;
        const clientId = clientIdRef.current;
        wsClient.send({
          type: 'join',
          roomId: targetRoomId,
          role: 'phone',
          clientId,
          peerId: clientId,
          label,
        });
        setStatus('connected');
        dbg(`Joined room ${targetRoomId} as ${clientId}`);
      }, 500);
      joinIntervalRef.current = checkWs;

      window.addEventListener('ws:webrtc', handleWebRTC as unknown as EventListener);
      window.addEventListener('ws:record', handleRecordCommand as unknown as EventListener);
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : 'Init failed';
      dbg(message);
      setStatus('error');
      setErrorMessage(message);
    }
  };

  const handleWebRTC = async (event: CustomEvent<WsDetail>) => {
    const { type, data } = event.detail;

    if (type === 'peer:answer') {
      await peerConnectionRef.current?.setRemoteDescription(new RTCSessionDescription(data));
    } else if (type === 'peer:ice') {
      await peerConnectionRef.current?.addIceCandidate(new RTCIceCandidate(data));
    }
  };

  useEffect(() => {
    if (status === 'connected' && stream) {
      void setupPeerConnection();
    }
  }, [status, stream]);

  const setupPeerConnection = async () => {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });
    peerConnectionRef.current = pc;

    stream?.getTracks().forEach((track) => {
      if (stream) pc.addTrack(track, stream);
    });

    const peerId = clientIdRef.current;

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      wsClient.send({
        type: 'peer:ice',
        data: { ...event.candidate.toJSON(), peerId } as any,
        to: 'pc',
      });
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    wsClient.send({
      type: 'peer:offer',
      data: { ...offer, peerId } as any,
      to: 'pc',
    });
  };

  const handleRecordCommand = (event: CustomEvent<WsDetail>) => {
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
      videoBitsPerSecond: 150_000_000,
    });

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };

    recorder.onstop = uploadRecording;
    recorder.start(1000);
    mediaRecorderRef.current = recorder;
    setRecordState('recording');
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
  };

  const uploadRecording = async () => {
    setRecordState('uploading');
    const blob = new Blob(chunksRef.current, { type: mediaRecorderRef.current?.mimeType });
    const experimentId = experimentIdRef.current;

    const formData = new FormData();
    formData.append('video', blob, `recording_${Date.now()}.webm`);

    const xhr = new XMLHttpRequest();
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        setUploadProgress(Math.round((event.loaded / event.total) * 100));
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        setRecordState('done');
      } else {
        setRecordState('error');
        setErrorMessage('Upload failed');
      }
    };

    xhr.onerror = () => {
      setRecordState('error');
      setErrorMessage('Upload failed');
    };

    xhr.open('POST', `/api/upload/${experimentId}/phone`);
    xhr.send(formData);

    if (window.location.hostname === 'localhost') {
      setTimeout(() => setRecordState('done'), 2000);
    }
  };

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#050a14] text-slate-100">
      <div className="pointer-events-none absolute -left-20 top-[-8rem] h-[18rem] w-[18rem] rounded-full bg-sky-400/15 blur-3xl" />
      <div className="pointer-events-none absolute -right-14 bottom-[-6rem] h-[16rem] w-[16rem] rounded-full bg-orange-500/15 blur-3xl" />

      <div className="relative z-10 flex h-full flex-col">
        <header className="border-b border-slate-800 bg-slate-950/75 px-4 py-3 backdrop-blur-xl">
          <div className="flex items-center justify-between">
            <div>
              <p className="eyebrow">Phone Capture Node</p>
              <p className="text-sm font-semibold tracking-[0.08em]">PHYSICS-CAPTURE</p>
            </div>
            <div className="text-right">
              <span
                className={`ui-pill ${status === 'connected' ? 'border-lime-400/35 text-lime-100' : 'border-rose-400/35 text-rose-100'}`}
              >
                {status === 'connected' ? 'Linked' : 'Offline'}
              </span>
              <p className="mt-1 text-[10px] font-mono text-slate-500">Code {displayCode}</p>
            </div>
          </div>
        </header>

        <main className="relative flex-1 bg-black">
          <video ref={videoRef} autoPlay playsInline muted className="h-full w-full object-cover" />

          <div className="absolute left-4 top-16 z-20 w-64 rounded-xl border border-slate-700 bg-slate-950/80 p-2 opacity-90 backdrop-blur-md">
            <div className="custom-scrollbar max-h-28 overflow-y-auto">
              {debugLog.map((line, index) => (
                <p key={index} className="font-mono text-[9px] leading-3 text-sky-300">
                  {line}
                </p>
              ))}
            </div>
          </div>

          <div className="pointer-events-none absolute inset-4 rounded-2xl border border-dashed border-white/30">
            <div className="m-4 inline-block rounded border border-white/15 bg-black/45 px-3 py-2 text-[11px] uppercase tracking-[0.16em] text-slate-200 backdrop-blur-md">
              Keep sync marker in this zone
            </div>
          </div>

          {recordState === 'recording' ? (
            <div className="absolute left-1/2 top-6 -translate-x-1/2 rounded-full border border-rose-300/45 bg-rose-500/20 px-4 py-2 text-sm font-semibold uppercase tracking-[0.18em] text-rose-100">
              Recording
            </div>
          ) : null}

          {visibilityWarning ? (
            <div className="absolute left-1/2 top-20 -translate-x-1/2 rounded-xl border border-amber-300/45 bg-amber-500/20 px-4 py-2 text-xs font-medium text-amber-100">
              Keep this tab visible while recording.
            </div>
          ) : null}

          {recordState === 'uploading' || recordState === 'done' || recordState === 'error' ? (
            <div className="absolute inset-0 z-20 grid place-items-center bg-slate-950/90 p-8 backdrop-blur-md">
              <div className="w-full max-w-sm space-y-4 rounded-2xl border border-slate-700 bg-slate-900/80 p-6 text-center">
                {recordState === 'uploading' ? (
                  <>
                    <p className="eyebrow">Transfer</p>
                    <h3 className="text-2xl">Uploading Capture</h3>
                    <p className="text-sm text-slate-400">Syncing high-speed footage to master node.</p>
                    <div className="h-2 overflow-hidden rounded-full bg-slate-800">
                      <div
                        className="h-full bg-gradient-to-r from-sky-400 to-orange-400"
                        style={{ width: `${uploadProgress}%` }}
                      />
                    </div>
                    <p className="font-mono text-lg text-slate-200">{uploadProgress}%</p>
                  </>
                ) : null}

                {recordState === 'done' ? (
                  <>
                    <p className="eyebrow text-lime-200">Transfer Complete</p>
                    <h3 className="text-2xl">Capture Synced</h3>
                    <p className="text-sm text-slate-400">Ready for another recording pass.</p>
                    <button onClick={() => setRecordState('idle')} className="btn-main w-full">
                      Done
                    </button>
                  </>
                ) : null}

                {recordState === 'error' ? (
                  <>
                    <p className="eyebrow text-rose-200">Transfer Error</p>
                    <h3 className="text-2xl">Upload Failed</h3>
                    <p className="text-sm text-rose-100">{errorMessage}</p>
                    <button onClick={uploadRecording} className="btn-main w-full">
                      Retry Upload
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          ) : null}
        </main>

        <footer className="border-t border-slate-800 bg-slate-950/80 p-5 backdrop-blur-xl">
          <div className="custom-scrollbar mb-3 max-h-28 overflow-y-auto rounded-xl border border-slate-700 bg-slate-950/85 p-2">
            {debugLog.map((line, index) => (
              <p key={index} className="font-mono text-[10px] leading-4 text-slate-400">
                {line}
              </p>
            ))}
          </div>

          {recordState === 'idle' ? (
            <div className="space-y-2 text-center">
              <p className="eyebrow">Recorder State</p>
              <p className="text-xs uppercase tracking-[0.18em] text-slate-400">
                Awaiting master command
              </p>
            </div>
          ) : null}

          {status === 'error' ? (
            <div className="mt-3 space-y-2 text-center">
              <p className="text-sm font-semibold text-rose-100">System Error</p>
              <p className="text-xs text-slate-400">{errorMessage}</p>
              <button onClick={() => window.location.reload()} className="btn-alt px-4 py-2">
                Reload App
              </button>
            </div>
          ) : null}
        </footer>
      </div>
    </div>
  );
};
