/**
 * Assemble the yilia NApp: ChunfengManager + NACAB abilities + NACEB events
 * + WebSocket / Streamable HTTP server transports.
 */
import { NApp } from '@nyirusu/nasdk';
import { type BleBackend, type BleBackendKind } from '../ble/index.js';
import { ChunfengManager } from '../chunfeng/manager.js';
export interface YiliaEndpointOptions {
    host: string;
    port: number;
    path?: string;
}
export interface YiliaAppOptions {
    /** NApp id. Default 'yilia'. */
    id?: string;
    /** BLE backend: 'auto' (default) | 'bluez' | 'noble', or a ready instance. */
    backend?: BleBackendKind | BleBackend;
    /** WebSocket entry. Default { host: '127.0.0.1', port: 18900, path: '/nacp' }. false disables. */
    websocket?: YiliaEndpointOptions | false;
    /** Streamable HTTP entry. Default { host: '127.0.0.1', port: 18901, path: '/nacp' }. false disables. */
    stream?: YiliaEndpointOptions | false;
    /** Default device name (env YILIA_DEVICE_NAME). */
    deviceName?: string;
    /** Default device address (env YILIA_DEVICE_ADDRESS). */
    deviceAddress?: string;
    /**
     * Server-side failure log sink. Default console.error; false disables.
     * NASDK only sends the failure FACT to callers ('processor-failed') — the
     * reason is printed here, on the server.
     */
    logger?: ((message: string) => void) | false;
}
export declare const DEFAULT_WEBSOCKET_ENDPOINT: YiliaEndpointOptions;
export declare const DEFAULT_STREAM_ENDPOINT: YiliaEndpointOptions;
export interface YiliaApp {
    readonly app: NApp;
    readonly manager: ChunfengManager;
    readonly backend: BleBackend;
    start(): Promise<void>;
    terminate(): Promise<void>;
}
export declare function createYiliaApp(options?: YiliaAppOptions): Promise<YiliaApp>;
