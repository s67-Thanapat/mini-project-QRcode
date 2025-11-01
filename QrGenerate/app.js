// front-end/app.js - Real-time QR Code Generation
const el = (id) => document.getElementById(id);
const out = (obj) => {
    const result = el('result');
    if (result) {
        result.textContent = JSON.stringify(obj, null, 2);
    }
};

class QRCheckInSystem {
    constructor() {
        this.mqttClient = null;
        this.sessionTimer = null;
        this.timeLeft = 0;
        this.isConnected = false;
        this.cameraRetryTimer = null;
        this.cameraStreamUrl = null;
        this.sensorResetTimer = null;
        this.cameraResetTimer = null;
        this.sensorDefaultStatus = { text: 'รอตรวจจับ', className: 'status-waiting' };
        this.cameraDefaultStatus = { text: 'รอตรวจจับ', className: 'status-waiting' };
        this.thumbHoldSeconds = 3;
        this.thumbInProgress = false;
        this.thumbCompleted = false;
        clearTimeout(this.qrFallbackTimer);
        this.qrFallbackTimer = null;
        this.qrRequested = false;
        clearTimeout(this.qrFallbackTimer);
        this.qrFallbackTimer = null;
        this.qrRequested = false;
        this.qrRequested = false;
        this.qrFallbackTimer = null;

        this.initializeSystem();
        this.setupEventListeners();
        this.setupCameraFeed();
        this.connectMQTT();
    }

    parseBoolean(value) {
        if (typeof value === 'boolean') return value;
        if (typeof value === 'number') return value > 0;
        if (typeof value === 'string') {
            const normalized = value.trim().toLowerCase();
            const trueSet = ['true', '1', 'yes', 'y', 'present', 'detected', 'online', 'active', 'ready', 'ok'];
            const falseSet = ['false', '0', 'no', 'n', 'absent', 'offline', 'inactive', 'idle', 'fail', 'none'];
            if (trueSet.includes(normalized)) return true;
            if (falseSet.includes(normalized)) return false;
        }
        return null;
    }

    resolveBoolean(source, keys = [], defaultValue = false) {
        const direct = this.parseBoolean(source);
        if (direct !== null) return direct;

        if (!source || typeof source !== 'object') return defaultValue;

        for (const key of keys) {
            if (Object.prototype.hasOwnProperty.call(source, key)) {
                const parsed = this.parseBoolean(source[key]);
                if (parsed !== null) return parsed;
            }
        }

        return defaultValue;
    }

    initializeSystem() {
        this.updateSystemStatus('กำลังเชื่อมต่อ...', 'status-waiting');
        this.addLogEntry('ระบบกำลังเริ่มต้น...');
        this.resetThumbIndicator();
    }

    setupEventListeners() {
        const manualBtn = el('btn-create');
        if (manualBtn) manualBtn.onclick = () => this.createQRManual();

        const healthBtn = el('btn-health');
        if (healthBtn) healthBtn.onclick = () => this.checkHealth();

        const clearBtn = el('btn-clear');
        if (clearBtn) clearBtn.onclick = () => this.clearAll();
    }

    setupCameraFeed() {
        const streamEl = el('camera-feed');
        if (!streamEl) return;

        const overlay = el('camera-offline');
        const portOverride = streamEl.dataset.streamPort;
        const path = streamEl.dataset.streamPath || '/stream';

        if (/^https?:/i.test(path)) {
            this.cameraStreamUrl = path;
        } else {
            const currentPort = window.location.port;
            const port = portOverride || currentPort || '';
            const portSegment = port ? `:${port}` : '';
            this.cameraStreamUrl = `${window.location.protocol}//${window.location.hostname}${portSegment}${path}`;
        }

        const connect = () => {
            if (!this.cameraStreamUrl) return;
            streamEl.src = `${this.cameraStreamUrl}?v=${Date.now()}`;
        };

        const scheduleReconnect = () => {
            clearTimeout(this.cameraRetryTimer);
            this.cameraRetryTimer = setTimeout(() => {
                this.cameraRetryTimer = null;
                connect();
            }, 5000);
        };

        streamEl.onload = () => {
            clearTimeout(this.cameraRetryTimer);
            if (overlay) overlay.classList.add('hidden');
            this.updateCameraStatus('กล้องพร้อมทำงาน', 'status-online');
        };

        streamEl.onerror = () => {
            if (overlay) overlay.classList.remove('hidden');
            this.updateCameraStatus('กล้องไม่พร้อม', 'status-offline');
            scheduleReconnect();
        };

        // แสดง overlay ระหว่างรอเชื่อมต่อ
        if (overlay) overlay.classList.remove('hidden');
        connect();
    }

