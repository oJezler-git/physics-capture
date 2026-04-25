// packages/signaling/src/ffmpeg.ts
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import crypto from "crypto";

export async function extractFrames(
  videoPath: string,
  framesDir: string,
  outputFormat: "png" | "jpg" = "png",
): Promise<number> {
  // ─── Isolated temp directory ────────────────────────────────────────────────
  // Placed next to framesDir (same filesystem / same drive letter on Windows)
  // so that the final fs.rename calls below are guaranteed to be atomic,
  // in-place moves rather than cross-device copies.
  const sessionId = crypto.randomUUID();
  const tempDir = path.join(path.dirname(framesDir), `.ffmpeg-tmp-${sessionId}`);
  await fs.promises.mkdir(tempDir, { recursive: true });

  const isPng = outputFormat === "png";
  const outputCountFilter = (f: string) => f.endsWith(`.${outputFormat}`);
  const maxDimRaw = process.env.FFMPEG_MAX_DIM?.trim();
  const maxDim = maxDimRaw ? Number.parseInt(maxDimRaw, 10) : NaN;
  const useResize = Number.isFinite(maxDim) && maxDim > 0;

  // ─── Relative output pattern ─────────────────────────────────────────────────
  // FFmpeg's image2 muxer interprets the colon in a Windows absolute path
  // (e.g. C:\…\%06d.png) as a muxer-option separator, producing
  // "No such file or directory" / "Invalid argument" errors.
  // Using a bare relative pattern and setting `cwd` to tempDir sidesteps
  // the issue entirely: FFmpeg never sees a drive letter in the output path.
  const relativeOutputPattern = `%06d.${outputFormat}`;

  const resizeFilter = useResize
    ? `scale=${maxDim}:${maxDim}:force_original_aspect_ratio=decrease,`
    : "";

  const filter = isPng
    ? `${resizeFilter}scale=trunc(iw/2)*2:trunc(ih/2)*2,format=rgb24`
    : `${resizeFilter}scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuvj420p`;

  const codec = isPng ? "png" : "mjpeg";
  const hwaccel = process.env.FFMPEG_HWACCEL?.trim();
  const decoder = process.env.FFMPEG_VIDEO_DECODER?.trim();
  const threads = process.env.FFMPEG_THREADS?.trim();

  const ffmpegArgs = [
    "-y",
    "-fflags",
    "+genpts",
    ...(hwaccel ? ["-hwaccel", hwaccel] : []),
    ...(decoder ? ["-c:v", decoder] : []),
    ...(threads ? ["-threads", threads] : []),
    "-i",
    videoPath,
    "-vf",
    filter,
    "-c:v",
    codec,
    relativeOutputPattern,
  ];

  try {
    // ─── Run FFmpeg in the isolated temp directory ──────────────────────────
    await new Promise<void>((resolve, reject) => {
      const ffmpeg = spawn("ffmpeg", ffmpegArgs, {
        // All relative output paths resolve inside tempDir.
        // Concurrent calls each get their own UUID-named tempDir, so they
        // can never collide with one another.
        cwd: tempDir,
      });

      let stderrData = "";

      ffmpeg.stderr.on("data", (data) => {
        const chunk = data.toString();
        console.error("[FFmpeg stderr]:", chunk);
        stderrData += chunk;
      });

      ffmpeg.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(`ffmpeg exited with code ${code}. Stderr: ${stderrData}`),
          );
        }
      });

      ffmpeg.on("error", (err) => {
        reject(new Error(`Failed to start ffmpeg: ${err.message}`));
      });
    });

    // ─── Atomic commit: swap tempDir contents → framesDir ──────────────────
    // Only reached when FFmpeg exits cleanly (code 0), so a failed or partial
    // extraction can never corrupt framesDir.
    await fs.promises.rm(framesDir, { recursive: true, force: true });
    await fs.promises.mkdir(framesDir, { recursive: true });

    const extractedFiles = await fs.promises.readdir(tempDir);
    const imageFiles = extractedFiles.filter(outputCountFilter);

    const BATCH_SIZE = 50;
    for (let i = 0; i < imageFiles.length; i += BATCH_SIZE) {
      const batch = imageFiles.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(async (file) => {
          const src = path.join(tempDir, file);
          const dest = path.join(framesDir, file);
          try {
            await fs.promises.rename(src, dest);
          } catch {
            await fs.promises.copyFile(src, dest);
            await fs.promises.unlink(src);
          }
        }),
      );
      console.log(
        `[FFmpeg] Transferred ${Math.min(
          i + BATCH_SIZE,
          imageFiles.length,
        )}/${imageFiles.length} frames`,
      );
    }

    return imageFiles.length;
  } finally {
    // ─── Cleanup ────────────────────────────────────────────────────────────
    // Always remove the temp directory, whether the extraction succeeded or
    // failed.  Errors here are suppressed so they don't mask the real error.
    await fs.promises
      .rm(tempDir, { recursive: true, force: true })
      .catch(() => undefined);
  }
}
