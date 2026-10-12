/**
 * Yilia events (NACEB) — long-running Chunfeng control workflows.
 *
 *  - `yilia.session`  : an interactive control session. Normal signals inject
 *                       commands ({action, level, confirm?} | {op:'stop'} | {op:'end'});
 *                       pause stops the outputs, abort stops and tears down.
 *  - `yilia.sequence` : a scripted sequence of {action, level, durationMs} steps.
 *
 * All device-touching tasks share busyKeys [DEVICE_BUSY_KEY], so the single
 * physical device is never driven by two tasks at once.
 *
 * NOTE: NASDK invokes handlers with `this` bound to the framework instance
 * (TaskInstance / PipelineInstance), never to the handler object — so the
 * manager reaches execute()/onSignal() through closure capture, not `this`.
 */
import { NACEB } from '@nyirusu/nasdk/NACEB';
import { type ChunfengManager } from '../chunfeng/manager.js';
export declare const DEVICE_BUSY_KEY = "yilia-device";
export declare function createYiliaEvents(manager: ChunfengManager): NACEB;
