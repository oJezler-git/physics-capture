import { useSessionStore } from '../stores/sessionStore';
import { useCalibrationStore } from '../stores/calibrationStore';
import { useTrackingStore } from '../stores/trackingStore';
import { useResultsStore } from '../stores/resultsStore';
import type { BallTrack, CalibrationResult, CameraDevice, PhysicsResult } from '../types';

// Define message types matching the implementation plan
export type InboundMessage =
  | { type: 'phone:joined'; data: CameraDevice }
  | { type: 'calibration:progress'; data: { progress: number; stage: string } }
  | { type: 'calibration:failed'; data: { message: string } }
  | { type: 'calibration:complete'; data: CalibrationResult }
  | { type: 'tracking:update'; data: { tracks: BallTrack[]; progress: number } }
  | { type: 'tracking:complete'; data: { tracks: BallTrack[] } }
  | { type: 'tracking:correction_applied'; data: { ok: boolean } }
  | { type: 'physics:result'; data: PhysicsResult }
  | { type: 'upload:progress'; data: { cameraId: string; percent: number } }
  | { type: 'frames:ready'; data: { frameCount: number } }
  | { type: 'record:start'; data: { experimentId: string } }
  | { type: 'record:stop'; data: { experimentId: string } }
  | { type: 'peer:offer'; data: RTCSessionDescriptionInit & { peerId: string } }
  | { type: 'peer:answer'; data: RTCSessionDescriptionInit & { peerId: string } }
  | { type: 'peer:ice'; data: RTCIceCandidateInit & { peerId: string } };

export type OutboundMessage =
  | { type: 'record:start'; experimentId: string }
  | { type: 'record:stop'; experimentId: string }
  | { type: 'peer:offer'; data: RTCSessionDescriptionInit & { peerId: string } }
  | { type: 'peer:answer'; data: RTCSessionDescriptionInit & { peerId: string } }
  | { type: 'peer:ice'; data: RTCIceCandidateInit & { peerId: string } }
  | { type: 'join'; room: string; role: 'pc' | 'phone'; label?: string };

export class WSClient {
  private socket: WebSocket | null = null;
  private url: string;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private messageQueue: OutboundMessage[] = [];
  private isConnected = false;

  constructor(url: string = 'ws://localhost:3001') {
    this.url = url;
  }

  connect() {
    try {
      this.socket = new WebSocket(this.url);

      this.socket.onopen = () => {
        console.log('[WS] Connected');
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.flushQueue();
      };

      this.socket.onmessage = (event) => {
        try {
          const msg: InboundMessage = JSON.parse(event.data);
          this.dispatch(msg);
        } catch (err) {
          console.error('[WS] Parse error', err, event.data);
        }
      };

      this.socket.onclose = (event) => {
        this.isConnected = false;
        console.warn(`[WS] Disconnected (code: ${event.code})`);
        this.attemptReconnect();
      };

      this.socket.onerror = (err) => {
        console.error('[WS] Error', err);
      };
    } catch (err) {
      console.error('[WS] Connection failed', err);
      this.attemptReconnect();
    }
  }

  private attemptReconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = Math.min(250 * Math.pow(2, this.reconnectAttempts), 8000);
      console.log(
        `[WS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`,
      );
      setTimeout(() => this.connect(), delay);
    } else {
      console.error('[WS] Max reconnect attempts reached');
    }
  }

  send(msg: OutboundMessage) {
    if (this.isConnected && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(msg));
    } else {
      console.warn('[WS] Not connected, queueing message', msg);
      if (this.messageQueue.length < 20) {
        this.messageQueue.push(msg);
      }
    }
  }

  private flushQueue() {
    while (this.messageQueue.length > 0) {
      const msg = this.messageQueue.shift();
      if (msg) this.send(msg);
    }
  }

  private dispatch(msg: InboundMessage) {
    switch (msg.type) {
      case 'phone:joined':
        useSessionStore.getState().addCamera(msg.data);
        break;
      case 'calibration:progress':
        useCalibrationStore.getState().onCalibrationProgress(msg.data.progress);
        break;
      case 'calibration:complete':
        useCalibrationStore.getState().onCalibrationComplete(msg.data);
        break;
      case 'calibration:failed':
        useCalibrationStore.getState().onCalibrationFailed(msg.data.message);
        break;
      case 'tracking:update':
        useTrackingStore.getState().onTrackingUpdate(msg.data.tracks, msg.data.progress);
        break;
      case 'tracking:complete':
        useTrackingStore.getState().onTrackingComplete(msg.data.tracks);
        break;
      case 'tracking:correction_applied':
        window.dispatchEvent(new CustomEvent('ws:tracking', { detail: msg }));
        break;
      case 'physics:result':
        useResultsStore.getState().onPhysicsResult(msg.data);
        break;
      case 'upload:progress':
        // Update per-camera upload progress in sessionStore or a dedicated uploadStore
        // For now, let's just log it
        console.log(`[WS] Upload progress for ${msg.data.cameraId}: ${msg.data.percent}%`);
        break;
      case 'frames:ready':
        useTrackingStore.getState().setFrameCount(msg.data.frameCount);
        window.dispatchEvent(new CustomEvent('ws:frames', { detail: msg }));
        break;
      case 'record:start':
      case 'record:stop':
        window.dispatchEvent(new CustomEvent('ws:record', { detail: msg }));
        break;
      case 'peer:offer':
      case 'peer:answer':
      case 'peer:ice':
        // These will be handled by the WebRTC Manager
        window.dispatchEvent(new CustomEvent('ws:webrtc', { detail: msg }));
        break;
      default:
        console.warn('[WS] Unknown message type', (msg as { type: string }).type);
    }
  }
}

const parseHost = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return '';

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      return new URL(trimmed).hostname;
    } catch {
      return trimmed;
    }
  }

  return trimmed.split(':')[0];
};

const isLocalHostname = (hostname: string) => {
  if (!hostname) return false;

  if (hostname === 'localhost' || hostname === '0.0.0.0') return true;
  if (hostname.endsWith('.local')) return true;
  if (/^127\./.test(hostname)) return true;
  if (/^10\./.test(hostname)) return true;
  if (/^192\.168\./.test(hostname)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)) return true;

  return false;
};

const getDefaultWsUrl = () => {
  const host = parseHost(import.meta.env.VITE_APP_HOST || '') || window.location.hostname;
  const protocol = isLocalHostname(host) ? 'ws' : 'wss';
  return `${protocol}://${host}:3001`;
};

// Use explicit WebSocket URL when provided, otherwise infer local/public fallback.
const WS_URL = import.meta.env.VITE_WS_URL || getDefaultWsUrl();
export const wsClient = new WSClient(WS_URL);
