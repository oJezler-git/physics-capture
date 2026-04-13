import { useSessionStore } from '../stores/sessionStore';
import { useCalibrationStore } from '../stores/calibrationStore';
import { useTrackingStore } from '../stores/trackingStore';
import { useResultsStore } from '../stores/resultsStore';
import { 
  CalibrationResult, 
  TrackingStatusMessage, 
  PhysicsResult, 
  CameraDevice 
} from '../types';

// Define message types matching the implementation plan
type InboundMessage =
  | { type: 'phone:joined'; data: CameraDevice }
  | { type: 'calibration:progress'; data: { progress: number } }
  | { type: 'calibration:complete'; data: CalibrationResult }
  | { type: 'tracking:update'; data: { tracks: any[], progress: number } }
  | { type: 'tracking:complete'; data: { tracks: any[] } }
  | { type: 'physics:result'; data: PhysicsResult }
  | { type: 'upload:progress'; data: { cameraId: string; percent: number } }
  | { type: 'frames:ready'; data: { frameCount: number } }
  | { type: 'peer:offer'; data: RTCSessionDescriptionInit }
  | { type: 'peer:ice'; data: RTCIceCandidateInit };

type OutboundMessage =
  | { type: 'record:start'; experimentId: string }
  | { type: 'record:stop'; experimentId: string }
  | { type: 'peer:answer'; data: RTCSessionDescriptionInit }
  | { type: 'peer:ice'; data: RTCIceCandidateInit }
  | { type: 'join'; room: string; role: 'pc' | 'phone' };

class WSClient {
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
      console.log(`[WS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
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
      case 'tracking:update':
        useTrackingStore.getState().onTrackingUpdate(msg.data.tracks, msg.data.progress);
        break;
      case 'tracking:complete':
        useTrackingStore.getState().onTrackingComplete(msg.data.tracks);
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
        break;
      case 'peer:offer':
      case 'peer:ice':
        // These will be handled by the WebRTC Manager
        window.dispatchEvent(new CustomEvent('ws:webrtc', { detail: msg }));
        break;
      default:
        console.warn('[WS] Unknown message type', (msg as any).type);
    }
  }
}

export const wsClient = new WSClient();
