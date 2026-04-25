import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { wsClient } from '../lib/wsClient';
import { useSessionStore } from '../stores/sessionStore';
import { acquireCamera, createRecorder } from '../lib/mediaRecorder';
import {
  describeCandidate,
  getRtcConfiguration,
  toIceCandidateInit,
  toSessionDescriptionInit,
} from '../lib/rtcConfig';

type RecordState = 'idle' | 'recording' | 'uploading' | 'done' | 'error';

export const PhonePage = () => {
  const [searchParams] = useSearchParams();
  const room = searchParams.get('room');
  const requestedCameraId = Number.parseInt(searchParams.get('camera') ?? '0', 10);
  const resolvedCameraId =
    Number.isFinite(requestedCameraId) && requestedCameraId >= 0 ? requestedCameraId : 0;
  const requestedMode = searchParams.get('recording');
  const recordingMode =
    requestedMode === 'legacy' || requestedMode === 'future-extreme'
      ? requestedMode
      : 'browser-high';
  const setRecordingMode = useSessionStore((state) => state.setRecordingMode);

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
    setRecordingMode(recordingMode);

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
  }, [room, recordingMode, setRecordingMode, teardownPeerConnection]);

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
      const { stream: mediaStream, settings } = await acquireCamera(recordingMode);
      if (isCancelled()) {
        mediaStream.getTracks().forEach((t) => t.stop());
        return;
      }
      dbg(
        `Camera granted ${settings.width}x${settings.height} @ ${settings.frameRate}fps (${settings.facingMode || 'unknown'} / ${settings.deviceId || 'n/a'})`,
      );
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
      dbg('Received WebRTC answer');
      await peerConnectionRef.current?.setRemoteDescription(
        new RTCSessionDescription(toSessionDescriptionInit(data)),
      );
    } else if (type === 'peer:ice') {
      try {
        await peerConnectionRef.current?.addIceCandidate(
          new RTCIceCandidate(toIceCandidateInit(data)),
        );
      } catch (err) {
        dbg(`Failed to add ICE candidate: ${(err as Error).message}`);
      }
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

    const pc = new RTCPeerConnection(getRtcConfiguration());
    peerConnectionRef.current = pc;

    stream!.getTracks().forEach((track) => pc.addTrack(track, stream!));

    const videoSender = pc.getSenders().find((sender) => sender.track?.kind === 'video');
    if (videoSender) {
      try {
        const parameters: any = videoSender.getParameters();
        parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
        parameters.encodings[0] = {
          ...parameters.encodings[0],
          maxBitrate: 2_500_000,
        };
        parameters.degradationPreference = 'maintain-framerate';
        await videoSender.setParameters(parameters);
        dbg('Preview bitrate capped for WebRTC monitor stream');
      } catch (err) {
        dbg(`Preview bitrate cap unavailable: ${(err as Error).message}`);
      }
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        dbg(`ICE -> pc ${describeCandidate(event.candidate)}`);
        wsClient.send({
          type: 'peer:ice',
          data: { ...event.candidate.toJSON(), peerId: phoneClientIdRef.current } as any,
          to: 'pc',
        });
      }
    };
    pc.oniceconnectionstatechange = () => {
      dbg(`iceConnectionState=${pc.iceConnectionState}`);
    };
    pc.onicegatheringstatechange = () => {
      dbg(`iceGatheringState=${pc.iceGatheringState}`);
    };
    pc.onconnectionstatechange = () => {
      dbg(`connectionState=${pc.connectionState}`);
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
    dbg('Sent WebRTC offer');
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
    const recorder = createRecorder(stream, recordingMode);

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };

    recorder.onstop = uploadRecording;

    dbg(`Recorder configured ${recorder.mimeType} @ ${recorder.videoBitsPerSecond}bps`);
    recorder.start();
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

    if (blob.size === 0) {
      setRecordState('error');
      setErrorMessage(
        `Recording came back empty (${mediaRecorderRef.current?.mimeType || 'unknown mime type'}).`,
      );
      return;
    }
    if (!experimentId) {
      setRecordState('error');
      setErrorMessage('Missing experiment id for upload.');
      return;
    }

    const formData = new FormData();
    const uploadExt = blob.type.includes('mp4')
      ? 'mp4'
      : blob.type.includes('webm')
        ? 'webm'
        : 'bin';
    formData.append('experiment_id', experimentId);
    formData.append('camera_id', String(resolvedCameraId));
    formData.append('recording_mode', recordingMode);
    formData.append('mime_type', blob.type || 'application/octet-stream');
    formData.append('duration_ms', '0');
    formData.append('file', blob, `cam${resolvedCameraId}_${Date.now()}.${uploadExt}`);

    const xhr = new XMLHttpRequest();
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        setRecordState('done');
      } else {
        setRecordState('error');
        setErrorMessage(`Upload failed (${xhr.status})`);
      }
    };
    xhr.onerror = () => {
      setRecordState('error');
      setErrorMessage('Upload failed');
    };
    xhr.open('POST', '/api/upload-video');
    xhr.send(formData);
  };

  return (
    <div className="fixed inset-0 bg-[var(--bg-base)] text-slate-100 overflow-hidden">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="absolute inset-0 w-full h-full object-cover"
      />

      <div className="absolute top-3 right-3 z-20">
        <span
          className={`text-xs px-3 py-1.5 rounded-full border font-medium tracking-wider uppercase backdrop-blur-md shadow-sm ${
            status === 'connected'
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
              : status === 'connecting'
                ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
                : 'bg-[var(--accent)]/10 border-[var(--accent)]/30 text-[var(--accent)]'
          }`}
        >
          {status}
        </span>
      </div>

      {visibilityWarning && (
        <div className="absolute top-12 right-3 z-20 text-xs px-3 py-1.5 rounded-full border border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)] font-medium tracking-wider uppercase backdrop-blur-md shadow-sm">
          visibility_warning=true
        </div>
      )}

      <div className="absolute z-20 left-3 right-3 bottom-3 sm:left-auto sm:w-[min(420px,calc(100vw-1.5rem))] lg:w-[min(340px,34vw)] max-h-[42vh] overflow-y-auto rounded-3xl border border-[var(--line)] bg-[#09090b]/80 p-5 shadow-lg backdrop-blur-xl custom-scrollbar">
        <p className="text-[10px] font-medium uppercase tracking-wider text-slate-500 mb-2">console</p>
        {debugLog.length === 0 ? (
          <p className="text-xs text-slate-500">No logs yet...</p>
        ) : (
          debugLog.map((line, i) => (
            <p key={i} className="text-[11px] leading-relaxed text-slate-300 break-all font-mono">
              {line}
            </p>
          ))
        )}
        {errorMessage && (
          <p className="text-[11px] leading-4 text-[var(--accent)] break-all mt-1">error={errorMessage}</p>
        )}
      </div>
    </div>
  );
};
