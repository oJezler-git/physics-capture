import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSessionStore } from '../stores/sessionStore';
import { useTrackingStore } from '../stores/trackingStore';
import { createRecorder, startRecording, stopRecording, uploadVideo } from '../lib/mediaRecorder';
import { Button } from '../components/ui/Button';

type CaptureSource = 'live' | 'manual';

export const RecordingPage = () => {
  const navigate = useNavigate();
  const { experimentId, cameras, addCamera, advancePhase, recordingMode } = useSessionStore();
  const setTrackingFrameCount = useTrackingStore((state) => state.setFrameCount);
  const liveRecordableCameras = useMemo(() => cameras.filter((camera) => camera.stream), [cameras]);

  const [captureSource, setCaptureSource] = useState<CaptureSource>('manual');
  const [isRecording, setIsRecording] = useState(false);
  const [frameCount, setFrameCount] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [manualSlots] = useState(1);
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
    <div className="mx-auto max-w-7xl py-6 px-4 sm:px-6 lg:px-8 space-y-6">
      {!isRecording && (
        <header className="surface-panel flex flex-wrap items-center justify-between gap-5 p-5 transition-all duration-300 glitch-in stagger-1">
          <div className="space-y-1">
            <p className="eyebrow">Step 2/5</p>
            <h1 className="text-2xl sm:text-3xl">Capture</h1>
            <p className="subtle-copy max-w-2xl text-xs">
              Session {experimentId?.slice(0, 8).toUpperCase()} • Mode:{' '}
              {recordingMode === 'legacy'
                ? 'Legacy'
                : recordingMode === 'browser-high'
                  ? 'Browser high'
                  : 'Extreme'}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="flex border border-[var(--line)] bg-[var(--bg-panel)] p-1 rounded-2xl">
              <Button
                type="button"
                onClick={() => setCaptureSource('live')}
                disabled={liveRecordableCameras.length === 0}
                className={`rounded-xl px-4 py-1.5 text-[10px] font-semibold tracking-wide transition-all ${
                  captureSource === 'live'
                    ? 'bg-[var(--accent)] text-zinc-950 shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                } ${liveRecordableCameras.length === 0 ? 'cursor-not-allowed opacity-50' : ''}`}
              >
                Live Capture
              </Button>
              <Button
                type="button"
                onClick={() => setCaptureSource('manual')}
                className={`rounded-xl px-4 py-1.5 text-[10px] font-semibold tracking-wide transition-all ${
                  captureSource === 'manual'
                    ? 'bg-[var(--accent)] text-zinc-950 shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Manual Upload
              </Button>
            </div>

            {frameCount !== null ? (
              <Button
                variant="main"
                onClick={() => {
                  advancePhase();
                  navigate('/calibration');
                }}
                className="px-6 py-2"
              >
                Continue to Scale
              </Button>
            ) : captureSource === 'live' ? (
              <Button
                variant="main"
                sound="start"
                onClick={handleStart}
                className="px-6 py-2"
                disabled={uploadPhase !== 'idle' || liveRecordableCameras.length === 0}
              >
                Start Recording
              </Button>
            ) : (
              <Button
                variant="main"
                onClick={handleManualUpload}
                className="px-6 py-2"
                disabled={uploadPhase !== 'idle'}
              >
                Upload & Proceed
              </Button>
            )}
          </div>
        </header>
      )}

      {isRecording && (
        <div className="flex items-center justify-between rounded-3xl border border-[var(--accent)] bg-[var(--accent)]/10 px-6 py-4 animate-pulse slide-up">
          <div className="flex items-center gap-4">
            <div className="h-4 w-4 rounded-full bg-[var(--accent)] shadow-[0_0_15px_var(--accent)]" />
            <span className="font-mono text-xl font-bold tracking-tight text-[var(--accent)]">
              Live Capture: {formatTime(elapsed)}
            </span>
          </div>
          <Button
            onClick={handleStop}
            sound="stop"
            className="rounded-xl border border-[var(--accent)] bg-[var(--accent)] px-6 py-2 text-sm font-semibold tracking-wide text-zinc-950 transition-all hover:bg-[var(--accent-hover)]"
          >
            End Recording & Extract
          </Button>
        </div>
      )}

      <div
        className={`grid gap-6 ${isRecording ? 'grid-cols-1' : 'lg:grid-cols-[5fr_3fr]'} items-start`}
      >
        <div className="flex flex-col gap-6">
          <section className="surface-panel p-5 glitch-in stagger-2">
            <p className="eyebrow">Planar Capture</p>
            <h2 className="mt-1 text-xl">One Overhead Video</h2>
            <p className="subtle-copy mt-2 text-xs">
              Place the camera above the scene, keep the ball path and a ruler in frame, then upload
              the recording as Cam 1. No visual sync, stereo calibration, or second camera is
              needed.
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <div className="surface-soft rounded-xl p-3">
                <p className="text-[9px] font-bold uppercase tracking-wider text-slate-400">
                  Camera
                </p>
                <p className="mt-1 text-xs text-slate-200">Overhead, zoomed, steady</p>
              </div>
              <div className="surface-soft rounded-xl p-3">
                <p className="text-[9px] font-bold uppercase tracking-wider text-slate-400">
                  Scale
                </p>
                <p className="mt-1 text-xs text-slate-200">Ruler in the ball plane</p>
              </div>
              <div className="surface-soft rounded-xl p-3">
                <p className="text-[9px] font-bold uppercase tracking-wider text-slate-400">
                  Motion
                </p>
                <p className="mt-1 text-xs text-slate-200">Keep the full path visible</p>
              </div>
            </div>
          </section>

          {!isRecording && captureSource === 'live' && (
            <section className="surface-panel p-5 glitch-in stagger-3">
              <div className="mb-3 flex items-center justify-between">
                <p className="eyebrow">Live Monitors</p>
                <span className="ui-pill text-[9px]">{cameras.length} sources</span>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                {cameras.map((camera, index) => (
                  <div
                    key={camera.id}
                    className="surface-soft overflow-hidden rounded-xl border border-[var(--line)]"
                  >
                    <div className="relative aspect-video bg-[var(--bg-base)]">
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
                        <div className="grid h-full w-full place-items-center text-[9px] font-medium tracking-wider uppercase text-slate-500">
                          Negotiating stream...
                        </div>
                      )}
                      <div className="absolute left-2 top-2 rounded-md border border-[var(--line)] bg-black/40 px-2 py-1 text-[9px] font-semibold tracking-widest uppercase text-slate-100 backdrop-blur-md">
                        Cam {index + 1}
                      </div>
                    </div>
                    <div className="flex items-center justify-between px-3 py-1.5 text-[9px] text-slate-400">
                      <span>{camera.label}</span>
                      <span className="capitalize">{camera.status}</span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>

        {!isRecording && (
          <div className="flex flex-col gap-6" style={{ animationDelay: '100ms' }}>
            {captureSource === 'manual' && (
              <section className="surface-panel flex flex-col p-5 glitch-in stagger-3">
                <div className="mb-4 flex items-center justify-between">
                  <p className="eyebrow">Manual Video Upload</p>
                  <span className="ui-pill text-[9px]">Single camera</span>
                </div>

                <div className="space-y-3">
                  {Array.from({ length: manualSlots }, (_, index) => {
                    const camera = cameras[index];
                    const file = manualFiles[index];
                    return (
                      <div
                        key={`manual-slot-${index}`}
                        className="surface-soft space-y-2 p-3 rounded-xl border border-[var(--line)]"
                      >
                        <p className="text-[9px] font-semibold tracking-wider uppercase text-slate-400">
                          {camera?.label ?? 'Overhead Cam'}
                        </p>
                        <input
                          type="file"
                          accept="video/*"
                          onChange={(event) => {
                            const selectedFile = event.currentTarget.files?.[0] ?? null;
                            handleManualFileChange(index, selectedFile);
                          }}
                          className="block w-full text-[10px] text-slate-300 file:mr-2 file:rounded-lg file:border-0 file:bg-[var(--bg-panel)] file:px-2 file:py-1 file:text-[9px] file:font-semibold file:text-slate-100 hover:file:bg-slate-700"
                        />
                        <p className="text-[9px] text-slate-400 truncate">
                          {file ? file.name : 'No file selected'}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            <section className="surface-panel p-5 glitch-in stagger-4">
              <p className="eyebrow mb-4">Status & Pipeline</p>

              <div className="space-y-4">
                {uploadError && (
                  <div className="rounded-xl border border-[var(--accent)] bg-[var(--accent)]/10 px-4 py-3 text-xs font-medium text-[var(--accent)]">
                    {uploadError}
                  </div>
                )}

                {uploadPhase === 'uploading' ? (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between text-[10px] text-slate-400">
                      <span className="font-medium tracking-wider uppercase">
                        Uploading footage
                      </span>
                      <span className="font-mono text-[var(--accent)]">{overallUploadPct}%</span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full border border-[var(--line)] bg-[var(--bg-panel)]">
                      <div
                        className="h-full bg-[var(--accent)] transition-all duration-300"
                        style={{ width: `${overallUploadPct}%` }}
                      />
                    </div>
                  </div>
                ) : uploadPhase === 'extracting' ? (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 text-[10px] text-slate-400">
                      <div className="w-3 h-3 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
                      <span className="font-medium tracking-wider uppercase">
                        FFmpeg Extraction...
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full border border-[var(--line)] bg-[var(--bg-panel)]">
                      <div className="h-full w-full animate-pulse bg-[var(--accent)]" />
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center py-4 border-2 border-dashed border-[var(--line)] rounded-2xl">
                    <p className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
                      {frameCount !== null ? 'Extraction Ready' : 'Awaiting footage'}
                    </p>
                  </div>
                )}
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
};
