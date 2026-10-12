/**
 * noble BLE backend — used on Windows (WinRT bindings built into
 * @abandonware/noble) and as a fallback on other desktop platforms.
 *
 * The package is an optional dependency: it is imported lazily so that
 * Linux installs never need its native toolchain.
 */

import { normalizeAddress, uuidMatches } from '../chunfeng/protocol.js'
import {
  BleDeviceNotFoundError,
  BleError,
  BleUnavailableError,
  type BleBackend,
  type BleConnection,
  type BleDeviceInfo,
  type ConnectOptions,
  type ScanOptions,
} from './types.js'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Noble = any
type NoblePeripheral = any
type NobleCharacteristic = any

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function peripheralAddress(peripheral: NoblePeripheral): string {
  return normalizeAddress(peripheral.address || peripheral.id || '')
}

export class NobleBackend implements BleBackend {
  readonly name = 'noble'

  private noble: Noble = null

  private async ensureReady(): Promise<Noble> {
    if (this.noble) return this.noble
    let mod: unknown
    try {
      mod = await import('@abandonware/noble')
    } catch (err) {
      throw new BleUnavailableError(
        `noble 后端不可用（@abandonware/noble 未安装或加载失败）：${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
    const noble = (mod as { default?: Noble }).default ?? mod
    try {
      await noble.waitForPoweredOnAsync()
    } catch (err) {
      throw new BleUnavailableError(
        `蓝牙适配器未就绪（请确认蓝牙已开启且有权限）：${err instanceof Error ? err.message : String(err)}`,
      )
    }
    this.noble = noble
    return noble
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.ensureReady()
      return true
    } catch {
      return false
    }
  }

  async scan(options?: ScanOptions): Promise<BleDeviceInfo[]> {
    const noble = await this.ensureReady()
    const timeoutMs = Math.max(500, Math.min(options?.timeoutMs ?? 5000, 30_000))
    const found = new Map<string, BleDeviceInfo>()

    const onDiscover = (peripheral: NoblePeripheral) => {
      const name = String(peripheral.advertisement?.localName ?? '').trim()
      const address = peripheralAddress(peripheral)
      if (!address) return
      const info: BleDeviceInfo = { name, address }
      if (typeof peripheral.rssi === 'number') info.rssi = peripheral.rssi
      if (options?.filter && !options.filter(info)) return
      found.set(address, info)
    }

    noble.on('discover', onDiscover)
    try {
      await noble.startScanningAsync([], true)
      await sleep(timeoutMs)
    } finally {
      await noble.stopScanningAsync().catch(() => {})
      noble.removeListener('discover', onDiscover)
    }
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  private async findPeripheral(address: string, timeoutMs: number): Promise<NoblePeripheral> {
    const noble = await this.ensureReady()
    const target = normalizeAddress(address)
    let discovered: NoblePeripheral | null = null

    const onDiscover = (peripheral: NoblePeripheral) => {
      if (peripheralAddress(peripheral) === target) discovered = peripheral
    }
    noble.on('discover', onDiscover)
    try {
      await noble.startScanningAsync([], true)
      const deadline = Date.now() + timeoutMs
      while (!discovered && Date.now() < deadline) await sleep(200)
    } finally {
      await noble.stopScanningAsync().catch(() => {})
      noble.removeListener('discover', onDiscover)
    }
    if (!discovered) throw new BleDeviceNotFoundError(`在 ${timeoutMs}ms 内未发现设备 ${target}`)
    return discovered
  }

  async connect(address: string, options: ConnectOptions): Promise<BleConnection> {
    const peripheral = await this.findPeripheral(address, options.scanTimeoutMs ?? 10_000)
    await peripheral.connectAsync()

    const shortWanted = options.characteristicUuids.map((uuid) => uuid.toLowerCase())
    const { services, characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
      [options.serviceUuid],
      shortWanted,
    )
    const serviceUuids: string[] = (services ?? []).map((service: { uuid: string }) => service.uuid.toLowerCase())

    const charMap = new Map<string, NobleCharacteristic>()
    for (const char of characteristics ?? []) {
      const uuid = String(char.uuid).toLowerCase()
      for (const wanted of shortWanted) {
        if (uuidMatches(uuid, wanted) || uuidMatches(wanted, uuid)) charMap.set(wanted, char)
      }
    }

    return new NobleConnection(peripheralAddress(peripheral), peripheral, charMap, serviceUuids)
  }

  async dispose(): Promise<void> {
    // noble has no global teardown; individual peripherals disconnect themselves.
  }
}

class NobleConnection implements BleConnection {
  readonly backendName = 'noble'
  private connected = true

  constructor(
    readonly address: string,
    private readonly peripheral: NoblePeripheral,
    private readonly characteristics: Map<string, NobleCharacteristic>,
    private readonly serviceUuids: string[],
  ) {
    this.peripheral.once('disconnect', () => {
      this.connected = false
      for (const handler of this.disconnectHandlers) handler()
    })
  }

  private disconnectHandlers: Array<() => void> = []

  isConnected(): boolean {
    return this.connected
  }

  async listServiceUuids(): Promise<string[]> {
    return [...this.serviceUuids]
  }

  private characteristic(charUuid: string): NobleCharacteristic {
    const wanted = charUuid.toLowerCase()
    const char =
      this.characteristics.get(wanted) ??
      [...this.characteristics.entries()].find(([known]) => uuidMatches(known, wanted) || uuidMatches(wanted, known))?.[1]
    if (!char) throw new BleError('gatt_error', `特征 ${charUuid} 不在已发现集合中`)
    return char
  }

  async write(charUuid: string, data: Uint8Array, withResponse: boolean): Promise<void> {
    await this.characteristic(charUuid).writeAsync(Buffer.from(data), !withResponse)
  }

  async subscribe(charUuid: string, handler: (data: Uint8Array) => void): Promise<void> {
    const char = this.characteristic(charUuid)
    char.on('data', (data: Buffer) => handler(new Uint8Array(data)))
    await char.subscribeAsync()
  }

  onDisconnect(handler: () => void): void {
    this.disconnectHandlers.push(handler)
  }

  async disconnect(): Promise<void> {
    this.connected = false
    await this.peripheral.disconnectAsync().catch(() => {})
  }
}
