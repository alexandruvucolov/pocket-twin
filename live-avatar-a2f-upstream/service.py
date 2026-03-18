from __future__ import annotations

import json
import logging
import math
import os
import shlex
import struct
import subprocess
import wave
from dataclasses import dataclass
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from models import UpstreamSession

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class NvidiaConfig:
    sdk_root: str = os.getenv("NVIDIA_A2F_SDK_ROOT", "").strip()
    model_path: str = os.getenv("NVIDIA_A2F_MODEL_PATH", "").strip()
    artifacts_dir: str = os.getenv("NVIDIA_A2F_ARTIFACTS_DIR", "./artifacts").strip() or "./artifacts"
    outputs_dir: str = os.getenv("NVIDIA_A2F_OUTPUTS_DIR", "./outputs").strip() or "./outputs"
    sample_rate: int = int(os.getenv("NVIDIA_A2F_SAMPLE_RATE", "16000").strip() or "16000")
    use_gpu_solver: bool = os.getenv("NVIDIA_A2F_USE_GPU_SOLVER", "true").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    enable_execution: bool = os.getenv("NVIDIA_A2F_ENABLE_EXECUTION", "false").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    run_command: str = os.getenv("NVIDIA_A2F_RUN_COMMAND", "").strip()
    run_timeout_seconds: int = int(os.getenv("NVIDIA_A2F_RUN_TIMEOUT_SECONDS", "180").strip() or "180")
    elevenlabs_api_key: str = os.getenv("NVIDIA_A2F_ELEVENLABS_API_KEY", "").strip()
    elevenlabs_voice_id: str = os.getenv("NVIDIA_A2F_ELEVENLABS_VOICE_ID", "").strip()


