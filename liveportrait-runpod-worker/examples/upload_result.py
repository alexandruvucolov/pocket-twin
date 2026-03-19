from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path


PUBLIC_RESULTS_DIR = Path(
    os.getenv("LIVEPORTRAIT_PUBLIC_RESULTS_DIR", "/workspace/liveportrait-results")
)
PUBLIC_BASE_URL = os.getenv(
    "LIVEPORTRAIT_PUBLIC_BASE_URL",
    "https://YOUR-HOST/results",
)


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python upload_result.py <video-path>")

    source = Path(sys.argv[1])
    if not source.exists():
        raise RuntimeError(f"File not found: {source}")

    PUBLIC_RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    target = PUBLIC_RESULTS_DIR / source.name
    shutil.copy2(source, target)
    print(f"{PUBLIC_BASE_URL}/{target.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
