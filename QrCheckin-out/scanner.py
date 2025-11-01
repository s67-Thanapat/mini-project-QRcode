from evdev import InputDevice, categorize, ecodes

def scanner_loop(callback):
    device_path = "/dev/input/event0"
    print(f"🔍 Opening scanner device: {device_path}")
    dev = InputDevice(device_path)

    key_map = {
        2: "1", 3: "2", 4: "3", 5: "4", 6: "5", 7: "6", 8: "7", 9: "8", 10: "9", 11: "0",
        16: "Q", 17: "W", 18: "E", 19: "R", 20: "T", 21: "Y", 22: "U", 23: "I", 24: "O", 25: "P",
        30: "A", 31: "S", 32: "D", 33: "F", 34: "G", 35: "H", 36: "J", 37: "K", 38: "L",
        44: "Z", 45: "X", 46: "C", 47: "V", 48: "B", 49: "N", 50: "M"
    }

    uuid = ""
    for event in dev.read_loop():
        if event.type == ecodes.EV_KEY:
            data = categorize(event)
            if data.keystate == 1:  # key down
                if data.keycode == "KEY_ENTER":
                    if uuid:
                        print(f"🔹 Scanned: {uuid}")
                        callback(uuid)
                        uuid = ""
                else:
                    key = key_map.get(data.scancode, "")
                    uuid += key
