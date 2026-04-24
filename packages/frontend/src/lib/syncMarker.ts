export interface SyncMarkerRenderConfig {
  grayBits: number; // e.g. 10
  gratingCycles: number; // low spatial freq, e.g. 3-5 across width
  phaseStepRad: number; // phase advance per display frame
  borderPx: number;
  paddingPx: number;
}

export interface SyncMarkerCadenceMetrics {
  intervalMs: number; // mean
  jitterMs: number; // MAD (median absolute deviation)
}

const TAU = Math.PI * 2;

export function grayEncode(value: number, bits: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(bits)) return 0;
  const safeBits = Math.max(1, Math.min(30, Math.floor(bits)));
  const mask = (1 << safeBits) - 1;
  const n = (Math.floor(value) >>> 0) & mask;
  return (n ^ (n >>> 1)) & mask;
}

export function grayDecode(gray: number): number {
  let n = Math.floor(gray) >>> 0;
  n ^= n >>> 16;
  n ^= n >>> 8;
  n ^= n >>> 4;
  n ^= n >>> 2;
  n ^= n >>> 1;
  return n >>> 0;
}

export function hammingDistance(a: number, b: number): number {
  let x = (a ^ b) >>> 0;
  let count = 0;
  while (x) {
    x &= x - 1;
    count++;
  }
  return count;
}

