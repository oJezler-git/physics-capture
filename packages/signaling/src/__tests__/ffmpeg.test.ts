import { describe, it, expect, vi, beforeEach } from "vitest";
import { extractFrames } from "../ffmpeg.js";
import { spawn } from "child_process";
import fs from "fs";

vi.mock("child_process");

describe("extractFrames - Unit", () => {
  const mockSpawn = spawn as any;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(fs.promises, "mkdir").mockResolvedValue(undefined);
    vi.spyOn(fs.promises, "readdir").mockResolvedValue([]);
    vi.spyOn(fs.promises, "unlink").mockResolvedValue(undefined);
  });

  it("calls ffmpeg with correct arguments for PNG", async () => {
    // We need to ensure readdir returns the expected files for both the tempDir scan and the final framesDir scan.
    vi.spyOn(fs.promises, "readdir").mockImplementation((async (dir: any) => {
      if (typeof dir === "string" && dir.includes(".ffmpeg-tmp-")) {
        return [
          "000001.png",
          "000002.png",
          "000003.png",
          "000004.png",
          "000005.png",
        ];
      }
      return [];
    }) as any);
    vi.spyOn(fs.promises, "rename").mockResolvedValue(undefined);

    // Mock the spawned process
    const mockProcess = {
      stderr: { on: vi.fn() },
      on: vi.fn((event, cb) => {
        if (event === "close") setTimeout(() => cb(0), 10);
      }),
    };
    (spawn as any).mockReturnValue(mockProcess);

    const count = await extractFrames("video.mp4", "frames_dir", "png");

    expect(count).toBe(5);
    expect(spawn).toHaveBeenCalledWith(
      "ffmpeg",
      expect.arrayContaining(["-i", "video.mp4"]),
      expect.any(Object),
    );
  });

  it("rejects if ffmpeg fails", async () => {
    const mockProcess = {
      on: vi.fn((event, cb) => {
        if (event === "close") setTimeout(() => cb(1), 10);
      }),
      stderr: { on: vi.fn() },
    };
    mockSpawn.mockReturnValue(mockProcess);

    await expect(extractFrames("video.mp4", "frames_dir")).rejects.toThrow(
      "ffmpeg exited with code 1",
    );
  });
});
