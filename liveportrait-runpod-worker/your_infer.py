from __future__ import annotations

import base64
import json
import mimetypes
import os
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any
from urllib.request import urlopen


def _pick_string(value: Any) -> str | None:
    if isinstance(value, str):
        value = value.strip()
        return value or None
    return None


def _guess_suffix(mime_type: str | None, default: str) -> str:
    if mime_type:
        guessed = mimetypes.guess_extension(mime_type, strict=False)
        if guessed:
            return guessed
    return default


def _download_to_file(url: str, path: Path) -> Path:
    with urlopen(url, timeout=60) as response:
        path.write_bytes(response.read())
    return path


def _write_base64_file(encoded: str, path: Path) -> Path:
    path.write_bytes(base64.b64decode(encoded))
    return path


def _prepare_source_files(payload: dict[str, Any], work_dir: Path) -> dict[str, str]:
    source_image_url = _pick_string(payload.get("source_image_url"))
    source_image_base64 = _pick_string(payload.get("source_image_base64"))
    source_image_mime_type = _pick_string(payload.get("source_image_mime_type"))
    driving_video_url = _pick_string(payload.get("driving_video_url"))
    motion_template_url = _pick_string(payload.get("motion_template_url"))
    audio_url = _pick_string(payload.get("audio_url"))

    if not source_image_url and not source_image_base64:
        raise RuntimeError("Missing source image input")

    source_image_path = work_dir / f"source{_guess_suffix(source_image_mime_type, '.jpg')}"
    if source_image_base64:
        _write_base64_file(source_image_base64, source_image_path)
    else:
        _download_to_file(source_image_url or "", source_image_path)

    result: dict[str, str] = {
        "source_image_path": str(source_image_path),
    }

    if driving_video_url:
        driving_path = work_dir / "driving.mp4"
        _download_to_file(driving_video_url, driving_path)
        result["driving_video_path"] = str(driving_path)

    if motion_template_url:
        motion_path = work_dir / "motion-template.bin"
        _download_to_file(motion_template_url, motion_path)
        result["motion_template_path"] = str(motion_path)

    if audio_url:
        audio_path = work_dir / "audio.wav"
        _download_to_file(audio_url, audio_path)
        result["audio_path"] = str(audio_path)

    return result


def _stringify_context(payload: dict[str, Any], paths: dict[str, str], output_dir: Path) -> dict[str, str]:
    output_video_name = os.getenv("LIVEPORTRAIT_OUTPUT_FILENAME", "result.mp4").strip() or "result.mp4"
    output_video_path = output_dir / output_video_name
    context: dict[str, str] = {
        "output_dir": str(output_dir),
        "output_video_path": str(output_video_path),
        "output_video_name": output_video_name,
        "live_portrait_mode": str(payload.get("live_portrait_mode") or "full"),
        "animation_region": str(payload.get("animation_region") or ""),
        "retarget_part": str(payload.get("retarget_part") or ""),
        "retarget_module": str(payload.get("retarget_module") or ""),
        "preserve_head_pose": str(bool(payload.get("preserve_head_pose"))).lower(),
        "preserve_eye_gaze": str(bool(payload.get("preserve_eye_gaze"))).lower(),
        "normalize_lips": str(bool(payload.get("normalize_lips"))).lower(),
    }

    for key, value in paths.items():
        context[key] = value

    for key, value in payload.items():
        if isinstance(value, (str, int, float, bool)) and key not in context:
            context[key] = str(value)

    for optional_key in ("driving_video_path", "motion_template_path", "audio_path"):
        context.setdefault(optional_key, "")

    return context


