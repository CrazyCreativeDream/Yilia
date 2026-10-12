/**
 * noble BLE backend — used on Windows (WinRT bindings built into
 * @abandonware/noble) and as a fallback on other desktop platforms.
 *
 * The package is an optional dependency: it is imported lazily so that
 * Linux installs never need its native toolchain.
 */
import { normalizeAddress, uuidMatches } from '../chunfeng/protocol.js';
import { BleDeviceNotFoundError, BleError, BleUnavailableError, } from './types.js';
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function peripheralAddress(peripheral) {
    return normalizeAddress(peripheral.address || peripheral.id || '');
}
export class NobleBackend {
    name = 'noble';
    noble = null;
    async ensureReady() {
        if (this.noble)
            return this.noble;
        let mod;
        try {
            mod = await import('@abandonware/noble');
        }
        catch (err) {
            throw new BleUnavailableError(`noble 后端不可用（@abandonware/noble 未安装或加载失败）：${err instanceof Error ? err.message : String(err)}`);
        }
        const noble = mod.default ?? mod;
        try {
            await noble.waitForPoweredOnAsync();
        }
        catch (err) {
            throw new BleUnavailableError(`蓝牙适配器未就绪（请确认蓝牙已开启且有权限）：${err instanceof Error ? err.message : String(err)}`);
        }
        this.noble = noble;
        return noble;
    }
    async isAvailable() {
        try {
            await this.ensureReady();
            return true;
        }
        catch {
            return false;
        }
    }
    async scan(options) {
        const noble = await this.ensureReady();
        const timeoutMs = Math.max(500, Math.min(options?.timeoutMs ?? 5000, 30_000));
        const found = new Map();
        const onDiscover = (peripheral) => {
            const name = String(peripheral.advertisement?.localName ?? '').trim();
            const address = peripheralAddress(peripheral);
            if (!address)
                return;
            const info = { name, address };
            if (typeof peripheral.rssi === 'number')
                info.rssi = peripheral.rssi;
            if (options?.filter && !options.filter(info))
                return;
            found.set(address, info);
        };
        noble.on('discover', onDiscover);
        try {
            await noble.startScanningAsync([], true);
            await sleep(timeoutMs);
        }
        finally {
            await noble.stopScanningAsync().catch(() => { });
            noble.removeListener('discover', onDiscover);
        }
        return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
    }
    async findPeripheral(address, timeoutMs) {
        const noble = await this.ensureReady();
        const target = normalizeAddress(address);
        let discovered = null;
        const onDiscover = (peripheral) => {
            if (peripheralAddress(peripheral) === target)
                discovered = peripheral;
        };
        noble.on('discover', onDiscover);
        try {
            await noble.startScanningAsync([], true);
            const deadline = Date.now() + timeoutMs;
            while (!discovered && Date.now() < deadline)
                await sleep(200);
        }
        finally {
            await noble.stopScanningAsync().catch(() => { });
            noble.removeListener('discover', onDiscover);
        }
        if (!discovered)
            throw new BleDeviceNotFoundError(`在 ${timeoutMs}ms 内未发现设备 ${target}`);
        return discovered;
    }
    async connect(address, options) {
        const peripheral = await this.findPeripheral(address, options.scanTimeoutMs ?? 10_000);
        await peripheral.connectAsync();
        const shortWanted = options.characteristicUuids.map((uuid) => uuid.toLowerCase());
        const { services, characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync([options.serviceUuid], shortWanted);
        const serviceUuids = (services ?? []).map((service) => service.uuid.toLowerCase());
        const charMap = new Map();
        for (const char of characteristics ?? []) {
            const uuid = String(char.uuid).toLowerCase();
            for (const wanted of shortWanted) {
                if (uuidMatches(uuid, wanted) || uuidMatches(wanted, uuid))
                    charMap.set(wanted, char);
            }
        }
        return new NobleConnection(peripheralAddress(peripheral), peripheral, charMap, serviceUuids);
    }
    async dispose() {
        // noble has no global teardown; individual peripherals disconnect themselves.
    }
}
class NobleConnection {
    address;
    peripheral;
    characteristics;
    serviceUuids;
    backendName = 'noble';
    connected = true;
    constructor(address, peripheral, characteristics, serviceUuids) {
        this.address = address;
        this.peripheral = peripheral;
        this.characteristics = characteristics;
        this.serviceUuids = serviceUuids;
        this.peripheral.once('disconnect', () => {
            this.connected = false;
            for (const handler of this.disconnectHandlers)
                handler();
        });
    }
    disconnectHandlers = [];
    isConnected() {
        return this.connected;
    }
    async listServiceUuids() {
        return [...this.serviceUuids];
    }
    characteristic(charUuid) {
        const wanted = charUuid.toLowerCase();
        const char = this.characteristics.get(wanted) ??
            [...this.characteristics.entries()].find(([known]) => uuidMatches(known, wanted) || uuidMatches(wanted, known))?.[1];
        if (!char)
            throw new BleError('gatt_error', `特征 ${charUuid} 不在已发现集合中`);
        return char;
    }
    async write(charUuid, data, withResponse) {
        await this.characteristic(charUuid).writeAsync(Buffer.from(data), !withResponse);
    }
    async subscribe(charUuid, handler) {
        const char = this.characteristic(charUuid);
        char.on('data', (data) => handler(new Uint8Array(data)));
        await char.subscribeAsync();
    }
    onDisconnect(handler) {
        this.disconnectHandlers.push(handler);
    }
    async disconnect() {
        this.connected = false;
        await this.peripheral.disconnectAsync().catch(() => { });
    }
}
//# sourceMappingURL=noble.js.map