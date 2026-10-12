/**
 * The wire protocol only tells the caller THAT a request failed
 * ('processor-failed'). The server MUST print the reason locally.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { NApp } from '@nyirusu/nasdk'
import WebSocketClientProvider from '@nyirusu/nact-websocket-client'
import { createYiliaApp } from '../src/napp/app.js'
import { SERVICE_UUID } from '../src/chunfeng/protocol.js'
import type { BleBackend, BleConnection, BleDeviceInfo } from '../src/ble/types.js'

const WS_PORT = 18912

class FakeConnection implements BleConnection {
  readonly backendName = 'fake'
  constructor(readonly address: string) {}
  isConnected(): boolean {
    return true
  }
  async listServiceUuids(): Promise<string[]> {
    return [SERVICE_UUID]
  }
  async write(): Promise<void> {}
  async subscribe(): Promise<void> {}
  onDisconnect(): void {}
  async disconnect(): Promise<void> {}
}

class FakeBackend implements BleBackend {
  readonly name = 'fake'
  async isAvailable(): Promise<boolean> {
    return true
  }
  async scan(): Promise<BleDeviceInfo[]> {
    return [{ name: 'DK-META2', address: 'AA:BB:CC:DD:EE:FF' }]
  }
  async connect(address: string): Promise<BleConnection> {
    return new FakeConnection(address)
  }
  async dispose(): Promise<void> {}
}

describe('server-side failure logging', () => {
  it('prints the reason when an ability is rejected', async () => {
    const logs: string[] = []
    const yilia = await createYiliaApp({
      backend: new FakeBackend(),
      websocket: { host: '127.0.0.1', port: WS_PORT, path: '/nacp' },
      stream: false,
      logger: (msg) => logs.push(msg),
    })
    await yilia.start()

    const client = new NApp({ id: 'log-test-client' })
    client.nact.use(new WebSocketClientProvider())
    await client.start()
    await client.connect('yilia', { type: 'websocket', provider: { url: `ws://127.0.0.1:${WS_PORT}/nacp` } })

    try {
      // confirm gate: level>0 without confirm must be rejected AND logged
      const call = client.request('yilia', { kind: 'ability', target: 'yilia.vibration', payload: { level: 5 } })
      await assert.rejects(call.response, /processor-failed/)

      assert.equal(logs.length, 1, `expected exactly 1 server log, got: ${JSON.stringify(logs)}`)
      assert.match(logs[0]!, /yilia\.vibration/)
      assert.match(logs[0]!, /confirmation_required/)
      assert.match(logs[0]!, /confirm=true/)
    } finally {
      await client.terminate().catch(() => {})
      await yilia.terminate().catch(() => {})
    }
  })

  it('prints the reason when an event fails', async () => {
    const logs: string[] = []
    const yilia = await createYiliaApp({
      backend: new FakeBackend(),
      websocket: { host: '127.0.0.1', port: WS_PORT, path: '/nacp' },
      stream: false,
      logger: (msg) => logs.push(msg),
    })
    await yilia.start()

    const client = new NApp({ id: 'log-test-client-2' })
    client.nact.use(new WebSocketClientProvider())
    await client.start()
    await client.connect('yilia', { type: 'websocket', provider: { url: `ws://127.0.0.1:${WS_PORT}/nacp` } })

    try {
      // sequence without connect first → setAction throws not_connected
      const call = client.request('yilia', {
        kind: 'event',
        target: 'yilia.sequence',
        payload: { steps: [{ action: 'vibration', level: 10, durationMs: 10 }], confirm: true },
      })
      await assert.rejects(call.response, /processor-failed/)

      const failureLogs = logs.filter((l) => l.includes('失败'))
      assert.ok(failureLogs.length >= 1, `expected failure logs, got: ${JSON.stringify(logs)}`)
      assert.ok(
        failureLogs.some((l) => l.includes('not_connected') || l.includes('未连接')),
        `expected the not_connected reason in server logs, got: ${JSON.stringify(logs)}`,
      )
    } finally {
      await client.terminate().catch(() => {})
      await yilia.terminate().catch(() => {})
    }
  })
})
