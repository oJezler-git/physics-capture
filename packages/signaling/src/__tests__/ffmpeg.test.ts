import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractFrames } from '../ffmpeg.js';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

vi.mock('child_process');
vi.mock('fs', () => ({
  default: {
    promises: {
      mkdir: vi.fn().mockResolvedValue(undefined),
      readdir: vi.fn().mockResolvedValue([]),
      unlink: vi.fn().mockResolvedValue(undefined),
    },
    existsSync: vi.fn().mockReturnValue(true),
  },
}));

describe('extractFrames', () => {
  const mockSpawn = spawn as any;
  
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls ffmpeg with correct arguments for PNG', async () => {
    const mockProcess = {
      on: vi.fn((event, cb) => {
        if (event === 'close') setTimeout(() => cb(0), 10);
      }),
      stderr: { on: vi.fn() },
    };
    mockSpawn.mockReturnValue(mockProcess);
    
    // Mock readdir to return 5 frames after "extraction"
    (fs.promises.readdir as any).mockResolvedValue(['000001.png', '000002.png', '000003.png', '000004.png', '000005.png']);

    const count = await extractFrames('video.mp4', 'frames_dir', 'png');
    
    expect(count).toBe(5);
    expect(fs.promises.mkdir).toHaveBeenCalledWith('frames_dir', { recursive: true });
    expect(mockSpawn).toHaveBeenCalledWith('ffmpeg', expect.arrayContaining(['-i', 'video.mp4', 'frames_dir\\%06d.png']));
  });

  it('rejects if ffmpeg fails', async () => {
    const mockProcess = {
      on: vi.fn((event, cb) => {
        if (event === 'close') setTimeout(() => cb(1), 10);
      }),
      stderr: { on: vi.fn() },
    };
    mockSpawn.mockReturnValue(mockProcess);

    await expect(extractFrames('video.mp4', 'frames_dir')).rejects.toThrow('ffmpeg exited with code 1');
  });
});
