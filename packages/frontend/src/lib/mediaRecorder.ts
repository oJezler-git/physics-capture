// packages/frontend/src/lib/mediaRecorder.ts

import type { RecordingMode } from '../types';

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

function isAppleMobileBrowser(): boolean {
  const userAgent = navigator.userAgent || '';
  const platform = navigator.platform || '';
  return /iPhone|iPad|iPod/i.test(userAgent) || /iPhone|iPad|iPod/i.test(platform);
}

function extensionFromMimeType(mimeType: string): string {
  if (mimeType.includes('mp4')) return 'mp4';
  if (mimeType.includes('webm')) return 'webm';
  if (mimeType.includes('x-matroska') || mimeType.includes('matroska')) return 'mkv';
  return 'webm';
}

export function pickPreferredRecorderMimeType(mode: RecordingMode): string {
  if (mode === 'legacy') {
    const legacyOrder = [
      'video/webm;codecs=vp8',
      'video/webm;codecs=vp9',
      'video/mp4;codecs=avc1',
      'video/mp4',
    ];
    return (
      legacyOrder.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || 'video/webm'
    );
  }

  const appleFirst = [
    'video/mp4;codecs=avc1',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
  ];
  const defaultOrder = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/mp4;codecs=avc1',
    'video/mp4',
  ];
  const candidates = isAppleMobileBrowser() ? appleFirst : defaultOrder;
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || 'video/webm';
}

export async function acquireCamera(
  mode: RecordingMode = 'browser-high',
): Promise<{ stream: MediaStream; settings: CameraSettings }> {
  const isLegacy = mode === 'legacy';
  const constraints: MediaStreamConstraints = {
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: isLegacy ? 1920 : 3840 },
      height: { ideal: isLegacy ? 1080 : 2160 },
      frameRate: { ideal: isLegacy ? 30 : 60, max: isLegacy ? 30 : 60 },
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

export function createRecorder(
  stream: MediaStream,
  mode: RecordingMode = 'browser-high',
): MediaRecorder {
  const mimeType = pickPreferredRecorderMimeType(mode);
  const videoBitsPerSecond = mode === 'legacy' ? 20_000_000 : 100_000_000;

  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond,
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
  recorder.start();
}

export async function stopRecording(recorder: MediaRecorder): Promise<Blob> {
  const chunks = recorderChunks.get(recorder) ?? [];

  return new Promise((resolve) => {
    if (recorder.state === 'inactive') {
      resolve(new Blob(chunks, { type: recorder.mimeType }));
      return;
    }

    recorder.onstop = () => {
      resolve(new Blob(chunks, { type: recorder.mimeType }));
    };
    recorder.stop();
  });
}

export async function uploadVideo(
  blob: Blob,
  experimentId: string,
  cameraId: number,
  durationMs: number,
  recordingMode: RecordingMode,
  onProgress: (loaded: number, total: number) => void,
): Promise<UploadResult> {
  if (blob.size === 0) {
    throw new Error('Recorded video is empty. The browser did not emit any video chunks.');
  }

  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append('experiment_id', experimentId);
    formData.append('camera_id', cameraId.toString());
    formData.append('recording_mode', recordingMode);
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
