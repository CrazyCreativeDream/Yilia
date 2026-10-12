/**
 * noble BLE backend — used on Windows (WinRT bindings built into
 * @abandonware/noble) and as a fallback on other desktop platforms.
 *
 * The package is an optional dependency: it is imported lazily so that
 * Linux installs never need its native toolchain.
 */
import { type BleBackend, type BleConnection, type BleDeviceInfo, type ConnectOptions, type ScanOptions } from './types.js';
export declare class NobleBackend implements BleBackend {
    readonly name = "noble";
    private noble;
    private ensureReady;
    isAvailable(): Promise<boolean>;
    scan(options?: ScanOptions): Promise<BleDeviceInfo[]>;
    private findPeripheral;
    connect(address: string, options: ConnectOptions): Promise<BleConnection>;
    dispose(): Promise<void>;
}
