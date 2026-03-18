from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from dotenv import load_dotenv

from models import SessionState

logger = logging.getLogger(__name__)

load_dotenv(Path(__file__).with_name(".env"))


@dataclass(slots=True)
class AdapterConfig:
    upstream_base_url: str = os.getenv("A2F_UPSTREAM_BASE_URL", "").strip().rstrip("/")
    upstream_api_key: str = os.getenv("A2F_UPSTREAM_API_KEY", "").strip()
    fake_mode: bool = os.getenv("A2F_ENABLE_FAKE_MODE", "true").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


class Audio2FaceAdapter:
    def __init__(self) -> None:
        self.config = AdapterConfig()
        self.sessions: dict[str, SessionState] = {}

    def _headers(self) -> dict[str, str]:
        headers = {
            "Content-Type": "application/json",
            "accept": "application/json",
        }
        if self.config.upstream_api_key:
            headers["Authorization"] = f"Bearer {self.config.upstream_api_key}"
        return headers

    @property
    def has_upstream(self) -> bool:
        return bool(self.config.upstream_base_url)

    def create_session(self, state: SessionState) -> SessionState:
        self.sessions[state.sessionId] = state
        if self.has_upstream:
            upstream_response = self._post("/sessions", state.model_dump())
            self._merge_upstream_session(state, upstream_response)
        else:
            logger.info("A2F fake mode session created: %s", state.sessionId)
        return state

    def speak(self, session_id: str, text: str, avatar_profile_id: str) -> SessionState:
        session = self.get_session(session_id)
        session.utteranceCount += 1
        session.lastText = text
        session.avatarProfileId = avatar_profile_id or session.avatarProfileId
        if self.has_upstream:
            upstream_response = self._post(
                f"/sessions/{session_id}/speak",
                {
                    "sessionId": session_id,
                    "avatarProfileId": session.avatarProfileId,
                    "text": text,
                },
            )
            self._merge_upstream_session(session, upstream_response)
        else:
            logger.info("A2F fake mode speak: %s (%s chars)", session_id, len(text))
        return session

    def close_session(self, session_id: str) -> None:
        session = self.sessions.pop(session_id, None)
        if not session:
            return
        if self.has_upstream:
            self._post(f"/sessions/{session_id}/close", {"sessionId": session_id})
        else:
            logger.info("A2F fake mode closed session: %s", session_id)

    def get_session(self, session_id: str) -> SessionState:
        session = self.sessions.get(session_id)
        if not session:
            raise KeyError(session_id)
        return session

    def _merge_upstream_session(self, session: SessionState, response: dict[str, Any] | None) -> None:
        if not isinstance(response, dict):
            return
        upstream_session = response.get("session")
        if not isinstance(upstream_session, dict):
            return

        session.lastOutputDir = upstream_session.get("lastOutputDir") or session.lastOutputDir
        session.lastManifestPath = upstream_session.get("lastManifestPath") or session.lastManifestPath
        session.lastExecutionOk = upstream_session.get("lastExecutionOk")
        session.lastExecutionError = upstream_session.get("lastExecutionError")
        diagnostics = upstream_session.get("diagnostics")
        if isinstance(diagnostics, dict):
            session.metadata["upstreamDiagnostics"] = diagnostics

    def _post(self, path: str, body: dict[str, Any]) -> dict[str, Any] | None:
        if not self.has_upstream:
            return None
        request = Request(
            f"{self.config.upstream_base_url}{path}",
            data=json.dumps(body).encode("utf-8"),
            headers=self._headers(),
            method="POST",
        )
        try:
            with urlopen(request, timeout=20) as response:
                payload = response.read().decode("utf-8", errors="ignore")
                return json.loads(payload) if payload else None
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="ignore")
            raise RuntimeError(f"A2F upstream error ({exc.code}): {detail}") from exc
        except URLError as exc:
            raise RuntimeError(f"A2F upstream unavailable: {exc}") from exc
