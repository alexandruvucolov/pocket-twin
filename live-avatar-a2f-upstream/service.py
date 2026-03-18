from __future__ import annotations

import json
import logging
import math
import os
import struct
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
    sample_rate: int = int(os.getenv("NVIDIA_A2F_SAMPLE_RATE", "16000").strip() or "16000")
    use_gpu_solver: bool = os.getenv("NVIDIA_A2F_USE_GPU_SOLVER", "true").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    elevenlabs_api_key: str = os.getenv("NVIDIA_A2F_ELEVENLABS_API_KEY", "").strip()
    elevenlabs_voice_id: str = os.getenv("NVIDIA_A2F_ELEVENLABS_VOICE_ID", "").strip()


class NvidiaAudio2FaceService:
    def __init__(self) -> None:
        self.config = NvidiaConfig()
        self.sessions: dict[str, UpstreamSession] = {}
        self.artifacts_dir = Path(self.config.artifacts_dir).expanduser().resolve()
        self.artifacts_dir.mkdir(parents=True, exist_ok=True)

    @property
    def is_sdk_configured(self) -> bool:
        return bool(self.config.sdk_root and self.config.model_path)

    @property
    def has_tts(self) -> bool:
        return bool(self.config.elevenlabs_api_key and self.config.elevenlabs_voice_id)

    def create_session(self, session: UpstreamSession) -> UpstreamSession:
        session.status = "sdk-ready" if self.is_sdk_configured else "scaffold-ready"
        session.diagnostics = {
            "sdkConfigured": self.is_sdk_configured,
            "sdkRoot": bool(self.config.sdk_root),
            "modelPath": bool(self.config.model_path),
            "gpuSolver": self.config.use_gpu_solver,
            "ttsConfigured": self.has_tts,
            "artifactsDir": str(self.artifacts_dir),
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
        session.status = "queued-for-a2f" if self.is_sdk_configured else "audio-prepared"
        session.diagnostics["nextTask"] = "Feed WAV/PCM into NVIDIA Audio2Face streaming executor"
        session.diagnostics["audioPrepared"] = True
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