export function phaseForFrame(displayFrame: number, phaseStepRad: number): number {
  const phase = (displayFrame * phaseStepRad) % TAU;
  return phase < 0 ? phase + TAU : phase;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function computeCadenceMetrics(intervalsMs: number[]): SyncMarkerCadenceMetrics {
  if (intervalsMs.length === 0) return { intervalMs: 0, jitterMs: 0 };
  const intervalMs = intervalsMs.reduce((sum, v) => sum + v, 0) / intervalsMs.length;
  const med = median(intervalsMs);
  const deviations = intervalsMs.map((v) => Math.abs(v - med));
  const jitterMs = median(deviations);
  return { intervalMs, jitterMs };
}

export class SyncMarkerRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private config: SyncMarkerRenderConfig;

  private running = false;
  private rafId: number | null = null;
  private displayFrame = 0;

  private lastTs: number | null = null;
  private intervalsMs: number[] = [];
  private gratingCanvas: HTMLCanvasElement;
  private gratingCtx: CanvasRenderingContext2D;

  constructor(canvas: HTMLCanvasElement, config: Partial<SyncMarkerRenderConfig> = {}) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get 2D context');
    this.ctx = ctx;

    this.config = {
      grayBits: 10,
      gratingCycles: 4,
      phaseStepRad: TAU / 32,
      borderPx: 10,
      paddingPx: 10,
      ...config,
    };

    this.gratingCanvas = document.createElement('canvas');
    this.gratingCanvas.height = 1;
    const gratingCtx = this.gratingCanvas.getContext('2d');
    if (!gratingCtx) throw new Error('Could not get 2D context for grating');
    this.gratingCtx = gratingCtx;
  }

  getCadenceMetrics(): SyncMarkerCadenceMetrics {
    return computeCadenceMetrics(this.intervalsMs);
  }

  getDisplayFrame(): number {
    return this.displayFrame;
  }

  reset(): void {
    this.displayFrame = 0;
    this.lastTs = null;
    this.intervalsMs = [];
  }

  start(): void {
    this.running = true;
    this.reset();
    this.rafId = requestAnimationFrame(this.render);
  }

  stop(): void {
    this.running = false;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  private render = (ts: number) => {
    if (!this.running) return;

    if (this.lastTs !== null) {
      const dt = ts - this.lastTs;
      if (Number.isFinite(dt) && dt > 0) {
        this.intervalsMs.push(dt);
        if (this.intervalsMs.length > 240) this.intervalsMs.shift();
      }
    }
    this.lastTs = ts;

    const width = this.canvas.width;
    const height = this.canvas.height;

    this.ctx.fillStyle = '#000000';
    this.ctx.fillRect(0, 0, width, height);

    // High-contrast border system for robust detection + warp rectification.
    // We use a white-black-white "sandwich" to ensure there are always strong gradients.
    const border = Math.max(2, Math.floor(this.config.borderPx));

    // 1. Outer White Border
    this.ctx.strokeStyle = '#ffffff';
    this.ctx.lineWidth = border;
    this.ctx.strokeRect(border / 2, border / 2, width - border, height - border);

    // 2. Inner Black "Dead Zone" (helps isolate content from border artifacts)
    const deadZone = Math.max(1, Math.floor(border * 0.4));
    this.ctx.strokeStyle = '#000000';
    this.ctx.lineWidth = deadZone;
    this.ctx.strokeRect(
      border + deadZone / 2,
      border + deadZone / 2,
      width - 2 * border - deadZone,
      height - 2 * border - deadZone,
    );

    // 3. Content Frame (Thin White)
    const contentFrame = border + deadZone;
    this.ctx.strokeStyle = '#ffffff';
    this.ctx.lineWidth = 1;
    this.ctx.strokeRect(
      contentFrame + 0.5,
      contentFrame + 0.5,
      width - 2 * contentFrame - 1,
      height - 2 * contentFrame - 1,
    );

    // Inner content region.
    const pad = Math.max(0, Math.floor(this.config.paddingPx));
    const innerX = contentFrame + pad;
    const innerY = contentFrame + pad;
    const innerW = Math.max(1, width - 2 * (contentFrame + pad));
    const innerH = Math.max(1, height - 2 * (contentFrame + pad));

    const grayBits = Math.max(1, Math.min(16, Math.floor(this.config.grayBits)));
    const grayRowH = Math.max(16, Math.floor(innerH * 0.28));
    const gap = Math.max(4, Math.floor(innerH * 0.03));
    const gratingY = innerY + grayRowH + gap;
    const gratingH = Math.max(1, innerH - grayRowH - gap);

    // Gray code: macro-time counter.
    const grayValue = grayEncode(this.displayFrame, grayBits);
    const cellW = innerW / grayBits;
    const cellPad = Math.max(0, Math.min(3, Math.floor(cellW * 0.08)));

    // Background for gray strip.
    this.ctx.fillStyle = '#000000';
    this.ctx.fillRect(innerX, innerY, innerW, grayRowH);

    for (let i = 0; i < grayBits; i++) {
      const bitIndex = grayBits - 1 - i;
      const bit = (grayValue >>> bitIndex) & 1;
      const x = innerX + i * cellW;

      const x0 = Math.floor(x + cellPad);
      const x1 = Math.floor(x + cellW - cellPad);
      const y0 = Math.floor(innerY + cellPad);
      const y1 = Math.floor(innerY + grayRowH - cellPad);

      this.ctx.fillStyle = bit ? '#ffffff' : '#000000';
      this.ctx.fillRect(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));

      // Thin per-cell outline to help thresholding after compression.
      this.ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      this.ctx.lineWidth = 1;
      this.ctx.strokeRect(x0 + 0.5, y0 + 0.5, Math.max(1, x1 - x0) - 1, Math.max(1, y1 - y0) - 1);
    }

    // Phased sine grating: micro-time within display frame.
    const phase = phaseForFrame(this.displayFrame, this.config.phaseStepRad);
    const cycles = Math.max(1, Math.min(12, Math.floor(this.config.gratingCycles)));

    const gratingW = Math.max(1, Math.floor(innerW));
    if (this.gratingCanvas.width !== gratingW) this.gratingCanvas.width = gratingW;

    const row = this.gratingCtx.createImageData(gratingW, 1);
    const data = row.data;
    const amplitude = 0.45 * 255;
    const dc = 0.5 * 255;
    const omegaX = (TAU * cycles) / gratingW;

    for (let x = 0; x < gratingW; x++) {
      const intensity = Math.max(
        0,
        Math.min(255, Math.round(dc + amplitude * Math.sin(omegaX * x + phase))),
      );
      const idx = x * 4;
      data[idx] = intensity;
      data[idx + 1] = intensity;
      data[idx + 2] = intensity;
      data[idx + 3] = 255;
    }

    this.gratingCtx.putImageData(row, 0, 0);
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(this.gratingCanvas, innerX, gratingY, innerW, gratingH);

    // Subtle inner frame to make the ROI boundary clear after rectification.
    this.ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    this.ctx.lineWidth = 2;
    this.ctx.strokeRect(innerX + 1, innerY + 1, innerW - 2, innerH - 2);

    // Advance after drawing to keep a strict 1:1 mapping between rAF ticks and displayed frames.
    this.displayFrame += 1;
    this.rafId = requestAnimationFrame(this.render);
  };
}