class NvidiaAudio2FaceService:
    def __init__(self) -> None:
        self.config = NvidiaConfig()
        self.sessions: dict[str, UpstreamSession] = {}
        self.artifacts_dir = Path(self.config.artifacts_dir).expanduser().resolve()
        self.outputs_dir = Path(self.config.outputs_dir).expanduser().resolve()
        self.artifacts_dir.mkdir(parents=True, exist_ok=True)
        self.outputs_dir.mkdir(parents=True, exist_ok=True)

    @property
    def is_sdk_configured(self) -> bool:
        return bool(self.config.sdk_root and self.config.model_path)

    @property
    def has_tts(self) -> bool:
        return bool(self.config.elevenlabs_api_key and self.config.elevenlabs_voice_id)

    @property
    def can_execute(self) -> bool:
        return self.is_sdk_configured and self.config.enable_execution and bool(self.config.run_command)

    def create_session(self, session: UpstreamSession) -> UpstreamSession:
        session.status = "sdk-ready" if self.is_sdk_configured else "scaffold-ready"
        session.diagnostics = {
            "sdkConfigured": self.is_sdk_configured,
            "sdkRoot": bool(self.config.sdk_root),
            "modelPath": bool(self.config.model_path),
            "gpuSolver": self.config.use_gpu_solver,
            "ttsConfigured": self.has_tts,
            "artifactsDir": str(self.artifacts_dir),
            "outputsDir": str(self.outputs_dir),
            "executionEnabled": self.config.enable_execution,
            "runCommandConfigured": bool(self.config.run_command),
            "canExecute": self.can_execute,
        }
        self.sessions[session.sessionId] = session
        logger.info("NVIDIA A2F session created: %s", session.sessionId)
        return session

    def get_session(self, session_id: str) -> UpstreamSession:
        session = self.sessions.get(session_id)
        if not session:
            raise KeyError(session_id)
        return session

    def speak(self, session_id: str, text: str, avatar_profile_id: str) -> UpstreamSession:
        session = self.get_session(session_id)
        session.utteranceCount += 1
        session.lastText = text
        session.avatarProfileId = avatar_profile_id or session.avatarProfileId
        audio_path = self._generate_audio_artifact(session, text)
        session.lastAudioPath = str(audio_path)
        session.lastAudioSampleRate = self.config.sample_rate
        manifest_path, output_dir = self._write_execution_manifest(session, audio_path)
        session.lastManifestPath = str(manifest_path)
        session.lastOutputDir = str(output_dir)
        session.lastExecutionOk = None
        session.lastExecutionError = None
        session.status = "queued-for-a2f" if self.is_sdk_configured else "audio-prepared"
        session.diagnostics["nextTask"] = "Run NVIDIA Audio2Face command bridge"
        session.diagnostics["audioPrepared"] = True
        session.diagnostics["manifestPath"] = str(manifest_path)
        session.diagnostics["outputDir"] = str(output_dir)
        session.diagnostics["executionTriggered"] = False
        if self.can_execute:
            self._run_execution(session, audio_path, output_dir, manifest_path)
        logger.info("NVIDIA A2F speak queued: %s", session_id)
        return session

    def close_session(self, session_id: str) -> None:
        session = self.sessions.pop(session_id, None)
        if session:
            logger.info("NVIDIA A2F session closed: %s", session_id)

    def _generate_audio_artifact(self, session: UpstreamSession, text: str) -> Path:
        target = self.artifacts_dir / f"{session.sessionId}-{session.utteranceCount:04d}.wav"
        if self.has_tts:
            try:
                self._write_elevenlabs_wav(target, text)
                return target
            except Exception:
                logger.exception("ElevenLabs TTS failed, falling back to tone for %s", session.sessionId)

        self._write_placeholder_tone(target, text)
        return target

    def _write_execution_manifest(self, session: UpstreamSession, audio_path: Path) -> tuple[Path, Path]:
        output_dir = self.outputs_dir / session.sessionId / f"utt-{session.utteranceCount:04d}"
        output_dir.mkdir(parents=True, exist_ok=True)
        manifest_path = output_dir / "request.json"
        manifest = {
            "sessionId": session.sessionId,
            "utterance": session.utteranceCount,
            "avatarProfileId": session.avatarProfileId,
            "audioPath": str(audio_path),
            "modelPath": self.config.model_path,
            "sdkRoot": self.config.sdk_root,
            "sampleRate": self.config.sample_rate,
            "useGpuSolver": self.config.use_gpu_solver,
            "outputDir": str(output_dir),
            "text": session.lastText,
        }
        manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        return manifest_path, output_dir

    def _run_execution(
        self,
        session: UpstreamSession,
        audio_path: Path,
        output_dir: Path,
        manifest_path: Path,
    ) -> None:
        command = self.config.run_command.format(
            sdk_root=shlex.quote(self.config.sdk_root),
            model_path=shlex.quote(self.config.model_path),
            audio_path=shlex.quote(str(audio_path)),
            output_dir=shlex.quote(str(output_dir)),
            manifest_path=shlex.quote(str(manifest_path)),
            session_id=shlex.quote(session.sessionId),
            utterance=session.utteranceCount,
            sample_rate=self.config.sample_rate,
            use_gpu_solver=str(self.config.use_gpu_solver).lower(),
        )
        session.lastRunCommand = command
        session.diagnostics["executionTriggered"] = True
        session.diagnostics["runCommand"] = command

        result_path = output_dir / "result.json"
        stdout_path = output_dir / "stdout.log"
        stderr_path = output_dir / "stderr.log"

        env = os.environ.copy()
        env["NVIDIA_A2F_SDK_ROOT"] = self.config.sdk_root
        env["NVIDIA_A2F_MODEL_PATH"] = self.config.model_path
        env["NVIDIA_A2F_AUDIO_PATH"] = str(audio_path)
        env["NVIDIA_A2F_OUTPUT_DIR"] = str(output_dir)
        env["NVIDIA_A2F_REQUEST_PATH"] = str(manifest_path)

        try:
            command_cwd = Path(__file__).resolve().parent
            completed = subprocess.run(
                command,
                shell=True,
                env=env,
                cwd=str(command_cwd),
                capture_output=True,
                text=True,
                timeout=self.config.run_timeout_seconds,
                check=False,
            )
        except Exception as exc:
            session.status = "a2f-exec-failed"
            session.lastExecutionOk = False
            session.lastExecutionError = str(exc)
            session.diagnostics["executionError"] = str(exc)
            logger.exception("NVIDIA A2F execution failed before process start: %s", session.sessionId)
            return

        stdout_path.write_text(completed.stdout or "", encoding="utf-8")
        stderr_path.write_text(completed.stderr or "", encoding="utf-8")
        result = {
            "ok": completed.returncode == 0,
            "returnCode": completed.returncode,
            "stdoutPath": str(stdout_path),
            "stderrPath": str(stderr_path),
            "requestPath": str(manifest_path),
            "audioPath": str(audio_path),
        }
        result_path.write_text(json.dumps(result, indent=2), encoding="utf-8")

        session.lastExecutionOk = completed.returncode == 0
        session.lastExecutionError = None if completed.returncode == 0 else (completed.stderr or completed.stdout or "Execution failed").strip()[:2000]
        session.diagnostics["resultPath"] = str(result_path)
        session.diagnostics["stdoutPath"] = str(stdout_path)
        session.diagnostics["stderrPath"] = str(stderr_path)
        session.diagnostics["returnCode"] = completed.returncode
        if completed.returncode == 0:
            session.status = "a2f-executed"
        else:
            session.status = "a2f-exec-failed"

    def _write_placeholder_tone(self, target: Path, text: str) -> None:
        duration_seconds = max(1.2, min(len(text) * 0.045, 6.0))
        total_frames = int(duration_seconds * self.config.sample_rate)
        frequency = 180.0 + min(len(text), 40) * 6.0
        amplitude = 0.25
        with wave.open(str(target), "wb") as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(self.config.sample_rate)
            frames = bytearray()
            for i in range(total_frames):
                sample = amplitude * math.sin(2.0 * math.pi * frequency * (i / self.config.sample_rate))
                sample *= 1.0 - min(i / max(total_frames, 1), 1.0) * 0.15
                frames.extend(struct.pack("<h", int(sample * 32767)))
            wav_file.writeframes(bytes(frames))

    def _write_elevenlabs_wav(self, target: Path, text: str) -> None:
        request = Request(
            f"https://api.elevenlabs.io/v1/text-to-speech/{self.config.elevenlabs_voice_id}",
            data=json.dumps(
                {
                    "text": text,
                    "model_id": "eleven_multilingual_v2",
                    "output_format": "pcm_16000",
                }
            ).encode("utf-8"),
            headers={
                "xi-api-key": self.config.elevenlabs_api_key,
                "Content-Type": "application/json",
                "accept": "audio/pcm",
            },
            method="POST",
        )
        try:
            with urlopen(request, timeout=60) as response:
                pcm_payload = response.read()
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="ignore")
            raise RuntimeError(f"ElevenLabs error ({exc.code}): {detail}") from exc
        except URLError as exc:
            raise RuntimeError(f"ElevenLabs unavailable: {exc}") from exc

        with wave.open(str(target), "wb") as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(self.config.sample_rate)
            wav_file.writeframes(pcm_payload)
