from evdev import InputDevice, categorize, ecodes

# ใช้ event ที่ scanner ต่ออยู่ (ตอนนี้คือ event0)
dev = InputDevice('/dev/input/event0')
print("📡 Listening for scanner input on /dev/input/event0 ...")

buffer = ""
for event in dev.read_loop():
    if event.type == ecodes.EV_KEY and event.value == 1:
        key = categorize(event).keycode

        if key == "KEY_ENTER":
            if buffer:
                print("✅ Scanned:", buffer)
                buffer = ""
        elif key.startswith("KEY_"):
            ch = key.replace("KEY_", "").lower()
            if ch in ['leftshift', 'rightshift']:
                continue
            if len(ch) == 1:
                buffer += ch
