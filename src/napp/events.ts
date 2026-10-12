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

import { NACEB, PipelineHandler, TaskHandler, TERMINAL } from '@nyirusu/nasdk/NACEB'
import type { NormalSignal } from '@nyirusu/nasdk/NACEB'
import { ChunfengError, type ChunfengManager } from '../chunfeng/manager.js'
import type { ChunfengAction } from '../chunfeng/protocol.js'

export const DEVICE_BUSY_KEY = 'yilia-device'

const ACTIONS: ChunfengAction[] = ['vibration', 'linear', 'rotary']
const MAX_STEP_DURATION_MS = 60_000

/* ------------------------------------------------------------------ */
/* shared helpers                                                      */
/* ------------------------------------------------------------------ */

function abortableSleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false)
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve(!signal.aborted)
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

type SessionCommand =
  | { action: ChunfengAction; level: number; confirm?: boolean }
  | { op: 'stop' }
  | { op: 'end' }

interface SessionSharedState {
  inbox?: SessionCommand[]
  waiter?: () => void
  [key: string]: unknown
}

function parseSessionCommand(raw: unknown): SessionCommand {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ChunfengError('invalid_signal', 'session 信号必须是对象。')
  }
  const p = raw as Record<string, unknown>
  if (p['op'] === 'stop' || p['op'] === 'end') return { op: p['op'] }
  const action = p['action']
  if (typeof action !== 'string' || !ACTIONS.includes(action as ChunfengAction)) {
    throw new ChunfengError('invalid_action', `action 必须是 ${ACTIONS.join(' / ')}。`)
  }
  const level = p['level']
  if (!Number.isInteger(level) || (level as number) < 0 || (level as number) > 100) {
    throw new ChunfengError('invalid_level', 'level 必须是 0 到 100 的整数。')
  }
  return { action: action as ChunfengAction, level: level as number, confirm: p['confirm'] === true }
}

function pushCommand(state: SessionSharedState, command: SessionCommand): void {
  state.inbox ??= []
  state.inbox.push(command)
  const waiter = state.waiter
  state.waiter = undefined
  waiter?.()
}

function waitForCommand(state: SessionSharedState, signal: AbortSignal): Promise<SessionCommand | null> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(null)
    const queued = state.inbox?.shift()
    if (queued !== undefined) return resolve(queued)
    const done = (command: SessionCommand | null) => {
      signal.removeEventListener('abort', onAbort)
      if (state.waiter === onWake) state.waiter = undefined
      resolve(command)
    }
    const onAbort = () => done(null)
    const onWake = () => done(state.inbox?.shift() ?? null)
    state.waiter = onWake
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/* ------------------------------------------------------------------ */
/* yilia.session                                                       */
/* ------------------------------------------------------------------ */

interface SessionPayload {
  address?: string
  name?: string
  keepConnected?: boolean
}

class SessionPipeline extends PipelineHandler {
  readonly name = 'yilia-session'
  override readonly description = '春风设备交互控制会话：normal 信号注入动作，pause 归零，abort 停止并收尾。'

  override next(lastResult: unknown) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const self = this as any
    if (lastResult === undefined) {
      const state = self.state as SessionSharedState
      state.inbox = []
      return { task: 'yilia-session-task', input: self.event.payload }
    }
    return { task: TERMINAL, input: lastResult }
  }

  override onNormalSIG(signal: NormalSignal): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pushCommand((this as any).state as SessionSharedState, parseSessionCommand(signal.payload))
  }
}

/* ------------------------------------------------------------------ */
/* yilia.sequence                                                      */
/* ------------------------------------------------------------------ */

interface SequenceStep {
  action: ChunfengAction
  level: number
  durationMs: number
}

interface SequencePayload {
  steps: SequenceStep[]
  confirm: boolean
  stopOnEnd: boolean
}

function parseSequencePayload(raw: unknown): SequencePayload {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ChunfengError('invalid_payload', 'sequence payload 必须是对象。')
  }
  const p = raw as Record<string, unknown>
  const stepsRaw = p['steps']
  if (!Array.isArray(stepsRaw) || stepsRaw.length === 0) {
    throw new ChunfengError('invalid_payload', 'steps 必须是非空数组。')
  }
  if (stepsRaw.length > 256) {
    throw new ChunfengError('invalid_payload', 'steps 不能超过 256 步。')
  }
  const steps: SequenceStep[] = stepsRaw.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new ChunfengError('invalid_payload', `steps[${index}] 必须是对象。`)
    }
    const step = item as Record<string, unknown>
    const action = step['action']
    if (typeof action !== 'string' || !ACTIONS.includes(action as ChunfengAction)) {
      throw new ChunfengError('invalid_action', `steps[${index}].action 必须是 ${ACTIONS.join(' / ')}。`)
    }
    const level = step['level']
    if (!Number.isInteger(level) || (level as number) < 0 || (level as number) > 100) {
      throw new ChunfengError('invalid_level', `steps[${index}].level 必须是 0 到 100 的整数。`)
    }
    const durationMsRaw = step['durationMs'] ?? 1000
    if (typeof durationMsRaw !== 'number' || !Number.isFinite(durationMsRaw)) {
      throw new ChunfengError('invalid_payload', `steps[${index}].durationMs 必须是数字。`)
    }
    return {
      action: action as ChunfengAction,
      level: level as number,
      durationMs: Math.max(0, Math.min(durationMsRaw, MAX_STEP_DURATION_MS)),
    }
  })
  return { steps, confirm: p['confirm'] === true, stopOnEnd: p['stopOnEnd'] !== false }
}

