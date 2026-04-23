// packages/signaling/src/ffmpeg.ts
import { spawn } from "child_process";
import path from "path";
import fs from "fs";

export async function extractFrames(
  videoPath: string,
  framesDir: string,
  outputFormat: "png" | "jpg" = "png",
): Promise<number> {
  // Ensure frames directory exists before extraction.
  await fs.promises.mkdir(framesDir, { recursive: true });

  // Clear old extracted frames so repeated uploads can't leave a mixed JPG/PNG sequence behind.
  const existingFiles = await fs.promises.readdir(framesDir);
  await Promise.all(
    existingFiles
      .filter((file) => /\.(jpg|jpeg|png)$/i.test(file))
      .map((file) => fs.promises.unlink(path.join(framesDir, file))),
  );

  const isPng = outputFormat === "png";
  const outputPattern = path.join(framesDir, `%06d.${outputFormat}`);
  const outputCountFilter = (f: string) => f.endsWith(`.${outputFormat}`);

  // ffmpeg command: extract to sequential PNGs or JPGs depending on mode.
  // -y: overwrite output files
  // -vf: lock dimensions to the first decoded frame (handles mid-stream resolution changes),
  //      and generate monotonic timestamps (avoids non-monotone PTS issues on some WebM/VP9 captures)
  // %06d.png / %06d.jpg: 6-digit zero-padded filename (starts at 000001)
  const ffmpegArgs = [
    "-y",
    "-fflags",
    "+genpts",
    "-i",
    videoPath,
    "-vf",
    isPng
      ? "scale=trunc(iw/2)*2:trunc(ih/2)*2:eval=init,setsar=1,setpts=N/(if(gte(FRAME_RATE\\,1)\\,FRAME_RATE\\,30)*TB),format=rgb24"
      : "scale=trunc(iw/2)*2:trunc(ih/2)*2:eval=init,setsar=1,setpts=N/(if(gte(FRAME_RATE\\,1)\\,FRAME_RATE\\,30)*TB),format=yuvj420p",
    "-c:v",
    isPng ? "png" : "mjpeg",
    outputPattern,
  ];
  const ffmpeg = spawn("ffmpeg", ffmpegArgs);

  return new Promise((resolve, reject) => {
    ffmpeg.on("error", reject);

    ffmpeg.on("close", async (code) => {
      if (code === 0) {
        // Count files to return frame count
        try {
          const files = await fs.promises.readdir(framesDir);
          const imageFiles = files.filter(outputCountFilter);
          resolve(imageFiles.length);
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
