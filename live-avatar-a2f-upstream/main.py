from __future__ import annotations

import logging

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from models import SessionCloseBody, SessionCreateBody, SessionSpeakBody, UpstreamSession
from service import NvidiaAudio2FaceService

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
service = NvidiaAudio2FaceService()

app = FastAPI(title="Pocket Twin NVIDIA Audio2Face Upstream")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, object]:
    return {
        "ok": True,
        "sdkConfigured": service.is_sdk_configured,
        "ttsConfigured": service.has_tts,
        "artifactsDir": str(service.artifacts_dir),
    }


@app.post("/sessions")
async def create_session(body: SessionCreateBody) -> dict[str, object]:
    session = service.create_session(
        UpstreamSession(
            sessionId=body.sessionId,
            avatarId=body.avatarId,
            avatarName=body.avatarName,
            sourceImageUrl=body.sourceImageUrl,
            avatarProfileId=body.avatarProfileId,
        )
    )
    return {"ok": True, "session": session.model_dump()}


@app.get("/sessions/{session_id}")
async def get_session(session_id: str) -> dict[str, object]:
    try:
        session = service.get_session(session_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Session not found") from exc
    return {"ok": True, "session": session.model_dump()}


@app.post("/sessions/{session_id}/speak")
async def speak(session_id: str, body: SessionSpeakBody) -> dict[str, object]:
    if session_id != body.sessionId:
        raise HTTPException(status_code=400, detail="Session id mismatch")
    try:
        session = service.speak(session_id, body.text, body.avatarProfileId)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Session not found") from exc
    return {"ok": True, "session": session.model_dump()}


@app.post("/sessions/{session_id}/close")
async def close_session(session_id: str, body: SessionCloseBody) -> dict[str, object]:
    if session_id != body.sessionId:
        raise HTTPException(status_code=400, detail="Session id mismatch")
    service.close_session(session_id)
    return {"ok": True, "sessionId": session_id}
