from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class SessionCreateBody(BaseModel):
    sessionId: str
    avatarId: str | None = None
    avatarName: str | None = None
    sourceImageUrl: str | None = None
    avatarProfileId: str = Field(default="default-avatar")


class SessionSpeakBody(BaseModel):
    sessionId: str
    avatarProfileId: str = Field(default="default-avatar")
    text: str


class SessionCloseBody(BaseModel):
    sessionId: str


class UpstreamSession(BaseModel):
    sessionId: str
    avatarId: str | None = None
    avatarName: str | None = None
    sourceImageUrl: str | None = None
    avatarProfileId: str = Field(default="default-avatar")
    status: str = Field(default="ready")
    utteranceCount: int = 0
    lastText: str | None = None
    lastAudioPath: str | None = None
    lastAudioSampleRate: int | None = None
    lastOutputDir: str | None = None
    lastManifestPath: str | None = None
    lastRunCommand: str | None = None
    lastExecutionOk: bool | None = None
    lastExecutionError: str | None = None
    diagnostics: dict[str, Any] = Field(default_factory=dict)
