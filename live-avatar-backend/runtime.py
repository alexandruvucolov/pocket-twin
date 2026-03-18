from __future__ import annotations

import base64
import json
import logging
import os
import random
import time
from pathlib import Path
from urllib.request import urlopen

import av
import cv2
import numpy as np
from aiortc import RTCPeerConnection, VideoStreamTrack
from fastapi import HTTPException

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# MediaPipe Face Mesh – imported lazily so the backend still starts when
# mediapipe is not installed (degrades to the old heuristic warp).
# ---------------------------------------------------------------------------
def _try_import_face_mesh():
    try:
        import mediapipe as mp  # noqa: PLC0415
        return mp.solutions.face_mesh.FaceMesh
    except Exception:
        return None

_FaceMeshCls = _try_import_face_mesh()


# ---------------------------------------------------------------------------
# Lip landmark detection (MediaPipe Face Mesh)
# ---------------------------------------------------------------------------
def _detect_lip_data(image: np.ndarray) -> dict | None:
    """Detect lip geometry from a 512×512 BGR source image.

    Returns a dict with:
        upper_y / upper_x   – centroid of inner-upper-lip landmarks
        lower_y / lower_x   – centroid of inner-lower-lip landmarks
        center_x            – horizontal mid-point between lip corners
        width               – pixel distance between left and right corners
        natural_gap         – resting vertical distance between upper/lower
        mouth_center_x/y    – single centre point (for legacy fallback)

    Returns None if MediaPipe is unavailable or no face was detected.
    """
    if _FaceMeshCls is None:
        return None

    try:
        face_mesh = _FaceMeshCls(
            static_image_mode=True,
            max_num_faces=1,
            refine_landmarks=True,
            min_detection_confidence=0.3,
        )
        rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        result = face_mesh.process(rgb)
        face_mesh.close()

        if not result.multi_face_landmarks:
            return None

        h, w = image.shape[:2]
        lm = result.multi_face_landmarks[0].landmark

        def px(idx: int) -> tuple[float, float]:
            return lm[idx].x * w, lm[idx].y * h

        # MediaPipe Face Mesh inner-lip landmark indices
        #   upper inner: 78 191 80 81 82 13 312 311 310 415 308
        #   lower inner: 78  95 88 178 87 14 317 402 318 324 308
        upper_inner_idx = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308]
        lower_inner_idx = [78,  95, 88, 178, 87, 14, 317, 402, 318, 324, 308]
        left_corner_idx  = 61
        right_corner_idx = 291

        n_lm = len(lm)
        upper_pts = [px(i) for i in upper_inner_idx if i < n_lm]
        lower_pts = [px(i) for i in lower_inner_idx if i < n_lm]

        if not upper_pts or not lower_pts:
            return None

        upper_x = float(np.mean([p[0] for p in upper_pts]))
        upper_y = float(np.mean([p[1] for p in upper_pts]))
        lower_x = float(np.mean([p[0] for p in lower_pts]))
        lower_y = float(np.mean([p[1] for p in lower_pts]))

        left_corner  = px(left_corner_idx)  if left_corner_idx  < n_lm else (0.0, (upper_y + lower_y) / 2)
        right_corner = px(right_corner_idx) if right_corner_idx < n_lm else (float(w), (upper_y + lower_y) / 2)

        center_x    = (left_corner[0] + right_corner[0]) / 2.0
        lip_width   = max(float(right_corner[0] - left_corner[0]), 20.0)
        natural_gap = max(lower_y - upper_y, 2.0)

        # Eye positions for blink animation
        # Left eye: top=159, bottom=145, outer=33, inner=133
        # Right eye: top=386, bottom=374, outer=263, inner=362
        def _eye_rect(top_i: int, bot_i: int, outer_i: int, inner_i: int) -> dict | None:
            if any(i >= n_lm for i in [top_i, bot_i, outer_i, inner_i]):
                return None
            tx, ty = px(top_i)
            bx, by = px(bot_i)
            ox, oy = px(outer_i)
            ix, iy = px(inner_i)
            ecx = (ox + ix) / 2.0
            ecy = (ty + by) / 2.0
            return {
                "cx": ecx, "cy": ecy,
                "half_h": max((by - ty) / 2.0, 3.0),
                "half_w": max(abs(ox - ix) / 2.0, 8.0),
                "top_y": ty,
            }

        return {
            "upper_x": upper_x,
            "upper_y": upper_y,
            "lower_x": lower_x,
            "lower_y": lower_y,
            "center_x": center_x,
            "width": lip_width,
            "natural_gap": natural_gap,
            "mouth_center_x": int(center_x),
            "mouth_center_y": int((upper_y + lower_y) / 2.0),
            "left_eye":  _eye_rect(159, 145,  33, 133),
            "right_eye": _eye_rect(386, 374, 263, 362),
        }
    except Exception as exc:
        logger.debug("_detect_lip_data failed: %s", exc)
        return None



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
        # Lip geometry detected from source image ----------------------------
        self._lip_data: dict | None = None          # MediaPipe path (preferred)
        self._mouth_center_x = 256                  # fallback centre (legacy)
        self._mouth_center_y = 360
        if source_frame is not None:
            self._lip_data = _detect_lip_data(source_frame)
            if self._lip_data is not None:
                self._mouth_center_x = self._lip_data["mouth_center_x"]
                self._mouth_center_y = self._lip_data["mouth_center_y"]
                logger.info(
                    "Lip landmarks detected: center=(%.0f, %.0f) width=%.0f natural_gap=%.1fpx",
                    self._lip_data["center_x"],
                    (self._lip_data["upper_y"] + self._lip_data["lower_y"]) / 2,
                    self._lip_data["width"],
                    self._lip_data["natural_gap"],
                )
            else:
                logger.warning("MediaPipe could not detect a face – using edge-based mouth-centre fallback.")
                self._mouth_center_x, self._mouth_center_y = self._detect_mouth_center(source_frame)
        # Motion state -------------------------------------------------------
        self._speech_until = 0.0
        self._a2f_started_at = 0.0
        self._a2f_duration_seconds = 0.0
        self._a2f_frames: list[tuple[float, float]] = []
        # Blink state --------------------------------------------------------
        self._next_blink_at: float = 0.0   # 0 = not yet initialised
        self._blink_start: float = -1.0    # -1 = not currently blinking

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
        # Use the 95th-percentile as the ceiling so loud frames hit 1.0
        # while quieter ones still produce visible movement (not compressed to 0).
        p95 = float(np.percentile(values, 95))
        value_span = max(p95 - min_value, (max(values) - min_value) * 0.15, 1e-6)

        timeline = [
            # Power curve < 1 gives a concave shape: small jaw movements map
            # to a larger fraction of the visible range, improving sync feel.
            (timestamp, float(np.clip(((value - min_value) / value_span) ** 0.70, 0.0, 1.0)))
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
            # Slightly faster sine + higher base so fallback animation is
            # more visually in-step with typical speech cadence.
            return 0.35 + max(0.0, np.sin(now * 15.0)) * 0.65

        return 0.0

    def _detect_mouth_center(self, image: np.ndarray) -> tuple[int, int]:
        image_h, image_w = image.shape[:2]
        search_y1 = int(image_h * 0.52)
        search_y2 = int(image_h * 0.88)
        search_x1 = int(image_w * 0.18)
        search_x2 = int(image_w * 0.82)
        roi = image[search_y1:search_y2, search_x1:search_x2]
        if roi.size == 0:
            return 256, 360

        gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
        sobel_y = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
        edge_strength = cv2.GaussianBlur(np.abs(sobel_y), (0, 0), 1.2)

        roi_float = roi.astype(np.float32)
        b = roi_float[..., 0]
        g = roi_float[..., 1]
        r = roi_float[..., 2]
        redness = np.clip(r - 0.55 * g - 0.35 * b, 0.0, None)
        darkness = np.clip(150.0 - gray.astype(np.float32), 0.0, None)

        yy, xx = np.mgrid[0:roi.shape[0], 0:roi.shape[1]]
        cx = roi.shape[1] / 2.0
        center_weight = np.exp(-((xx - cx) ** 2) / (2.0 * (roi.shape[1] * 0.22) ** 2))
        lower_weight = np.clip((yy / max(roi.shape[0] - 1, 1) - 0.18) / 0.82, 0.0, 1.0)

        score = (edge_strength * 0.55 + redness * 0.30 + darkness * 0.15) * center_weight * lower_weight
        max_score = float(score.max()) if score.size else 0.0
        if max_score <= 1e-6:
            return 256, 360

        mask = score >= (max_score * 0.72)
        if not np.any(mask):
            peak_index = np.unravel_index(int(np.argmax(score)), score.shape)
            mouth_y, mouth_x = peak_index
        else:
            weights = score[mask]
            mouth_y = int(np.average(yy[mask], weights=weights))
            mouth_x = int(np.average(xx[mask], weights=weights))

        return search_x1 + mouth_x, search_y1 + mouth_y

    def _blink_amount(self, now: float) -> float:
        """Return 0.0 (open) → 1.0 (closed) following a natural blink schedule."""
        if self._next_blink_at == 0.0:
            self._next_blink_at = now + random.uniform(1.5, 3.5)
        # Start a new blink when due
        if self._blink_start < 0.0 and now >= self._next_blink_at:
            self._blink_start = now
            self._next_blink_at = now + random.uniform(2.5, 6.0)
        if self._blink_start < 0.0:
            return 0.0
        elapsed = now - self._blink_start
        blink_total = 0.15          # full close+open cycle in seconds
        if elapsed >= blink_total:
            self._blink_start = -1.0
            return 0.0
        # Triangle wave: ramp up to 1.0 then back down
        half = blink_total / 2.0
        return 1.0 - abs(elapsed - half) / half

    def _apply_blink(self, image: np.ndarray, blink: float) -> np.ndarray:
        """Overlay upper-eyelid skin over the eye region to simulate a blink."""
        if blink < 0.01 or self._lip_data is None:
            return image
        out = image.copy()
        for eye_key in ("left_eye", "right_eye"):
            eye = self._lip_data.get(eye_key)
            if not eye:
                continue
            cx   = eye["cx"]
            cy   = eye["cy"]
            hh   = eye["half_h"]
            hw   = eye["half_w"]
            x1   = max(int(cx - hw * 1.25), 0)
            x2   = min(int(cx + hw * 1.25), image.shape[1])
            top  = max(int(cy - hh * 1.1), 1)
            bot  = min(int(cy + hh * 1.1), image.shape[0])
            if x1 >= x2 or top >= bot:
                continue
            lid_h = bot - top
            # Sample skin colour from just above the eye (eyelid source)
            skin_y = max(top - 3, 0)
            skin_strip = image[skin_y : skin_y + 1, x1:x2]           # 1 row
            eyelid = np.repeat(skin_strip, lid_h, axis=0)             # stretch
            alpha = float(np.clip(blink * 1.15, 0.0, 1.0))
            region = out[top:bot, x1:x2].astype(np.float32)
            out[top:bot, x1:x2] = np.clip(
                region * (1.0 - alpha) + eyelid.astype(np.float32) * alpha,
                0, 255,
            ).astype(np.uint8)
        return out

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
        """Warp the mouth region to simulate lip movement.

        If MediaPipe detected lip landmarks at session-creation time, uses the
        precise upper/lower lip positions for a clean, natural-looking warp.
        Otherwise falls back to the original heuristic center-based warp.
        """
        if mouth_open <= 0.01:
            return image

        if self._lip_data is not None:
            return self._apply_landmark_warp(image, mouth_open)
        return self._apply_center_warp(image, mouth_open)

    def _apply_landmark_warp(self, image: np.ndarray, mouth_open: float) -> np.ndarray:
        """MediaPipe-guided lip warp: upper lip moves up, lower lip moves down.

        Each lip surface is driven by a Gaussian centred exactly on its landmark
        row — so the lip pixels themselves deform outward, not just the surrounding
        skin.  A small horizontal corner-spread is also applied so the mouth widens
        naturally as it opens.
        """
        ld = self._lip_data  # type: ignore[assignment]
        image_h, image_w = image.shape[:2]

        upper_y: float = ld["upper_y"]
        lower_y: float = ld["lower_y"]
        center_x: float = ld["center_x"]
        lip_width: float = ld["width"]
        natural_gap: float = ld["natural_gap"]
        lip_mid_y = (upper_y + lower_y) / 2.0

        # Total opening: guaranteed minimum based on lip width so closed-mouth
        # avatars still get visible movement (natural_gap can be ~2px when closed).
        max_delta = max(natural_gap * 4.0, lip_width * 0.30) + 20.0
        gap_delta = mouth_open * max_delta

        upper_shift = gap_delta * 0.42   # upper lip travels upward
        lower_shift = gap_delta * 0.58   # lower lip travels downward

        # Influence radii
        sigma_x   = lip_width * 0.50          # horizontal (covers full lip)
        sigma_y_u = max(lip_width * 0.28, 8.0)  # vertical spread around upper landmark
        sigma_y_d = max(lip_width * 0.32, 9.0)  # vertical spread around lower landmark

        grid_x, grid_y = np.meshgrid(
            np.arange(image_w, dtype=np.float32),
            np.arange(image_h, dtype=np.float32),
        )

        # Horizontal weight centred on lip midpoint
        wx = np.exp(-0.5 * ((grid_x - center_x) / sigma_x) ** 2)

        # ── Upper lip Gaussian: centred AT upper_y (no clipping) ──────────────
        # Pixels exactly at upper_y get weight ≈ 1; falloff both above and below.
        wy_upper = np.exp(-0.5 * ((grid_y - upper_y) / sigma_y_u) ** 2)
        upper_weight = wx * wy_upper

        # ── Lower lip Gaussian: centred AT lower_y ────────────────────────────
        wy_lower = np.exp(-0.5 * ((grid_y - lower_y) / sigma_y_d) ** 2)
        lower_weight = wx * wy_lower

        # Jaw/chin drop: chin skin below the lips shifts slightly downward
        sigma_y_jaw  = max(lip_width * 0.55, 14.0)
        jaw_center_y = lower_y + max(lip_width * 0.45, 12.0)
        wy_jaw  = np.exp(-0.5 * ((grid_y - jaw_center_y) / sigma_y_jaw) ** 2)
        jaw_weight = wx * wy_jaw * np.clip((grid_y - lower_y) / (sigma_y_jaw + 1e-6), 0.0, 1.0)
        jaw_shift  = mouth_open * max(lip_width * 0.07, 3.0)

        # Reverse-map: "to draw output pixel (y,x), fetch source from (warp_y, warp_x)"
        #   upper lip moves UP  → sample from further down  → warp_y += upper_shift
        #   lower lip moves DOWN → sample from further up   → warp_y -= lower_shift
        #   chin shifts down    → sample from further up    → warp_y -= jaw_shift
        warp_y = grid_y + upper_weight * upper_shift - lower_weight * lower_shift - jaw_weight * jaw_shift

        # Horizontal corner spread: as mouth opens, corners pull outward slightly
        sigma_y_corner = max(lip_width * 0.18, 5.0)
        corner_band = np.exp(-0.5 * ((grid_y - lip_mid_y) / sigma_y_corner) ** 2)
        # normalised ±1 at each corner, 0 at centre
        corner_nx = (grid_x - center_x) / (lip_width * 0.5 + 1e-6)
        warp_x = grid_x - wx * corner_band * corner_nx * mouth_open * 3.5

        result = cv2.remap(
            image,
            warp_x,
            warp_y,
            interpolation=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_REFLECT_101,
        )

        # Dark mouth-cavity shadow between the open lips
        gap_half  = max(gap_delta * 0.44, 1.0)
        inner_dy  = np.abs(grid_y - lip_mid_y)
        inner_dx  = np.abs(grid_x - center_x) / (lip_width * 0.42 + 1e-6)
        inner_mask = (
            np.clip(1.0 - inner_dx, 0.0, 1.0)
            * np.clip(1.0 - inner_dy / gap_half, 0.0, 1.0)
        )
        shadow_strength = float(np.clip(0.04 + mouth_open * 0.28, 0.0, 0.38))
        shadow_alpha = (inner_mask * shadow_strength)[..., None]
        shadow_color = np.full_like(result, (16, 12, 18), dtype=np.uint8)
        result = np.clip(
            result.astype(np.float32) * (1.0 - shadow_alpha)
            + shadow_color.astype(np.float32) * shadow_alpha,
            0,
            255,
        ).astype(np.uint8)

        return result


    def _apply_center_warp(self, image: np.ndarray, mouth_open: float) -> np.ndarray:
        """Legacy heuristic warp used when MediaPipe did not detect a face."""
        image_h, image_w = image.shape[:2]
        center_x = self._mouth_center_x
        center_y = self._mouth_center_y
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
        # Head micro-movement ------------------------------------------------
        # Idle: slow gentle sway.  Speaking: faster nod in sync with speech.
        idle_x = int(np.sin(now * 0.5) * min(max_x, 24) * 0.35)
        idle_y = int(np.cos(now * 0.4) * min(max_y, 24) * 0.2)
        if speaking:
            # Subtle vertical nod at ~speech cadence (~4 Hz)
            nod = int(np.sin(now * 4.2) * 2.5)
        else:
            nod = 0
        if has_a2f_motion:
            offset_x = max_x // 2
            offset_y = max_y // 2 + nod
        else:
            offset_x = max_x // 2 + idle_x
            offset_y = max_y // 2 + idle_y + nod
        offset_x = max(0, min(offset_x, max_x))
        offset_y = max(0, min(offset_y, max_y))
        image = scaled[offset_y : offset_y + 512, offset_x : offset_x + 512].copy()

        if speaking and not has_a2f_motion:
            highlight = image.copy()
            cv2.circle(highlight, (256, 356), 72, (90, 90, 180), -1)
            cv2.addWeighted(highlight, 0.08, image, 0.92, 0, image)

        image = self._apply_mouth_warp(image, mouth_open)
        blink = self._blink_amount(now)
        if blink > 0.01:
            image = self._apply_blink(image, blink)
        return image

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
