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
import { NACEB, PipelineHandler, TaskHandler, TERMINAL } from '@nyirusu/nasdk/NACEB';
import { ChunfengError } from '../chunfeng/manager.js';
export const DEVICE_BUSY_KEY = 'yilia-device';
const ACTIONS = ['vibration', 'linear', 'rotary'];
const MAX_STEP_DURATION_MS = 60_000;
/* ------------------------------------------------------------------ */
/* shared helpers                                                      */
/* ------------------------------------------------------------------ */
function abortableSleep(ms, signal) {
    return new Promise((resolve) => {
        if (signal.aborted)
            return resolve(false);
        const timer = setTimeout(done, ms);
        function done() {
            clearTimeout(timer);
            signal.removeEventListener('abort', done);
            resolve(!signal.aborted);
        }
        signal.addEventListener('abort', done, { once: true });
    });
}
function parseSessionCommand(raw) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new ChunfengError('invalid_signal', 'session 信号必须是对象。');
    }
    const p = raw;
    if (p['op'] === 'stop' || p['op'] === 'end')
        return { op: p['op'] };
    const action = p['action'];
    if (typeof action !== 'string' || !ACTIONS.includes(action)) {
        throw new ChunfengError('invalid_action', `action 必须是 ${ACTIONS.join(' / ')}。`);
    }
    const level = p['level'];
    if (!Number.isInteger(level) || level < 0 || level > 100) {
        throw new ChunfengError('invalid_level', 'level 必须是 0 到 100 的整数。');
    }
    return { action: action, level: level, confirm: p['confirm'] === true };
}
function pushCommand(state, command) {
    state.inbox ??= [];
    state.inbox.push(command);
    const waiter = state.waiter;
    state.waiter = undefined;
    waiter?.();
}
function waitForCommand(state, signal) {
    return new Promise((resolve) => {
        if (signal.aborted)
            return resolve(null);
        const queued = state.inbox?.shift();
        if (queued !== undefined)
            return resolve(queued);
        const done = (command) => {
            signal.removeEventListener('abort', onAbort);
            if (state.waiter === onWake)
                state.waiter = undefined;
            resolve(command);
        };
        const onAbort = () => done(null);
        const onWake = () => done(state.inbox?.shift() ?? null);
        state.waiter = onWake;
        signal.addEventListener('abort', onAbort, { once: true });
    });
}
class SessionPipeline extends PipelineHandler {
    name = 'yilia-session';
    description = '春风设备交互控制会话：normal 信号注入动作，pause 归零，abort 停止并收尾。';
    next(lastResult) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const self = this;
        if (lastResult === undefined) {
            const state = self.state;
            state.inbox = [];
            return { task: 'yilia-session-task', input: self.event.payload };
        }
        return { task: TERMINAL, input: lastResult };
    }
    onNormalSIG(signal) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        pushCommand(this.state, parseSessionCommand(signal.payload));
    }
}
function parseSequencePayload(raw) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new ChunfengError('invalid_payload', 'sequence payload 必须是对象。');
    }
    const p = raw;
    const stepsRaw = p['steps'];
    if (!Array.isArray(stepsRaw) || stepsRaw.length === 0) {
        throw new ChunfengError('invalid_payload', 'steps 必须是非空数组。');
    }
    if (stepsRaw.length > 256) {
        throw new ChunfengError('invalid_payload', 'steps 不能超过 256 步。');
    }
    const steps = stepsRaw.map((item, index) => {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) {
            throw new ChunfengError('invalid_payload', `steps[${index}] 必须是对象。`);
        }
        const step = item;
        const action = step['action'];
        if (typeof action !== 'string' || !ACTIONS.includes(action)) {
            throw new ChunfengError('invalid_action', `steps[${index}].action 必须是 ${ACTIONS.join(' / ')}。`);
        }
        const level = step['level'];
        if (!Number.isInteger(level) || level < 0 || level > 100) {
            throw new ChunfengError('invalid_level', `steps[${index}].level 必须是 0 到 100 的整数。`);
        }
        const durationMsRaw = step['durationMs'] ?? 1000;
        if (typeof durationMsRaw !== 'number' || !Number.isFinite(durationMsRaw)) {
            throw new ChunfengError('invalid_payload', `steps[${index}].durationMs 必须是数字。`);
        }
        return {
            action: action,
            level: level,
            durationMs: Math.max(0, Math.min(durationMsRaw, MAX_STEP_DURATION_MS)),
        };
    });
    return { steps, confirm: p['confirm'] === true, stopOnEnd: p['stopOnEnd'] !== false };
}
class SequencePipeline extends PipelineHandler {
    name = 'yilia-sequence';
    description = '按 steps 顺序执行春风动作序列；abort 立即停止全部输出。';
    next(lastResult) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const self = this;
        const payload = parseSequencePayload(self.event.payload);
        const state = self.state;
        if (lastResult === undefined)
            state.index = 0;
        else if ((state.index ?? 0) < payload.steps.length)
            state.index = (state.index ?? 0) + 1;
        const index = state.index ?? 0;
        if (index < payload.steps.length) {
            return {
                task: 'yilia-apply',
                input: { step: payload.steps[index], confirm: payload.confirm, index, total: payload.steps.length },
            };
        }
        if (payload.stopOnEnd && !state.stopSent) {
            state.stopSent = true;
            return { task: 'yilia-stop', input: { reason: 'sequence-end' } };
        }
        return { task: TERMINAL, input: { ok: true, completed: payload.steps.length, stopOnEnd: payload.stopOnEnd } };
    }
}
/* ------------------------------------------------------------------ */
/* factory — task handlers close over the manager                      */
/* ------------------------------------------------------------------ */
export function createYiliaEvents(manager) {
    class SessionTask extends TaskHandler {
        name = 'yilia-session-task';
        busyKeys = [DEVICE_BUSY_KEY];
        async execute() {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const self = this;
            const input = (self.input ?? {});
            const state = self.pipeline.state;
            const abortSignal = self.abortSignal;
            const report = (chunk) => self.processingResultReport(chunk);
            const wasConnected = manager.isConnected;
            if (!wasConnected) {
                await manager.connect({ address: input.address, name: input.name });
            }
            report({ type: 'ready', status: manager.status() });
            let reason = 'end';
            try {
                for (;;) {
                    const command = await waitForCommand(state, abortSignal);
                    if (command === null) {
                        reason = 'aborted';
                        break;
                    }
                    if ('op' in command && command.op === 'end')
                        break;
                    if ('op' in command && command.op === 'stop') {
                        const result = await manager.stop();
                        report({ type: 'stopped', result });
                        continue;
                    }
                    if ('action' in command) {
                        const result = await manager.setAction(command.action, command.level, command.confirm === true);
                        report({ type: 'applied', result });
                    }
                }
            }
            finally {
                await manager.stop().catch(() => { });
                if (!wasConnected && !input.keepConnected) {
                    await manager.disconnect(false).catch(() => { });
                }
            }
            return { ended: true, reason };
        }
    }
    class ApplyTask extends TaskHandler {
        name = 'yilia-apply';
        busyKeys = [DEVICE_BUSY_KEY];
        async execute() {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const self = this;
            const input = self.input;
            const { step, confirm, index, total } = input;
            await manager.setAction(step.action, step.level, confirm);
            self.processingResultReport({ type: 'applied', index, total, action: step.action, level: step.level });
            const completed = await abortableSleep(step.durationMs, self.abortSignal);
            if (!completed) {
                // Aborted mid-step: onSignal already zeroed the outputs.
                self.processingResultReport({ type: 'interrupted', index, total, action: step.action });
            }
            return { action: step.action, level: step.level, durationMs: step.durationMs };
        }
        async onSignal(signal) {
            if (signal.kind === 'abort')
                await manager.stop().catch(() => { });
        }
    }
    class StopTask extends TaskHandler {
        name = 'yilia-stop';
        busyKeys = [DEVICE_BUSY_KEY];
        async execute() {
            return manager.stop();
        }
    }
    return new NACEB({
        pipelineHandlers: [new SessionPipeline(), new SequencePipeline()],
        taskHandlers: [new SessionTask(), new ApplyTask(), new StopTask()],
        eventAlias: [
            {
                eventName: 'yilia.session',
                pipelineName: 'yilia-session',
                description: '交互控制会话：payload {address?, name?, keepConnected?}；normal 信号 {action, level, confirm?} | {op:"stop"} | {op:"end"}；pause 归零输出；abort 停止并收尾。',
            },
            {
                eventName: 'yilia.sequence',
                pipelineName: 'yilia-sequence',
                description: '序列控制：payload {steps: [{action, level, durationMs?}], confirm, stopOnEnd?}；abort 信号立即停止全部输出。',
            },
        ],
    });
}
//# sourceMappingURL=events.js.map