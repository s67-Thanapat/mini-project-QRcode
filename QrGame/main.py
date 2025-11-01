# main.py — ESP32 + MicroPython BLE game paddle (2 buttons + LED heartbeat)
# Buttons: LEFT=GPIO26, RIGHT=GPIO27  (active low to GND)
# LED: GPIO22 (blink while running)

try:
    import ubluetooth as bt
except ImportError:
    raise SystemExit("⚠️ เฟิร์มแวร์นี้ไม่มี ubluetooth — กรุณาแฟลช MicroPython ที่รองรับ BLE")

from machine import Pin
import time

# === Pins (เลี่ยง GPIO12) ===
BTN_L = Pin(26, Pin.IN, Pin.PULL_UP)
BTN_R = Pin(27, Pin.IN, Pin.PULL_UP)
LED = Pin(22, Pin.OUT)  # LED GPIO22

# === UUIDs (ต้องตรงกับหน้าเว็บ) ===
SERVICE_UUID_STR = '12345678-1234-1234-1234-1234567890ab'
CHAR_UUID_STR = 'abcd1234-1234-1234-1234-abcdef012345'

SERVICE_UUID = bt.UUID(SERVICE_UUID_STR)
CHAR_UUID = bt.UUID(CHAR_UUID_STR)

# Characteristic: READ | NOTIFY (1 ไบต์: bit0=ซ้าย, bit1=ขวา)
CHAR = (CHAR_UUID, bt.FLAG_READ | bt.FLAG_NOTIFY)
SERVICE = (SERVICE_UUID, (CHAR,))

# IRQ consts
_IRQ_CENTRAL_CONNECT = getattr(bt, "_IRQ_CENTRAL_CONNECT", 1)
_IRQ_CENTRAL_DISCONNECT = getattr(bt, "_IRQ_CENTRAL_DISCONNECT", 2)


def _adv_uuid128(uuid_str):
    hexstr = uuid_str.replace('-', '')
    b = bytes.fromhex(hexstr)
    return bytes(reversed(b))


def build_adv_flags():
    return bytes((2, 0x01, 0x06))


def build_adv_name(name):
    nb = name.encode()
    return bytes((len(nb) + 1, 0x09)) + nb


def build_adv_uuid128_complete(uuid_strs):
    svc_bytes = b''.join(_adv_uuid128(u) for u in uuid_strs)
    return bytes((len(svc_bytes) + 1, 0x07)) + svc_bytes


class BlePaddle:
    def __init__(self, name='QR-Paddle'):
        self._ble = bt.BLE()
        self._ble.active(True)
        try:
            self._ble.config(gap_name=name)
        except Exception as e:
            print("gap_name config not supported:", e)

        self._ble.irq(self._irq)

        ((self._h_btn,),) = self._ble.gatts_register_services((SERVICE,))
        print("GATTS value handle:", self._h_btn)
        self._ble.gatts_write(self._h_btn, b'\x00')

        self._connections = set()

        self._adv_data = build_adv_flags() + build_adv_name(name)
        self._resp_data = build_adv_uuid128_complete([SERVICE_UUID_STR])

        self._advertise(start=True)

        self._last_mask = -1
        self._last_send_ms = 0

        # สำหรับ LED heartbeat
        self._last_led_ms = 0
        self._led_state = 0

    def _irq(self, event, data):
        if event == _IRQ_CENTRAL_CONNECT:
            conn_handle, _, _ = data
            self._connections.add(conn_handle)
            print("✅ Connected:", conn_handle)
            self._advertise(start=False)
        elif event == _IRQ_CENTRAL_DISCONNECT:
            conn_handle, _, _ = data
            self._connections.discard(conn_handle)
            print("❌ Disconnected:", conn_handle)
            self._advertise(start=True)

    def _advertise(self, start=True, interval_us=500_000):
        try:
            self._ble.gap_advertise(None)
        except Exception:
            pass

        if not start:
            print("⏹️ Advertising stop")
            return

        print("📣 Advertising start…")
        try:
            self._ble.gap_advertise(interval_us, adv_data=self._adv_data, resp_data=self._resp_data)
        except TypeError:
            print("⚠️ resp_data not supported → advertise without UUID list")
            self._ble.gap_advertise(interval_us, adv_data=self._adv_data)
        except OSError as e:
            print("⚠️ advertise OSError:", e)
            self._ble.gap_advertise(interval_us, adv_data=build_adv_flags())

    def notify_mask(self, mask):
        self._ble.gatts_write(self._h_btn, bytes((mask,)))
        for conn in tuple(self._connections):
            try:
                self._ble.gatts_notify(conn, self._h_btn)
            except Exception as e:
                print("notify error:", e)

    def read_buttons_mask(self):
        left = (BTN_L.value() == 0)
        right = (BTN_R.value() == 0)
        return (0x01 if left else 0) | (0x02 if right else 0)

    def loop(self):
        mask = self.read_buttons_mask()
        now = time.ticks_ms()

        # ส่ง notify ปุ่ม
        if mask != self._last_mask or time.ticks_diff(now, self._last_send_ms) > 200:
            self.notify_mask(mask)
            self._last_mask = mask
            self._last_send_ms = now

        # กระพริบ LED ทุก 500ms
        if time.ticks_diff(now, self._last_led_ms) > 500:
            self._led_state = 1 - self._led_state
            LED.value(self._led_state)
            self._last_led_ms = now

        time.sleep_ms(8)


def main():
    print("=== QR-Paddle-BLE (ESP32 / MicroPython) ===")
    ble = BlePaddle()
    while True:
        ble.loop()


if __name__ == "__main__":
    main()