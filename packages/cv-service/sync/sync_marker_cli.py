from __future__ import annotations

import argparse
import math
from pathlib import Path

try:
    # When executed as a module: python -m sync.sync_marker_cli
    from .sync_marker import SyncMarkerSpec, generate_sync_for_experiment, write_sync_json
except ImportError:  # pragma: no cover
    # When executed as a script: python packages/cv-service/sync/sync_marker_cli.py
    from sync_marker import SyncMarkerSpec, generate_sync_for_experiment, write_sync_json


def _parse_camera_ids(value: str) -> list[int]:
    out: list[int] = []
    for part in value.split(","):
        part = part.strip()
        if not part:
            continue
        out.append(int(part))
    return sorted(set(out))


def main() -> int:
    parser = argparse.ArgumentParser(description="Decode Sync Marker timestamps and write sync.json.")
    parser.add_argument("--experiments-dir", type=Path, required=True)
    parser.add_argument("--experiment-id", type=str, required=True)
    parser.add_argument("--camera-ids", type=str, default="0,1")
    parser.add_argument("--display-hz", type=float, default=60.0)
    parser.add_argument("--sample-stride", type=int, default=5)
    parser.add_argument("--roi-width", type=int, default=400)
    parser.add_argument("--roi-height", type=int, default=200)
    parser.add_argument("--gray-bits", type=int, default=10)
    parser.add_argument("--grating-cycles", type=int, default=4)
    parser.add_argument("--phase-step-rad", type=float, default=None)
    args = parser.parse_args()

    experiment_dir = args.experiments_dir / args.experiment_id
    spec = SyncMarkerSpec(
        gray_bits=int(args.gray_bits),
        grating_cycles=int(args.grating_cycles),
        phase_step_rad=float(args.phase_step_rad)
        if args.phase_step_rad is not None
        else (math.tau / 32.0),
        roi_width_px=int(args.roi_width),
        roi_height_px=int(args.roi_height),
    )

    camera_ids = _parse_camera_ids(args.camera_ids)
    results = generate_sync_for_experiment(
        experiment_dir=experiment_dir,
        camera_ids=camera_ids,
        spec=spec,
        display_hz=float(args.display_hz),
        sample_stride=int(args.sample_stride),
    )
    if not results:
        raise SystemExit("No sync marker could be decoded from the extracted frames.")

    ref = "cam0" if any(r.camera_id == 0 for r in results) else f"cam{results[0].camera_id}"
    out_path = experiment_dir / "results" / "sync.json"
    write_sync_json(
        experiment_dir=experiment_dir,
        camera_results=results,
        reference_camera=ref,
        spec=spec,
        output_path=out_path,
    )
    print(f"Wrote {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
