// packages/signaling/src/ffmpeg.ts
import { spawn } from "child_process";
import path from "path";
import fs from "fs";

export async function extractFrames(
  videoPath: string,
  framesDir: string,
): Promise<number> {
  // Ensure frames directory exists before extraction.
  await fs.promises.mkdir(framesDir, { recursive: true });

  // ffmpeg command: extract to sequential JPGs
  // -y: overwrite output files
  // -vf: lock dimensions to the first decoded frame (handles mid-stream resolution changes),
  //      and generate monotonic timestamps (avoids non-monotone PTS issues on some WebM/VP9 captures)
  // %06d.jpg: 6-digit zero-padded filename (starts at 000001.jpg)
  const ffmpeg = spawn("ffmpeg", [
    "-y",
    "-fflags",
    "+genpts",
    "-i", videoPath,
    "-vf",
    "scale=trunc(iw/2)*2:trunc(ih/2)*2:eval=init,setsar=1,setpts=N/(if(gte(FRAME_RATE\\,1)\\,FRAME_RATE\\,30)*TB),format=yuvj420p",
    path.join(framesDir, "%06d.jpg"),
  ]);

  return new Promise((resolve, reject) => {
    ffmpeg.on("error", reject);

    ffmpeg.on("close", async (code) => {
      if (code === 0) {
        // Count files to return frame count
        try {
          const files = await fs.promises.readdir(framesDir);
          const jpgFiles = files.filter((f) => f.endsWith(".jpg"));
          resolve(jpgFiles.length);
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
