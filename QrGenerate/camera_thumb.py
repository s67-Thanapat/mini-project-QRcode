# camera_thumb.py - เวอร์ชันปรับปรุงสำหรับ RPi
import os
import time
import json
import logging
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, HTTPServer
import socket
import socketserver
import threading
from typing import Optional, Dict
import cv2
import mediapipe as mp
import paho.mqtt.client as mqtt

# ===================== Configuration =====================
SITE = os.getenv('SITE', 'gateA')
DEVICE_ID = os.getenv('DEVICE_ID', 'esp32-01')
MQTT_HOST = os.getenv('MQTT_HOST', '127.0.0.1')
MQTT_PORT = int(os.getenv('MQTT_PORT', '1883'))
MQTT_USER = os.getenv('MQTT_USER', 'server')
MQTT_PASS = os.getenv('MQTT_PASS', '12345678')

TOPIC_THUMB = f"{SITE}/{DEVICE_ID}/ui/thumb"
TOPIC_SESSION = f"{SITE}/{DEVICE_ID}/ui/session_status"

# Camera settings
CAM_INDEX = int(os.getenv('CAM_INDEX', '0'))
FRAME_W = int(os.getenv('FRAME_W', '640'))
FRAME_H = int(os.getenv('FRAME_H', '480'))
STREAM_PORT = int(os.getenv('STREAM_PORT', '9101'))
STREAM_ENABLED = os.getenv('STREAM_ENABLED', '1') != '0'
STREAM_JPEG_QUALITY = int(os.getenv('STREAM_JPEG_QUALITY', '80'))
SHOW_WINDOW = os.getenv('SHOW_WINDOW', '0') == '1'

# ===================== Logging Setup =====================
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# ===================== Streaming Helpers =====================

class FrameBuffer:
    def __init__(self):
        self._lock = threading.Lock()
        self._cond = threading.Condition(self._lock)
        self._frame = None
        self._sequence = 0

    def update(self, frame_bytes: bytes):
        with self._cond:
            self._frame = frame_bytes
            self._sequence += 1
            self._cond.notify_all()

    def wait_for_frame(self, last_sequence: int, timeout: float = 1.0):
        with self._cond:
            if last_sequence == -1 and self._frame is not None:
                return self._frame, self._sequence

            updated = self._cond.wait_for(
                lambda: self._sequence != last_sequence,
                timeout=timeout
            )
            if not updated or self._frame is None:
                return None, last_sequence

            return self._frame, self._sequence


def make_stream_handler(frame_buffer: FrameBuffer):
    class StreamingHandler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path not in ('/', '/stream'):
                self.send_error(404)
                return

            try:
                self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            except OSError:
                pass

            self.send_response(200)
            self.send_header('Age', '0')
            self.send_header('Cache-Control', 'no-cache, private')
            self.send_header('Pragma', 'no-cache')
            self.send_header('Content-Type', 'multipart/x-mixed-replace; boundary=frame')
            self.end_headers()

            try:
                last_sequence = -1
                while True:
                    frame, last_sequence = frame_buffer.wait_for_frame(last_sequence, timeout=1.5)
                    if frame is None:
                        continue

                    self.wfile.write(b'--frame\r\n')
                    self.wfile.write(b'Content-Type: image/jpeg\r\n')
                    self.wfile.write(f'Content-Length: {len(frame)}\r\n\r\n'.encode('utf-8'))
                    self.wfile.write(frame)
                    self.wfile.write(b'\r\n')
                    try:
                        self.wfile.flush()
                    except ValueError:
                        break
            except BrokenPipeError:
                logger.debug('Stream client disconnected')
            except Exception as exc:
                logger.error(f'Streaming error: {exc}')

        def log_message(self, format, *args):  # noqa: N802 - suppress default logging
            return

    return StreamingHandler


