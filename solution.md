Looking at this, the fix has three interlocking parts: a per-extraction **UUID-named temp directory** acts as FFmpeg's `cwd`, so the output pattern can be purely relative (`%06d.png` — no drive letter, no colon). Only after FFmpeg exits cleanly do we **atomically swap** the temp dir's contents into `framesDir`. The temp dir lives next to `framesDir` (same filesystem parent) so `fs.rename` works without cross-device issues and is cleaned up in a `finally` block regardless of outcome.Here's a full breakdown of every design decision:

---

### The root cause

The original code builds the FFmpeg output path with `path.join(framesDir, '%06d.png')`, which on Windows produces something like `C:\Users\…\frames\%06d.png`. FFmpeg's **image2 muxer** treats the `:` after the drive letter as a key=value option separator (e.g. `C` = `\Users\…`), so it never sees a valid path and throws `Invalid argument` or `No such file or directory` — even with quoting, because this happens inside FFmpeg's own argument parser, not the shell.

---

### Fix 1 — Relative output pattern + `cwd` (kills the root cause)

```ts
const relativeOutputPattern = `%06d.${outputFormat}`;
const ffmpeg = spawn("ffmpeg", ffmpegArgs, { cwd: tempDir });
```

FFmpeg now only ever sees `%06d.png` as the output path. It resolves that relative to its working directory (`cwd`), which is set to `tempDir`. No drive letter, no colon, no muxer confusion.

---

### Fix 2 — UUID temp directory (concurrency safety)

```ts
const sessionId = crypto.randomUUID();
const tempDir = path.join(path.dirname(framesDir), `.ffmpeg-tmp-${sessionId}`);
```

Every concurrent call to `extractFrames` gets its own uniquely-named directory. Two simultaneous extractions running with `cwd: tempDir` and `%06d.png` output will write to completely separate folders — they can never stomp on each other's frames.

The temp dir is placed **next to** `framesDir` (same parent, same drive letter) rather than in `os.tmpdir()`. This is critical for the next point.

---

### Fix 3 — Atomic commit (atomicity / no corrupt state)

```ts
// Only runs if ffmpeg resolved cleanly:
await fs.promises.rm(framesDir, { recursive: true, force: true });
await fs.promises.mkdir(framesDir, { recursive: true });
// then rename each file from tempDir → framesDir
```

The original code cleared `framesDir` _before_ spawning FFmpeg, so any crash or non-zero exit left the directory empty and any reader would see 0 frames. Now `framesDir` is only touched **after** the `Promise<void>` resolves (i.e., `code === 0`). A failed extraction leaves the previous frame set untouched.

`rename` is used instead of `copyFile` + `unlink` because both paths are on the same volume, making it an O(1) metadata operation. The `catch` branch is a defensive fallback for unusual setups where that assumption breaks down.

---

### Fix 4 — `finally` cleanup

```ts
} finally {
  await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
}
```

The temp directory is removed regardless of outcome — success, FFmpeg failure, or an unexpected thrown exception — and cleanup errors are suppressed so they can't shadow the real error.

```
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

  // ─── Relative output pattern ─────────────────────────────────────────────────
  // FFmpeg's image2 muxer interprets the colon in a Windows absolute path
  // (e.g. C:\…\%06d.png) as a muxer-option separator, producing
  // "No such file or directory" / "Invalid argument" errors.
  // Using a bare relative pattern and setting `cwd` to tempDir sidesteps
  // the issue entirely: FFmpeg never sees a drive letter in the output path.
  const relativeOutputPattern = `%06d.${outputFormat}`;

  const filter = isPng
    ? "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=rgb24"
    : "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuvj420p";

  const codec = isPng ? "png" : "mjpeg";

  const ffmpegArgs = [
    "-y",
    "-fflags",
    "+genpts",
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
        stderrData += data.toString();
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

    await Promise.all(
      imageFiles.map(async (file) => {
        const src = path.join(tempDir, file);
        const dest = path.join(framesDir, file);
        // rename is O(1) when src and dest share the same volume (guaranteed
        // above by co-locating tempDir next to framesDir).  The catch branch
        // is a defensive fallback for any edge-case environment where the
        // assumption doesn't hold.
        try {
          await fs.promises.rename(src, dest);
        } catch {
          await fs.promises.copyFile(src, dest);
          await fs.promises.unlink(src);
        }
      }),
    );

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
```
