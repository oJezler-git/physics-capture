// packages/frontend/src/lib/metronome.ts

export interface MetronomeConfig {
  canvasWidth: number;
  canvasHeight: number;
  dotRadius: number;
  dotColor: string;
  backgroundColor: string;
  speedFraction: number; // dot travels this fraction of canvasWidth per second
}

export class VisualMetronome {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private config: MetronomeConfig;
  private startTime: number | null = null;
  private animFrameId: number | null = null;
  private running = false;

  constructor(canvas: HTMLCanvasElement, config: Partial<MetronomeConfig> = {}) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get 2D context');
    this.ctx = ctx;
    
    this.config = {
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      dotRadius: 20,
      dotColor: '#FFFFFF',
      backgroundColor: '#000000',
      speedFraction: 0.25,
      ...config
    };
  }

  private render = (timestamp: number) => {
    if (!this.running) return;

    if (this.startTime === null) this.startTime = timestamp;
    const elapsedMs = timestamp - this.startTime;
    const elapsedS = elapsedMs / 1000.0;

    const travelRange = this.config.canvasWidth - 2 * this.config.dotRadius;
    const speed = this.config.canvasWidth * this.config.speedFraction;
    const dotCycleS = travelRange / speed;
    const cyclePosition = (elapsedS % dotCycleS);
    
    const dotX = this.config.dotRadius + (cyclePosition / dotCycleS) * travelRange;
    const dotY = this.config.canvasHeight / 2;

    this.ctx.fillStyle = this.config.backgroundColor;
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    
    this.ctx.beginPath();
    this.ctx.arc(dotX, dotY, this.config.dotRadius, 0, 2 * Math.PI);
    this.ctx.fillStyle = this.config.dotColor;
    this.ctx.fill();

    this.animFrameId = requestAnimationFrame(this.render);
  };

  start() {
    this.running = true;
    this.startTime = null;
    this.animFrameId = requestAnimationFrame(this.render);
  }

  stop() {
    this.running = false;
    if (this.animFrameId) cancelAnimationFrame(this.animFrameId);
  }
}
