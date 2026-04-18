import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { wsClient } from '../lib/wsClient';

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
    setDebugLog((prev) => [...prev, `${new Date().toISOString().slice(11, 23)} ${msg}`]);
  };

  const teardownPeerConnection = useCallback(() => {
    if (peerConnectionRef.current) {
      try {
        peerConnectionRef.current.onicecandidate = null;
        peerConnectionRef.current.onconnectionstatechange = null;
        peerConnectionRef.current.close();
      } catch {
        // Ignore teardown errors during recovery.
      }
      peerConnectionRef.current = null;
    }
  }, []);

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
      teardownPeerConnection();
      window.removeEventListener('ws:webrtc', handleWebRTC);
      window.removeEventListener('ws:record', handleRecordCommand);
    };
  }, [room, teardownPeerConnection]);

  useEffect(() => {
    if (!room) return;

    const onWsOpen = () => {
      dbg('WS open event');
      joinRoom();
    };
    const onWsClose = () => {
      dbg('WS close event');
      setStatus('connecting');
      teardownPeerConnection();
    };
    const onWsReconnectScheduled = (event: Event) => {
      const detail = (event as CustomEvent<{ attempt?: number; delayMs?: number }>).detail;
      dbg(
        `WS reconnect scheduled attempt=${detail?.attempt ?? '?'} delay=${detail?.delayMs ?? '?'}ms`,
      );
    };

    window.addEventListener('ws:open', onWsOpen);
    window.addEventListener('ws:close', onWsClose);
    window.addEventListener('ws:reconnect-scheduled', onWsReconnectScheduled);
    joinRoom();

    return () => {
      window.removeEventListener('ws:open', onWsOpen);
      window.removeEventListener('ws:close', onWsClose);
      window.removeEventListener('ws:reconnect-scheduled', onWsReconnectScheduled);
    };
  }, [room, joinRoom, teardownPeerConnection]);

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
    teardownPeerConnection();

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
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        teardownPeerConnection();
        if (wsClient.connected && stream) {
          setTimeout(() => {
            if (wsClient.connected && stream && !peerConnectionRef.current) {
              void setupPeerConnection();
            }
          }, 300);
        }
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
    <div className="fixed inset-0 bg-black text-slate-100 overflow-hidden font-mono">
      <video ref={videoRef} autoPlay playsInline muted className="absolute inset-0 w-full h-full object-cover" />

      <div className="absolute top-3 right-3 z-20">
        <span
          className={`text-xs px-3 py-1 rounded-full border backdrop-blur-md ${
            status === 'connected'
              ? 'bg-emerald-500/20 border-emerald-400/60 text-emerald-100'
              : status === 'connecting'
                ? 'bg-amber-500/20 border-amber-400/60 text-amber-100'
                : 'bg-rose-500/20 border-rose-400/60 text-rose-100'
          }`}
        >
          {status}
        </span>
      </div>

      {visibilityWarning ? (
        <div className="absolute top-12 right-3 z-20 text-xs px-2 py-1 rounded border border-amber-500/60 bg-amber-500/20 text-amber-100">
          visibility_warning=true
        </div>
      ) : null}

      <div className="absolute z-20 left-3 right-3 bottom-3 sm:left-auto sm:w-[min(420px,calc(100vw-1.5rem))] lg:w-[min(340px,34vw)] max-h-[42vh] overflow-y-auto rounded-lg border border-slate-500/50 bg-slate-950/20 backdrop-blur-md p-2">
        <p className="text-[10px] uppercase tracking-wide text-slate-300 mb-1">console</p>
        {debugLog.length === 0 ? (
          <p className="text-xs text-slate-500">No logs yet...</p>
        ) : (
          debugLog.map((line, i) => (
            <p key={i} className="text-[11px] leading-4 text-slate-200 break-all">
              {line}
            </p>
          ))
        )}
        {errorMessage ? (
          <p className="text-[11px] leading-4 text-rose-300 break-all mt-1">error={errorMessage}</p>
        ) : null}
      </div>
    </div>
  );
};
