/**
 * Yilia abilities (NACAB) — one-shot Chunfeng device controls.
 */

import { NACAB } from '@nyirusu/nasdk'
import { ChunfengError, type ChunfengManager } from '../chunfeng/manager.js'
import { type ChunfengAction } from '../chunfeng/protocol.js'

const ACTIONS: ChunfengAction[] = ['vibration', 'linear', 'rotary']

function asRecord(payload: unknown): Record<string, unknown> {
  if (payload === null || payload === undefined) return {}
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ChunfengError('invalid_payload', 'payload 必须是对象。')
  }
  return payload as Record<string, unknown>
}

function readLevel(payload: Record<string, unknown>): number {
  const level = payload['level']
  if (!Number.isInteger(level) || (level as number) < 0 || (level as number) > 100) {
    throw new ChunfengError('invalid_level', 'level 必须是 0 到 100 的整数。')
  }
  return level as number
}

function readConfirm(payload: Record<string, unknown>): boolean {
  return payload['confirm'] === true
}

function readAction(payload: Record<string, unknown>): ChunfengAction {
  const action = payload['action']
  if (typeof action !== 'string' || !ACTIONS.includes(action as ChunfengAction)) {
    throw new ChunfengError('invalid_action', `action 必须是 ${ACTIONS.join(' / ')}。`)
  }
  return action as ChunfengAction
}

export function createYiliaAbilities(manager: ChunfengManager): NACAB {
  const nacab = new NACAB()

  nacab.register({
    name: 'yilia.scan',
    description: '扫描附近支持的春风（DokiDoki）BLE 设备，不发送任何动作。',
    execute: (payload) => {
      const p = asRecord(payload)
      const timeoutMs = p['timeoutMs'] === undefined ? undefined : Number(p['timeoutMs'])
      const prefix = p['prefix'] === undefined ? undefined : String(p['prefix'])
      return manager.scan({ timeoutMs, prefix })
    },
  })

  nacab.register({
    name: 'yilia.connect',
    description: '连接指定的春风设备并发现 GATT 能力；不传参数时连接默认设备。',
    execute: (payload) => {
      const p = asRecord(payload)
      const address = p['address'] === undefined ? undefined : String(p['address'])
      const name = p['name'] === undefined ? undefined : String(p['name'])
      return manager.connect({ address, name })
    },
  })

  nacab.register({
    name: 'yilia.disconnect',
    description: '停止心跳、将所有输出归零并断开设备连接。',
    execute: () => manager.disconnect(true),
  })

  nacab.register({
    name: 'yilia.status',
    description: '查看 yilia 当前持有的设备连接状态。',
    execute: () => manager.status(),
  })

  nacab.register({
    name: 'yilia.set',
    description: '设置指定动作（vibration/linear/rotary）的强度 0-100；非零需要 confirm=true。',
    execute: (payload) => {
      const p = asRecord(payload)
      return manager.setAction(readAction(p), readLevel(p), readConfirm(p))
    },
  })

  for (const action of ACTIONS) {
    nacab.register({
      name: `yilia.${action}`,
      description: `设置${action === 'vibration' ? '震动' : action === 'linear' ? '伸缩' : '旋转'}强度 0-100；非零需要 confirm=true。`,
      execute: (payload) => {
        const p = asRecord(payload)
        return manager.setAction(action, readLevel(p), readConfirm(p))
      },
    })
  }

  nacab.register({
    name: 'yilia.stop',
    description: '立即将所有已支持输出归零（linear → rotary → vibration）。',
    execute: () => manager.stop(),
  })

  return nacab
}
