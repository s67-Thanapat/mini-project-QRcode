from fastapi import FastAPI, WebSocket, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from starlette.websockets import WebSocketDisconnect
import threading, asyncio, datetime, socket, uvicorn, time, os
from dotenv import load_dotenv
from pathlib import Path
from scanner import scanner_loop
from supabase_client import check_uuid_exists, insert_checkin
from fastapi.staticfiles import StaticFiles


# =====================================================
# 🌐 Load environment variables
# =====================================================
env_path = Path(__file__).resolve().parent / ".env"
load_dotenv()
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", 5002))
BOOTH_NAME = os.getenv("BASE_NAME", "CprE-Booth")


# =====================================================
# 🚀 FastAPI setup
# =====================================================
app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

clients = set()
participants = {}
event_loop = None  # Event loop for async broadcast

SCAN_COOLDOWN = 5          # Minimum 5 seconds between scans
CHECKOUT_COOLDOWN = 30     # Must wait 30 seconds before checkout


# =====================================================
# 🕓 Initialize event loop
# =====================================================
@app.on_event("startup")
async def on_startup():
    global event_loop
    event_loop = asyncio.get_running_loop()


# =====================================================
# 🧭 Web routes
# =====================================================
@app.get("/")
async def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """Handle WebSocket connections"""
    await websocket.accept()
    clients.add(websocket)
    print(f"🔗 WebSocket connected: {websocket.client}")
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        clients.remove(websocket)
        print("⚠️ WebSocket disconnected")


# =====================================================
# 🔄 Broadcast system
# =====================================================
async def _broadcast_async(data):
    """Send data to all connected WebSocket clients"""
    dead = []
    for ws in clients:
        try:
            await ws.send_json(data)
        except Exception:
            dead.append(ws)
    for ws in dead:
        clients.remove(ws)


def broadcast(data):
    """Thread-safe broadcast"""
    global event_loop
    if event_loop and event_loop.is_running():
        asyncio.run_coroutine_threadsafe(_broadcast_async(data), event_loop)
    else:
        print("⚠️ FastAPI event loop not ready yet!")


