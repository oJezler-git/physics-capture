import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSessionStore } from '../stores/sessionStore';
import { useTrackingStore } from '../stores/trackingStore';
import { SyncMarkerComponent } from '../components/SyncMarker';
import { createRecorder, startRecording, stopRecording, uploadVideo } from '../lib/mediaRecorder';

const SYNC_CONFIG = { grayBits: 10, gratingCycles: 4 };

type CaptureSource = 'live' | 'manual';

export const RecordingPage = () => {
  const navigate = useNavigate();
  const { experimentId, cameras, addCamera, advancePhase, recordingMode } = useSessionStore();
  const setTrackingFrameCount = useTrackingStore((state) => state.setFrameCount);
  const liveRecordableCameras = useMemo(() => cameras.filter((camera) => camera.stream), [cameras]);

  const [captureSource, setCaptureSource] = useState<CaptureSource>(
    liveRecordableCameras.length > 0 ? 'live' : 'manual',
  );
  const [isRecording, setIsRecording] = useState(false);
  const [frameCount, setFrameCount] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [manualSlots, setManualSlots] = useState(() => Math.min(3, Math.max(cameras.length, 1)));
  const [manualFiles, setManualFiles] = useState<Record<number, File | null>>({});
  const recorders = useRef<Map<string, MediaRecorder>>(new Map());

  // Track what the backend is doing after Stop/Upload is pressed
  const [uploadPhase, setUploadPhase] = useState<'idle' | 'uploading' | 'extracting'>('idle');
  const [uploadProgress, setUploadProgress] = useState<Record<string, number>>({});

  useEffect(() => {
    if (captureSource === 'live' && liveRecordableCameras.length === 0) {
      setCaptureSource('manual');
    }
  }, [captureSource, liveRecordableCameras.length]);

  useEffect(() => {
    setManualSlots((slots) => Math.min(3, Math.max(slots, cameras.length || 1)));
  }, [cameras.length]);

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

  const markUploadComplete = (maxFrameCount: number) => {
    if (maxFrameCount > 0) {
      setFrameCount(maxFrameCount);
      setTrackingFrameCount(maxFrameCount);
    }
    setUploadPhase('idle');
  };

  const updateUploadProgress = (key: string, loaded: number, total: number) => {
    const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
    setUploadProgress((prev) => ({ ...prev, [key]: pct }));
    if (pct === 100) setUploadPhase('extracting');
  };

  const handleStart = async () => {
    if (!experimentId || liveRecordableCameras.length === 0) return;
    setUploadError(null);
    setIsRecording(true);

    // Let focus-mode transition settle before frame 0 capture.
    await new Promise((resolve) => setTimeout(resolve, 300));

    liveRecordableCameras.forEach((camera) => {
      if (!camera.stream) return;
      const recorder = createRecorder(camera.stream, recordingMode);
      recorders.current.set(camera.id, recorder);
      startRecording(recorder);
    });
  };

  const handleStop = async () => {
    setIsRecording(false);
    setUploadError(null);
    setUploadPhase('uploading');
    setUploadProgress({});
    let maxFrameCount = 0;

    try {
      for (const [cameraId, recorder] of recorders.current) {
        const blob = await stopRecording(recorder);
        const camera = cameras.find((candidate) => candidate.id === cameraId);
        const cameraIndex = cameras.findIndex((candidate) => candidate.id === cameraId);
        if (!camera || !experimentId) continue;

        const result = await uploadVideo(
          blob,
          experimentId,
          cameraIndex >= 0 ? cameraIndex : 0,
          elapsed * 1000,
          recordingMode,
          (loaded, total) => updateUploadProgress(cameraId, loaded, total),
        );
        maxFrameCount = Math.max(maxFrameCount, result.frameCount);
      }
      markUploadComplete(maxFrameCount);
    } catch (error) {
      setUploadPhase('idle');
      setUploadError(error instanceof Error ? error.message : 'Live upload failed.');
    } finally {
      recorders.current.clear();
    }
  };

  const handleManualFileChange = (cameraIndex: number, file: File | null) => {
    setManualFiles((prev) => ({ ...prev, [cameraIndex]: file }));
  };

  const handleManualUpload = async () => {
    if (!experimentId) return;
    const selected = Array.from({ length: manualSlots }, (_, index) => ({
      index,
      file: manualFiles[index] ?? null,
    })).filter((entry) => !!entry.file) as Array<{ index: number; file: File }>;

    if (selected.length === 0) {
      setUploadError('Select at least one video file before uploading.');
      return;
    }

    setUploadError(null);
    setUploadPhase('uploading');
    setUploadProgress({});
    let maxFrameCount = 0;

    try {
      for (const entry of selected) {
        const result = await uploadVideo(
          entry.file,
          experimentId,
          entry.index,
          0,
          recordingMode,
          (loaded, total) => updateUploadProgress(`manual-${entry.index}`, loaded, total),
        );
        maxFrameCount = Math.max(maxFrameCount, result.frameCount);

        const existing = cameras[entry.index];
        addCamera({
          id: existing?.id ?? `uploaded-cam-${entry.index}`,
          type: existing?.type ?? 'phone',
          label: existing?.label ?? `Uploaded Cam ${entry.index + 1}`,
          stream: existing?.stream ?? null,
          status: existing?.stream ? 'live' : 'disconnected',
          peerId: existing?.peerId ?? null,
        });
      }

      markUploadComplete(maxFrameCount);
    } catch (error) {
      setUploadPhase('idle');
      setUploadError(error instanceof Error ? error.message : 'Manual upload failed.');
    }
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
            <div className="flex rounded-xl border border-slate-700 bg-slate-950/80 p-1">
              <button
                type="button"
                onClick={() => setCaptureSource('live')}
                disabled={liveRecordableCameras.length === 0}
                className={`rounded-lg px-3 py-1.5 text-xs uppercase tracking-[0.14em] transition ${
                  captureSource === 'live'
                    ? 'bg-sky-500/20 text-sky-100'
                    : 'text-slate-300 hover:text-slate-100'
                } ${liveRecordableCameras.length === 0 ? 'cursor-not-allowed opacity-50' : ''}`}
              >
                Live Capture
              </button>
              <button
                type="button"
                onClick={() => setCaptureSource('manual')}
                className={`rounded-lg px-3 py-1.5 text-xs uppercase tracking-[0.14em] transition ${
                  captureSource === 'manual'
                    ? 'bg-sky-500/20 text-sky-100'
                    : 'text-slate-300 hover:text-slate-100'
                }`}
              >
                Manual Upload
              </button>
            </div>
            <span className="ui-pill">
              Capture mode:{' '}
              {recordingMode === 'legacy'
                ? 'Legacy'
                : recordingMode === 'browser-high'
                  ? 'Browser high'
                  : 'Extreme preview'}
            </span>
            {captureSource === 'live' ? (
              <button
                onClick={handleStart}
                className="btn-main"
                disabled={uploadPhase !== 'idle' || liveRecordableCameras.length === 0}
              >
                Start Recording
              </button>
            ) : (
              <button onClick={handleManualUpload} className="btn-main" disabled={uploadPhase !== 'idle'}>
                Upload Selected Videos
              </button>
            )}
          </div>
        </header>
      )}

      {isRecording && (
        <div className="flex items-center justify-between rounded-2xl border border-rose-400/25 bg-rose-500/10 px-6 py-4 animate-pulse">
          <div className="flex items-center gap-3">
            <div className="h-3 w-3 rounded-full bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.6)]" />
            <span className="font-mono text-xl font-bold tracking-tight text-rose-100 uppercase">
              Live Capture: {formatTime(elapsed)}
            </span>
          </div>
          <button
            onClick={handleStop}
            className="rounded-xl border border-rose-300/40 bg-black/40 px-6 py-2.5 text-sm font-bold uppercase tracking-wider text-rose-100 transition-all hover:bg-rose-500/20"
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
              <span className="ui-pill">{captureSource === 'manual' ? 'Manual Upload' : 'Idle'}</span>
            </div>
          )}
          <div className="h-full">
            <SyncMarkerComponent config={SYNC_CONFIG} />
          </div>
        </section>

        {!isRecording && (
          <section className="surface-panel flex min-h-[420px] flex-col p-5">
            {captureSource === 'manual' ? (
              <>
                <div className="mb-3 flex items-center justify-between">
                  <p className="eyebrow">Manual Video Ingest</p>
                  <span className="ui-pill">{manualSlots} slot{manualSlots > 1 ? 's' : ''}</span>
                </div>
                <div className="mb-3 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setManualSlots((count) => Math.min(3, count + 1))}
                    className="btn-alt px-3 py-1.5 text-[10px]"
                    disabled={manualSlots >= 3}
                  >
                    Add Slot
                  </button>
                  <button
                    type="button"
                    onClick={() => setManualSlots((count) => Math.max(1, count - 1))}
                    className="btn-alt px-3 py-1.5 text-[10px]"
                    disabled={manualSlots <= 1}
                  >
                    Remove Slot
                  </button>
                </div>
                <div className="custom-scrollbar flex-1 space-y-3 overflow-y-auto pr-1">
                  {Array.from({ length: manualSlots }, (_, index) => {
                    const camera = cameras[index];
                    const file = manualFiles[index];
                    return (
                      <div key={`manual-slot-${index}`} className="surface-soft space-y-2 p-3">
                        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-300">
                          {camera?.label ?? `Cam ${index + 1}`}
                        </p>
                        <input
                          type="file"
                          accept="video/*"
                          onChange={(event) => {
                            const selectedFile = event.currentTarget.files?.[0] ?? null;
                            handleManualFileChange(index, selectedFile);
                          }}
                          className="block w-full text-xs text-slate-300 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-700 file:px-3 file:py-2 file:text-xs file:font-semibold file:text-slate-100 hover:file:bg-slate-600"
                        />
                        <p className="text-[11px] text-slate-400 truncate">
                          {file ? file.name : 'No file selected'}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : (
              <>
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
              </>
            )}

            <div className="mt-4 border-t border-slate-800 pt-4">
              {uploadError ? (
                <div className="mb-3 rounded-xl border border-rose-400/35 bg-rose-500/10 px-3 py-2 text-xs text-rose-100">
                  {uploadError}
                </div>
              ) : null}
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
                    <span className="uppercase tracking-[0.14em]">Extracting frames (ffmpeg)...</span>
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
