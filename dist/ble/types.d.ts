/**
 * Cross-platform BLE central abstraction.
 *
 * Yilia talks to this interface only. Platform backends:
 *  - BlueZ over D-Bus (Linux, preferred)
 *  - noble (Windows, and fallback where available)
 */
export interface BleDeviceInfo {
    /** Advertised local name (may be empty). */
    name: string;
    /** Normalized address, AA:BB:CC:DD:EE:FF when known. */
    address: string;
    rssi?: number;
}
export interface ScanOptions {
    /** Scan window. Default 5000. */
    timeoutMs?: number;
    /** Return false to drop a discovered device. */
    filter?: (device: BleDeviceInfo) => boolean;
}
export interface ConnectOptions {
    /** GATT service UUID that must exist on the peripheral. */
    serviceUuid: string;
    /** Characteristic UUIDs (short or long form) to resolve up front. */
    characteristicUuids: string[];
    /** Extra scan window used to locate the peripheral. Default 10000. */
    scanTimeoutMs?: number;
}
export interface BleConnection {
    readonly address: string;
    readonly backendName: string;
    isConnected(): boolean;
    /** UUIDs of all GATT services visible on the peripheral. */
    listServiceUuids(): Promise<string[]>;
    /**
     * Write to a characteristic. `withResponse` selects the ATT write type;
     * the characteristic UUID may be given in short ('ffb5') or long form.
     */
    write(charUuid: string, data: Uint8Array, withResponse: boolean): Promise<void>;
    /** Subscribe to notifications of a characteristic. */
    subscribe(charUuid: string, handler: (data: Uint8Array) => void): Promise<void>;
    /** Register a disconnect observer. */
    onDisconnect(handler: () => void): void;
    disconnect(): Promise<void>;
}
export interface BleBackend {
    readonly name: string;
    /** True when the backend can run on this machine (best-effort check). */
    isAvailable(): Promise<boolean>;
    scan(options?: ScanOptions): Promise<BleDeviceInfo[]>;
    connect(address: string, options: ConnectOptions): Promise<BleConnection>;
    /** Release backend resources (D-Bus connection, noble handles, ...). */
    dispose(): Promise<void>;
}
export declare class BleError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export declare class BleUnavailableError extends BleError {
    constructor(message: string);
}
export declare class BleDeviceNotFoundError extends BleError {
    constructor(message: string);
}
