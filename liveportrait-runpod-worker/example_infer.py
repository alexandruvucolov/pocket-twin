from __future__ import annotations

import json
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit("Usage: python example_infer.py <input.json> <output.json>")

    input_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2])
    payload = json.loads(input_path.read_text(encoding="utf-8"))

    # Replace this file with your real LivePortrait integration.
    # Expected output shape:
    # {
    #   "video_url": "https://.../result.mp4"
    # }
    raise RuntimeError(
        "example_infer.py is only a stub. Replace it with your LivePortrait pipeline and write a JSON object containing `video_url` to output.json.\n"
        f"Received input: {json.dumps(payload, indent=2)}"
    )


if __name__ == "__main__":
    raise SystemExit(main())
