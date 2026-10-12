/**
 * Cross-platform BLE central abstraction.
 *
 * Yilia talks to this interface only. Platform backends:
 *  - BlueZ over D-Bus (Linux, preferred)
 *  - noble (Windows, and fallback where available)
 */
export class BleError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'BleError';
        this.code = code;
    }
}
export class BleUnavailableError extends BleError {
    constructor(message) {
        super('ble_unavailable', message);
        this.name = 'BleUnavailableError';
    }
}
export class BleDeviceNotFoundError extends BleError {
    constructor(message) {
        super('device_not_found', message);
        this.name = 'BleDeviceNotFoundError';
    }
}
//# sourceMappingURL=types.js.map