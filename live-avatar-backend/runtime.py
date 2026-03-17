from __future__ import annotations

import base64
import os
import time
from urllib.request import urlopen

import av
import cv2
import numpy as np
from aiortc import RTCPeerConnection, VideoStreamTrack
from fastapi import HTTPException


def load_source_frame(
    source_image_url: str | None = None,
    source_image_base64: str | None = None,
) -> np.ndarray | None:
    payload: bytes | None = None

    if source_image_base64:
        payload = base64.b64decode(source_image_base64)
    elif source_image_url:
        with urlopen(source_image_url, timeout=20) as response:
            payload = response.read()

    if not payload:
        return None

    encoded = np.frombuffer(payload, dtype=np.uint8)
    image = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
    if image is None:
        return None

    height, width = image.shape[:2]
    side = min(height, width)
    offset_x = max((width - side) // 2, 0)
    offset_y = max((height - side) // 2, 0)
    cropped = image[offset_y : offset_y + side, offset_x : offset_x + side]
    return cv2.resize(cropped, (512, 512), interpolation=cv2.INTER_AREA)


class PlaceholderTrack(VideoStreamTrack):
    def __init__(self, label: str, source_frame: np.ndarray | None = None):
        super().__init__()
        self.label = label
        self.source_frame = source_frame
        self._speech_until = 0.0

    def set_text(self, text: str) -> None:
        self.label = (text or "live").strip()[:120]
        self._speech_until = time.monotonic() + 4.0

    def _render_placeholder(self, now: float, speaking: bool) -> np.ndarray:
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
        return image

    def _render_avatar(self, now: float, speaking: bool) -> np.ndarray:
        if self.source_frame is None:
            return self._render_placeholder(now, speaking)

        scale = 1.04 + 0.02 * np.sin(now * 0.7)
        if speaking:
            scale += 0.015 * np.sin(now * 5.5)

        scaled = cv2.resize(
            self.source_frame,
            None,
            fx=scale,
            fy=scale,
            interpolation=cv2.INTER_LINEAR,
        )
        scaled_h, scaled_w = scaled.shape[:2]
        max_x = max(scaled_w - 512, 0)
        max_y = max(scaled_h - 512, 0)
        offset_x = max_x // 2 + int(np.sin(now * 0.5) * min(max_x, 24) * 0.35)
        offset_y = max_y // 2 + int(np.cos(now * 0.4) * min(max_y, 24) * 0.2)
        offset_x = max(0, min(offset_x, max_x))
        offset_y = max(0, min(offset_y, max_y))
        image = scaled[offset_y : offset_y + 512, offset_x : offset_x + 512].copy()

        overlay = image.copy()
        mouth_center = (256, 360)
        mouth_width = 116
        mouth_height = 14
        mouth_alpha = 0.18
        if speaking:
            mouth_height = 24 + int((np.sin(now * 12.0) + 1) * 18)
            mouth_alpha = 0.28

        cv2.ellipse(
            overlay,
            mouth_center,
            (mouth_width // 2, max(mouth_height // 2, 8)),
            0,
            0,
            360,
            (30, 30, 120),
            -1,
        )
        cv2.addWeighted(overlay, mouth_alpha, image, 1 - mouth_alpha, 0, image)

        if speaking:
            highlight = image.copy()
            cv2.circle(highlight, (256, 356), 72, (90, 90, 180), -1)
            cv2.addWeighted(highlight, 0.08, image, 0.92, 0, image)

        return image

    async def recv(self) -> av.VideoFrame:
        pts, time_base = await self.next_timestamp()
        now = time.monotonic()
        speaking = now < self._speech_until
        image = self._render_avatar(now, speaking)

        frame = av.VideoFrame.from_ndarray(
            cv2.cvtColor(image, cv2.COLOR_BGR2RGB),
            format="rgb24",
        )
        frame.pts = pts
        frame.time_base = time_base
        return frame


class LoopingVideoTrack(VideoStreamTrack):
    def __init__(self, video_path: str):
        super().__init__()
        self.video_path = video_path
        self.capture = cv2.VideoCapture(video_path)
        self.label = "live"

    def set_text(self, text: str) -> None:
        self.label = (text or "live").strip()[:120]

    def _read_frame(self) -> np.ndarray:
        if not self.capture.isOpened():
            self.capture.open(self.video_path)

        ok, frame = self.capture.read()
        if ok and frame is not None:
            return cv2.resize(frame, (512, 512), interpolation=cv2.INTER_LINEAR)

        self.capture.set(cv2.CAP_PROP_POS_FRAMES, 0)
        ok, frame = self.capture.read()
        if ok and frame is not None:
            return cv2.resize(frame, (512, 512), interpolation=cv2.INTER_LINEAR)

        return np.zeros((512, 512, 3), dtype=np.uint8)

    async def recv(self) -> av.VideoFrame:
        pts, time_base = await self.next_timestamp()
        image = self._read_frame()
        frame = av.VideoFrame.from_ndarray(
            cv2.cvtColor(image, cv2.COLOR_BGR2RGB),
            format="rgb24",
        )
        frame.pts = pts
        frame.time_base = time_base
        return frame

    def cleanup(self) -> None:
        try:
            self.capture.release()
        except Exception:
            pass
        try:
            os.remove(self.video_path)
        except Exception:
            pass


SESSIONS: dict[str, tuple[RTCPeerConnection, PlaceholderTrack | LoopingVideoTrack]] = {}


def get_session(
    session_id: str,
) -> tuple[RTCPeerConnection, PlaceholderTrack | LoopingVideoTrack]:
    session = SESSIONS.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


async def close_session(session_id: str) -> None:
    session = SESSIONS.pop(session_id, None)
    if session:
        cleanup = getattr(session[1], "cleanup", None)
        if callable(cleanup):
            cleanup()
        await session[0].close()
