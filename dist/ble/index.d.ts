/**
 * BLE backend auto-selection.
 *
 * Priority: Linux → BlueZ D-Bus (pure JS, no native build, no root needed
 * beyond the bluetooth group). Windows → noble (WinRT bindings).
 * Any platform can be overridden explicitly.
 */
import { type BleBackend } from './types.js';
export * from './types.js';
export { BluezBackend } from './bluez.js';
export { NobleBackend } from './noble.js';
export type BleBackendKind = 'auto' | 'bluez' | 'noble';
export declare function createBleBackend(kind?: BleBackendKind): Promise<BleBackend>;
