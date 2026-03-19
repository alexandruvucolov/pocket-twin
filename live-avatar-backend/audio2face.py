from __future__ import annotations

import json
import os
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


class Audio2FaceClient:
    def __init__(self) -> None:
        self.base_url = os.getenv("LIVE_AVATAR_A2F_SERVICE_URL", "").strip().rstrip("/")
        self.api_key = os.getenv("LIVE_AVATAR_A2F_API_KEY", "").strip()
        self.avatar_id = os.getenv("LIVE_AVATAR_A2F_AVATAR_ID", "default-avatar").strip()
        # Set to True after the first connection-refused error so we stop
        # hammering a non-existent service on every speak/session call.
        self._unreachable = False

    @property
    def is_configured(self) -> bool:
        return bool(self.base_url) and not self._unreachable

    def _headers(self) -> dict[str, str]:
        headers = {
            "Content-Type": "application/json",
            "accept": "application/json",
        }
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    def notify_session_started(self, session_id: str, payload: dict[str, Any]) -> None:
        if not self.is_configured:
            return

        body = {
            "sessionId": session_id,
            "avatarId": payload.get("avatarId"),
            "avatarName": payload.get("avatarName"),
            "sourceImageUrl": payload.get("sourceImageUrl"),
            "avatarProfileId": self.avatar_id,
        }
        self._post("/sessions", body)

    def speak(self, session_id: str, text: str) -> dict[str, Any] | None:
        if not self.is_configured:
            return None

        body = {
            "sessionId": session_id,
            "avatarProfileId": self.avatar_id,
            "text": text,
        }
        return self._post(f"/sessions/{session_id}/speak", body)

    def close_session(self, session_id: str) -> None:
        if not self.is_configured:
            return
        self._post(f"/sessions/{session_id}/close", {"sessionId": session_id})

    def _post(self, path: str, body: dict[str, Any]) -> dict[str, Any] | None:
        request = Request(
            f"{self.base_url}{path}",
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
            raise RuntimeError(f"Audio2Face service error ({exc.code}): {detail}") from exc
        except URLError as exc:
            # Mark service as unreachable so subsequent calls are silently skipped.
            self._unreachable = True
            raise RuntimeError(f"Audio2Face service unavailable: {exc}") from exc
