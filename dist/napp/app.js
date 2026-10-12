/**
 * Assemble the yilia NApp: ChunfengManager + NACAB abilities + NACEB events
 * + WebSocket / Streamable HTTP server transports.
 */
import { NApp } from '@nyirusu/nasdk';
import WebSocketServerProvider from '@nyirusu/nact-websocket-server';
import StreamableHTTPServerProvider from '@nyirusu/nact-streamable-http-server';
import { createBleBackend } from '../ble/index.js';
import { ChunfengManager } from '../chunfeng/manager.js';
import { createYiliaAbilities } from './abilities.js';
import { createYiliaEvents } from './events.js';
export const DEFAULT_WEBSOCKET_ENDPOINT = { host: '127.0.0.1', port: 18900, path: '/nacp' };
export const DEFAULT_STREAM_ENDPOINT = { host: '127.0.0.1', port: 18901, path: '/nacp' };
export async function createYiliaApp(options = {}) {
    const backend = typeof options.backend === 'object' && options.backend !== null
        ? options.backend
        : await createBleBackend(options.backend ?? 'auto');
    const manager = new ChunfengManager({
        backend,
        preferredName: options.deviceName,
        preferredAddress: options.deviceAddress,
        onLinkLost: (reason) => {
            app.bus.emit('yilia:link-lost', { reason, at: new Date().toISOString() });
        },
    });
    const websocket = options.websocket === undefined ? DEFAULT_WEBSOCKET_ENDPOINT : options.websocket;
    const stream = options.stream === undefined ? DEFAULT_STREAM_ENDPOINT : options.stream;
    if (websocket === false && stream === false) {
        throw new Error('至少需要一个入口：websocket 与 stream 不能同时禁用。');
    }
    const server = [];
    if (websocket)
        server.push({ type: 'websocket', provider: { ...websocket } });
    if (stream)
        server.push({ type: 'streamable-http', provider: { ...stream } });
    const app = new NApp({ id: options.id ?? 'yilia', server });
    if (websocket)
        app.nact.use(new WebSocketServerProvider());
    if (stream)
        app.nact.use(new StreamableHTTPServerProvider());
    const nacab = createYiliaAbilities(manager);
    const naceb = createYiliaEvents(manager);
    app.bindProcessor('ability', nacab.nacpAdaptor);
    app.bindProcessor('event', naceb.nacpAdaptor);
    // Server-side failure logging. The wire protocol only tells the caller
    // THAT a request failed ('processor-failed'); the reason lives here.
    const logger = options.logger === undefined ? console.error : options.logger;
    if (logger) {
        const stamp = () => new Date().toISOString();
        const formatErr = (err) => {
            if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
                const e = err;
                return `[${String(e.code)}] ${String(e.message)}`;
            }
            return err instanceof Error ? err.message : String(err);
        };
        nacab.eventBusObs.listen('nacab:runtime:error:*', (m) => {
            const name = m?.opt?.name ?? m?.id ?? '?';
            logger(`[yilia][${stamp()}][ability] ${name} 失败：${m?.opt?.error ? formatErr(m.opt.error) : (m?.msg ?? '未知错误')}`);
        });
        naceb.eventBusObs.listen('naceb:runtime:error:*', (m) => {
            logger(`[yilia][${stamp()}][event] ${m?.msg ?? '未知错误'}`);
        });
        naceb.on('afterPushEvent', (e) => {
            naceb.getEvent(e.id)?.afterTFailure(function () {
                const final = this.final;
                const reason = typeof final?.error === 'string' ? final.error : JSON.stringify(final ?? null);
                logger(`[yilia][${stamp()}][event] ${e.name}#${e.id} 失败：${reason}`);
            });
        });
    }
    let started = false;
    return {
        app,
        manager,
        backend,
        async start() {
            if (started)
                return;
            await app.start();
            started = true;
        },
        async terminate() {
            await manager.shutdown().catch(() => { });
            await app.terminate().catch(() => { });
            await backend.dispose().catch(() => { });
        },
    };
}
//# sourceMappingURL=app.js.map