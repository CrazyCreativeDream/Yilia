import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ChunfengManager, ConfirmationRequiredError, NotConnectedError } from '../src/chunfeng/manager.js'
import {
  CHAR_NOTIFY,
  CHAR_WRITE_NO_RESPONSE,
  CHAR_WRITE_RESPONSE,
  SERVICE_UUID,
  buildActionFrame,
} from '../src/chunfeng/protocol.js'
import type {
  BleBackend,
  BleConnection,
  BleDeviceInfo,
  ConnectOptions,
} from '../src/ble/types.js'

/** In-memory BLE backend emulating one DK-META2 peripheral. */
class FakeConnection implements BleConnection {
  readonly backendName = 'fake'
  writes: { uuid: string; data: Uint8Array; withResponse: boolean }[] = []
  private connected = true
  private disconnectHandlers: Array<() => void> = []

  constructor(readonly address: string) {}

  isConnected(): boolean {
    return this.connected
  }

  async listServiceUuids(): Promise<string[]> {
    return [SERVICE_UUID]
  }

  async write(uuid: string, data: Uint8Array, withResponse: boolean): Promise<void> {
    if (!this.connected) throw new Error('not connected')
    this.writes.push({ uuid, data, withResponse })
  }

  async subscribe(): Promise<void> {}

  onDisconnect(handler: () => void): void {
    this.disconnectHandlers.push(handler)
  }

  async disconnect(): Promise<void> {
    this.connected = false
  }

  simulateDisconnect(): void {
    this.connected = false
    for (const handler of this.disconnectHandlers) handler()
  }
}

class FakeBackend implements BleBackend {
  readonly name = 'fake'
  devices: BleDeviceInfo[] = [{ name: 'DK-META2', address: 'AA:BB:CC:DD:EE:FF', rssi: -50 }]
  lastConnection: FakeConnection | null = null

  async isAvailable(): Promise<boolean> {
    return true
  }

  async scan(): Promise<BleDeviceInfo[]> {
    return this.devices
  }

  async connect(address: string, _options: ConnectOptions): Promise<BleConnection> {
    const found = this.devices.find((d) => d.address === address)
    if (!found) throw new Error('device not found')
    this.lastConnection = new FakeConnection(address)
    return this.lastConnection
  }

  async dispose(): Promise<void> {}
}

function makeManager(): { manager: ChunfengManager; backend: FakeBackend } {
  const backend = new FakeBackend()
  const manager = new ChunfengManager({ backend, heartbeatIntervalMs: 60_000 })
  return { manager, backend }
}

