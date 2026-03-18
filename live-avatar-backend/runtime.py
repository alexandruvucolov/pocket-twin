from __future__ import annotations

import base64
import json
import os
import time
from pathlib import Path
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
        self._a2f_started_at = 0.0
        self._a2f_duration_seconds = 0.0
        self._a2f_frames: list[tuple[float, float]] = []

    def set_text(self, text: str) -> None:
        self.label = (text or "live").strip()[:120]
        self._speech_until = time.monotonic() + 4.0

    def load_a2f_motion(self, output_dir: str | None) -> bool:
        if not output_dir:
            return False

        motion_path = Path(output_dir) / "a2f-motion.json"
        if not motion_path.exists():
            return False

        payload = json.loads(motion_path.read_text(encoding="utf-8"))
        frames = payload.get("frames") if isinstance(payload, dict) else None
        if not isinstance(frames, list) or not frames:
            return False

        raw_timeline: list[tuple[float, float]] = []
        for frame in frames:
            if not isinstance(frame, dict):
                continue
            time_ms = frame.get("timeMs")
            if not isinstance(time_ms, (int, float)):
                continue

            jaw_transform = frame.get("jawTransform")
            jaw_values = (
                [float(value) for value in jaw_transform]
                if isinstance(jaw_transform, list)
                else []
            )
            if len(jaw_values) >= 15:
                raw_open = abs(jaw_values[14]) + abs(jaw_values[13]) * 0.35
            else:
                mouth_open = frame.get("mouthOpen")
                if not isinstance(mouth_open, (int, float)):
                    continue
                raw_open = float(mouth_open)

            raw_timeline.append((max(float(time_ms), 0.0) / 1000.0, raw_open))

        if not raw_timeline:
            return False

        values = [value for _, value in raw_timeline]
        min_value = min(values)
        max_value = max(values)
        value_span = max(max_value - min_value, 1e-6)

        timeline = [
            (timestamp, float(np.clip((value - min_value) / value_span, 0.0, 1.0)))
            for timestamp, value in raw_timeline
        ]

        if not timeline:
            return False

        self._a2f_frames = timeline
        self._a2f_started_at = time.monotonic()
        self._a2f_duration_seconds = timeline[-1][0]
        self._speech_until = self._a2f_started_at + max(self._a2f_duration_seconds, 0.25)
        return True

    def _current_mouth_open(self, now: float) -> float:
        if self._a2f_frames:
            elapsed = max(now - self._a2f_started_at, 0.0)
            if elapsed <= self._a2f_duration_seconds:
                previous_time, previous_value = self._a2f_frames[0]
                for current_time, current_value in self._a2f_frames[1:]:
                    if elapsed <= current_time:
                        span = max(current_time - previous_time, 1e-6)
                        ratio = min(max((elapsed - previous_time) / span, 0.0), 1.0)
                        return previous_value + (current_value - previous_value) * ratio
                    previous_time, previous_value = current_time, current_value
                return self._a2f_frames[-1][1]

            self._a2f_frames = []

        if now < self._speech_until:
            return 0.3 + max(0.0, np.sin(now * 12.0)) * 0.6

        return 0.0

    def _render_placeholder(self, now: float, mouth_open: float) -> np.ndarray:
        speaking = mouth_open > 0.02
        image = np.zeros((512, 512, 3), dtype=np.uint8)

        if speaking:
            pulse = int((np.sin(now * 10) + 1) * 100)
            image[:, :] = (255, 40 + pulse, 40)
        else:
            image[:, :] = (40, 120, 220)

        bar_x = int((now * 220) % 380)
        image[:, bar_x : bar_x + 120] = (255, 255, 255)
        image[180:330, 156:356] = (20, 20, 20)

        mouth_h = 24 + int(mouth_open * 110)
        top = 330 - mouth_h // 2
        image[top : top + mouth_h, 176:336] = (255, 0, 0)
        return image

    def _apply_mouth_warp(self, image: np.ndarray, mouth_open: float) -> np.ndarray:
        if mouth_open <= 0.01:
            return image

        result = image.copy()
        center_x = 256
        center_y = 360
        half_width = 84
        half_height = 30

        x1 = max(center_x - half_width, 0)
        x2 = min(center_x + half_width, image.shape[1])
        y1 = max(center_y - half_height, 0)
        y2 = min(center_y + half_height, image.shape[0])
        roi = image[y1:y2, x1:x2].copy()
        if roi.size == 0:
            return result

        roi_h, roi_w = roi.shape[:2]
        lip_band = max(6, roi_h // 5)
        top_lip = roi[:lip_band].copy()
        bottom_lip = roi[-lip_band:].copy()

        gap = int(6 + mouth_open * 26)
        inner_top = min(lip_band + gap, roi_h)
        inner_bottom = max(roi_h - lip_band - gap, 0)

        roi[:] = cv2.GaussianBlur(roi, (0, 0), 1.1)

        top_start = max((inner_top - lip_band) // 2, 0)
        top_end = min(top_start + lip_band, roi_h)
        bottom_start = max(inner_bottom + (roi_h - inner_bottom - lip_band) // 2, 0)
        bottom_end = min(bottom_start + lip_band, roi_h)

        roi[top_start:top_end] = cv2.addWeighted(
            roi[top_start:top_end],
            0.18,
            top_lip[: top_end - top_start],
            0.82,
            0,
        )
        roi[bottom_start:bottom_end] = cv2.addWeighted(
            roi[bottom_start:bottom_end],
            0.18,
            bottom_lip[: bottom_end - bottom_start],
            0.82,
            0,
        )

        cavity_top = min(top_end, roi_h)
        cavity_bottom = max(bottom_start, cavity_top)
        if cavity_bottom > cavity_top:
            cavity_h = cavity_bottom - cavity_top
            gradient = np.linspace(0.25, 1.0, cavity_h, dtype=np.float32)[:, None]
            cavity = np.zeros((cavity_h, roi_w, 3), dtype=np.float32)
            cavity[..., 0] = 16 + 30 * gradient
            cavity[..., 1] = 10 + 10 * gradient
            cavity[..., 2] = 30 + 45 * gradient
            existing = roi[cavity_top:cavity_bottom].astype(np.float32)
            alpha = 0.55 + mouth_open * 0.25
            roi[cavity_top:cavity_bottom] = np.clip(
                existing * (1.0 - alpha) + cavity * alpha,
                0,
                255,
            ).astype(np.uint8)

            tooth_h = max(2, int(cavity_h * 0.18))
            tooth_y = cavity_top + max(1, int(cavity_h * 0.08))
            tooth_margin = max(10, roi_w // 6)
            roi[tooth_y:tooth_y + tooth_h, tooth_margin:roi_w - tooth_margin] = cv2.addWeighted(
                roi[tooth_y:tooth_y + tooth_h, tooth_margin:roi_w - tooth_margin],
                0.25,
                np.full((tooth_h, roi_w - 2 * tooth_margin, 3), 230, dtype=np.uint8),
                0.75,
                0,
            )

        lip_shadow = result.copy()
        shadow_alpha = 0.08 + mouth_open * 0.1
        cv2.ellipse(
            lip_shadow,
            (center_x, center_y),
            (half_width - 6, max(10, int(10 + mouth_open * 8))),
            0,
            0,
            360,
            (20, 20, 40),
            2,
        )
        cv2.addWeighted(lip_shadow, shadow_alpha, result, 1.0 - shadow_alpha, 0, result)

        result[y1:y2, x1:x2] = roi
        return result

    def _render_avatar(self, now: float, mouth_open: float) -> np.ndarray:
        speaking = mouth_open > 0.02
        if self.source_frame is None:
            return self._render_placeholder(now, mouth_open)

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

        if speaking:
            highlight = image.copy()
            cv2.circle(highlight, (256, 356), 72, (90, 90, 180), -1)
            cv2.addWeighted(highlight, 0.08, image, 0.92, 0, image)

        return self._apply_mouth_warp(image, mouth_open)

    async def recv(self) -> av.VideoFrame:
        pts, time_base = await self.next_timestamp()
        now = time.monotonic()
        mouth_open = self._current_mouth_open(now)
        image = self._render_avatar(now, mouth_open)

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

    def load_a2f_motion(self, output_dir: str | None) -> bool:
        return False

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
