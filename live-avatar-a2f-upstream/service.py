from __future__ import annotations

import logging
import os
from dataclasses import dataclass

from models import UpstreamSession

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class NvidiaConfig:
    sdk_root: str = os.getenv("NVIDIA_A2F_SDK_ROOT", "").strip()
    model_path: str = os.getenv("NVIDIA_A2F_MODEL_PATH", "").strip()
    use_gpu_solver: bool = os.getenv("NVIDIA_A2F_USE_GPU_SOLVER", "true").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


class NvidiaAudio2FaceService:
    def __init__(self) -> None:
        self.config = NvidiaConfig()
        self.sessions: dict[str, UpstreamSession] = {}

    @property
    def is_sdk_configured(self) -> bool:
        return bool(self.config.sdk_root and self.config.model_path)

    def create_session(self, session: UpstreamSession) -> UpstreamSession:
        session.status = "sdk-ready" if self.is_sdk_configured else "scaffold-ready"
        session.diagnostics = {
            "sdkConfigured": self.is_sdk_configured,
            "sdkRoot": bool(self.config.sdk_root),
            "modelPath": bool(self.config.model_path),
            "gpuSolver": self.config.use_gpu_solver,
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
        session.status = "queued-for-a2f" if self.is_sdk_configured else "scaffold-speak"
        session.diagnostics["nextTask"] = (
            "Implement TTS -> WAV/PCM -> NVIDIA Audio2Face streaming executor"
        )
        logger.info("NVIDIA A2F speak queued: %s", session_id)
        return session

    def close_session(self, session_id: str) -> None:
        session = self.sessions.pop(session_id, None)
        if session:
            logger.info("NVIDIA A2F session closed: %s", session_id)