def _run_command(template: str, context: dict[str, str], cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    command = template.format(**context).strip()
    if not command:
        raise RuntimeError("Resolved command is empty")

    return subprocess.run(
        shlex.split(command),
        check=False,
        capture_output=True,
        text=True,
        cwd=str(cwd) if cwd else None,
        env=os.environ.copy(),
    )


def _build_default_command(context: dict[str, str]) -> str:
    base = os.getenv("LIVEPORTRAIT_BASE_COMMAND", "").strip()
    if not base:
        raise RuntimeError(
            "Set LIVEPORTRAIT_INFER_COMMAND_TEMPLATE or LIVEPORTRAIT_BASE_COMMAND to your LivePortrait invocation."
        )

    parts = [base]

    source_arg = os.getenv("LIVEPORTRAIT_SOURCE_ARG", "--source").strip()
    driving_arg = os.getenv("LIVEPORTRAIT_DRIVING_ARG", "--driving").strip()
    motion_arg = os.getenv("LIVEPORTRAIT_MOTION_ARG", "--motion-template").strip()
    audio_arg = os.getenv("LIVEPORTRAIT_AUDIO_ARG", "").strip()
    output_arg = os.getenv("LIVEPORTRAIT_OUTPUT_ARG", "--output").strip()
    mode_arg = os.getenv("LIVEPORTRAIT_MODE_ARG", "").strip()

    if source_arg:
        parts.extend([source_arg, shlex.quote(context["source_image_path"])])
    if context["driving_video_path"] and driving_arg:
        parts.extend([driving_arg, shlex.quote(context["driving_video_path"])])
    if context["motion_template_path"] and motion_arg:
        parts.extend([motion_arg, shlex.quote(context["motion_template_path"])])
    if context["audio_path"] and audio_arg:
        parts.extend([audio_arg, shlex.quote(context["audio_path"])])
    if output_arg:
        parts.extend([output_arg, shlex.quote(context["output_video_path"])])
    if mode_arg:
        parts.extend([mode_arg, shlex.quote(context["live_portrait_mode"])])

    return " ".join(parts)


def _resolve_video_url(context: dict[str, str]) -> str | None:
    upload_template = os.getenv("LIVEPORTRAIT_UPLOAD_COMMAND_TEMPLATE", "").strip()
    if upload_template:
        upload_result = _run_command(upload_template, context)
        if upload_result.returncode != 0:
            raise RuntimeError(
                "Upload command failed"
                f"\nstdout:\n{upload_result.stdout.strip()}"
                f"\nstderr:\n{upload_result.stderr.strip()}"
            )
        return upload_result.stdout.strip() or None

    url_template = os.getenv("LIVEPORTRAIT_RESULT_URL_TEMPLATE", "").strip()
    if url_template:
        return url_template.format(**context).strip() or None

    return None


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit("Usage: python your_infer.py <input.json> <output.json>")

    input_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2])
    payload = json.loads(input_path.read_text(encoding="utf-8"))

    with tempfile.TemporaryDirectory(prefix="liveportrait-infer-") as temp_dir:
        work_dir = Path(temp_dir)
        output_dir = work_dir / "output"
        output_dir.mkdir(parents=True, exist_ok=True)

        paths = _prepare_source_files(payload, work_dir)
        context = _stringify_context(payload, paths, output_dir)

        command_template = os.getenv("LIVEPORTRAIT_INFER_COMMAND_TEMPLATE", "").strip()
        command = command_template or _build_default_command(context)
        process = _run_command(command, context)
        if process.returncode != 0:
            raise RuntimeError(
                "LivePortrait command failed"
                f"\ncommand:\n{command.format(**context) if command_template else command}"
                f"\nstdout:\n{process.stdout.strip()}"
                f"\nstderr:\n{process.stderr.strip()}"
            )

        video_url = _resolve_video_url(context)
        if not video_url:
            raise RuntimeError(
                "No public video URL could be resolved. Set LIVEPORTRAIT_UPLOAD_COMMAND_TEMPLATE or LIVEPORTRAIT_RESULT_URL_TEMPLATE."
            )

        output_payload = {
            "video_url": video_url,
            "output_video_path": context["output_video_path"],
            "command": command.format(**context) if command_template else command,
        }
        output_path.write_text(json.dumps(output_payload), encoding="utf-8")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())