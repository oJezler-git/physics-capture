import cv2
import numpy as np
from PIL import Image, ImageDraw
import sys
import os

def generate_test_video(output_path, width=640, height=480, duration_sec=1, fps=30):
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    out = cv2.VideoWriter(output_path, fourcc, fps, (width, height))

    num_frames = duration_sec * fps
    for i in range(num_frames):
        # Create a black frame
        frame = np.zeros((height, width, 3), dtype=np.uint8)
        
        # Draw a moving white circle
        x = int(50 + (width - 100) * (i / num_frames))
        y = height // 2
        cv2.circle(frame, (x, y), 30, (255, 255, 255), -1)
        
        # Add some text to verify frame index
        cv2.putText(frame, f"Frame {i}", (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 255, 255), 2)

        out.write(frame)
    
    out.release()
    print(f"Generated test video: {output_path}")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python generate-test-video.py <output_path>")
        sys.exit(1)
    
    generate_test_video(sys.argv[1])
