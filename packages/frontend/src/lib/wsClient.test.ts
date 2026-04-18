import { WSClient } from './wsClient';
import { useTrackingStore } from '../stores/trackingStore';
import { useUiStore } from '../stores/uiStore';

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

  receiveRaw(payload: string): void {
    this.onmessage?.(
      new MessageEvent('message', {
        data: payload,
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
    useUiStore.setState({ toasts: [] });
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

  it('continues reconnecting beyond five failed attempts', () => {
    const client = new WSClient('ws://test.local');
    client.connect();

    MockWebSocket.instances[0].close(1006);
    vi.advanceTimersByTime(500); // attempt 1
    MockWebSocket.instances[1].close(1006);
    vi.advanceTimersByTime(1000); // attempt 2
    MockWebSocket.instances[2].close(1006);
    vi.advanceTimersByTime(2000); // attempt 3
    MockWebSocket.instances[3].close(1006);
    vi.advanceTimersByTime(4000); // attempt 4
    MockWebSocket.instances[4].close(1006);
    vi.advanceTimersByTime(8000); // attempt 5
    MockWebSocket.instances[5].close(1006);
    vi.advanceTimersByTime(8000); // attempt 6

    expect(MockWebSocket.instances).toHaveLength(7);
  });

  it('queues outbound messages while disconnected and flushes on open', () => {
    const client = new WSClient('ws://test.local');
    client.connect();

    const socket = MockWebSocket.instances[0];
    client.send({ type: 'record:start', experimentId: 'exp-42' });
    expect(socket.sentMessages).toHaveLength(0);

    socket.open();
    expect(socket.sentMessages).toHaveLength(1);
    expect(JSON.parse(socket.sentMessages[0])).toEqual({
      type: 'record:start',
      experimentId: 'exp-42',
    });
  });

  it('does not open duplicate sockets when connect is called repeatedly', () => {
    const client = new WSClient('ws://test.local');
    client.connect();
    client.connect();

    expect(MockWebSocket.instances).toHaveLength(1);

    const socket = MockWebSocket.instances[0];
    socket.open();
    client.connect();

    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('replays join messages after reconnect', () => {
    const client = new WSClient('ws://test.local');
    client.connect();

    const firstSocket = MockWebSocket.instances[0];
    firstSocket.open();
    client.send({ type: 'join', roomId: 'exp-1', clientId: 'pc', role: 'pc' });
    expect(firstSocket.sentMessages).toHaveLength(1);

    firstSocket.close(1006);
    vi.advanceTimersByTime(500);

    const secondSocket = MockWebSocket.instances[1];
    secondSocket.open();
    expect(secondSocket.sentMessages).toHaveLength(1);
    expect(JSON.parse(secondSocket.sentMessages[0])).toEqual({
      type: 'join',
      roomId: 'exp-1',
      clientId: 'pc',
      role: 'pc',
    });
  });

  it('pushes an error toast for malformed inbound messages', () => {
    const client = new WSClient('ws://test.local');
    client.connect();

    const socket = MockWebSocket.instances[0];
    socket.open();
    socket.receiveRaw('{ definitely-not-json');

    const toasts = useUiStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].level).toBe('error');
    expect(toasts[0].message).toContain('malformed');
  });
});
