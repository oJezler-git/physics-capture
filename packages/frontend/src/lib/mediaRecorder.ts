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
  cameraId: 0 | 1;
  storedPath: string;
  frameCount: number;
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
  
  return new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 100_000_000,
  });
}

export async function startRecording(recorder: MediaRecorder): Promise<void> {
  recorder.start(1000);
}

export async function stopRecording(recorder: MediaRecorder): Promise<Blob> {
  const chunks: Blob[] = [];
  
  // Set up data collection before stopping
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };

  return new Promise((resolve) => {
    recorder.onstop = () => {
      resolve(new Blob(chunks, { type: recorder.mimeType }));
    };
    recorder.stop();
  });
}

export async function uploadVideo(
  blob: Blob,
  experimentId: string,
  cameraId: 0 | 1,
  durationMs: number,
  onProgress: (loaded: number, total: number) => void
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append('experiment_id', experimentId);
    formData.append('camera_id', cameraId.toString());
    formData.append('mime_type', blob.type);
    formData.append('duration_ms', durationMs.toString());
    formData.append('file', blob, `cam${cameraId}.webm`);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload-video');
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(event.loaded, event.total);
      }
    };
    xhr.onload = () => {
      if (xhr.status === 200) {
        resolve(JSON.parse(xhr.responseText));
      } else {
        reject(new Error(`Upload failed: ${xhr.statusText}`));
      }
    };
    xhr.onerror = () => reject(new Error('Upload failed'));
    xhr.send(formData);
  });
}