    setThumbMessage(text) {
        const label = el('thumb-label');
        if (label) {
            label.textContent = text;
        }
    }

    setThumbProgress(progress = 0, state = 'idle') {
        const fill = el('thumb-progress');
        const container = el('thumb-progress-container');
        const clamped = Math.max(0, Math.min(progress, 1));

        if (fill) {
            fill.style.width = `${(clamped * 100).toFixed(1)}%`;
            fill.classList.toggle('is-complete', clamped >= 0.999 || state === 'complete');
        }

        if (container) {
            const isComplete = clamped >= 0.999 || state === 'complete';
            const isActive = (state === 'active') || (clamped > 0 && clamped < 1);
            container.classList.toggle('is-active', isActive && !isComplete);
            container.classList.toggle('is-complete', isComplete);
        }
    }

    resetThumbIndicator() {
        this.setThumbProgress(0, 'idle');
        this.setThumbMessage(`ชูนิ้วโป้งค้างไว้ ${this.thumbHoldSeconds} วินาที`);
    }

    connectMQTT() {
        // ใช้ WebSocket สำหรับ MQTT over WebSocket
        const mqttUrl = `ws://${window.location.hostname}:9001/mqtt`;
        
        try {
            this.mqttClient = new Paho.MQTT.Client(mqttUrl, "web-client-" + Math.random().toString(16));
            
            this.mqttClient.onConnectionLost = (response) => {
                console.log('MQTT disconnected:', response);
                this.updateSystemStatus('ขาดการเชื่อมต่อ', 'status-offline');
                this.addLogEntry('การเชื่อมต่อ MQTT หลุด');
                
                // พยายามเชื่อมต่อใหม่หลังจาก 5 วินาที
                setTimeout(() => this.connectMQTT(), 5000);
            };

            this.mqttClient.onMessageArrived = (message) => {
                this.handleMQTTMessage(message);
            };

            const options = {
                onSuccess: () => {
                    console.log('MQTT connected');
                    this.isConnected = true;
                    this.updateSystemStatus('เชื่อมต่อแล้ว', 'status-online');
                    this.addLogEntry('เชื่อมต่อ MQTT สำเร็จ');
                    
                    // Subscribe topics
                    this.mqttClient.subscribe("gateA/esp32-01/event/presence");
                    this.mqttClient.subscribe("gateA/esp32-01/ui/thumb");
                    this.mqttClient.subscribe("gateA/esp32-01/ui/armed");
                    this.mqttClient.subscribe("gateA/esp32-01/ui/cancel");
                    this.mqttClient.subscribe("gateA/esp32-01/ui/session_status");
                    this.mqttClient.subscribe("gateA/esp32-01/status/online");
                },
                onFailure: (error) => {
                    console.error('MQTT connection failed:', error);
                    this.updateSystemStatus('เชื่อมต่อล้มเหลว', 'status-offline');
                    this.addLogEntry('เชื่อมต่อ MQTT ล้มเหลว');
                },
                userName: 'server',
                password: '12345678'
            };

            this.mqttClient.connect(options);
        } catch (error) {
            console.error('MQTT setup error:', error);
            this.fallbackToSSE();
        }
    }

