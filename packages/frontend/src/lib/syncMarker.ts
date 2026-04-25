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
      grayBits: 8,
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

    // Quiet zone around the marker helps isolate it from scene clutter.
    const quietMargin = Math.max(8, Math.floor(Math.min(width, height) * 0.06));
    const availW = Math.max(1, width - 2 * quietMargin);
    const availH = Math.max(1, height - 2 * quietMargin);
    const targetAR = 2.0;
    let markerW = availW;
    let markerH = Math.floor(markerW / targetAR);
    if (markerH > availH) {
      markerH = availH;
      markerW = Math.floor(markerH * targetAR);
    }
    const markerX = Math.floor((width - markerW) / 2);
    const markerY = Math.floor((height - markerH) / 2);

    // High-contrast border system for robust detection + warp rectification.
    const border = Math.max(2, Math.floor(this.config.borderPx));

    // 1. Outer White Border
    this.ctx.strokeStyle = '#ffffff';
    this.ctx.lineWidth = border;
    this.ctx.strokeRect(
      markerX + border / 2,
      markerY + border / 2,
      markerW - border,
      markerH - border,
    );

    // 2. Inner Black "Dead Zone" (helps isolate content from border artifacts)
    const deadZone = Math.max(1, Math.floor(border * 0.4));
    this.ctx.strokeStyle = '#000000';
    this.ctx.lineWidth = deadZone;
    this.ctx.strokeRect(
      markerX + border + deadZone / 2,
      markerY + border + deadZone / 2,
      markerW - 2 * border - deadZone,
      markerH - 2 * border - deadZone,
    );

    // 3. Content Frame (Thin White)
    const contentFrame = border + deadZone;
    this.ctx.strokeStyle = '#ffffff';
    this.ctx.lineWidth = 1;
    this.ctx.strokeRect(
      markerX + contentFrame + 0.5,
      markerY + contentFrame + 0.5,
      markerW - 2 * contentFrame - 1,
      markerH - 2 * contentFrame - 1,
    );

    // Fiducial L-corners make orientation and localization less ambiguous.
    const cornerArm = Math.max(18, Math.floor(Math.min(markerW, markerH) * 0.28));
    const cornerThickness = Math.max(5, Math.floor(border * 1.0));
    this.ctx.fillStyle = '#ffffff';
    const drawLCorner = (x: number, y: number, sx: 1 | -1, sy: 1 | -1) => {
      this.ctx.fillRect(x, y, sx * cornerArm, sy * cornerThickness);
      this.ctx.fillRect(x, y, sx * cornerThickness, sy * cornerArm);
    };
    drawLCorner(markerX + border, markerY + border, 1, 1);
    drawLCorner(markerX + markerW - border, markerY + border, -1, 1);
    drawLCorner(markerX + markerW - border, markerY + markerH - border, -1, -1);
    drawLCorner(markerX + border, markerY + markerH - border, 1, -1);

    // Static checker signature to distinguish marker from generic rectangles.
    const sigCells = 4;
    const sigSize = Math.max(10, Math.floor(Math.min(markerW, markerH) * 0.09));
    const sigCell = Math.max(2, Math.floor(sigSize / sigCells));
    const sigW = sigCell * sigCells;
    const sigH = sigCell * sigCells;
    const sigX = markerX + markerW - border - sigW - 2;
    const sigY = markerY + border + 2;
    this.ctx.fillStyle = '#000000';
    this.ctx.fillRect(sigX - 1, sigY - 1, sigW + 2, sigH + 2);
    for (let yy = 0; yy < sigCells; yy++) {
      for (let xx = 0; xx < sigCells; xx++) {
        const bit = (xx + yy) % 2;
        this.ctx.fillStyle = bit ? '#ffffff' : '#000000';
        this.ctx.fillRect(sigX + xx * sigCell, sigY + yy * sigCell, sigCell, sigCell);
      }
    }

    // Inner content region.
    const pad = Math.max(0, Math.floor(this.config.paddingPx));
    const innerX = markerX + contentFrame + pad;
    const innerY = markerY + contentFrame + pad;
    const innerW = Math.max(1, markerW - 2 * (contentFrame + pad));
    const innerH = Math.max(1, markerH - 2 * (contentFrame + pad));

    const grayBits = Math.max(1, Math.min(16, Math.floor(this.config.grayBits)));
    const grayRowH = Math.max(12, Math.floor(innerH * 0.18));
    const gap = Math.max(4, Math.floor(innerH * 0.04));
    const grayRow2Y = innerY + grayRowH + gap;
    const gratingStartY = grayRow2Y + grayRowH + gap;
    const gratingTotalH = Math.max(1, innerY + innerH - gratingStartY);
    const gratingBandGap = Math.max(2, Math.floor(gratingTotalH * 0.08));
    const gratingH = Math.max(1, Math.floor((gratingTotalH - gratingBandGap) / 2));
    const gratingY1 = gratingStartY;
    const gratingY2 = gratingY1 + gratingH + gratingBandGap;

    // Gray code: macro-time counter.
    const grayValue = grayEncode(this.displayFrame, grayBits);
    const cellW = innerW / grayBits;
    const cellPad = Math.max(0, Math.min(3, Math.floor(cellW * 0.08)));

    // Background for gray strips.
    this.ctx.fillStyle = '#000000';
    this.ctx.fillRect(innerX, innerY, innerW, grayRowH);
    this.ctx.fillRect(innerX, grayRow2Y, innerW, grayRowH);

    for (let i = 0; i < grayBits; i++) {
      const bitIndex = grayBits - 1 - i;
      const bit = (grayValue >>> bitIndex) & 1;
      const x = innerX + i * cellW;

      const x0 = Math.floor(x + cellPad);
      const x1 = Math.floor(x + cellW - cellPad);
      const y0a = Math.floor(innerY + cellPad);
      const y1a = Math.floor(innerY + grayRowH - cellPad);
      const y0b = Math.floor(grayRow2Y + cellPad);
      const y1b = Math.floor(grayRow2Y + grayRowH - cellPad);

      this.ctx.fillStyle = bit ? '#ffffff' : '#000000';
      this.ctx.fillRect(x0, y0a, Math.max(1, x1 - x0), Math.max(1, y1a - y0a));
      this.ctx.fillRect(x0, y0b, Math.max(1, x1 - x0), Math.max(1, y1b - y0b));

      // Thin per-cell outline to help thresholding after compression.
      this.ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      this.ctx.lineWidth = 1;
      this.ctx.strokeRect(x0 + 0.5, y0a + 0.5, Math.max(1, x1 - x0) - 1, Math.max(1, y1a - y0a) - 1);
      this.ctx.strokeRect(x0 + 0.5, y0b + 0.5, Math.max(1, x1 - x0) - 1, Math.max(1, y1b - y0b) - 1);
    }

    // Phased sine gratings: micro-time within display frame with quadrature redundancy.
    const phase = phaseForFrame(this.displayFrame, this.config.phaseStepRad);
    const cycles = Math.max(1, Math.min(12, Math.floor(this.config.gratingCycles)));

    const gratingW = Math.max(1, Math.floor(innerW));
    if (this.gratingCanvas.width !== gratingW) this.gratingCanvas.width = gratingW;

    const row = this.gratingCtx.createImageData(gratingW, 1);
    const data = row.data;
    const amplitude = 0.48 * 255;
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
    this.ctx.drawImage(this.gratingCanvas, innerX, gratingY1, innerW, gratingH);

    // Same frequency, +90° phase for robust quadrature decode.
    const rowQ = this.gratingCtx.createImageData(gratingW, 1);
    const dataQ = rowQ.data;
    for (let x = 0; x < gratingW; x++) {
      const intensity = Math.max(
        0,
        Math.min(255, Math.round(dc + amplitude * Math.sin(omegaX * x + phase + Math.PI / 2))),
      );
      const idx = x * 4;
      dataQ[idx] = intensity;
      dataQ[idx + 1] = intensity;
      dataQ[idx + 2] = intensity;
      dataQ[idx + 3] = 255;
    }
    this.gratingCtx.putImageData(rowQ, 0, 0);
    this.ctx.drawImage(this.gratingCanvas, innerX, gratingY2, innerW, gratingH);

    // Subtle inner frame to make the ROI boundary clear after rectification.
    this.ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    this.ctx.lineWidth = 2;
    this.ctx.strokeRect(innerX + 1, innerY + 1, innerW - 2, innerH - 2);

    // Advance after drawing to keep a strict 1:1 mapping between rAF ticks and displayed frames.
    this.displayFrame += 1;
    this.rafId = requestAnimationFrame(this.render);
  };
}
