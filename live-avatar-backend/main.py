from __future__ import annotations

import asyncio
import json
import logging
import os
import ssl
import tempfile
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from uuid import uuid4

from aiortc import (
    RTCConfiguration,
    RTCIceServer,
    RTCPeerConnection,
    RTCSessionDescription,
)
from aiortc.sdp import candidate_from_sdp
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from audio2face import Audio2FaceClient
from dotenv import load_dotenv
from runtime import LoopingVideoTrack, PlaceholderTrack, SESSIONS, close_session, get_session, load_source_frame
from schemas import AnswerBody, CreateSessionBody, IceBody, SpeakBody


load_dotenv()
logger = logging.getLogger(__name__)
A2F_CLIENT = Audio2FaceClient()
PENDING_ICE_CANDIDATES: dict[
    str,
    list[dict[str, str | int | None]],
] = {}


def _split_urls(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def _serialize_url_value(value: Any) -> str | list[str]:
    if isinstance(value, list):
        return [str(item) for item in value if str(item).strip()]
    return str(value)


def _to_rtc_ice_server(value: dict[str, Any]) -> RTCIceServer:
    return RTCIceServer(
        urls=_serialize_url_value(value.get("urls") or []),
        username=str(value.get("username") or "").strip() or None,
        credential=str(value.get("credential") or "").strip() or None,
    )


def _load_explicit_ice_servers() -> list[RTCIceServer]:
    raw_value = os.getenv("LIVE_AVATAR_ICE_SERVERS_JSON", "").strip()
    if not raw_value:
        return []

    payload = json.loads(raw_value)
    if not isinstance(payload, list):
        raise RuntimeError("LIVE_AVATAR_ICE_SERVERS_JSON must be a JSON array")

    return [_to_rtc_ice_server(item) for item in payload if isinstance(item, dict)]


def _pick_string(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _extract_video_url(value: Any) -> str | None:
    if not isinstance(value, dict):
        return None

    direct = (
        _pick_string(value.get("video_url"))
        or _pick_string(value.get("videoUrl"))
        or _pick_string(value.get("result_url"))
        or _pick_string(value.get("resultUrl"))
        or _pick_string(value.get("url"))
        or _pick_string(value.get("mp4_url"))
        or _pick_string(value.get("mp4Url"))
    )
    if direct:
        return direct

    for nested_key in ("output", "result", "data"):
        nested = _extract_video_url(value.get(nested_key))
        if nested:
            return nested

    return None


def _get_runpod_config() -> tuple[str, str, str | None] | None:
    api_key = os.getenv("LIVE_AVATAR_RUNPOD_API_KEY", "").strip()
    endpoint_id = os.getenv("LIVE_AVATAR_RUNPOD_LIVEPORTRAIT_ENDPOINT_ID", "").strip()
    base_url = os.getenv("LIVE_AVATAR_RUNPOD_BASE_URL", "https://api.runpod.ai/v2").strip()
    driving_video_url = os.getenv("LIVE_AVATAR_DRIVING_VIDEO_URL", "").strip() or None
    if not api_key or not endpoint_id:
        return None
    return api_key, f"{base_url.rstrip('/')}/{endpoint_id}", driving_video_url


def _submit_runpod_job(source_image_url: str, driving_video_url: str | None) -> str:
    config = _get_runpod_config()
    if not config:
        raise RuntimeError("Runpod LivePortrait is not configured")

    api_key, endpoint_url, default_driving_video_url = config
    payload = {
        "input": {
            "source_image_url": source_image_url,
            "output_format": "mp4",
            **(
                {"driving_video_url": driving_video_url or default_driving_video_url}
                if (driving_video_url or default_driving_video_url)
                else {}
            ),
        }
    }
    request = Request(
        f"{endpoint_url}/run",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "accept": "application/json",
        },
        method="POST",
    )
    with urlopen(request, timeout=30) as response:
        body = json.loads(response.read().decode("utf-8"))

    job_id = _pick_string(body.get("id")) if isinstance(body, dict) else None
    if not job_id:
        raise RuntimeError(f"Runpod job submission failed: {body}")
    return job_id


def _wait_for_runpod_video(job_id: str) -> str:
    config = _get_runpod_config()
    if not config:
        raise RuntimeError("Runpod LivePortrait is not configured")

    api_key, endpoint_url, _ = config
    for _attempt in range(90):
        request = Request(
            f"{endpoint_url}/status/{job_id}",
            headers={
                "Authorization": f"Bearer {api_key}",
                "accept": "application/json",
            },
            method="GET",
        )
        with urlopen(request, timeout=30) as response:
            body = json.loads(response.read().decode("utf-8"))

        status = _pick_string(body.get("status")) if isinstance(body, dict) else None
        if status == "COMPLETED":
            video_url = _extract_video_url(body)
            if video_url:
                return video_url
            raise RuntimeError(f"Runpod job completed without video_url: {body}")
        if status in {"FAILED", "CANCELLED", "TIMED_OUT"}:
            raise RuntimeError(f"Runpod job {status.lower()}: {body}")
        time.sleep(2)

    raise RuntimeError("Runpod LivePortrait job timed out")


def _download_video_to_tempfile(video_url: str) -> str:
    with urlopen(video_url, timeout=60) as response:
        payload = response.read()

    with tempfile.NamedTemporaryFile(delete=False, suffix=".mp4") as temp_file:
        temp_file.write(payload)
        return temp_file.name


def _prepare_liveportrait_video(source_image_url: str) -> str:
    config = _get_runpod_config()
    if not config:
        raise RuntimeError("Runpod LivePortrait is not configured")
    _api_key, _endpoint_url, driving_video_url = config
    job_id = _submit_runpod_job(source_image_url, driving_video_url)
    video_url = _wait_for_runpod_video(job_id)
    return _download_video_to_tempfile(video_url)


def _fetch_metered_ice_servers_sync() -> list[RTCIceServer]:
    domain = os.getenv("LIVE_AVATAR_METERED_DOMAIN", "").strip()
    api_key = os.getenv("LIVE_AVATAR_METERED_API_KEY", "").strip()
    region = os.getenv("LIVE_AVATAR_METERED_REGION", "").strip()
    api_base_url = os.getenv("LIVE_AVATAR_METERED_API_BASE_URL", "").strip()
    allow_insecure_tls = os.getenv("LIVE_AVATAR_METERED_INSECURE_TLS", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    if not domain or not api_key:
        return []

    query = {"apiKey": api_key}
    if region:
        query["region"] = region

    base_url = api_base_url.rstrip("/") or f"https://{domain}"
    url = f"{base_url}/api/v1/turn/credentials?{urlencode(query)}"
    ssl_context = ssl._create_unverified_context() if allow_insecure_tls else None
    with urlopen(url, timeout=15, context=ssl_context) as response:
        payload = json.loads(response.read().decode("utf-8"))

    if not isinstance(payload, list):
        logger.warning("Metered TURN credentials response was invalid: %s", payload)
        return []

    return [_to_rtc_ice_server(item) for item in payload if isinstance(item, dict)]


async def get_ice_servers() -> list[RTCIceServer]:
    try:
        explicit_ice_servers = _load_explicit_ice_servers()
        if explicit_ice_servers:
            return explicit_ice_servers
    except Exception:
        logger.exception("Failed to parse LIVE_AVATAR_ICE_SERVERS_JSON")

    try:
        metered_servers = await asyncio.to_thread(_fetch_metered_ice_servers_sync)
        if metered_servers:
            return metered_servers
    except Exception:
        logger.exception("Failed to fetch Metered TURN credentials; falling back to default ICE servers")

    stun_urls = _split_urls(
        os.getenv(
            "LIVE_AVATAR_STUN_URLS",
            "stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302",
        )
    )
    ice_servers: list[RTCIceServer] = []

    if stun_urls:
        ice_servers.append(RTCIceServer(urls=stun_urls))

    turn_urls = _split_urls(os.getenv("LIVE_AVATAR_TURN_URLS", ""))
    turn_username = os.getenv("LIVE_AVATAR_TURN_USERNAME", "").strip()
    turn_credential = os.getenv("LIVE_AVATAR_TURN_CREDENTIAL", "").strip()
    if turn_urls and turn_username and turn_credential:
        ice_servers.append(
            RTCIceServer(
                urls=turn_urls,
                username=turn_username,
                credential=turn_credential,
            )
        )

    return ice_servers


def serialize_ice_servers(ice_servers: list[RTCIceServer]) -> list[dict[str, Any]]:
    serialized: list[dict[str, Any]] = []
    for server in ice_servers:
        item: dict[str, Any] = {"urls": server.urls}
        if server.username:
            item["username"] = server.username
        if server.credential:
            item["credential"] = server.credential
        serialized.append(item)
    return serialized


async def _wait_for_ice_gathering_complete(
    pc: RTCPeerConnection,
    timeout: float = 8.0,
) -> None:
    if pc.iceGatheringState == "complete":
        return

    completed = asyncio.Event()

    @pc.on("icegatheringstatechange")
    async def on_ice_gathering_state_change() -> None:
        if pc.iceGatheringState == "complete":
            completed.set()

    try:
        await asyncio.wait_for(completed.wait(), timeout=timeout)
    except TimeoutError:
        logger.warning(
            "Timed out waiting for ICE gathering to complete; returning best-effort offer"
        )


async def _add_ice_candidate(
    pc: RTCPeerConnection,
    payload: dict[str, str | int | None],
) -> None:
    candidate_value = payload.get("candidate")
    if not candidate_value:
        return

    candidate = candidate_from_sdp(str(candidate_value).replace("candidate:", "", 1))
    candidate.sdpMid = (
        str(payload.get("sdpMid")) if payload.get("sdpMid") is not None else None
    )
    candidate.sdpMLineIndex = (
        int(payload["sdpMLineIndex"])
        if payload.get("sdpMLineIndex") is not None
        else None
    )
    await pc.addIceCandidate(candidate)

app = FastAPI(title="Pocket Twin Live Avatar Backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, bool]:
    return {"ok": True}


@app.post("/api/live-avatar/sessions")
async def create_session(body: CreateSessionBody) -> dict[str, Any]:
    session_id = f"session_{uuid4().hex}"
    ice_servers = await get_ice_servers()
    pc = RTCPeerConnection(RTCConfiguration(iceServers=ice_servers))
    source_frame = None
    try:
        source_frame = await asyncio.to_thread(
            load_source_frame,
            body.sourceImageUrl,
            body.sourceImageBase64,
        )
    except Exception:
        logger.exception("Failed to load avatar source image for session %s", session_id)

    track: PlaceholderTrack | LoopingVideoTrack
    if body.sourceImageUrl and _get_runpod_config():
        try:
            liveportrait_video_path = await asyncio.to_thread(
                _prepare_liveportrait_video,
                body.sourceImageUrl,
            )
            track = LoopingVideoTrack(liveportrait_video_path)
        except Exception:
            logger.exception(
                "Failed to prepare LivePortrait video for session %s; falling back to image animation",
                session_id,
            )
            track = PlaceholderTrack(body.avatarName, source_frame=source_frame)
    else:
        track = PlaceholderTrack(body.avatarName, source_frame=source_frame)
    pc.addTrack(track)
    SESSIONS[session_id] = (pc, track)
    PENDING_ICE_CANDIDATES[session_id] = []

    if A2F_CLIENT.is_configured:
        try:
            await asyncio.to_thread(
                A2F_CLIENT.notify_session_started,
                session_id,
                body.model_dump(),
            )
        except Exception:
            logger.exception("Audio2Face session bootstrap failed for %s", session_id)

    offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    await _wait_for_ice_gathering_complete(pc)
    local = pc.localDescription
    if not local:
        raise HTTPException(status_code=500, detail="Failed to create offer")

    return {
        "sessionId": session_id,
        "offer": {"type": local.type, "sdp": local.sdp},
        "iceServers": serialize_ice_servers(ice_servers),
    }


@app.post("/api/live-avatar/sessions/{session_id}/answer")
async def submit_answer(session_id: str, body: AnswerBody) -> dict[str, bool | str]:
    pc, _ = get_session(session_id)
    answer_type = str(body.answer.get("type") or "")
    answer_sdp = str(body.answer.get("sdp") or "")
    if not answer_type or not answer_sdp:
        raise HTTPException(status_code=400, detail="Answer SDP is missing")
    await pc.setRemoteDescription(RTCSessionDescription(answer_sdp, answer_type))

    pending = PENDING_ICE_CANDIDATES.get(session_id, [])
    while pending:
        payload = pending.pop(0)
        await _add_ice_candidate(pc, payload)

    return {"ok": True, "sessionId": session_id}


@app.post("/api/live-avatar/sessions/{session_id}/ice")
async def submit_ice(session_id: str, body: IceBody) -> dict[str, bool | str]:
    pc, _ = get_session(session_id)
    payload: dict[str, str | int | None] = {
        "candidate": body.candidate,
        "sdpMid": body.sdpMid,
        "sdpMLineIndex": body.sdpMLineIndex,
    }

    if pc.remoteDescription is None:
        PENDING_ICE_CANDIDATES.setdefault(session_id, []).append(payload)
        return {"ok": True, "sessionId": session_id, "queued": True}

    try:
        await _add_ice_candidate(pc, payload)
    except Exception as exc:
        logger.exception("Failed to add ICE candidate for session %s", session_id)
        raise HTTPException(status_code=400, detail=f"Invalid ICE candidate: {exc}") from exc

    return {"ok": True, "sessionId": session_id}


@app.post("/api/live-avatar/sessions/{session_id}/speak")
async def speak(session_id: str, body: SpeakBody) -> dict[str, bool | str]:
    _, track = get_session(session_id)
    track.set_text(body.text)

    if A2F_CLIENT.is_configured:
        try:
            await asyncio.to_thread(A2F_CLIENT.speak, session_id, body.text)
        except Exception:
            logger.exception("Audio2Face speak sync failed for %s", session_id)

    return {"ok": True, "sessionId": session_id}


@app.delete("/api/live-avatar/sessions/{session_id}")
async def delete_session(session_id: str) -> dict[str, bool | str]:
    PENDING_ICE_CANDIDATES.pop(session_id, None)

    if A2F_CLIENT.is_configured:
        try:
            await asyncio.to_thread(A2F_CLIENT.close_session, session_id)
        except Exception:
            logger.exception("Audio2Face close sync failed for %s", session_id)

    await close_session(session_id)
    return {"ok": True, "sessionId": session_id}