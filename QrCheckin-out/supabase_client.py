from supabase import create_client
import datetime, os
from dotenv import load_dotenv

# =====================================================
# 🌐 Load environment variables
# =====================================================
load_dotenv()
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
BASE_NAME = os.getenv("BASE_NAME", "CprE-Booth")

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)


# =====================================================
# 🧩 ตรวจสอบ UUID
# =====================================================
def check_uuid_exists(uuid: str) -> bool:
    """ตรวจสอบว่า UUID อยู่ใน genqrcode หรือไม่"""
    try:
        result = supabase.table("genqrcode").select("uuid").eq("uuid", uuid).execute()
        return len(result.data) > 0
    except Exception as e:
        print(f"❌ Error checking UUID: {e}")
        return False


# =====================================================
# 🧾 บันทึกข้อมูล Check-in / Check-out / Auto-checkout
# =====================================================
def insert_checkin(uuid: str, status: str):
    """บันทึกข้อมูลลงในตาราง checkins"""
    now = datetime.datetime.now().isoformat(timespec="seconds")

    # ✅ แปลงสถานะให้ละเอียดขึ้น
    if status.lower().startswith("auto"):
        # Auto Checkout หรือ Auto Check-in
        data = {
            "uuid": uuid,
            "booth": BASE_NAME,
            "status": "AUTO_OUT",
            "checkout_time": now,
            "checkin_time": None,           # ✅ เพิ่มเพื่อความชัดเจน
            "last_updated": now,
        }

    elif status.lower() == "check-in":
        data = {
            "uuid": uuid,
            "booth": BASE_NAME,
            "status": "IN",
            "checkin_time": now,
            "checkout_time": None,          # ✅ สำคัญ — ทำให้ server.py หาเจอว่าเปิดค้างอยู่
            "last_updated": now,
        }

    else:
        data = {
            "uuid": uuid,
            "booth": BASE_NAME,
            "status": "OUT",
            "checkin_time": None,           # ✅ เพิ่มเพื่อความชัดเจน
            "checkout_time": now,
            "last_updated": now,
        }

    try:
        supabase.table("checkins").insert(data).execute()
        print(f"✅ Inserted {status} record for {uuid} at {BASE_NAME}")
    except Exception as e:
        print(f"❌ Error inserting {status} record for {uuid}: {e}")
