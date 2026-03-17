from __future__ import annotations

import logging

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from models import CloseSessionBody, CreateSessionBody, SessionState, SpeakBody
from service import Audio2FaceAdapter

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
adapter = Audio2FaceAdapter()

app = FastAPI(title="Pocket Twin Audio2Face Adapter")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, bool | str]:
    return {
        "ok": True,
        "mode": "upstream" if adapter.has_upstream else "fake",
    }


@app.post("/sessions")
async def create_session(body: CreateSessionBody) -> dict[str, object]:
    state = adapter.create_session(
        SessionState(
            sessionId=body.sessionId,
            avatarId=body.avatarId,
            avatarName=body.avatarName,
            sourceImageUrl=body.sourceImageUrl,
            avatarProfileId=body.avatarProfileId,
        )
    )
    return {"ok": True, "session": state.model_dump()}


@app.get("/sessions/{session_id}")
async def get_session(session_id: str) -> dict[str, object]:
    try:
        session = adapter.get_session(session_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Session not found") from exc
    return {"ok": True, "session": session.model_dump()}


@app.post("/sessions/{session_id}/speak")
async def speak(session_id: str, body: SpeakBody) -> dict[str, object]:
    if session_id != body.sessionId:
        raise HTTPException(status_code=400, detail="Session id mismatch")
    try:
        session = adapter.speak(session_id, body.text, body.avatarProfileId)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Session not found") from exc
    except RuntimeError as exc:
        logger.exception("A2F speak failed for %s", session_id)
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"ok": True, "session": session.model_dump()}


@app.post("/sessions/{session_id}/close")
async def close_session(session_id: str, body: CloseSessionBody) -> dict[str, object]:
    if session_id != body.sessionId:
        raise HTTPException(status_code=400, detail="Session id mismatch")
    try:
        adapter.close_session(session_id)
    except RuntimeError as exc:
        logger.exception("A2F close failed for %s", session_id)
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"ok": True, "sessionId": session_id}