    fallbackToSSE() {
        // Fallback to Server-Sent Events if MQTT fails
        console.log('Trying SSE fallback...');
        const eventSource = new EventSource('/api/events');
        
        eventSource.onopen = () => {
            this.isConnected = true;
            this.updateSystemStatus('เชื่อมต่อด้วย SSE', 'status-online');
            this.addLogEntry('เชื่อมต่อ SSE สำเร็จ');
        };

        eventSource.onmessage = (event) => {
            const data = JSON.parse(event.data);
            this.handleSystemEvent(data);
        };

        eventSource.onerror = (error) => {
            console.error('SSE error:', error);
            this.updateSystemStatus('เชื่อมต่อล้มเหลว', 'status-offline');
        };
    }

    handleSystemEvent(event) {
        if (!event || !event.type) return;
        if (event.type === 'heartbeat') return;
        if (event.type === 'mqtt' && event.topic) {
            this.processTopicEvent(event.topic, event.payload || {});
        }
    }

    handleMQTTMessage(message) {
        const topic = message.destinationName;
        const payload = JSON.parse(message.payloadString);
        
        console.log(`MQTT: ${topic}`, payload);
        this.processTopicEvent(topic, payload);
    }

    processTopicEvent(topic, payload = {}) {
        switch (topic) {
            case "gateA/esp32-01/event/presence":
                this.handleSensorDetection(payload);
                break;
            case "gateA/esp32-01/ui/thumb":
                this.handleThumbDetection(payload);
                break;
            case "gateA/esp32-01/ui/armed":
                this.handleArmedSession(payload);
                break;
            case "gateA/esp32-01/ui/cancel":
                this.handleSessionCancel(payload);
                break;
            case "gateA/esp32-01/ui/session_status":
                this.handleSessionStatus(payload);
                break;
            case "gateA/esp32-01/status/online":
                this.handleDeviceStatus(payload);
                break;
        }
    }

    handleSensorDetection(data) {
        const present = this.resolveBoolean(data, ['present', 'detected', 'active', 'value', 'state'], true);

        if (present) {
            this.updateSensorStatus('ตรวจจับวัตถุแล้ว', 'status-active');

            const hasDistance = typeof data?.distance === 'number';
            const distanceText = hasDistance ? ` (ระยะ ${Math.round(data.distance)}cm)` : '';
            this.addLogEntry(`เซนเซอร์ตรวจจับวัตถุได้${distanceText}`);

            this.showInstruction(`✅ ตรวจพบวัตถุ! กรุณาชูนิ้วโป้งค้างไว้ ${this.thumbHoldSeconds} วินาที`);
            this.thumbInProgress = false;
            this.thumbCompleted = false;
            this.resetThumbIndicator();
        } else {
            this.updateSensorStatus('รอตรวจจับ', 'status-waiting');
            const reasonText = data?.reason ? `: ${data.reason}` : '';
            this.addLogEntry(`เซนเซอร์ไม่พบวัตถุ${reasonText}`);

            this.updateCameraStatus('รอตรวจจับ', 'status-waiting');
            this.thumbInProgress = false;
            this.thumbCompleted = false;
            this.resetThumbIndicator();
        }
    }

    handleThumbDetection(data) {
        const holdComplete = data && data.hold_complete === true;
        const detected = this.resolveBoolean(data?.thumb, ['thumb', 'detected', 'value', 'state', 'active'], false);
        const rawProgress = typeof data?.progress === 'number' ? data.progress : (holdComplete ? 1 : 0);
        const progress = Math.max(0, Math.min(rawProgress, 1));

        const active = detected || holdComplete;

        this.setThumbProgress(progress, holdComplete ? 'complete' : (active ? 'active' : 'idle'));

        if (active) {
            if (!this.thumbInProgress) {
                this.thumbInProgress = true;
                this.thumbCompleted = false;
                this.addLogEntry('เริ่มตรวจจับนิ้วโป้ง');
            }

            if (holdComplete && !this.thumbCompleted) {
                this.thumbCompleted = true;
                this.addLogEntry('ตรวจจับนิ้วโป้งครบตามเวลา');
            }

            if (holdComplete) {
                this.updateCameraStatus('ตรวจจับนิ้วโป้งแล้ว', 'status-active');
                this.setThumbMessage('นิ้วโป้งพร้อมแล้ว');
            } else {
                this.updateCameraStatus('กำลังตรวจจับนิ้วโป้ง...', 'status-active');
                const remaining = Math.max(0, this.thumbHoldSeconds * (1 - progress));
                this.setThumbMessage(`ค้างอีก ${remaining.toFixed(1)} วินาที`);
            }
            return;
        }

        if (this.thumbInProgress || this.thumbCompleted) {
            this.addLogEntry('ยกนิ้วโป้งออกแล้ว');
        }
        this.thumbInProgress = false;
        this.thumbCompleted = false;
        this.updateCameraStatus('รอตรวจจับ', 'status-waiting');
        this.resetThumbIndicator();
    }

