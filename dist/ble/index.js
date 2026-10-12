/**
 * BLE backend auto-selection.
 *
 * Priority: Linux → BlueZ D-Bus (pure JS, no native build, no root needed
 * beyond the bluetooth group). Windows → noble (WinRT bindings).
 * Any platform can be overridden explicitly.
 */
import process from 'node:process';
import { BluezBackend } from './bluez.js';
import { NobleBackend } from './noble.js';
import { BleUnavailableError } from './types.js';
export * from './types.js';
export { BluezBackend } from './bluez.js';
export { NobleBackend } from './noble.js';
export async function createBleBackend(kind = 'auto') {
    if (kind === 'bluez')
        return new BluezBackend();
    if (kind === 'noble')
        return new NobleBackend();
    // auto: platform preference first, then availability probing.
    const candidates = process.platform === 'linux'
        ? [new BluezBackend(), new NobleBackend()]
        : process.platform === 'win32'
            ? [new NobleBackend(), new BluezBackend()]
            : [new NobleBackend(), new BluezBackend()];
    const failures = [];
    for (const backend of candidates) {
        if (await backend.isAvailable())
            return backend;
        failures.push(backend.name);
    }
    throw new BleUnavailableError(`没有可用的 BLE 后端（已尝试：${failures.join(', ')}）`);
}
//# sourceMappingURL=index.js.map