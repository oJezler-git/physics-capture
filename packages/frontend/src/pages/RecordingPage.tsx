import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSessionStore } from '../stores/sessionStore';
import { useTrackingStore } from '../stores/trackingStore';
import { SyncMarkerComponent } from '../components/SyncMarker';
import { createRecorder, startRecording, stopRecording, uploadVideo } from '../lib/mediaRecorder';

export const RecordingPage = () => {
  const navigate = useNavigate();
  const { experimentId, cameras, advancePhase, recordingMode } = useSessionStore();
  const setTrackingFrameCount = useTrackingStore((state) => state.setFrameCount);

  const [isRecording, setIsRecording] = useState(false);
  const [frameCount, setFrameCount] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const recorders = useRef<Map<string, MediaRecorder>>(new Map());

  // Track what the backend is doing after Stop is pressed
  const [uploadPhase, setUploadPhase] = useState<'idle' | 'uploading' | 'extracting'>('idle');
  const [uploadProgress, setUploadProgress] = useState<Record<string, number>>({});

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    if (isRecording) {
      timer = setInterval(() => setElapsed((value) => value + 1), 1000);
    } else {
      setElapsed(0);
    }
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [isRecording]);

  const handleStart = async () => {
    if (!experimentId) return;
    setIsRecording(true);

    // Give the browser a moment to complete the layout transition (Focus Mode)
    // before the MediaRecorder starts capturing. This ensures frame 0 matches
    // the stable layout used for the rest of the clip.
    await new Promise((resolve) => setTimeout(resolve, 300));

    cameras.forEach((camera) => {
      if (!camera.stream) return;
      const recorder = createRecorder(camera.stream, recordingMode);
      recorders.current.set(camera.id, recorder);
      startRecording(recorder);
    });
  };

  const handleStop = async () => {
    setIsRecording(false);
    setUploadPhase('uploading');
    setUploadProgress({});
    let maxFrameCount = 0;

    for (const [cameraId, recorder] of recorders.current) {
      const blob = await stopRecording(recorder);
      const camera = cameras.find((candidate) => candidate.id === cameraId);
      const cameraIndex = cameras.findIndex((candidate) => candidate.id === cameraId);
      if (camera && experimentId) {
        // Phase 1: XHR upload with progress
        const result = await uploadVideo(
          blob,
          experimentId,
          cameraIndex >= 0 ? cameraIndex : 0,
          elapsed * 1000,
          recordingMode,
          (loaded, total) => {
            const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
            setUploadProgress((prev) => ({ ...prev, [cameraId]: pct }));
            // Once all bytes are sent the server starts ffmpeg — switch phase
            if (pct === 100) setUploadPhase('extracting');
          },
        );
        maxFrameCount = Math.max(maxFrameCount, result.frameCount);
      }
    }

    if (maxFrameCount > 0) {
      setFrameCount(maxFrameCount);
      setTrackingFrameCount(maxFrameCount);
    }
    setUploadPhase('idle');
    recorders.current.clear();
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const overallUploadPct =
    Object.keys(uploadProgress).length > 0
      ? Math.round(
          Object.values(uploadProgress).reduce((sum, v) => sum + v, 0) /
            Object.keys(uploadProgress).length,
        )
      : 0;

  return (
    <div className="mx-auto max-w-7xl space-y-6 rise-in">
      {!isRecording && (
        <header className="surface-panel flex flex-wrap items-center justify-between gap-5 p-6 transition-all duration-300">
          <div>
            <p className="eyebrow">Phase 03 - Capture</p>
            <h1 className="mt-1 text-3xl">Record Experiment Run</h1>
            <p className="subtle-copy mt-2">Session {experimentId?.slice(0, 8).toUpperCase()}</p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <span className="ui-pill">
              Capture mode:{' '}
              {recordingMode === 'legacy'
                ? 'Legacy'
                : recordingMode === 'browser-high'
                  ? 'Browser high'
                  : 'Extreme preview'}
            </span>
            <button onClick={handleStart} className="btn-main" disabled={uploadPhase !== 'idle'}>
              Start Recording
            </button>
          </div>
        </header>
      )}

      {isRecording && (
        <div className="flex items-center justify-between px-6 py-4 bg-rose-500/10 border border-rose-400/25 rounded-2xl animate-pulse">
          <div className="flex items-center gap-3">
            <div className="w-3 h-3 rounded-full bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.6)]" />
            <span className="font-mono text-xl font-bold tracking-tight text-rose-100 uppercase">
              Live Capture: {formatTime(elapsed)}
            </span>
          </div>
          <button
            onClick={handleStop}
            className="px-6 py-2.5 rounded-xl border border-rose-300/40 bg-black/40 text-sm font-bold uppercase tracking-wider text-rose-100 hover:bg-rose-500/20 transition-all"
          >
            End Recording & Extract
          </button>
        </div>
      )}

      <div className={`grid gap-6 ${isRecording ? 'grid-cols-1' : 'lg:grid-cols-[1.8fr_1fr]'}`}>
        <section className={`surface-panel p-5 ${isRecording ? 'h-[75vh]' : 'h-[400px] lg:h-[500px]'}`}>
          {!isRecording && (
            <div className="mb-3 flex items-center justify-between">
              <p className="eyebrow">Visual Sync Lane</p>
              <span className="ui-pill">Idle</span>
            </div>
          )}
          <div className="h-full">
            <SyncMarkerComponent config={{ grayBits: 14, gratingCycles: 4 }} />
          </div>
        </section>

        {!isRecording && (
          <section className="surface-panel flex min-h-[420px] flex-col p-5">
          <div className="mb-3 flex items-center justify-between">
            <p className="eyebrow">Live Monitors</p>
            <span className="ui-pill">{cameras.length} sources</span>
          </div>

          <div className="custom-scrollbar flex-1 space-y-3 overflow-y-auto pr-1">
            {cameras.map((camera, index) => (
              <div key={camera.id} className="surface-soft overflow-hidden">
                <div className="relative aspect-video bg-black">
                  {camera.stream ? (
                    <video
                      autoPlay
                      playsInline
                      muted
                      className="h-full w-full object-cover"
                      ref={(element) => {
                        if (element) element.srcObject = camera.stream;
                      }}
                    />
                  ) : (
                    <div className="grid h-full w-full place-items-center text-xs uppercase tracking-[0.18em] text-slate-500">
                      Negotiating stream...
                    </div>
                  )}
                  <div className="absolute left-2 top-2 rounded border border-black/30 bg-black/55 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-100">
                    Cam {index + 1}
                  </div>
                </div>
                <div className="flex items-center justify-between px-3 py-2 text-xs text-slate-400">
                  <span>{camera.label}</span>
                  <span>{camera.status}</span>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4 border-t border-slate-800 pt-4">
            {frameCount !== null ? (
              <button
                onClick={() => {
                  advancePhase();
                  navigate('/tracking');
                }}
                className="btn-main w-full"
              >
                Continue to Tracking
              </button>
            ) : uploadPhase === 'uploading' ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs text-slate-400">
                  <span className="uppercase tracking-[0.14em]">Uploading footage</span>
                  <span className="font-mono">{overallUploadPct}%</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-slate-800">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-sky-500 to-indigo-500 transition-all duration-300"
                    style={{ width: `${overallUploadPct}%` }}
                  />
                </div>
              </div>
            ) : uploadPhase === 'extracting' ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs text-slate-400">
                  <svg
                    className="h-3.5 w-3.5 animate-spin text-sky-400"
                    viewBox="0 0 24 24"
                    fill="none"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                    />
                  </svg>
                  <span className="uppercase tracking-[0.14em]">Extracting frames (ffmpeg)…</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-slate-800">
                  <div className="h-full w-full animate-pulse rounded-full bg-gradient-to-r from-sky-500/50 to-indigo-500/50" />
                </div>
              </div>
            ) : isRecording ? (
              <p className="text-center text-xs uppercase tracking-[0.18em] text-slate-500">
                Capturing in progress
              </p>
            ) : (
              <p className="text-center text-xs uppercase tracking-[0.18em] text-slate-500">
                Awaiting frame extraction
              </p>
            )}
          </div>
        </section>
        )}
      </div>
    </div>
  );
};
