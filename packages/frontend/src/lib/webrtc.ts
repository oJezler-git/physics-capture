import { wsClient } from './wsClient';
import { useSessionStore } from '../stores/sessionStore';

interface PeerEntry {
  peerId: string;
  conn: RTCPeerConnection;
  stream: MediaStream | null;
}

class PeerManager {
  private peers: Map<string, PeerEntry> = new Map();

  constructor() {
    window.addEventListener('ws:webrtc', (event: any) => {
      const { type, data } = event.detail;
      const peerId = data.peerId; // Assuming peerId is in the message data

      if (type === 'peer:offer') {
        this.handleOffer(peerId, data);
      } else if (type === 'peer:ice') {
        this.handleIce(peerId, data);
      }
    });
  }

  private async handleOffer(peerId: string, offer: RTCSessionDescriptionInit) {
    console.log(`[WebRTC] Received offer from ${peerId}`);

    const conn = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });

    const entry: PeerEntry = { peerId, conn, stream: null };
    this.peers.set(peerId, entry);

    conn.onicecandidate = (event) => {
      if (event.candidate) {
        wsClient.send({
          type: 'peer:ice',
          data: { ...event.candidate.toJSON(), peerId } as any,
          to: peerId,
        });
      }
    };

    conn.ontrack = (event) => {
      console.log(`[WebRTC] Received track from ${peerId}`);
      entry.stream = event.streams[0];
      console.log(`[DEBUG] Track stream:`, entry.stream);

      // Update camera in session store
      const cameras = useSessionStore.getState().cameras;
      const camera = cameras.find((c) => c.peerId === peerId) || cameras.find((c) => c.id === peerId);
      
      console.log(`[DEBUG] Found camera to update:`, camera);
      if (camera) {
        const updatedCamera = {
          ...camera,
          stream: entry.stream,
          status: 'live' as const,
          peerId: peerId,
        };
        useSessionStore.getState().addCamera(updatedCamera);
        console.log(`[DEBUG] SessionStore updated:`, updatedCamera);
      } else {
        console.warn(`[DEBUG] No camera found to update!`);
      }
    };

    try {
      await conn.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await conn.createAnswer();
      await conn.setLocalDescription(answer);

      wsClient.send({
        type: 'peer:answer',
        data: { ...answer, peerId } as any,
        to: peerId,
      });
    } catch (err) {
      console.error(`[WebRTC] Error handling offer from ${peerId}`, err);
    }
  }

  private async handleIce(peerId: string, candidate: RTCIceCandidateInit) {
    const entry = this.peers.get(peerId);
    if (entry) {
      try {
        await entry.conn.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.error(`[WebRTC] Error adding ICE candidate for ${peerId}`, err);
      }
    }
  }

  cleanup() {
    this.peers.forEach((entry) => {
      entry.conn.close();
    });
    this.peers.clear();
  }
}

export const peerManager = new PeerManager();
