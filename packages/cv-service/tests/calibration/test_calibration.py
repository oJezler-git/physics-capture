import pytest
import numpy as np
import cv2
import os
import shutil
from pathlib import Path
from calibration.intrinsic import (
    BOARD_SIZE,
    SQUARE_SIZE_MM,
    detect_corners_in_dir,
    calibrate_camera_from_corners,
    IntrinsicResult
)
from calibration.stereo import stereo_calibrate, StereoResult

def create_synthetic_checkerboard(width=1280, height=720, board_size=(8, 6), square_size=60):
    """
    Creates a synthetic image of a checkerboard.
    """
    img = np.ones((height, width), dtype=np.uint8) * 128 # Gray background
    
    rows, cols = board_size
    # Adjust to draw one more square than corners
    full_rows = rows + 1
    full_cols = cols + 1
    
    board_w = full_rows * square_size
    board_h = full_cols * square_size
    
    # Create the pattern
    pattern = np.zeros((board_h, board_w), dtype=np.uint8)
    for i in range(full_cols):
        for j in range(full_rows):
            if (i + j) % 2 == 0:
                pattern[i*square_size:(i+1)*square_size, j*square_size:(j+1)*square_size] = 255
                
    # Place it in the image with some rotation/perspective
    pts1 = np.float32([[0,0], [board_w,0], [0,board_h], [board_w,board_h]])
    
    # Add some perspective tilt
    pts2 = np.float32([
        [100, 100], 
        [width-200, 150], 
        [150, height-100], 
        [width-100, height-150]
    ])
    
    M = cv2.getPerspectiveTransform(pts1, pts2)
    dst = cv2.warpPerspective(pattern, M, (width, height), borderValue=128)
    
    # Convert to BGR for detect_corners_in_dir (which expects BGR from cv2.imread)
    return cv2.cvtColor(dst, cv2.COLOR_GRAY2BGR)

@pytest.fixture
def temp_experiment_dir(tmp_path):
    """Creates a temporary experiment structure with synthetic frames."""
    exp_dir = tmp_path / "test-exp"
    frames_dir = exp_dir / "frames" / "cam0"
    frames_dir.mkdir(parents=True)
    
    # Generate 50 slightly different views to satisfy stride requirements
    for i in range(50):
        # Slightly vary the pts2 for each frame
        width, height = 1280, 720
        offset = i * 5
        pts1 = np.float32([[0,0], [9*60,0], [0,7*60], [9*60,7*60]])
        pts2 = np.float32([
            [100 + offset, 100], 
            [width-200, 150 + offset], 
            [150, height-100 - offset], 
            [width-100 - offset, height-150]
        ])
        M = cv2.getPerspectiveTransform(pts1, pts2)
        
        # Create a basic pattern
        pattern = np.zeros((7*60, 9*60), dtype=np.uint8)
        for r in range(7):
            for c in range(9):
                if (r + c) % 2 == 0:
                    pattern[r*60:(r+1)*60, c*60:(c+1)*60] = 255
                    
        dst = cv2.warpPerspective(pattern, M, (width, height), borderValue=128)
        bgr = cv2.cvtColor(dst, cv2.COLOR_GRAY2BGR)
        
        cv2.imwrite(str(frames_dir / f"frame_{i:06d}.jpg"), bgr)
        
    return exp_dir

def test_intrinsic_calibration_pipeline(temp_experiment_dir):
    frames_dir = temp_experiment_dir / "frames" / "cam0"
    
    # 1. Test corner detection
    observations = []
    for frame_idx, total, obs in detect_corners_in_dir(frames_dir, stride=1):
        if obs:
            observations.append(obs)
            
    assert len(observations) >= 10, f"Expected at least 10 observations, got {len(observations)}"
    
    # 2. Test calibration
    result = calibrate_camera_from_corners(observations)
    
    assert isinstance(result, IntrinsicResult)
    # Synthetic warping doesn't perfectly match camera models; 10px is fine for a sanity test.
    assert result.reprojection_error_px < 10.0
    assert result.camera_matrix.shape == (3, 3)
    assert len(result.dist_coeffs) >= 5

def test_stereo_calibration_skipped_with_no_intrinsics(temp_experiment_dir):
    # Running stereo without pre-saved intrinsics should return None
    result = stereo_calibrate(temp_experiment_dir, camera_ids=[0, 1])
    assert result is None

def test_stereo_calibration_logic_mock(temp_experiment_dir):
    # Save mock intrinsics first
    calib_dir = temp_experiment_dir / "calibration"
    calib_dir.mkdir(exist_ok=True)
    
    from calibration.intrinsic import save_intrinsics, IntrinsicResult
    
    mock_k = np.array([[1000, 0, 640], [0, 1000, 360], [0, 0, 1]], dtype=np.float64)
    mock_d = np.zeros(5, dtype=np.float64)
    res = IntrinsicResult(mock_k, mock_d, (1280, 720), 0.1)
    
    # Create cam1 frames (just copy cam0)
    frames_dir1 = temp_experiment_dir / "frames" / "cam1"
    frames_dir1.mkdir(parents=True)
    for f in (temp_experiment_dir / "frames" / "cam0").glob("*.jpg"):
        shutil.copy(f, frames_dir1 / f.name)
    
    save_intrinsics(res, calib_dir / "cam0_intrinsics.json", camera_id=0)
    save_intrinsics(res, calib_dir / "cam1_intrinsics.json", camera_id=1)
    
    # Run stereo (identical cameras should have R=Identity, T=0)
    result = stereo_calibrate(temp_experiment_dir, camera_ids=[0, 1])
    
    assert result is not None
    assert isinstance(result, StereoResult)
    # For identical frames, R should be close to identity
    assert np.allclose(result.R, np.eye(3), atol=1e-2)
    # T should be small
    assert np.linalg.norm(result.T) < 5.0 
