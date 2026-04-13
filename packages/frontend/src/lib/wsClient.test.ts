import { WSClient } from './wsClient';
import { useTrackingStore } from '../stores/trackingStore';

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  sentMessages: string[] = [];

  constructor(public readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sentMessages.push(data);
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  close(code = 1000): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(
      new CloseEvent('close', {
        code,
        reason: '',
      }),
    );
  }

  receive(payload: unknown): void {
    this.onmessage?.(
      new MessageEvent('message', {
        data: JSON.stringify(payload),
      }),
    );
  }
}

describe('WSClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
    useTrackingStore.getState().reset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('dispatches tracking updates into the tracking store', () => {
    const client = new WSClient('ws://test.local');
    client.connect();

    const socket = MockWebSocket.instances[0];
    socket.open();
    socket.receive({
      type: 'tracking:update',
      data: {
        progress: 0.42,
        tracks: [
          {
            ballId: 0,
            cameraId: 'cam-1',
            points: [
              { frameIdx: 0, x: 10, y: 20, confidence: 0.95, isFlagged: false, isCorrected: false },
            ],
          },
        ],
      },
    });

    const state = useTrackingStore.getState();
    expect(state.progress).toBe(0.42);
    expect(state.tracks).toHaveLength(1);
    expect(state.tracks[0].cameraId).toBe('cam-1');
  });

  it('reconnects with backoff after disconnect', () => {
    const client = new WSClient('ws://test.local');
    client.connect();

    const socket = MockWebSocket.instances[0];
    socket.open();
    socket.close(1006);

    vi.advanceTimersByTime(499);
    expect(MockWebSocket.instances).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(2);
  });
});