    handleArmedSession(data) {
        const ttlMs = data && typeof data.ttl === 'number' ? data.ttl : 6000;
        this.updateSensorStatus('พร้อมตรวจจับ', 'status-online');
        this.updateCameraStatus('รอตรวจจับ', 'status-waiting');
        this.resetThumbIndicator();
        this.thumbInProgress = false;
        this.thumbCompleted = false;
        this.startSessionTimer(ttlMs);
        this.addLogEntry(`เริ่ม session ใหม่ (TTL: ${ttlMs}ms)`);
    }

    handleSessionCancel(data) {
        this.stopSessionTimer();
        this.updateSensorStatus('รอตรวจจับ', 'status-waiting');
        this.updateCameraStatus('รอตรวจจับ', 'status-waiting');
        this.resetThumbIndicator();
        this.thumbInProgress = false;
        this.thumbCompleted = false;
        this.addLogEntry(`Session ถูกยกเลิก: ${data.reason || 'unknown'}`);
    }

    handleSessionStatus(data) {
        if (!data || !data.status) return;
        switch (data.status) {
            case 'armed':
                this.handleArmedSession(data);
                break;
            case 'sensor_detected':
                this.handleSensorDetection(data);
                break;
            case 'thumb_detected':
                if (!this.thumbCompleted) {
                    this.addLogEntry('ตรวจจับนิ้วโป้งครบตามเวลา');
                }
                this.thumbInProgress = true;
                this.thumbCompleted = true;
                this.setThumbProgress(1, 'complete');
                // Fallback: if bridge doesn't publish qr_generated quickly, auto-create from UI
                clearTimeout(this.qrFallbackTimer);
                if (!this.qrRequested) {
                    this.qrFallbackTimer = setTimeout(() => {
                        if (!this.qrRequested) {
                            this.qrRequested = true;
                            this.addLogEntry('Fallback: เรียกสร้าง QR จากหน้าเว็บ');
                            this.createQRAuto();
                        }
                    }, 1500);
                }
                this.setThumbMessage('นิ้วโป้งพร้อมแล้ว');
                this.updateCameraStatus('ตรวจจับนิ้วโป้งแล้ว', 'status-active');
                break;
            case 'qr_generated':
                if (data.qr_data) {
                    this.displayQRCode(data.qr_data);
                }
                clearTimeout(this.qrFallbackTimer);
                this.qrFallbackTimer = null;
                this.qrRequested = false;
                this.updateSensorStatus('รอตรวจจับ', 'status-waiting');
                this.updateCameraStatus('รอตรวจจับ', 'status-waiting');
                this.resetThumbIndicator();
                this.thumbInProgress = false;
                this.thumbCompleted = false;
                break;
            case 'camera_ready':
                this.updateCameraStatus('กล้องพร้อมทำงาน', 'status-online');
                break;
            case 'idle':
                this.handleSessionCancel(data);
                break;
        }
    }

    handleDeviceStatus(data) {
        const online = this.resolveBoolean(data, ['online', 'status', 'value'], data === 'online');

        if (online) {
            this.addLogEntry('ESP32 เชื่อมต่อแล้ว');
            this.updateSensorStatus('รอตรวจจับ', 'status-waiting');
            this.updateCameraStatus('รอตรวจจับ', 'status-waiting');
            this.resetThumbIndicator();
            this.thumbInProgress = false;
            this.thumbCompleted = false;
        } else {
            this.addLogEntry('ESP32 ถูกตัดการเชื่อมต่อ');
            this.updateSensorStatus('อุปกรณ์ออฟไลน์', 'status-offline');
            this.updateCameraStatus('อุปกรณ์ออฟไลน์', 'status-offline');
            this.resetThumbIndicator();
            this.thumbInProgress = false;
            this.thumbCompleted = false;
        }
    }

