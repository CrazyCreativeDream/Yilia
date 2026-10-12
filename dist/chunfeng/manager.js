/**
 * ChunfengManager — owns one BLE connection to a DokiDoki device and
 * exposes safe high-level actions. Ported from the reference implementation
 * in .vendor/chunfeng-yuanli-ai-mcp (heartbeat_yuanli_mcp/device_manager.py).
 */
import { BleDeviceNotFoundError, } from '../ble/types.js';
import { CHAR_NOTIFY, CHAR_WRITE_NO_RESPONSE, CHAR_WRITE_RESPONSE, DEFAULT_DEVICE_NAME, SERVICE_UUID, STOP_ACTION_ORDER, buildActionFrame, buildCommandFrame, buildHeartbeatFrame, getDeviceProfile, isSupportedDeviceName, normalizeAddress, uuidMatches, MessageIdGenerator, } from './protocol.js';
export class ChunfengError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'ChunfengError';
        this.code = code;
    }
}
export class NotConnectedError extends ChunfengError {
    constructor(message = '设备未连接；请先调用 yilia.connect。') {
        super('not_connected', message);
        this.name = 'NotConnectedError';
    }
}
export class UnsupportedDeviceError extends ChunfengError {
    constructor(message) {
        super('unsupported_device', message);
        this.name = 'UnsupportedDeviceError';
    }
}
export class ConfirmationRequiredError extends ChunfengError {
    constructor(message = '非零设备动作需要 confirm=true。') {
        super('confirmation_required', message);
        this.name = 'ConfirmationRequiredError';
    }
}
export class ChunfengManager {
    backend;
    preferredName;
    preferredAddress;
    heartbeatIntervalMs;
    onLinkLost;
    connection = null;
    deviceName = null;
    deviceAddress = null;
    profile = null;
    hasWriteResponse = false;
    hasWriteNoResponse = false;
    hasNotify = false;
    heartbeatTimer = null;
    messageIds = new MessageIdGenerator();
    lastError = null;
    lastAction = null;
    /** Serialize every GATT write (actions + heartbeat share the link). */
    ioChain = Promise.resolve();
    constructor(options) {
        this.backend = options.backend;
        this.preferredName = options.preferredName ?? process.env.YILIA_DEVICE_NAME ?? DEFAULT_DEVICE_NAME;
        const envAddress = options.preferredAddress ?? process.env.YILIA_DEVICE_ADDRESS;
        this.preferredAddress = envAddress ? normalizeAddress(envAddress) : null;
        this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 2000;
        this.onLinkLost = options.onLinkLost;
    }
    get isConnected() {
        return this.connection?.isConnected() === true;
    }
    get currentProfile() {
        return this.profile;
    }
    withLock(fn) {
        const run = this.ioChain.then(fn, fn);
        this.ioChain = run.catch(() => { });
        return run;
    }
    async scan(options) {
        const timeoutMs = Math.max(1000, Math.min(options?.timeoutMs ?? 5000, 20_000));
        const prefix = options?.prefix?.trim().toUpperCase();
        const devices = await this.backend.scan({
            timeoutMs,
            filter: (device) => {
                if (!isSupportedDeviceName(device.name))
                    return false;
                if (prefix && !device.name.toUpperCase().startsWith(prefix))
                    return false;
                return true;
            },
        });
        const scanned = devices.map((device) => ({
            ...device,
            supported: true,
            connected: this.isConnected && device.address === this.deviceAddress,
        }));
        if (this.isConnected && this.deviceAddress && !scanned.some((d) => d.address === this.deviceAddress)) {
            scanned.push({
                name: this.deviceName ?? '',
                address: this.deviceAddress,
                supported: true,
                connected: true,
            });
        }
        return { devices: scanned, count: scanned.length, timeoutMs, backend: this.backend.name };
    }
    async connect(args) {
        let targetAddress = args?.address ? normalizeAddress(args.address) : null;
        let targetName = (args?.name ?? this.preferredName).trim();
        if (!targetAddress) {
            if (this.preferredAddress && (!args?.name || args.name.toUpperCase() === this.preferredName.toUpperCase())) {
                targetAddress = this.preferredAddress;
            }
            else {
                const listing = await this.scan({ timeoutMs: 5000, prefix: args?.name });
                let candidates = listing.devices;
                if (args?.name) {
                    candidates = candidates.filter((d) => d.name.toUpperCase() === args.name.toUpperCase());
                }
                const first = candidates[0];
                if (!first)
                    throw new BleDeviceNotFoundError(`未找到设备 ${args?.name ?? this.preferredName}。`);
                targetAddress = normalizeAddress(first.address);
                targetName = first.name;
            }
        }
        // An address identifies a peripheral, not its model. Never infer META2
        // merely because it is the default name when connecting by address.
        if ((args?.address || this.preferredAddress) && !args?.name) {
            const listing = await this.scan({ timeoutMs: 5000 });
            const actual = listing.devices.find((d) => normalizeAddress(d.address) === targetAddress);
            if (!actual)
                throw new BleDeviceNotFoundError(`无法识别设备 ${targetAddress} 的型号；请扫描设备或显式提供 name。`);
            targetName = actual.name;
        }
        if (this.isConnected && this.deviceAddress === targetAddress)
            return this.status();
        if (this.isConnected)
            await this.disconnect(true);
        const profile = getDeviceProfile(targetName);
        if (!profile)
            throw new UnsupportedDeviceError(`暂不支持设备型号 ${targetName || 'Unknown'}。`);
        const connection = await this.backend.connect(targetAddress, {
            serviceUuid: SERVICE_UUID,
            characteristicUuids: [CHAR_WRITE_RESPONSE, CHAR_WRITE_NO_RESPONSE, CHAR_NOTIFY],
        });
        const serviceUuids = await connection.listServiceUuids();
        if (!serviceUuids.some((uuid) => uuidMatches(uuid, SERVICE_UUID))) {
            await connection.disconnect().catch(() => { });
            const onlyStandard = serviceUuids.length > 0 && serviceUuids.every((uuid) => uuidMatches(uuid, '1800') || uuidMatches(uuid, '1801'));
            throw new ChunfengError('gatt_error', onlyStandard
                ? '未找到 DokiDoki GATT 服务 FFAC；当前只返回标准服务，通常表示官方客户端仍占用设备连接，请先在官方客户端断开设备。'
                : `未找到 DokiDoki GATT 服务 FFAC。当前可见服务：${serviceUuids.join(', ') || '无'}。`);
        }
        this.connection = connection;
        this.deviceName = targetName || DEFAULT_DEVICE_NAME;
        this.deviceAddress = targetAddress;
        this.profile = profile;
        this.hasWriteResponse = true;
        this.hasWriteNoResponse = true;
        this.hasNotify = true;
        this.messageIds.reset();
        this.lastError = null;
        this.lastAction = null;
        connection.onDisconnect(() => this.handleLinkLost('设备连接已断开。'));
        try {
            await connection.subscribe(CHAR_NOTIFY, () => { });
        }
        catch {
            this.hasNotify = false;
        }
        this.startHeartbeat();
        return this.status();
    }
    status() {
        const profile = this.profile;
        return {
            connected: this.isConnected,
            backend: this.backend.name,
            device: { name: this.deviceName, address: this.deviceAddress },
            profile: profile?.name ?? null,
            protocol: profile?.protocol ?? null,
            capabilities: profile ? [...profile.capabilities] : [],
            gatt: {
                service: profile ? SERVICE_UUID : null,
                writeWithResponse: profile && this.hasWriteResponse ? CHAR_WRITE_RESPONSE : null,
                writeWithoutResponse: profile && this.hasWriteNoResponse ? CHAR_WRITE_NO_RESPONSE : null,
                notify: profile && this.hasNotify ? CHAR_NOTIFY : null,
            },
            heartbeatRunning: this.heartbeatTimer !== null,
            lastAction: this.lastAction,
            lastError: this.lastError,
        };
    }
    async setAction(action, level, confirm = false) {
        if (!Number.isInteger(level) || level < 0 || level > 100) {
            throw new ChunfengError('invalid_level', 'level 必须是 0 到 100 的整数。');
        }
        if (level > 0 && !confirm)
            throw new ConfirmationRequiredError();
        const profile = this.requireProfile();
        if (!profile.capabilities.includes(action)) {
            throw new UnsupportedDeviceError(`${profile.name} 不支持 ${action}。`);
        }
        return this.withLock(async () => {
            const frame = buildActionFrame(this.messageIds.next(), action, level, profile);
            await this.writeControl(frame);
            this.lastAction = { action, level, at: new Date().toISOString() };
            return { ok: true, action, level, profile: profile.name };
        });
    }
    async stop() {
        if (!this.isConnected)
            return { ok: true, stopped: false, reason: 'not_connected', actions: [] };
        const profile = this.requireProfile();
        const actions = [];
        await this.withLock(async () => {
            if (profile.stopCommand !== undefined) {
                await this.writeControl(buildCommandFrame(this.messageIds.next(), profile.stopCommand, 0));
                actions.push(...profile.capabilities);
                return;
            }
            for (const action of STOP_ACTION_ORDER) {
                if (!profile.capabilities.includes(action))
                    continue;
                const frame = buildActionFrame(this.messageIds.next(), action, 0, profile);
                try {
                    await this.writeControl(frame);
                    actions.push(action);
                }
                catch (err) {
                    this.lastError = err instanceof Error ? err.message : String(err);
                }
            }
        });
        this.lastAction = { action: 'stop', at: new Date().toISOString() };
        return { ok: actions.length === profile.capabilities.length, stopped: true, actions };
    }
    async disconnect(sendStop = true) {
        this.stopHeartbeat();
        if (sendStop && this.isConnected)
            await this.bestEffortStop();
        const connection = this.connection;
        this.connection = null;
        this.deviceName = null;
        this.deviceAddress = null;
        this.profile = null;
        this.hasWriteResponse = false;
        this.hasWriteNoResponse = false;
        this.hasNotify = false;
        this.messageIds.reset();
        if (connection)
            await connection.disconnect().catch(() => { });
        return this.status();
    }
    async shutdown() {
        await this.disconnect(true);
    }
    requireProfile() {
        if (!this.isConnected || !this.profile)
            throw new NotConnectedError();
        return this.profile;
    }
    async writeControl(frame) {
        const connection = this.connection;
        if (!connection || !connection.isConnected())
            throw new NotConnectedError('设备连接已断开。');
        // Prefer the no-response characteristic for control frames, like the reference client.
        if (this.hasWriteNoResponse)
            await connection.write(CHAR_WRITE_NO_RESPONSE, frame, false);
        else
            await connection.write(CHAR_WRITE_RESPONSE, frame, true);
    }
    async writeHeartbeat() {
        const connection = this.connection;
        if (!connection || !connection.isConnected())
            return;
        const frame = buildHeartbeatFrame(this.messageIds.next());
        // Heartbeat goes to the with-response characteristic when available.
        if (this.hasWriteResponse)
            await connection.write(CHAR_WRITE_RESPONSE, frame, true);
        else
            await connection.write(CHAR_WRITE_NO_RESPONSE, frame, false);
    }
    startHeartbeat() {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            void this.withLock(async () => {
                if (!this.isConnected)
                    return;
                try {
                    await this.writeHeartbeat();
                }
                catch (err) {
                    this.lastError = err instanceof Error ? err.message : String(err);
                    this.stopHeartbeat();
                    await this.bestEffortStop();
                    await this.disconnect(false);
                    this.onLinkLost?.(`心跳失败，已停止输出并断开：${this.lastError}`);
                }
            });
        }, this.heartbeatIntervalMs);
        this.heartbeatTimer.unref?.();
    }
    stopHeartbeat() {
        if (this.heartbeatTimer !== null) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }
    async bestEffortStop() {
        if (!this.isConnected || !this.profile)
            return;
        try {
            await this.withLock(async () => {
                if (this.profile?.stopCommand !== undefined) {
                    await this.writeControl(buildCommandFrame(this.messageIds.next(), this.profile.stopCommand, 0));
                    return;
                }
                for (const action of STOP_ACTION_ORDER) {
                    if (!this.profile?.capabilities.includes(action))
                        continue;
                    const frame = buildActionFrame(this.messageIds.next(), action, 0, this.profile);
                    await this.writeControl(frame).catch(() => { });
                }
            });
        }
        catch (err) {
            this.lastError = err instanceof Error ? err.message : String(err);
        }
    }
    handleLinkLost(reason) {
        this.lastError = reason;
        // The connection is already down when this fires; guard on whether the
        // manager still holds it so the notification fires exactly once.
        if (this.connection !== null) {
            this.stopHeartbeat();
            this.connection = null;
            this.deviceName = null;
            this.deviceAddress = null;
            this.profile = null;
            this.messageIds.reset();
            this.onLinkLost?.(reason);
        }
    }
}
//# sourceMappingURL=manager.js.map