class SequencePipeline extends PipelineHandler {
  readonly name = 'yilia-sequence'
  override readonly description = '按 steps 顺序执行春风动作序列；abort 立即停止全部输出。'

  override next(lastResult: unknown) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const self = this as any
    const payload = parseSequencePayload(self.event.payload)
    const state = self.state as { index?: number; stopSent?: boolean }

    if (lastResult === undefined) state.index = 0
    else if ((state.index ?? 0) < payload.steps.length) state.index = (state.index ?? 0) + 1

    const index = state.index ?? 0
    if (index < payload.steps.length) {
      return {
        task: 'yilia-apply',
        input: { step: payload.steps[index], confirm: payload.confirm, index, total: payload.steps.length },
      }
    }
    if (payload.stopOnEnd && !state.stopSent) {
      state.stopSent = true
      return { task: 'yilia-stop', input: { reason: 'sequence-end' } }
    }
    return { task: TERMINAL, input: { ok: true, completed: payload.steps.length, stopOnEnd: payload.stopOnEnd } }
  }
}

/* ------------------------------------------------------------------ */
/* factory — task handlers close over the manager                      */
/* ------------------------------------------------------------------ */

export function createYiliaEvents(manager: ChunfengManager): NACEB {
  class SessionTask extends TaskHandler<{ ended: boolean; reason: string }> {
    readonly name = 'yilia-session-task'
    override readonly busyKeys = [DEVICE_BUSY_KEY]

    override async execute(): Promise<{ ended: boolean; reason: string }> {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const self = this as any
      const input = (self.input ?? {}) as SessionPayload
      const state = self.pipeline.state as SessionSharedState
      const abortSignal: AbortSignal = self.abortSignal
      const report = (chunk: unknown) => self.processingResultReport(chunk)

      const wasConnected = manager.isConnected
      if (!wasConnected) {
        await manager.connect({ address: input.address, name: input.name })
      }
      report({ type: 'ready', status: manager.status() })

      let reason = 'end'
      try {
        for (;;) {
          const command = await waitForCommand(state, abortSignal)
          if (command === null) {
            reason = 'aborted'
            break
          }
          if ('op' in command && command.op === 'end') break
          if ('op' in command && command.op === 'stop') {
            const result = await manager.stop()
            report({ type: 'stopped', result })
            continue
          }
          if ('action' in command) {
            const result = await manager.setAction(command.action, command.level, command.confirm === true)
            report({ type: 'applied', result })
          }
        }
      } finally {
        await manager.stop().catch(() => {})
        if (!wasConnected && !input.keepConnected) {
          await manager.disconnect(false).catch(() => {})
        }
      }
      return { ended: true, reason }
    }
  }

  class ApplyTask extends TaskHandler<{ action: ChunfengAction; level: number; durationMs: number }> {
    readonly name = 'yilia-apply'
    override readonly busyKeys = [DEVICE_BUSY_KEY]

    override async execute(): Promise<{ action: ChunfengAction; level: number; durationMs: number }> {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const self = this as any
      const input = self.input as { step: SequenceStep; confirm: boolean; index: number; total: number }
      const { step, confirm, index, total } = input

      await manager.setAction(step.action, step.level, confirm)
      self.processingResultReport({ type: 'applied', index, total, action: step.action, level: step.level })

      const completed = await abortableSleep(step.durationMs, self.abortSignal as AbortSignal)
      if (!completed) {
        // Aborted mid-step: onSignal already zeroed the outputs.
        self.processingResultReport({ type: 'interrupted', index, total, action: step.action })
      }
      return { action: step.action, level: step.level, durationMs: step.durationMs }
    }

    override async onSignal(signal: { kind: string }): Promise<void> {
      if (signal.kind === 'abort') await manager.stop().catch(() => {})
    }
  }

  class StopTask extends TaskHandler<unknown> {
    readonly name = 'yilia-stop'
    override readonly busyKeys = [DEVICE_BUSY_KEY]

    override async execute(): Promise<unknown> {
      return manager.stop()
    }
  }

  return new NACEB({
    pipelineHandlers: [new SessionPipeline(), new SequencePipeline()],
    taskHandlers: [new SessionTask(), new ApplyTask(), new StopTask()],
    eventAlias: [
      {
        eventName: 'yilia.session',
        pipelineName: 'yilia-session',
        description:
          '交互控制会话：payload {address?, name?, keepConnected?}；normal 信号 {action, level, confirm?} | {op:"stop"} | {op:"end"}；pause 归零输出；abort 停止并收尾。',
      },
      {
        eventName: 'yilia.sequence',
        pipelineName: 'yilia-sequence',
        description:
          '序列控制：payload {steps: [{action, level, durationMs?}], confirm, stopOnEnd?}；abort 信号立即停止全部输出。',
      },
    ],
  })
}