# =====================================================
# 🧩 Main QR logic
# =====================================================
def handle_scan(uuid: str):
    now = time.time()
    booth = BOOTH_NAME

    # 🔍 Validate UUID
    if not check_uuid_exists(uuid):
        broadcast({
            "message": f"⚠️ Invalid QR Code detected: {uuid}",
            "type": "invalid",
            "uuid": uuid
        })
        print(f"⚠️ Invalid QR: {uuid}")
        return

    info = participants.get(uuid, {"status": None, "last_time": 0, "booth": None})
    last_status, last_time, last_booth = info["status"], info["last_time"], info["booth"]

    # 🧱 ถ้า QR เคยเสร็จสิ้นแล้ว (completed)
    if last_status == "completed":
        broadcast({
            "message": f"🎉 This QR has already completed the process: {uuid}",
            "type": "completed",
            "uuid": uuid
        })
        print(f"🎉 Already completed: {uuid}")
        return

    # 🕓 Prevent too frequent scans
    if now - last_time < SCAN_COOLDOWN:
        remaining = round(SCAN_COOLDOWN - (now - last_time), 1)
        broadcast({
            "message": f"🕓 Please wait {remaining} seconds before scanning again: {uuid}",
            "type": "cooldown",
            "uuid": uuid
        })
        print(f"⏳ Cooldown active for {uuid} ({remaining}s left)")
        return

    # 🔁 Auto Check-out (Different booth detected) — ใช้ NULL เป็น open state
    try:
        from supabase_client import supabase

        # หาแถวที่ยังไม่ checkout (checkout_time IS NULL)
        open_record = (
            supabase.table("checkins")
            .select("*")
            .eq("uuid", uuid)
            .is_("checkout_time", None)
            .order("last_updated", desc=True)# ✅ ตรงนี้สำคัญ
            .limit(1)
            .execute()
        )

        if open_record.data:
            old = open_record.data[0]
            last_booth = old.get("booth")
            now_iso   = datetime.datetime.now().isoformat(timespec="seconds")

            if last_booth != booth:
                # ปิดบูธเดิม
                update_res = (
                    supabase.table("checkins")
                    .update({"checkout_time": now_iso})
                    .eq("uuid", uuid)
                    .eq("booth", last_booth)
                    .is_("checkout_time", None)
                    .execute()
                )
                updated = len(update_res.data) if getattr(update_res, "data", None) else 0
                print(f"🟠 Auto-checkout {uuid} from {last_booth} → updated rows: {updated}")

                # ตั้งสถานะฝั่งหน่วยความจำไว้เพื่อ broadcast
                participants[uuid] = {
                    "status": "in",
                    "last_time": time.time(),
                    "booth": booth,
                    "checkin_time": datetime.datetime.now().strftime("%H:%M:%S"),
                    "checkout_time": "-"
                }

                broadcast({
                    "message": f"🔁 Auto-checkout from {last_booth}",
                    "type": "auto_checkout",
                    "uuid": uuid,
                    "booth": last_booth,
                    "checkout_time": datetime.datetime.now().strftime("%H:%M:%S"),
                })

                # insert check-in ใหม่ให้บูธปัจจุบัน (ใน DB ให้ checkout_time=None)
                insert_checkin(uuid, "Check-in")

                broadcast({
                    "message": f"✅ Auto check-in at new booth: {booth}",
                    "type": "checkin",
                    "uuid": uuid,
                    "booth": booth,
                    "checkin_time": participants[uuid]["checkin_time"],
                    "checkout_time": "-"
                })
                print(f"✅ Auto check-in {uuid} at {booth}")
                return

    except Exception as e:
        print(f"⚠️ Supabase auto-checkout check failed: {e}")


    # ✅ Check-in
    if info.get("status") != "in":
        participants[uuid] = {
            "status": "in",
            "last_time": now,
            "booth": booth,
            "checkin_time": datetime.datetime.now().strftime("%H:%M:%S"),
            "checkout_time": "-"
        }
        insert_checkin(uuid, "Check-in")
        broadcast({
            "message": f"✅ Successfully checked in: {uuid}",
            "type": "checkin",
            "uuid": uuid,
            "booth": booth,
            "checkin_time": participants[uuid]["checkin_time"],
            "checkout_time": "-"
        })
        print(f"✅ Check-in: {uuid}")
        return

    # ❌ Check-out (after waiting at least 30s)
    elif last_status == "in":
        if now - last_time < CHECKOUT_COOLDOWN:
            remaining = int(CHECKOUT_COOLDOWN - (now - last_time))
            broadcast({
                "message": f"🕓 Please wait {remaining} seconds before checking out: {uuid}",
                "type": "cooldown",
                "uuid": uuid
            })
            print(f"⏳ Checkout too soon ({remaining}s left) for {uuid}")
            return

        # ✅ Proceed to check-out
        participants[uuid]["status"] = "completed"
        participants[uuid]["last_time"] = now
        participants[uuid]["checkout_time"] = datetime.datetime.now().strftime("%H:%M:%S")
        insert_checkin(uuid, "Check-out")
        broadcast({
            "message": f"❌ Successfully checked out: {uuid}",
            "type": "checkout",
            "uuid": uuid,
            "booth": booth,
            "checkin_time": participants[uuid]["checkin_time"],
            "checkout_time": participants[uuid]["checkout_time"]
        })
        print(f"❌ Check-out: {uuid}")
        return


# =====================================================
# 🧰 Utility
# =====================================================
def get_local_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.connect(("8.8.8.8", 80))
    ip = s.getsockname()[0]
    s.close()
    return ip



# =====================================================
# 🚀 Main
# =====================================================
if __name__ == "__main__":
    try:
        time.sleep(1.0)

        # Start scanner thread
        threading.Thread(target=scanner_loop, args=(handle_scan,), daemon=True).start()

        local_ip = get_local_ip()
        print(f"🌐 Server running at: http://{local_ip}:{PORT}/")

        uvicorn.run(app, host=HOST, port=PORT, reload=False, log_level="info")

    except KeyboardInterrupt:
        print("\n🛑 Server stopped by user")