describe('ChunfengManager', () => {
  it('identifies BH2PRO by address and uses captured piston and stop commands', async () => {
    const { manager, backend } = makeManager()
    backend.devices = [{ name: 'DK-BH2PRO', address: 'AA:BB:CC:DD:EE:FF' }]
    try {
      const status = await manager.connect({ address: 'AA:BB:CC:DD:EE:FF' })
      assert.equal(status.profile, 'DK-BH2PRO')
      assert.deepEqual(status.capabilities, ['linear', 'vibration'])
      await manager.setAction('linear', 4, true)
      assert.deepEqual([...backend.lastConnection!.writes.at(-1)!.data], [1, 2, 0, 3, 0x0c, 4, 0xf0])
      await manager.setAction('vibration', 7, true)
      // Windows capture: 0e 02 00 03 09 07 f0 (message ID varies).
      assert.deepEqual([...backend.lastConnection!.writes.at(-1)!.data], [2, 2, 0, 3, 0x09, 7, 0xf0])
      await assert.rejects(manager.setAction('rotary', 19, true), /不支持 rotary/)
      await manager.stop()
      assert.deepEqual([...backend.lastConnection!.writes.at(-1)!.data], [3, 2, 0, 3, 0xff, 0, 1])
      await manager.disconnect()
      assert.equal(backend.lastConnection!.writes.at(-1)!.data[4], 0xff)
    } finally {
      await manager.shutdown()
    }
  })

  it('scans and marks supported devices', async () => {
    const { manager } = makeManager()
    const result = await manager.scan()
    assert.equal(result.count, 1)
    assert.equal(result.devices[0]!.name, 'DK-META2')
    assert.equal(result.devices[0]!.supported, true)
  })

  it('connects by default name and reports status', async () => {
    const { manager } = makeManager()
    const status = await manager.connect()
    assert.equal(status.connected, true)
    assert.equal(status.profile, 'DK-META2')
    assert.deepEqual(status.capabilities, ['vibration', 'linear', 'rotary'])
    assert.equal(status.heartbeatRunning, true)
    await manager.shutdown()
  })

  it('rejects unsupported device models', async () => {
    const { manager, backend } = makeManager()
    backend.devices = [{ name: 'ACME-1', address: '11:22:33:44:55:66' }]
    await assert.rejects(manager.connect({ name: 'ACME-1' }), /暂不支持设备型号/)
  })

  it('requires confirm=true for non-zero actions', async () => {
    const { manager } = makeManager()
    await manager.connect()
    await assert.rejects(manager.setAction('vibration', 20), ConfirmationRequiredError)
    const ok = await manager.setAction('vibration', 20, true)
    assert.equal(ok.ok, true)
    await manager.shutdown()
  })

  it('writes the documented frame for vibration 20', async () => {
    const { manager, backend } = makeManager()
    await manager.connect()
    await manager.setAction('vibration', 20, true)
    const write = backend.lastConnection!.writes.at(-1)!
    assert.deepEqual([...write.data], [0x01, 0x02, 0x00, 0x03, 0x08, 0x14, 0xe4])
    assert.equal(write.uuid, CHAR_WRITE_NO_RESPONSE)
    assert.equal(write.withResponse, false)
    await manager.shutdown()
  })

  it('stop zeroes outputs in linear → rotary → vibration order', async () => {
    const { manager, backend } = makeManager()
    await manager.connect()
    backend.lastConnection!.writes.length = 0
    const result = await manager.stop()
    assert.equal(result.stopped, true)
    const frames = backend.lastConnection!.writes.map((w) => [...w.data])
    assert.deepEqual(
      frames.map((f) => f[4]),
      [0x0b, 0x0e, 0x08],
    )
    assert.ok(frames.every((f) => f[5] === 0))
    await manager.shutdown()
  })

  it('disconnect sends a best-effort stop first', async () => {
    const { manager, backend } = makeManager()
    await manager.connect()
    backend.lastConnection!.writes.length = 0
    await manager.disconnect(true)
    assert.equal(backend.lastConnection!.writes.length, 3)
    assert.equal(manager.isConnected, false)
  })

  it('setAction on a disconnected manager throws NotConnectedError', async () => {
    const { manager } = makeManager()
    await assert.rejects(manager.setAction('vibration', 0), NotConnectedError)
  })

  it('handles an unexpected link loss', async () => {
    const { manager, backend } = makeManager()
    let lost: string | null = null
    const m2 = new ChunfengManager({ backend, heartbeatIntervalMs: 60_000, onLinkLost: (r) => (lost = r) })
    await m2.connect()
    backend.lastConnection!.simulateDisconnect()
    assert.equal(m2.isConnected, false)
    assert.ok(lost !== null)
    assert.equal(manager.isConnected, false)
  })

  it('heartbeat frames are written on the with-response characteristic', async () => {
    const backend = new FakeBackend()
    const manager = new ChunfengManager({ backend, heartbeatIntervalMs: 30 })
    await manager.connect()
    backend.lastConnection!.writes.length = 0
    await new Promise((resolve) => setTimeout(resolve, 100))
    const heartbeats = backend.lastConnection!.writes.filter((w) => w.data[4] === 0xef)
    assert.ok(heartbeats.length >= 1)
    assert.equal(heartbeats[0]!.uuid, CHAR_WRITE_RESPONSE)
    assert.equal(heartbeats[0]!.withResponse, true)
    await manager.shutdown()
  })

  it('exposes the expected frame for direct comparison with the reference client', () => {
    // Reference: build_action_frame(7, 'linear', 100)
    const frame = buildActionFrame(7, 'linear', 100)
    assert.deepEqual([...frame], [0x07, 0x02, 0x00, 0x03, 0x0b, 0x64, 0x91])
    void CHAR_NOTIFY
  })
})
