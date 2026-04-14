# packages/cv-service/calibration/intrinsic.py
import cv2
import numpy as np
from pathlib import Path
from typing import List, Tuple, Optional

def calibrate_camera(frames: List[np.ndarray], board_size: Tuple[int, int] = (9, 7)) -> Optional[dict]:
    """
    Calibrates camera using checkerboard images.
    Returns intrinsic parameters if successful, None otherwise.
    """
    objp = np.zeros((board_size[0] * board_size[1], 3), np.float32)
    objp[:, :2] = np.mgrid[0:board_size[0], 0:board_size[1]].T.reshape(-1, 2)
    
    objpoints = []
    imgpoints = []
    
    for frame in frames:
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        ret, corners = cv2.findChessboardCorners(gray, board_size, None)
        if ret:
            objpoints.append(objp)
            imgpoints.append(corners)
            
    if len(objpoints) < 10: # Need sufficient images
        return None
        
    ret, mtx, dist, rvecs, tvecs = cv2.calibrateCamera(objpoints, imgpoints, gray.shape[::-1], None, None)
    
    if not ret:
        return None
        
    return {
        "fx": mtx[0, 0], "fy": mtx[1, 1],
        "cx": mtx[0, 2], "cy": mtx[1, 2],
        "k1": dist[0, 0], "k2": dist[0, 1], "p1": dist[0, 2], "p2": dist[0, 3], "k3": dist[0, 4]
    }
