from __future__ import annotations

from typing import Any

from pydantic import BaseModel


class CreateSessionBody(BaseModel):
    avatarId: str
    avatarName: str
    sourceImageUrl: str | None = None
    sourceImageBase64: str | None = None
    sourceImageMimeType: str | None = None


class AnswerBody(BaseModel):
    answer: dict[str, Any]


class IceBody(BaseModel):
    candidate: str | None = None
    sdpMid: str | None = None
    sdpMLineIndex: int | None = None


class SpeakBody(BaseModel):
    text: str
