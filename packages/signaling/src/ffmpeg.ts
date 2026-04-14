// packages/signaling/src/ffmpeg.ts
import { spawn } from "child_process";
import path from "path";
import fs from "fs/promises";
import { existsSync } from "fs";

export async function extractFrames(
  videoPath: string,
  framesDir: string
): Promise<number> {
  // Ensure frames directory exists
  if (!existsSync(framesDir)) {
    await fs.mkdir(framesDir, { recursive: true });
  }

  // ffmpeg command: extract to lossless pngs
  // -vsync 0: keep all frames, even if duplicates
  // frame_%06d.png: 6-digit zero-padded filename
  const ffmpeg = spawn("ffmpeg", [
    "-i", videoPath,
    "-vsync", "0",
    path.join(framesDir, "frame_%06d.png")
  ]);

  return new Promise((resolve, reject) => {
    ffmpeg.on("close", async (code) => {
      if (code === 0) {
        // Count files to return frame count
        try {
          const files = await fs.readdir(framesDir);
          const pngFiles = files.filter(f => f.endsWith(".png"));
          resolve(pngFiles.length);
        } catch (err) {
          reject(err);
        }
      } else {
        reject(new Error(`ffmpeg exited with code ${code}`));
      }
    });

    ffmpeg.stderr.on("data", (data) => {
      console.error(`ffmpeg stderr: ${data}`);
    });
  });
}
