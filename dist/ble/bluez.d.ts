/**
 * BlueZ (D-Bus) BLE backend — the preferred backend on Linux.
 *
 * Pure JavaScript via dbus-next: no native compilation, no HCI socket
 * permissions required beyond the standard `bluetooth` group / D-Bus policy.
 */
import { type BleBackend, type BleConnection, type BleDeviceInfo, type ConnectOptions, type ScanOptions } from './types.js';
export declare class BluezBackend implements BleBackend {
    readonly name = "bluez-dbus";
    private bus;
    private om;
    private adapterPath;
    private adapter;
    private proxyCache;
    isAvailable(): Promise<boolean>;
    private ensureReady;
    private pickAdapter;
    private managedObjects;
    private proxy;
    private getProperty;
    private collectDevices;
    scan(options?: ScanOptions): Promise<BleDeviceInfo[]>;
    private waitForDevicePath;
    private waitForProperty;
    connect(address: string, options: ConnectOptions): Promise<BleConnection>;
    /** Internal helpers used by BluezConnection. */
    writeCharacteristic(charPath: string, data: Uint8Array, withResponse: boolean): Promise<void>;
    startNotify(charPath: string, handler: (data: Uint8Array) => void): Promise<void>;
    rawDisconnect(devicePath: string): Promise<void>;
    isDeviceConnected(devicePath: string): Promise<boolean>;
    onDeviceDisconnect(devicePath: string, handler: () => void): void;
    dispose(): Promise<void>;
}
