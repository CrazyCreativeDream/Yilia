/**
 * ChunfengManager — owns one BLE connection to a DokiDoki device and
 * exposes safe high-level actions. Ported from the reference implementation
 * in .vendor/chunfeng-yuanli-ai-mcp (heartbeat_yuanli_mcp/device_manager.py).
 */
import { type BleBackend, type BleDeviceInfo } from '../ble/types.js';
import { type ChunfengAction, type DeviceProfile } from './protocol.js';
export declare class ChunfengError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export declare class NotConnectedError extends ChunfengError {
    constructor(message?: string);
}
export declare class UnsupportedDeviceError extends ChunfengError {
    constructor(message: string);
}
export declare class ConfirmationRequiredError extends ChunfengError {
    constructor(message?: string);
}
export interface ScannedDevice extends BleDeviceInfo {
    supported: boolean;
    connected: boolean;
}
export interface ScanResult {
    devices: ScannedDevice[];
    count: number;
    timeoutMs: number;
    backend: string;
}
export interface ConnectArgs {
    address?: string;
    name?: string;
}
export interface LastAction {
    action: string;
    level: number;
    at: string;
}
export interface ChunfengStatus {
    connected: boolean;
    backend: string;
    device: {
        name: string | null;
        address: string | null;
    };
    profile: string | null;
    protocol: string | null;
    capabilities: ChunfengAction[];
    gatt: {
        service: string | null;
        writeWithResponse: string | null;
        writeWithoutResponse: string | null;
        notify: string | null;
    };
    heartbeatRunning: boolean;
    lastAction: LastAction | {
        action: 'stop';
        at: string;
    } | null;
    lastError: string | null;
}
export interface ChunfengManagerOptions {
    backend: BleBackend;
    preferredName?: string;
    preferredAddress?: string;
    /** Heartbeat interval; the official client keeps ~2s. Default 2000. */
    heartbeatIntervalMs?: number;
    /** Called when the link drops unexpectedly or heartbeat fails. */
    onLinkLost?: (reason: string) => void;
}
export declare class ChunfengManager {
    private readonly backend;
    private readonly preferredName;
    private readonly preferredAddress;
    private readonly heartbeatIntervalMs;
    private readonly onLinkLost?;
    private connection;
    private deviceName;
    private deviceAddress;
    private profile;
    private hasWriteResponse;
    private hasWriteNoResponse;
    private hasNotify;
    private heartbeatTimer;
    private readonly messageIds;
    private lastError;
    private lastAction;
    /** Serialize every GATT write (actions + heartbeat share the link). */
    private ioChain;
    constructor(options: ChunfengManagerOptions);
    get isConnected(): boolean;
    get currentProfile(): DeviceProfile | null;
    private withLock;
    scan(options?: {
        timeoutMs?: number;
        prefix?: string;
    }): Promise<ScanResult>;
    connect(args?: ConnectArgs): Promise<ChunfengStatus>;
    status(): ChunfengStatus;
    setAction(action: ChunfengAction, level: number, confirm?: boolean): Promise<{
        ok: true;
        action: ChunfengAction;
        level: number;
        profile: string;
    }>;
    stop(): Promise<{
        ok: boolean;
        stopped: boolean;
        actions: ChunfengAction[];
        reason?: string;
    }>;
    disconnect(sendStop?: boolean): Promise<ChunfengStatus>;
    shutdown(): Promise<void>;
    private requireProfile;
    private writeControl;
    private writeHeartbeat;
    private startHeartbeat;
    private stopHeartbeat;
    private bestEffortStop;
    private handleLinkLost;
}
