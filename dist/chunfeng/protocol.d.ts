/**
 * The observed DokiDoki (Chunfeng / Heartbeat Yuanli) BLE protocol,
 * verified against the DK-META2 profile.
 *
 * Everything in this module is pure so frame construction can be tested
 * without a Bluetooth device.
 */
export declare const SERVICE_UUID = "0000ffac-0000-1000-8000-00805f9b34fb";
export declare const SERVICE_SHORT_UUID = "ffac";
export declare const CHAR_WRITE_RESPONSE = "ffb5";
export declare const CHAR_WRITE_NO_RESPONSE = "ffb7";
export declare const CHAR_NOTIFY = "ffb8";
export declare const CMD_APP_REQUEST = 2;
export declare const CMD_VIBRATION = 8;
export declare const CMD_LINEAR = 11;
export declare const CMD_ROTARY = 14;
export declare const CMD_HEARTBEAT = 239;
export declare const DEVICE_PREFIXES: readonly ["TF-", "DK-", "TRYFUN-"];
export declare const DEFAULT_DEVICE_NAME = "DK-META2";
/** Keep the stop order identical to the official client's ACTIONS_TO_ZERO. */
export declare const STOP_ACTION_ORDER: readonly ["linear", "rotary", "vibration"];
export type ChunfengAction = 'vibration' | 'linear' | 'rotary';
/** All actions supported by the DK-META2 profile. */
export declare const ACTIONS: readonly ["vibration", "linear", "rotary"];
export interface DeviceProfile {
    name: string;
    protocol: string;
    commands: Partial<Record<ChunfengAction, number>>;
    capabilities: ChunfengAction[];
    stopCommand?: number;
}
export declare const DK_META2_PROFILE: DeviceProfile;
export declare const PROFILES: Readonly<Record<string, DeviceProfile>>;
/** Normalize the aliases used by the official client. */
export declare function normalizeProfileName(deviceName: string | null | undefined): string;
export declare function getDeviceProfile(deviceName: string | null | undefined): DeviceProfile | undefined;
export declare function isSupportedDeviceName(deviceName: string | null | undefined): boolean;
/** Two's-complement byte checksum used by the official app. */
export declare function calculateChecksum(payload: Iterable<number>): number;
/**
 * Build one DokiDoki frame.
 *
 * The official client uses a single frame (total/current = 1/0). The
 * checksum covers the payload only, matching its JavaScript implementation.
 *
 * Layout: [message_id] [command_type] [0x00] [length] [...payload] [checksum]
 */
export declare function buildFrame(messageId: number, commandType: number, payload: Iterable<number>): Uint8Array;
export declare function buildCommandFrame(messageId: number, command: number, value: number): Uint8Array;
export declare function buildActionFrame(messageId: number, action: ChunfengAction, level: number, profile?: DeviceProfile): Uint8Array;
export declare function buildHeartbeatFrame(messageId: number): Uint8Array;
/** Cycle message IDs in the same 1..15 range as the official client. */
export declare class MessageIdGenerator {
    private current;
    reset(): void;
    next(): number;
}
/** Normalize a BLE address to the AA:BB:CC:DD:EE:FF form when possible. */
export declare function normalizeAddress(value: string | null | undefined): string;
/** Match a full or short UUID against a short 16-bit UUID like 'ffb5'. */
export declare function uuidMatches(value: string | null | undefined, shortUuid: string): boolean;
