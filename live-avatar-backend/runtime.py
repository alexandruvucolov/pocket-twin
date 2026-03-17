from __future__ import annotations

import time

import av
import numpy as np
from aiortc import RTCPeerConnection, VideoStreamTrack
from fastapi import HTTPException


class PlaceholderTrack(VideoStreamTrack):
    def __init__(self, label: str):
        super().__init__()
        self.label = label
        self._speech_until = 0.0

    def set_text(self, text: str) -> None:
        self.label = (text or "live").strip()[:120]
        self._speech_until = time.monotonic() + 4.0

    async def recv(self) -> av.VideoFrame:
        pts, time_base = await self.next_timestamp()
        now = time.monotonic()
        speaking = now < self._speech_until
        image = np.zeros((512, 512, 3), dtype=np.uint8)

        if speaking:
            pulse = int((np.sin(now * 10) + 1) * 100)
            image[:, :] = (255, 40 + pulse, 40)
        else:
            image[:, :] = (40, 120, 220)

        bar_x = int((now * 220) % 380)
        image[:, bar_x : bar_x + 120] = (255, 255, 255)
        image[180:330, 156:356] = (20, 20, 20)

        mouth_h = 30
        if speaking:
            mouth_h = 60 + int((np.sin(now * 12) + 1) * 50)
        top = 330 - mouth_h // 2
        image[top : top + mouth_h, 176:336] = (255, 0, 0)

        frame = av.VideoFrame.from_ndarray(image, format="rgb24")
        frame.pts = pts
        frame.time_base = time_base
        return frame


SESSIONS: dict[str, tuple[RTCPeerConnection, PlaceholderTrack]] = {}


def get_session(session_id: str) -> tuple[RTCPeerConnection, PlaceholderTrack]:
    session = SESSIONS.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


async def close_session(session_id: str) -> None:
    session = SESSIONS.pop(session_id, None)
    if session:
        await session[0].close()