    startSessionTimer(ttl) {
        this.stopSessionTimer();
        this.timeLeft = ttl / 1000; // แปลงเป็นวินาที
        const timerEl = el('session-timer');

        this.sessionTimer = setInterval(() => {
            this.timeLeft--;
            if (timerEl) timerEl.textContent = `${Math.max(this.timeLeft, 0)}s`;
            
            if (this.timeLeft <= 0) {
                this.stopSessionTimer();
                this.addLogEntry('Session หมดเวลา');
            }
        }, 1000);

        if (timerEl) timerEl.textContent = `${this.timeLeft}s`;
    }

    stopSessionTimer() {
        if (this.sessionTimer) {
            clearInterval(this.sessionTimer);
            this.sessionTimer = null;
        }
        const timerEl = el('session-timer');
        if (timerEl) timerEl.textContent = '0s';
    }

    async createQRAuto() {
        try {
            this.updateQRStatus('กำลังสร้าง QR Code...', 'status-waiting');
            
            const response = await fetch('/api/qr-create', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'X-Auto-Generate': 'true'
                }
            });
            
            const data = await response.json();
            
            if (data.ok && data.qr) {
                this.displayQRCode(data.qr);
                this.addLogEntry(`สร้าง QR Code สำเร็จ: ${data.qr.uuid}`);
            } else {
                throw new Error(data.error || 'สร้าง QR Code ไม่สำเร็จ');
            }
        } catch (error) {
            console.error('QR creation failed:', error);
            this.updateQRStatus('สร้าง QR Code ล้มเหลว', 'status-offline');
            this.addLogEntry(`สร้าง QR Code ล้มเหลว: ${error.message}`);
        }
    }

    async createQRManual() {
        try {
            this.updateQRStatus('กำลังสร้าง QR Code...', 'status-waiting');
            
            const response = await fetch('/api/qr-create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            
            const data = await response.json();
            out(data);
            
            if (data.ok && data.qr) {
                this.displayQRCode(data.qr);
                this.addLogEntry(`สร้าง QR Code ด้วยมือสำเร็จ: ${data.qr.uuid}`);
            }
        } catch (error) {
            console.error('Manual QR creation failed:', error);
            this.updateQRStatus('สร้าง QR Code ล้มเหลว', 'status-offline');
        }
    }

    displayQRCode(qrData) {
        const qrContainer = el('qrcode');
        if (qrContainer) {
            qrContainer.innerHTML = '';

            new QRCode(qrContainer, {
                text: qrData.payload,
                width: 256,
                height: 256,
                colorDark: "#000000",
                colorLight: "#ffffff",
                correctLevel: QRCode.CorrectLevel.H
            });

            qrContainer.classList.add('qr-created');
            setTimeout(() => {
                qrContainer.classList.remove('qr-created');
            }, 1000);
        }

        const uuidEl = el('qr-uuid');
        if (uuidEl) uuidEl.textContent = qrData.uuid;

        const createdEl = el('qr-created');
        if (createdEl) createdEl.textContent = new Date(qrData.created_at).toLocaleString('th-TH');

        const statusEl = el('qr-status');
        if (statusEl) statusEl.textContent = 'สร้างสำเร็จ';

        this.updateQRStatus('สร้างสำเร็จ', 'status-online');
    }

    async checkHealth() {
        try {
            const response = await fetch('/api/health');
            const data = await response.json();
            out(data);
            this.addLogEntry('ตรวจสอบระบบ: ปกติ');
        } catch (error) {
            console.error('Health check failed:', error);
            this.addLogEntry('ตรวจสอบระบบ: ล้มเหลว');
        }
    }

    clearAll() {
        const qrContainer = el('qrcode');
        if (qrContainer) {
            qrContainer.innerHTML = `
                <div class="qr-placeholder">
                    <div class="qr-icon">⌛</div>
                    <p>รอการสร้าง QR Code</p>
                </div>
            `;
        }

        const uuidEl = el('qr-uuid');
        if (uuidEl) uuidEl.textContent = '-';

        const createdEl = el('qr-created');
        if (createdEl) createdEl.textContent = '-';

        const statusEl = el('qr-status');
        if (statusEl) statusEl.textContent = 'รอสร้าง QR Code';

        this.updateSensorStatus('รอตรวจจับ', 'status-waiting');
        this.updateCameraStatus('รอตรวจจับ', 'status-waiting');
        this.resetThumbIndicator();
        this.thumbInProgress = false;
        this.thumbCompleted = false;
        clearTimeout(this.qrFallbackTimer);
        this.qrFallbackTimer = null;
        this.qrRequested = false;
        this.stopSessionTimer();
        this.updateQRStatus('รอการตรวจจับ', 'status-waiting');

        this.addLogEntry('ล้างข้อมูลทั้งหมดแล้ว');
    }

    updateSystemStatus(text, className) {
        const statusEl = el('system-status');
        if (!statusEl) return;
        statusEl.textContent = text;
        statusEl.className = className;
    }

    updateSensorStatus(text, className, resetMs = 0) {
        const statusEl = el('sensor-status');
        if (statusEl) {
            statusEl.textContent = text;
            statusEl.className = className;
        }

        if (this.sensorResetTimer) {
            clearTimeout(this.sensorResetTimer);
            this.sensorResetTimer = null;
        }

        if (resetMs && resetMs > 0) {
            this.sensorResetTimer = setTimeout(() => {
                this.sensorResetTimer = null;
                this.updateSensorStatus(this.sensorDefaultStatus.text, this.sensorDefaultStatus.className);
            }, resetMs);
        }
    }

    updateCameraStatus(text, className, resetMs = 0) {
        const statusEl = el('camera-status');
        if (statusEl) {
            statusEl.textContent = text;
            statusEl.className = className;
        }

        if (this.cameraResetTimer) {
            clearTimeout(this.cameraResetTimer);
            this.cameraResetTimer = null;
        }

        if (resetMs && resetMs > 0) {
            this.cameraResetTimer = setTimeout(() => {
                this.cameraResetTimer = null;
                this.updateCameraStatus(this.cameraDefaultStatus.text, this.cameraDefaultStatus.className);
                this.resetThumbIndicator();
                this.thumbInProgress = false;
                this.thumbCompleted = false;
            }, resetMs);
        }

        const overlay = el('camera-offline');
        if (overlay) {
            const offline = className === 'status-offline';
            overlay.classList.toggle('hidden', !offline);
        }
    }

    updateQRStatus(text, className) {
        const statusEl = el('qr-status-text');
        if (!statusEl) return;
        statusEl.textContent = text;
        statusEl.className = className;
    }

    addLogEntry(message) {
        const logContainer = el('detection-log');
        if (!logContainer) {
            console.log(`[log] ${message}`);
            return;
        }

        const logEntry = document.createElement('div');
        logEntry.className = 'log-entry';
        logEntry.textContent = `[${new Date().toLocaleTimeString('th-TH')}] ${message}`;

        logContainer.appendChild(logEntry);
        logContainer.scrollTop = logContainer.scrollHeight;

        if (logContainer.children.length > 10) {
            logContainer.removeChild(logContainer.firstChild);
        }
    }

    showInstruction(message) {
        this.addLogEntry(message);
        
        // สามารถเพิ่ม notification popup ได้ที่นี่
        if ('Notification' in window && Notification.permission === 'granted') {
            new Notification('ระบบตรวจสอบ', { body: message });
        }
    }
}

// เริ่มต้นระบบเมื่อโหลดหน้าเว็บเสร็จ
document.addEventListener('DOMContentLoaded', () => {
    window.qrSystem = new QRCheckInSystem();
    
    // ขอสิทธิ์การแจ้งเตือน
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }
});
