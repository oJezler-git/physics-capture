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

  // Clear old extracted frames.
  const existingFiles = await fs.promises.readdir(framesDir);
  await Promise.all(
    existingFiles
      .filter((file) => /\.(jpg|jpeg|png)$/i.test(file))
      .map((file) => fs.promises.unlink(path.join(framesDir, file))),
  );

  const isPng = outputFormat === "png";
  const outputPattern = path.join(framesDir, `%06d.${outputFormat}`);
  const outputCountFilter = (f: string) => f.endsWith(`.${outputFormat}`);

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
    outputPattern,
  ];

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", ffmpegArgs);
    let stderrData = "";
    
    ffmpeg.stderr.on("data", (data) => {
      stderrData += data.toString();
    });

    ffmpeg.on("close", async (code) => {
      if (code === 0) {
        try {
          const files = await fs.promises.readdir(framesDir);
          const imageFiles = files.filter(outputCountFilter);
          resolve(imageFiles.length);
        } catch (err) {
          reject(err);
        }
      } else {
        reject(new Error(`ffmpeg exited with code ${code}. Stderr: ${stderrData}`));
      }
    });
    
    ffmpeg.on("error", (err) => {
      reject(new Error(`Failed to start ffmpeg: ${err.message}`));
    });
  });
}
