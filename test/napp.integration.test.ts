/**
 * End-to-end test: real NApp over real WebSocket + Streamable HTTP
 * transports, with the BLE layer replaced by an in-memory fake backend.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NApp } from '@nyirusu/nasdk'
import WebSocketClientProvider from '@nyirusu/nact-websocket-client'
import StreamableHTTPClientProvider from '@nyirusu/nact-streamable-http-client'
import { createYiliaApp, type YiliaApp } from '../src/napp/app.js'
import { SERVICE_UUID } from '../src/chunfeng/protocol.js'
import type { BleBackend, BleConnection, BleDeviceInfo } from '../src/ble/types.js'

const WS_PORT = 18910
const STREAM_PORT = 18911

class FakeConnection implements BleConnection {
  readonly backendName = 'fake'
  writes: { uuid: string; data: Uint8Array; withResponse: boolean }[] = []
  private connected = true
  constructor(readonly address: string) {}
  isConnected(): boolean {
    return this.connected
  }
  async listServiceUuids(): Promise<string[]> {
    return [SERVICE_UUID]
  }
  async write(uuid: string, data: Uint8Array, withResponse: boolean): Promise<void> {
    this.writes.push({ uuid, data, withResponse })
  }
  async subscribe(): Promise<void> {}
  onDisconnect(): void {}
  async disconnect(): Promise<void> {
    this.connected = false
  }
}

class FakeBackend implements BleBackend {
  readonly name = 'fake'
  lastConnection: FakeConnection | null = null
  async isAvailable(): Promise<boolean> {
    return true
  }
  async scan(): Promise<BleDeviceInfo[]> {
    return [{ name: 'DK-META2', address: 'AA:BB:CC:DD:EE:FF', rssi: -42 }]
  }
  async connect(address: string): Promise<BleConnection> {
    this.lastConnection = new FakeConnection(address)
    return this.lastConnection
  }
  async dispose(): Promise<void> {}
}

async function callAbility(client: NApp, target: string, payload?: unknown) {
  const call = client.request('yilia', { kind: 'ability', target, payload })
  const response = await call.response
  assert.equal(response.meta.isOk, true, `${target} failed: ${JSON.stringify(response)}`)
  return response.payload
}

describe('yilia NApp integration', () => {
  let yilia: YiliaApp
  let backend: FakeBackend
  let wsClient: NApp
  let streamClient: NApp

  before(async () => {
    backend = new FakeBackend()
    yilia = await createYiliaApp({
      backend,
      websocket: { host: '127.0.0.1', port: WS_PORT, path: '/nacp' },
      stream: { host: '127.0.0.1', port: STREAM_PORT, path: '/nacp' },
      logger: false,
    })
    await yilia.start()

    wsClient = new NApp({ id: 'test-ws-client' })
    wsClient.nact.use(new WebSocketClientProvider())
    await wsClient.start()
    await wsClient.connect('yilia', { type: 'websocket', provider: { url: `ws://127.0.0.1:${WS_PORT}/nacp` } })

    streamClient = new NApp({ id: 'test-stream-client' })
    streamClient.nact.use(new StreamableHTTPClientProvider())
    await streamClient.start()
    await streamClient.connect('yilia', {
      type: 'streamable-http',
      provider: { url: `http://127.0.0.1:${STREAM_PORT}/nacp` },
    })
  })

  after(async () => {
    await wsClient.terminate().catch(() => {})
    await streamClient.terminate().catch(() => {})
    await yilia.terminate().catch(() => {})
  })

  it('runs the full control flow over WebSocket', async () => {
    const scan = (await callAbility(wsClient, 'yilia.scan')) as { count: number }
    assert.equal(scan.count, 1)

    const status = (await callAbility(wsClient, 'yilia.connect')) as { connected: boolean; profile: string }
    assert.equal(status.connected, true)
    assert.equal(status.profile, 'DK-META2')

    // confirm gate: a failed request rejects the response promise
    // (NASDK surfaces the failure fact as 'processor-failed'; the business
    // error detail rides the response payload server-side).
    const denied = wsClient.request('yilia', {
      kind: 'ability',
      target: 'yilia.vibration',
      payload: { level: 20 },
    })
    await assert.rejects(denied.response, /processor-failed/)

    const applied = (await callAbility(wsClient, 'yilia.vibration', { level: 20, confirm: true })) as {
      ok: boolean
    }
    assert.equal(applied.ok, true)
    const lastWrite = backend.lastConnection!.writes.at(-1)!
    assert.deepEqual([...lastWrite.data], [0x01, 0x02, 0x00, 0x03, 0x08, 0x14, 0xe4])

    await callAbility(wsClient, 'yilia.linear', { level: 10, confirm: true })
    await callAbility(wsClient, 'yilia.rotary', { level: 0 })

    const stopped = (await callAbility(wsClient, 'yilia.stop')) as { stopped: boolean }
    assert.equal(stopped.stopped, true)

    const after = (await callAbility(wsClient, 'yilia.status')) as { connected: boolean }
    assert.equal(after.connected, true)

    const off = (await callAbility(wsClient, 'yilia.disconnect')) as { connected: boolean }
    assert.equal(off.connected, false)
  })

  it('runs the sequence event over WebSocket with process streaming', async () => {
    await callAbility(wsClient, 'yilia.connect')
    backend.lastConnection!.writes.length = 0

    const call = wsClient.request('yilia', {
      kind: 'event',
      target: 'yilia.sequence',
      payload: {
        steps: [
          { action: 'vibration', level: 15, durationMs: 50 },
          { action: 'linear', level: 10, durationMs: 50 },
        ],
        confirm: true,
      },
    })
    const chunks: unknown[] = []
    for await (const message of call.stream) chunks.push(message.payload)
    const response = await call.response
    assert.equal(response.meta.isOk, true, JSON.stringify(response))
    assert.equal((response.payload as { completed: number }).completed, 2)
    assert.ok(chunks.length >= 2, 'expected process chunks')

    // 2 action frames + 3 stop frames (stopOnEnd default true)
    const frames = backend.lastConnection!.writes.map((w) => [...w.data])
    assert.equal(frames.length, 5)
    assert.deepEqual(frames[0], [0x01, 0x02, 0x00, 0x03, 0x08, 0x0f, 0xe9]) // vibration 15
    assert.deepEqual(frames[1], [0x02, 0x02, 0x00, 0x03, 0x0b, 0x0a, 0xeb]) // linear 10
    assert.ok(frames.slice(2).every((f) => f[5] === 0)) // stop frames

    await callAbility(wsClient, 'yilia.disconnect')
  })

  it('runs the session event with signal injection over Streamable HTTP', async () => {
    const call = streamClient.request('yilia', {
      kind: 'event',
      target: 'yilia.session',
      payload: {},
    })

    // Wait for the ready process chunk, then inject commands via signals.
    const stream = call.stream[Symbol.asyncIterator]()
    const first = await stream.next()
    assert.equal((first.value.payload as { type: string }).type, 'ready')

    await streamClient.signal('yilia', {
      parentId: call.reqId,
      kind: 'normal',
      payload: { action: 'rotary', level: 25, confirm: true },
    })
    const applied = await stream.next()
    assert.equal((applied.value.payload as { type: string }).type, 'applied')

    await streamClient.signal('yilia', { parentId: call.reqId, kind: 'normal', payload: { op: 'stop' } })
    const stopped = await stream.next()
    assert.equal((stopped.value.payload as { type: string }).type, 'stopped')

    await streamClient.signal('yilia', { parentId: call.reqId, kind: 'normal', payload: { op: 'end' } })
    const response = await call.response
    assert.equal(response.meta.isOk, true, JSON.stringify(response))
    assert.equal((response.payload as { ended: boolean }).ended, true)

    // Session connected the device itself and keepConnected was not set:
    // it must have stopped outputs and disconnected on the way out.
    const status = (await callAbility(streamClient, 'yilia.status')) as { connected: boolean }
    assert.equal(status.connected, false)
  })

  it('aborts a sequence over Streamable HTTP and zeroes the outputs', async () => {
    await callAbility(streamClient, 'yilia.connect')
    backend.lastConnection!.writes.length = 0

    const call = streamClient.request('yilia', {
      kind: 'event',
      target: 'yilia.sequence',
      payload: {
        steps: [{ action: 'vibration', level: 30, durationMs: 30_000 }],
        confirm: true,
      },
    })
    const stream = call.stream[Symbol.asyncIterator]()
    await stream.next() // applied
    await streamClient.signal('yilia', { parentId: call.reqId, kind: 'abort' })
    // aborted events end in failure → the response promise rejects
    await assert.rejects(call.response, /processor-failed/)

    const frames = backend.lastConnection!.writes.map((w) => [...w.data])
    const stopFrames = frames.filter((f) => f[5] === 0)
    assert.ok(stopFrames.length >= 3, 'abort must zero all outputs')

    await callAbility(streamClient, 'yilia.disconnect')
  })
})
