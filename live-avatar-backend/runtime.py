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

    def _has_active_a2f_motion(self, now: float) -> bool:
        return bool(self._a2f_frames) and now <= (self._a2f_started_at + self._a2f_duration_seconds)

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

        image_h, image_w = image.shape[:2]
        center_x = 256
        center_y = 360
        face_half_width = 210
        face_half_height = 180
        mouth_half_width = 118
        mouth_half_height = 62

        grid_x, grid_y = np.meshgrid(
            np.arange(image_w, dtype=np.float32),
            np.arange(image_h, dtype=np.float32),
        )
        dx = (grid_x - center_x) / float(face_half_width)
        dy = (grid_y - center_y) / float(face_half_height)
        radial = dx * dx + dy * dy
        face_mask = np.clip(1.0 - radial, 0.0, 1.0)
        lower_face_mask = face_mask * np.clip((grid_y - (center_y - 54)) / 210.0, 0.0, 1.0)

        mouth_dx = (grid_x - center_x) / float(mouth_half_width)
        mouth_dy = (grid_y - center_y) / float(mouth_half_height)
        mouth_radial = mouth_dx * mouth_dx + mouth_dy * mouth_dy
        mouth_mask = np.clip(1.0 - mouth_radial, 0.0, 1.0)
        inner_mouth_mask = np.clip(1.0 - (mouth_dx * mouth_dx + (mouth_dy * 1.35) * (mouth_dy * 1.35)), 0.0, 1.0)

        warp_x = grid_x.copy()
        warp_y = grid_y.copy()
        jaw_drop = mouth_open * 14.0 * lower_face_mask
        upper_pull = mouth_open * 5.0 * mouth_mask * np.clip((center_y - grid_y) / 75.0, 0.0, 1.0)
        cheek_pull = mouth_open * 4.0 * dx * lower_face_mask
        lip_spread = mouth_open * 6.0 * mouth_dx * mouth_mask
        lip_open = mouth_open * 16.0 * np.sign(mouth_dy) * np.power(np.abs(mouth_dy), 0.8) * mouth_mask

        warp_y += jaw_drop - upper_pull + lip_open
        warp_x += cheek_pull + lip_spread

        result = cv2.remap(
            image,
            warp_x,
            warp_y,
            interpolation=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_REFLECT_101,
        )

        # Remove the synthetic violet mouth cavity and use only a subtle natural shadow.
        mouth_shadow = np.clip(0.08 + mouth_open * 0.12, 0.0, 0.22)
        shadow_mask = (inner_mouth_mask * mouth_shadow)[..., None]
        shadow_tint = np.full_like(result, (18, 18, 24), dtype=np.uint8)
        result = np.clip(
            result.astype(np.float32) * (1.0 - shadow_mask)
            + shadow_tint.astype(np.float32) * shadow_mask,
            0,
            255,
        ).astype(np.uint8)

        return result

    def _render_avatar(self, now: float, mouth_open: float) -> np.ndarray:
        speaking = mouth_open > 0.02
        if self.source_frame is None:
            return self._render_placeholder(now, mouth_open)

        has_a2f_motion = self._has_active_a2f_motion(now)

        scale = 1.0 if has_a2f_motion else 1.04 + 0.02 * np.sin(now * 0.7)
        if speaking and not has_a2f_motion:
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
        if has_a2f_motion:
            offset_x = max_x // 2
            offset_y = max_y // 2
        else:
            offset_x = max_x // 2 + int(np.sin(now * 0.5) * min(max_x, 24) * 0.35)
            offset_y = max_y // 2 + int(np.cos(now * 0.4) * min(max_y, 24) * 0.2)
        offset_x = max(0, min(offset_x, max_x))
        offset_y = max(0, min(offset_y, max_y))
        image = scaled[offset_y : offset_y + 512, offset_x : offset_x + 512].copy()

        if speaking and not has_a2f_motion:
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
