Phase 1: The Core Pipeline (Sprints 1 & 2)
Goal: Get a video from a phone to the PC and see a tracked ball.

1.  Module H (gRPC Interface): Define the protocol first so Node.js and Python can talk.
2.  Module I (Node.js Backend) & Module G (Frontend): Set up the basic server and UI to handle the connection.
3.  Module A (Capture & Sync) & Module B (Recording): Get the phone PWA recording video and uploading it to the server.
4.  Module J (CV Backend) & Module D (Tracking): Implement the SAM2 tracker in Python to process the uploaded video.
5.  Module F (Physics Analysis): Implement basic velocity fitting (planar) to get results.
    - Outcome: You can now record an experiment with one phone and get physics data.

Phase 2: Accuracy & Multi-Camera (Sprints 3 & 4)
Goal: Sub-millisecond timing and 3D reconstruction. 6. Module A (Synchronisation - Part 2): Implement the Sync Marker (phased grating + Gray code) decoding to sync two cameras. 7. Module C (Calibration): Build the checkerboard detection to calibrate lens distortion. 8. Module E (Reconstruction): Use stereo triangulation to turn two 2D tracks into one 3D path.

Phase 3: Polish & Deployment (Sprints 5 & 6) 9. Module F (Physics - Part 2): Add uncertainty propagation (error bars) and friction compensation. 10. Module K (Data Management): Add the database to save/load past experiments. 11. Module L (Infrastructure): Finalize Docker configs for easy setup in a lab.
