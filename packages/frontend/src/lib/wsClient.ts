import { useSessionStore } from '../stores/sessionStore';
import { useCalibrationStore } from '../stores/calibrationStore';
import { useTrackingStore } from '../stores/trackingStore';
import { useResultsStore } from '../stores/resultsStore';
import { useUiStore } from '../stores/uiStore';
import type { BallTrack, CalibrationResult, CameraDevice, PhysicsResult } from '../types';

// Define message types matching the implementation plan
export type InboundMessage =
  | { type: 'phone:joined'; data: CameraDevice }
  | { type: 'peer:joined'; clientId: string; role: 'pc' | 'phone' }
  | { type: 'calibration:progress'; data: { progress: number; stage: string } }
  | { type: 'calibration:failed'; data: { message: string } }
  | { type: 'calibration:complete'; data: CalibrationResult }
  | { type: 'tracking:update'; data: { tracks: BallTrack[]; progress: number } }
  | { type: 'tracking:progress'; data: { progress: number } }
  | { type: 'tracking:complete'; data: { tracks: BallTrack[] } }
  | { type: 'tracking:correction_applied'; data: { ok: boolean } }
  | { type: 'physics:result'; data: PhysicsResult }
  | { type: 'upload:progress'; data: { cameraId: string; percent: number } }
  | {
      type: 'frames:ready';
      data: { frameCount: number; frameMap?: (string | null)[]; sequenceToPhysical?: number[] };
    }
  | { type: 'record:start'; data: { experimentId: string } }
  | { type: 'record:stop'; data: { experimentId: string } }
  | { type: 'peer:offer'; data: RTCSessionDescriptionInit & { peerId: string } }
  | { type: 'peer:answer'; data: RTCSessionDescriptionInit & { peerId: string } }
  | { type: 'peer:ice'; data: RTCIceCandidateInit & { peerId: string } };

export type OutboundMessage =
  | { type: 'record:start'; experimentId: string }
  | { type: 'record:stop'; experimentId: string }
  | { type: 'peer:offer'; data: RTCSessionDescriptionInit & { peerId: string }; to?: string }
  | { type: 'peer:answer'; data: RTCSessionDescriptionInit & { peerId: string }; to?: string }
  | { type: 'peer:ice'; data: RTCIceCandidateInit & { peerId: string }; to?: string }
  | { type: 'join'; roomId: string; clientId: string; role: 'pc' | 'phone'; label?: string };

export class WSClient {
  private socket: WebSocket | null = null;
  private url: string;
  private reconnectAttempts = 0;
  private messageQueue: OutboundMessage[] = [];
  private isConnected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private joinByClientId = new Map<string, Extract<OutboundMessage, { type: 'join' }>>();

  constructor(url: string = 'ws://localhost:3001') {
    this.url = url;

    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        if (!this.isConnected) {
          this.reconnectAttempts = 0;
          if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
          }
          this.connect();
        }
      });
    }
  }

  get connected() {
    return this.isConnected;
  }

  get reconnectCount() {
    return this.reconnectAttempts;
  }

  connect() {
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    try {
      const socket = new WebSocket(this.url);
      this.socket = socket;

      socket.onopen = () => {
        if (this.socket !== socket) return;
        console.log('[WS] Connected');
        this.isConnected = true;
        this.reconnectAttempts = 0;
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        window.dispatchEvent(new CustomEvent('ws:open'));
        this.replayJoins();
        this.flushQueue();
      };

      socket.onmessage = (event) => {
        if (this.socket !== socket) return;
        try {
          const msg: InboundMessage = JSON.parse(event.data);
          this.dispatch(msg);
        } catch (err) {
          console.error('[WS] Parse error', err, event.data);
          useUiStore.getState().pushToast('error', 'Received malformed server message.');
        }
      };

      socket.onclose = (event) => {
        if (this.socket !== socket) return;
        this.isConnected = false;
        this.socket = null;
        window.dispatchEvent(new CustomEvent('ws:close', { detail: { code: event.code } }));
        console.warn(`[WS] Disconnected (code: ${event.code})`);
        useUiStore.getState().pushToast('warn', 'WebSocket disconnected. Reconnecting...');
        this.attemptReconnect();
      };

      socket.onerror = (err) => {
        if (this.socket !== socket) return;
        console.error('[WS] Error', err);
        useUiStore.getState().pushToast('error', 'WebSocket error. Check backend connectivity.');
      };
    } catch (err) {
      console.error('[WS] Connection failed', err);
      useUiStore.getState().pushToast('error', 'Failed to connect to WebSocket server.');
      this.attemptReconnect();
    }
  }

  private attemptReconnect() {
    if (this.reconnectTimer) return;

    this.reconnectAttempts++;
    const delay = Math.min(250 * Math.pow(2, this.reconnectAttempts), 8000);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('ws:reconnect-scheduled', {
          detail: { attempt: this.reconnectAttempts, delayMs: delay },
        }),
      );
    }
    console.log(`[WS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  send(msg: OutboundMessage) {
    if (msg.type === 'join') {
      this.joinByClientId.set(msg.clientId, msg);
    }

    if (this.isConnected && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(msg));
    } else {
      console.warn('[WS] Not connected, queueing message', msg);
      if (msg.type !== 'join' && this.messageQueue.length < 20) {
        this.messageQueue.push(msg);
      }
    }
  }

  private replayJoins() {
    if (!this.isConnected || !this.socket || this.socket.readyState !== WebSocket.OPEN) return;

    for (const joinMsg of this.joinByClientId.values()) {
      this.socket.send(JSON.stringify(joinMsg));
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
      case 'peer:joined':
        // Presence info only; room membership is handled server-side.
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
      case 'tracking:progress':
        useTrackingStore.getState().setStatus('tracking', msg.data.progress);
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
        if (msg.data.frameMap) {
          useTrackingStore.getState().setFrameMap(msg.data.frameMap, msg.data.sequenceToPhysical);
        }
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
        useUiStore
          .getState()
          .pushToast('warn', `Unhandled WS message: ${(msg as { type: string }).type}`);
    }
  }
}

const getDefaultWsUrl = () => {
  const host = window.location.host;
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${host}/ws`;
};

// Use explicit WebSocket URL when provided, otherwise infer local/public fallback.
const WS_URL = import.meta.env.VITE_WS_URL || getDefaultWsUrl();
export const wsClient = new WSClient(WS_URL);
