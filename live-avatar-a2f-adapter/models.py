from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class CreateSessionBody(BaseModel):
    sessionId: str
    avatarId: str | None = None
    avatarName: str | None = None
    sourceImageUrl: str | None = None
    avatarProfileId: str = Field(default="default-avatar")


class SpeakBody(BaseModel):
    sessionId: str
    avatarProfileId: str = Field(default="default-avatar")
    text: str


class CloseSessionBody(BaseModel):
    sessionId: str


class SessionState(BaseModel):
    sessionId: str
    avatarId: str | None = None
    avatarName: str | None = None
    sourceImageUrl: str | None = None
    avatarProfileId: str = Field(default="default-avatar")
    utteranceCount: int = 0
    lastText: str | None = None
    lastOutputDir: str | None = None
    lastManifestPath: str | None = None
    lastExecutionOk: bool | None = None
    lastExecutionError: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
