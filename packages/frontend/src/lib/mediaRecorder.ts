// packages/frontend/src/lib/mediaRecorder.ts

export interface CameraSettings {
  width: number;
  height: number;
  frameRate: number;
  facingMode: string;
  deviceId: string;
}

export interface RecordingResult {
  videoBlob: Blob;
  mimeType: string;
  durationMs: number;
  actualSettings: CameraSettings;
}

export interface UploadResult {
  experimentId: string;
  cameraId: number;
  storedPath: string;
  frameCount: number;
}

const recorderChunks = new WeakMap<MediaRecorder, Blob[]>();

function extensionFromMimeType(mimeType: string): string {
  if (mimeType.includes("mp4")) return "mp4";
  if (mimeType.includes("webm")) return "webm";
  if (mimeType.includes("x-matroska") || mimeType.includes("matroska")) return "mkv";
  return "webm";
}

export async function acquireCamera(): Promise<{ stream: MediaStream; settings: CameraSettings }> {
  const constraints: MediaStreamConstraints = {
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 3840 },
      height: { ideal: 2160 },
      frameRate: { ideal: 60, max: 60 },
    },
  };

  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  const track = stream.getVideoTracks()[0];
  const settings = track.getSettings();

  const cameraSettings: CameraSettings = {
    width: settings.width || 0,
    height: settings.height || 0,
    frameRate: settings.frameRate || 0,
    facingMode: settings.facingMode || '',
    deviceId: settings.deviceId || '',
  };

  return { stream, settings: cameraSettings };
}

export function createRecorder(stream: MediaStream): MediaRecorder {
  const candidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/mp4;codecs=avc1',
    'video/mp4',
  ];

  const mimeType = candidates.find((c) => MediaRecorder.isTypeSupported(c)) || 'video/webm';
  
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 100_000_000,
  });

  recorderChunks.set(recorder, []);
  recorder.ondataavailable = (event) => {
    if (!event.data || event.data.size === 0) return;
    const chunks = recorderChunks.get(recorder);
    if (chunks) {
      chunks.push(event.data);
    }
  };

  return recorder;
}

export async function startRecording(recorder: MediaRecorder): Promise<void> {
  recorderChunks.set(recorder, []);
  recorder.start(1000);
}

export async function stopRecording(recorder: MediaRecorder): Promise<Blob> {
  const chunks = recorderChunks.get(recorder) ?? [];

  return new Promise((resolve) => {
    if (recorder.state === "inactive") {
      resolve(new Blob(chunks, { type: recorder.mimeType }));
      return;
    }

    recorder.onstop = () => {
      resolve(new Blob(chunks, { type: recorder.mimeType }));
    };
    recorder.requestData();
    recorder.stop();
  });
}

export async function uploadVideo(
  blob: Blob,
  experimentId: string,
  cameraId: number,
  durationMs: number,
  onProgress: (loaded: number, total: number) => void
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append('experiment_id', experimentId);
    formData.append('camera_id', cameraId.toString());
    formData.append('mime_type', blob.type);
    formData.append('duration_ms', durationMs.toString());
    const ext = extensionFromMimeType(blob.type);
    formData.append('file', blob, `cam${cameraId}.${ext}`);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload-video');
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(event.loaded, event.total);
      }
    };
    xhr.onload = () => {
      if (xhr.status === 200) {
        const payload = JSON.parse(xhr.responseText);
        resolve({
          experimentId: payload.experimentId ?? payload.experiment_id ?? experimentId,
          cameraId: Number(payload.cameraId ?? payload.camera_id ?? cameraId),
          storedPath: payload.storedPath ?? payload.stored_path ?? '',
          frameCount: Number(payload.frameCount ?? payload.frame_count ?? 0),
        });
      } else {
        reject(new Error(`Upload failed: ${xhr.statusText}`));
      }
    };
    xhr.onerror = () => reject(new Error('Upload failed'));
    xhr.send(formData);
  });
}
