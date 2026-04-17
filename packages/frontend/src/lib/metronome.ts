// packages/frontend/src/lib/metronome.ts

export interface MetronomeConfig {
  dotRadius: number;
  dotColor: string;
  backgroundColor: string;
  trailColor: string;
  speedFraction: number;
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
      dotRadius: 18,
      dotColor: '#ff7244',
      backgroundColor: '#050b14',
      trailColor: 'rgba(76,195,255,0.2)',
      speedFraction: 0.25,
      ...config,
    };
  }

  private render = (timestamp: number) => {
    if (!this.running) return;

    if (this.startTime === null) this.startTime = timestamp;
    const elapsedMs = timestamp - this.startTime;
    const elapsedS = elapsedMs / 1000.0;

    const width = this.canvas.width;
    const height = this.canvas.height;
    const travelRange = width - 2 * this.config.dotRadius;
    const speed = width * this.config.speedFraction;
    const dotCycleS = travelRange / speed;
    const cyclePosition = elapsedS % dotCycleS;

    const dotX = this.config.dotRadius + (cyclePosition / dotCycleS) * travelRange;
    const dotY = height / 2;

    this.ctx.fillStyle = this.config.backgroundColor;
    this.ctx.fillRect(0, 0, width, height);

    this.ctx.strokeStyle = this.config.trailColor;
    this.ctx.lineWidth = 2;
    this.ctx.beginPath();
    this.ctx.moveTo(0, dotY);
    this.ctx.lineTo(width, dotY);
    this.ctx.stroke();

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
