/**
 * The observed DokiDoki (Chunfeng / Heartbeat Yuanli) BLE protocol,
 * verified against the DK-META2 profile.
 *
 * Everything in this module is pure so frame construction can be tested
 * without a Bluetooth device.
 */
export const SERVICE_UUID = '0000ffac-0000-1000-8000-00805f9b34fb';
export const SERVICE_SHORT_UUID = 'ffac';
export const CHAR_WRITE_RESPONSE = 'ffb5';
export const CHAR_WRITE_NO_RESPONSE = 'ffb7';
export const CHAR_NOTIFY = 'ffb8';
export const CMD_APP_REQUEST = 0x02;
export const CMD_VIBRATION = 0x08;
export const CMD_LINEAR = 0x0b;
export const CMD_ROTARY = 0x0e;
export const CMD_HEARTBEAT = 0xef;
export const DEVICE_PREFIXES = ['TF-', 'DK-', 'TRYFUN-'];
export const DEFAULT_DEVICE_NAME = 'DK-META2';
/** Keep the stop order identical to the official client's ACTIONS_TO_ZERO. */
export const STOP_ACTION_ORDER = ['linear', 'rotary', 'vibration'];
/** All actions supported by the DK-META2 profile. */
export const ACTIONS = ['vibration', 'linear', 'rotary'];
export const DK_META2_PROFILE = {
    name: DEFAULT_DEVICE_NAME,
    protocol: 'dokidoki',
    commands: {
        vibration: CMD_VIBRATION,
        linear: CMD_LINEAR,
        rotary: CMD_ROTARY,
    },
    capabilities: ['vibration', 'linear', 'rotary'],
};
export const PROFILES = {
    [DK_META2_PROFILE.name]: DK_META2_PROFILE,
    'DK-BH2PRO': {
        name: 'DK-BH2PRO',
        protocol: 'dokidoki',
        commands: { linear: 0x0c, vibration: 0x09 },
        capabilities: ['linear', 'vibration'],
        stopCommand: 0xff,
    },
};
/** Normalize the aliases used by the official client. */
export function normalizeProfileName(deviceName) {
    const normalized = (deviceName ?? '').trim().toUpperCase().replace(/\0+$/, '');
    if (normalized.startsWith('TF-'))
        return `DK-${normalized.slice(3)}`;
    return normalized;
}
export function getDeviceProfile(deviceName) {
    return PROFILES[normalizeProfileName(deviceName)];
}
export function isSupportedDeviceName(deviceName) {
    const normalized = (deviceName ?? '').trim().toUpperCase().replace(/\0+$/, '');
    return DEVICE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}
function asBytes(values) {
    const result = [...values];
    for (const value of result) {
        if (!Number.isInteger(value) || value < 0 || value > 0xff) {
            throw new Error('BLE frame bytes must be integers between 0 and 255');
        }
    }
    return result;
}
/** Two's-complement byte checksum used by the official app. */
export function calculateChecksum(payload) {
    const bytes = asBytes(payload);
    const sum = bytes.reduce((acc, value) => acc + value, 0);
    return -sum & 0xff;
}
/**
 * Build one DokiDoki frame.
 *
 * The official client uses a single frame (total/current = 1/0). The
 * checksum covers the payload only, matching its JavaScript implementation.
 *
 * Layout: [message_id] [command_type] [0x00] [length] [...payload] [checksum]
 */
export function buildFrame(messageId, commandType, payload) {
    if (!Number.isInteger(messageId) || messageId < 1 || messageId > 15) {
        throw new Error('message_id must be an integer from 1 to 15');
    }
    if (!Number.isInteger(commandType) || commandType < 0 || commandType > 0xff) {
        throw new Error('command_type must be an integer from 0 to 255');
    }
    const payloadBytes = asBytes(payload);
    const length = payloadBytes.length + 1;
    if (length > 0xff)
        throw new Error('BLE payload is too large');
    const frame = new Uint8Array(4 + payloadBytes.length + 1);
    frame[0] = messageId & 0x0f;
    frame[1] = commandType;
    frame[2] = 0x00;
    frame[3] = length;
    frame.set(payloadBytes, 4);
    frame[frame.length - 1] = calculateChecksum(payloadBytes);
    return frame;
}
export function buildCommandFrame(messageId, command, value) {
    return buildFrame(messageId, CMD_APP_REQUEST, [command, value]);
}
export function buildActionFrame(messageId, action, level, profile = DK_META2_PROFILE) {
    const command = profile.commands[action];
    if (command === undefined)
        throw new Error(`${profile.name} does not support action '${action}'`);
    if (!Number.isInteger(level) || level < 0 || level > 100) {
        throw new Error('level must be an integer from 0 to 100');
    }
    return buildCommandFrame(messageId, command, level);
}
export function buildHeartbeatFrame(messageId) {
    return buildCommandFrame(messageId, CMD_HEARTBEAT, 0x01);
}
/** Cycle message IDs in the same 1..15 range as the official client. */
export class MessageIdGenerator {
    current = 0;
    reset() {
        this.current = 0;
    }
    next() {
        this.current = this.current >= 15 ? 1 : this.current + 1;
        return this.current;
    }
}
/** Normalize a BLE address to the AA:BB:CC:DD:EE:FF form when possible. */
export function normalizeAddress(value) {
    const raw = (value ?? '').replace(/[^0-9a-fA-F]/g, '');
    if (raw.length !== 12)
        return (value ?? '').trim().toUpperCase();
    return raw.toUpperCase().replace(/(..)/g, '$1:').slice(0, 17);
}
/** Match a full or short UUID against a short 16-bit UUID like 'ffb5'. */
export function uuidMatches(value, shortUuid) {
    const normalized = (value ?? '').toLowerCase();
    const short = shortUuid.toLowerCase();
    return normalized === short || normalized === `0000${short}-0000-1000-8000-00805f9b34fb`;
}
//# sourceMappingURL=protocol.js.map