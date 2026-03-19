from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Any

import runpod


def _pick_string(value: Any) -> str | None:
    if isinstance(value, str):
        value = value.strip()
        return value or None
    return None


def _pick_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"1", "true", "yes", "on"}:
            return True
        if lowered in {"0", "false", "no", "off"}:
            return False
    return None


def _pick_dict(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, dict) else {}


def _merge_aliases(payload: dict[str, Any]) -> dict[str, Any]:
    merged = dict(payload)

    alias_map = {
        "sourceImageUrl": "source_image_url",
        "sourceImageBase64": "source_image_base64",
        "sourceImageMimeType": "source_image_mime_type",
        "drivingVideoUrl": "driving_video_url",
        "motionTemplateUrl": "motion_template_url",
        "outputFormat": "output_format",
        "livePortraitMode": "live_portrait_mode",
        "livePortraitOptions": "live_portrait_options",
        "audioUrl": "audio_url",
    }

    for alias_key, target_key in alias_map.items():
        if target_key not in merged and alias_key in merged:
            merged[target_key] = merged[alias_key]

    return merged


def normalize_job_input(job_input: dict[str, Any]) -> dict[str, Any]:
    payload = _merge_aliases(job_input)
    options = _pick_dict(payload.get("live_portrait_options"))

    normalized: dict[str, Any] = {
        "source_image_url": _pick_string(payload.get("source_image_url")),
        "source_image_base64": _pick_string(payload.get("source_image_base64")),
        "source_image_mime_type": _pick_string(payload.get("source_image_mime_type")),
        "driving_video_url": _pick_string(payload.get("driving_video_url")),
        "motion_template_url": _pick_string(payload.get("motion_template_url")),
        "audio_url": _pick_string(payload.get("audio_url")),
        "output_format": _pick_string(payload.get("output_format")) or "mp4",
        "live_portrait_mode": _pick_string(payload.get("live_portrait_mode")) or "full",
    }

    if not normalized["source_image_url"] and not normalized["source_image_base64"]:
        raise ValueError("Missing source image. Provide `source_image_url` or `source_image_base64`.")

    normalized.update(options)

    mode = str(normalized["live_portrait_mode"]).strip().lower()
    normalized["live_portrait_mode"] = mode

    if mode == "lips-only":
        normalized.setdefault("animation_region", "lips")
        normalized.setdefault("retarget_part", "lips")
        normalized.setdefault("retarget_module", "R_lip")
        normalized.setdefault("preserve_head_pose", True)
        normalized.setdefault("preserve_eye_gaze", True)
        normalized.setdefault("normalize_lips", True)

    for key in ("preserve_head_pose", "preserve_eye_gaze", "normalize_lips"):
        bool_value = _pick_bool(normalized.get(key))
        if bool_value is not None:
            normalized[key] = bool_value

    return {key: value for key, value in normalized.items() if value is not None}


def _run_inference_script(normalized_input: dict[str, Any]) -> dict[str, Any]:
    script_path = os.getenv("LIVEPORTRAIT_INFERENCE_SCRIPT", "").strip()
    if not script_path:
        raise RuntimeError(
            "LIVEPORTRAIT_INFERENCE_SCRIPT is not set. Point it to a script that accepts: python script.py <input.json> <output.json>."
        )

    script = Path(script_path)
    if not script.exists():
        raise RuntimeError(f"Inference script not found: {script}")

    with tempfile.TemporaryDirectory(prefix="lp-worker-") as temp_dir:
        temp_path = Path(temp_dir)
        input_path = temp_path / "input.json"
        output_path = temp_path / "output.json"
        input_path.write_text(json.dumps(normalized_input), encoding="utf-8")

        process = subprocess.run(
            ["python", str(script), str(input_path), str(output_path)],
            check=False,
            capture_output=True,
            text=True,
            env=os.environ.copy(),
        )

        if process.returncode != 0:
            raise RuntimeError(
                "LivePortrait inference script failed"
                f"\nstdout:\n{process.stdout.strip()}"
                f"\nstderr:\n{process.stderr.strip()}"
            )

        if not output_path.exists():
            raise RuntimeError("Inference script did not create output.json")

        payload = json.loads(output_path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            raise RuntimeError("Inference script output must be a JSON object")
        return payload


def handler(job: dict[str, Any]) -> dict[str, Any]:
    job_input = _pick_dict(job.get("input"))
    normalized_input = normalize_job_input(job_input)
    result = _run_inference_script(normalized_input)

    if not any(result.get(key) for key in ("video_url", "url", "result_url", "mp4_url")):
        raise RuntimeError("Inference result did not include a video URL")

    return {
        "ok": True,
        "input": normalized_input,
        **result,
    }


runpod.serverless.start({"handler": handler})