class ThreadedHTTPServer(socketserver.ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def start_stream_server(frame_buffer: FrameBuffer):
    handler = make_stream_handler(frame_buffer)
    server = ThreadedHTTPServer(('0.0.0.0', STREAM_PORT), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    logger.info("📡 MJPEG stream ready at http://0.0.0.0:%s/stream", STREAM_PORT)
    return server

# ===================== Pipeline Components =====================
@dataclass
class TemporalParams:
    stable_frames_needed: int = 4
    debounce_ms: int = 2000
    max_gesture_gap_ms: int = 800

class ThumbsUpRule:
    """
    ตรวจจับท่าชูนิ้วโป้งแบบ optimized สำหรับ RPi
    """
    def __init__(self, lift_margin_px: float = 12.0, curl_margin_px: float = 6.0):
        self.lift_margin_px = lift_margin_px
        self.curl_margin_px = curl_margin_px

    def __call__(self, hand_lms, h: int, w: int) -> bool:
        try:
            lm = hand_lms.landmark
            y_vals = [point.y * h for point in lm]
            x_vals = [point.x * w for point in lm]

            hand_top = min(y_vals)
            hand_bottom = max(y_vals)
            hand_span = max(hand_bottom - hand_top, 1.0)
            lift_margin = max(self.lift_margin_px, hand_span * 0.12)
            curl_margin = max(self.curl_margin_px, hand_span * 0.08)

            wrist_y = y_vals[0]
            thumb_tip_y = y_vals[4]
            thumb_ip_y = y_vals[3]
            thumb_mcp_y = y_vals[2]

            thumb_up = (
                thumb_tip_y + lift_margin * 0.4 < thumb_ip_y and
                thumb_tip_y + lift_margin * 0.6 < thumb_mcp_y and
                thumb_tip_y + lift_margin < wrist_y
            )

            thumb_vertical = abs(thumb_tip_y - thumb_ip_y) > abs(x_vals[4] - x_vals[3]) * 0.5

            finger_sets = ((8, 6, 5), (12, 10, 9), (16, 14, 13), (20, 18, 17))
            curled_count = 0
            for tip, pip, mcp in finger_sets:
                tip_y = y_vals[tip]
                pip_y = y_vals[pip]
                mcp_y = y_vals[mcp]
                if tip_y > min(pip_y, mcp_y) + curl_margin * 0.6:
                    curled_count += 1

            index_suppressed = y_vals[8] > thumb_tip_y + curl_margin * 0.6
            others_curled = curled_count >= 3 or (curled_count >= 2 and index_suppressed)

            return bool(thumb_up and thumb_vertical and others_curled)
        except Exception as e:
            logger.error(f"Error in thumb detection: {e}")
            return False

class TemporalFilter:
    """
    กรองสัญญาณเพื่อลด false positive
    """
    def __init__(self, params: TemporalParams):
        self.p = params
        self._stable = 0
        self._last_emit_ms = 0
        self._last_true_ms = 0

    def step(self, detected: bool) -> bool:
        now = int(time.time() * 1000)

        if detected:
            if now - self._last_true_ms > self.p.max_gesture_gap_ms:
                self._stable = 0  # รีเซ็ตถ้าห่างเกินกำหนด
            self._stable += 1
            self._last_true_ms = now

        ready = self._stable >= self.p.stable_frames_needed
        if ready and (now - self._last_emit_ms > self.p.debounce_ms):
            self._stable = 0
            self._last_emit_ms = now
            return True
        return False

class MQTTManager:
    """จัดการการเชื่อมต่อ MQTT และการส่งสถานะ"""

    def __init__(self):
        self.client = None
        self.last_thumb_payload = None
        self.setup_mqtt()

    def setup_mqtt(self):
        try:
            self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
            self.client.username_pw_set(MQTT_USER, MQTT_PASS)
            self.client.connect(MQTT_HOST, MQTT_PORT, keepalive=60)
            self.client.loop_start()
            logger.info("MQTT client connected successfully")
        except Exception as e:
            logger.error(f"MQTT connection failed: {e}")

    def send_thumb_state(
        self,
        detected: bool,
        *,
        progress: Optional[float] = None,
        hold_complete: Optional[bool] = None,
        distance: Optional[float] = None,
    ) -> None:
        """ส่งสถานะนิ้วโป้งไปยัง MQTT"""
        payload: Dict[str, object] = {
            "thumb": bool(detected),
            "timestamp": time.time(),
            "camera": "rpi_camera"
        }

        if progress is not None:
            clamped = max(0.0, min(progress, 1.0))
            payload["progress"] = round(clamped, 4)

        if hold_complete is not None:
            payload["hold_complete"] = bool(hold_complete)

        if distance is not None:
            payload["distance"] = float(distance)

        payload_key = json.dumps(payload, sort_keys=True)
        if payload_key == self.last_thumb_payload:
            return
        self.last_thumb_payload = payload_key

        try:
            self.client.publish(TOPIC_THUMB, json.dumps(payload), qos=1)
            logger.info(
                "📸 ส่งสถานะนิ้วโป้ง: %s (progress=%.2f, hold_complete=%s)",
                payload["thumb"],
                payload.get("progress", 0.0),
                payload.get("hold_complete", False)
            )
        except Exception as e:
            logger.error(f"Failed to send MQTT message: {e}")

    def send_session_status(self, status: str):
        """ส่งสถานะ session ไปยัง frontend"""
        payload = json.dumps({
            "status": status,
            "camera": "active",
            "timestamp": time.time()
        })
        try:
            self.client.publish(TOPIC_SESSION, payload, qos=1)
        except Exception as e:
            logger.error(f"Failed to send session status: {e}")

# ===================== Main Pipeline =====================
class ThumbDetectionPipeline:
    def __init__(self):
        self.mqtt = MQTTManager()
        self.cap = None
        self.hands = None
        self.gesture_detector = ThumbsUpRule(lift_margin_px=10, curl_margin_px=6)
        self.is_running = False
        self.frame_buffer = FrameBuffer() if STREAM_ENABLED else None
        self.stream_server = None
        self.thumb_hold_duration_ms = 3000
        self.thumb_release_grace_ms = 600
        self.thumb_progress_step = 0.05
        self.thumb_hold_start_ms: Optional[int] = None
        self.last_detected_ms: Optional[int] = None
        self.last_progress_sent = 0.0
        self.thumb_hold_completed = False
        self.detect_stable_frames = 2
        self.consecutive_detect_frames = 0
        self.last_progress_bucket = -1

    def setup_camera(self):
        """ตั้งค่ากล้อง"""
        try:
            backends = [cv2.CAP_V4L2, cv2.CAP_ANY, None]
            for backend in backends:
                cap = cv2.VideoCapture(CAM_INDEX) if backend is None else cv2.VideoCapture(CAM_INDEX, backend)
                if cap.isOpened():
                    cap.set(cv2.CAP_PROP_FRAME_WIDTH, FRAME_W)
                    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, FRAME_H)
                    cap.set(cv2.CAP_PROP_FPS, 30)
                    buffer_prop = getattr(cv2, 'CAP_PROP_BUFFERSIZE', None)
                    if buffer_prop is not None:
                        cap.set(buffer_prop, 1)
                    try:
                        cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*'MJPG'))
                    except Exception:
                        logger.debug('Camera MJPG fourcc not supported, using default')
                    self.cap = cap
                    break

            if self.cap is None or not self.cap.isOpened():
                logger.error("Cannot open camera")
                return False
            
            logger.info("Camera initialized successfully")
            return True
        except Exception as e:
            logger.error(f"Camera setup failed: {e}")
            return False

    def setup_mediapipe(self):
        """ตั้งค่า MediaPipe"""
        try:
            self.mp_hands = mp.solutions.hands
            self.mp_draw = mp.solutions.drawing_utils
            
            self.hands = self.mp_hands.Hands(
                model_complexity=0,  # ใช้ model ง่ายๆ สำหรับ RPi
                max_num_hands=1,     # ตรวจจับมือเดียวเพื่อประสิทธิภาพ
                min_detection_confidence=0.45,
                min_tracking_confidence=0.25
            )
            logger.info("MediaPipe initialized successfully")
            return True
        except Exception as e:
            logger.error(f"MediaPipe setup failed: {e}")
            return False

    def publish_frame(self, frame):
        if not self.frame_buffer:
            return
        try:
            success, encoded = cv2.imencode(
                '.jpg', frame, [int(cv2.IMWRITE_JPEG_QUALITY), STREAM_JPEG_QUALITY]
            )
            if success:
                self.frame_buffer.update(encoded.tobytes())
        except Exception as exc:
            logger.debug(f"Frame encode failed: {exc}")

    def process_frame(self, frame):
        """ประมวลผลเฟรมและตรวจจับท่าทาง"""
        if self.hands is None:
            return False, frame

        annotated = frame.copy()

        try:
            # Convert BGR to RGB
            rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            h, w, _ = frame.shape

            # Process with MediaPipe
            results = self.hands.process(rgb_frame)

            detected = False
            if results.multi_hand_landmarks:
                for hand_landmarks in results.multi_hand_landmarks:
                    self.mp_draw.draw_landmarks(
                        annotated, hand_landmarks, self.mp_hands.HAND_CONNECTIONS
                    )

                    if self.gesture_detector(hand_landmarks, h, w):
                        detected = True
                        break

            return detected, annotated
        except Exception as e:
            logger.error(f"Error processing frame: {e}")
            return False, annotated

    def run(self):
        """รัน pipeline หลัก"""
        logger.info("🚀 เริ่มระบบตรวจจับท่าทาง...")
        
        if not self.setup_camera():
            return
        
        if not self.setup_mediapipe():
            return

        if STREAM_ENABLED and self.frame_buffer:
            try:
                self.stream_server = start_stream_server(self.frame_buffer)
            except Exception as exc:
                logger.error(f"Failed to start stream server: {exc}")

        self.is_running = True
        self.mqtt.send_session_status("camera_ready")
        logger.info("✅ ระบบพร้อมทำงาน - รอตรวจจับนิ้วโป้ง...")

        consecutive_failures = 0
        max_failures = 10

        try:
            while self.is_running:
                ret, frame = self.cap.read()
                if not ret:
                    consecutive_failures += 1
                    logger.warning(f"Failed to read frame ({consecutive_failures}/{max_failures})")
                    if consecutive_failures == 1:
                        self._reset_thumb_hold()
                    if consecutive_failures >= max_failures:
                        logger.error("Too many consecutive failures, restarting camera...")
                        self.cap.release()
                        time.sleep(2)
                        if not self.setup_camera():
                            break
                        consecutive_failures = 0
                    continue
                
                consecutive_failures = 0

                # ประมวลผลเฟรมและอัปเดตสถานะการชูนิ้วโป้ง
                detected, annotated = self.process_frame(frame)
                now_ms = int(time.time() * 1000)

                if detected:
                    self.consecutive_detect_frames += 1
                    self.last_detected_ms = now_ms
                else:
                    if self.thumb_hold_start_ms is None:
                        self.consecutive_detect_frames = 0
                        self.last_detected_ms = None

                if self.thumb_hold_start_ms is None:
                    if self.consecutive_detect_frames >= self.detect_stable_frames:
                        self.thumb_hold_start_ms = now_ms
                        self.last_progress_sent = 0.0
                        self.thumb_hold_completed = False
                        self.last_progress_bucket = 0
                        self.mqtt.send_thumb_state(True, progress=0.0, hold_complete=False)
                        logger.info("👆 เริ่มตรวจจับนิ้วโป้ง (เริ่มจับเวลา)")
                else:
                    if self.last_detected_ms is not None and (now_ms - self.last_detected_ms) > self.thumb_release_grace_ms:
                        logger.debug("Thumb hold released (timeout)")
                        self._reset_thumb_hold()
                    else:
                        hold_ms = max(0, now_ms - (self.thumb_hold_start_ms or now_ms))
                        progress = min(hold_ms / self.thumb_hold_duration_ms, 1.0)
                        bucket = int(progress / self.thumb_progress_step)
                        max_bucket = int(1 / self.thumb_progress_step)

                        if not self.thumb_hold_completed:
                            if progress >= 1.0:
                                self.thumb_hold_completed = True
                                self.last_progress_sent = 1.0
                                self.last_progress_bucket = max_bucket
                                self.mqtt.send_thumb_state(True, progress=1.0, hold_complete=True)
                                self.mqtt.send_session_status("thumb_detected")
                                logger.info("🎯 นิ้วโป้งค้างครบ %.1f วินาที", self.thumb_hold_duration_ms / 1000)
                            elif bucket > self.last_progress_bucket:
                                self.last_progress_bucket = bucket
                                self.last_progress_sent = progress
                                self.mqtt.send_thumb_state(True, progress=progress, hold_complete=False)

                display_frame = cv2.flip(annotated, 1)

                self.publish_frame(display_frame)

                if SHOW_WINDOW:
                    cv2.imshow("Thumb Detection - RPi", display_frame)
                    if cv2.waitKey(1) & 0xFF == ord('q'):
                        break

        except KeyboardInterrupt:
            logger.info("Received interrupt, shutting down...")
        except Exception as e:
            logger.error(f"Unexpected error: {e}")
        finally:
            self.cleanup()

    def _reset_thumb_hold(self):
        has_state = (
            self.thumb_hold_start_ms is not None or
            self.thumb_hold_completed or
            self.last_progress_sent > 0.0
        )
        if has_state:
            self.mqtt.send_thumb_state(False, progress=0.0, hold_complete=False)
            self.mqtt.last_thumb_payload = None

        self.thumb_hold_start_ms = None
        self.last_progress_sent = 0.0
        self.thumb_hold_completed = False
        self.last_detected_ms = None
        self.consecutive_detect_frames = 0
        self.last_progress_bucket = -1

    def cleanup(self):
        """ทำความสะอาด resources"""
        self.is_running = False
        self._reset_thumb_hold()
        if self.cap:
            self.cap.release()
        if self.hands:
            self.hands.close()
        if SHOW_WINDOW:
            cv2.destroyAllWindows()
        if self.stream_server:
            try:
                self.stream_server.shutdown()
                self.stream_server.server_close()
            except Exception as exc:
                logger.debug(f"Error stopping stream server: {exc}")
            self.stream_server = None
        if self.mqtt.client:
            self.mqtt.client.loop_stop()
            self.mqtt.client.disconnect()
        logger.info("ระบบปิดลงแล้ว")

def main():
    """ฟังก์ชันหลัก"""
    logger.info("=" * 50)
    logger.info("   RPi Thumb Detection System")
    logger.info("   Integrated with MQTT Bridge")
    logger.info("=" * 50)
    
    pipeline = ThumbDetectionPipeline()
    pipeline.run()

if __name__ == "__main__":
    main()
