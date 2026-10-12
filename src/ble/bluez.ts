/**
 * BlueZ (D-Bus) BLE backend — the preferred backend on Linux.
 *
 * Pure JavaScript via dbus-next: no native compilation, no HCI socket
 * permissions required beyond the standard `bluetooth` group / D-Bus policy.
 */

import { Variant, systemBus } from 'dbus-next'
import type { ClientInterface, MessageBus, ProxyObject } from 'dbus-next'
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

const BLUEZ_SERVICE = 'org.bluez'
const IF_OM = 'org.freedesktop.DBus.ObjectManager'
const IF_PROPS = 'org.freedesktop.DBus.Properties'
const IF_ADAPTER = 'org.bluez.Adapter1'
const IF_DEVICE = 'org.bluez.Device1'
const IF_GATT_SERVICE = 'org.bluez.GattService1'
const IF_GATT_CHAR = 'org.bluez.GattCharacteristic1'

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000
const SERVICES_RESOLVED_TIMEOUT_MS = 10_000

type ManagedObjects = Record<string, Record<string, Record<string, unknown>>>

/** Typed views over dbus-next's loosely-typed ClientInterface. */
interface ObjectManagerIface extends ClientInterface {
  GetManagedObjects(): Promise<ManagedObjects>
}

interface AdapterIface extends ClientInterface {
  StartDiscovery(): Promise<void>
  StopDiscovery(): Promise<void>
  SetDiscoveryFilter(filter: Record<string, Variant>): Promise<void>
}

interface DeviceIface extends ClientInterface {
  Connect(): Promise<void>
  Disconnect(): Promise<void>
}

interface PropertiesIface extends ClientInterface {
  Get(iface: string, property: string): Promise<unknown>
}

interface GattCharIface extends ClientInterface {
  WriteValue(value: number[], options: Record<string, Variant>): Promise<void>
  StartNotify(): Promise<void>
  StopNotify(): Promise<void>
}

function unwrap(value: unknown): unknown {
  if (value instanceof Variant) return value.value
  return value
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function deviceAddressFromPath(path: string): string | undefined {
  const match = /dev_([0-9A-Fa-f]{2}(?:_[0-9A-Fa-f]{2}){5})(?:\/|$)/.exec(path)
  return match?.[1] ? match[1].replace(/_/g, ':').toUpperCase() : undefined
}

export class BluezBackend implements BleBackend {
  readonly name = 'bluez-dbus'

  private bus: MessageBus | null = null
  private om: ObjectManagerIface | null = null
  private adapterPath: string | null = null
  private adapter: AdapterIface | null = null
  private proxyCache = new Map<string, Promise<ProxyObject>>()

  async isAvailable(): Promise<boolean> {
    try {
      await this.ensureReady()
      return true
    } catch {
      return false
    }
  }

  private async ensureReady(): Promise<void> {
    if (this.bus && this.om && this.adapter && this.adapterPath) return
    let bus: MessageBus
    try {
      bus = systemBus()
      await new Promise<void>((resolve, reject) => {
        bus.once('connect', resolve)
        bus.once('error', reject)
      })
    } catch (err) {
      throw new BleUnavailableError(
        `无法连接系统 D-Bus（BlueZ 需要）：${err instanceof Error ? err.message : String(err)}`,
      )
    }
    let root: ProxyObject
    try {
      root = await bus.getProxyObject(BLUEZ_SERVICE, '/')
    } catch (err) {
      bus.disconnect()
      throw new BleUnavailableError(
        `系统 D-Bus 上没有 org.bluez（请确认 bluetoothd 已运行）：${err instanceof Error ? err.message : String(err)}`,
      )
    }
    const om = root.getInterface(IF_OM) as ObjectManagerIface
    const managed = await om.GetManagedObjects()
    const adapterPath = this.pickAdapter(managed)
    if (!adapterPath) {
      bus.disconnect()
      throw new BleUnavailableError('未找到 BlueZ 蓝牙适配器（/org/bluez/hci*）')
    }
    const adapterObj = await bus.getProxyObject(BLUEZ_SERVICE, adapterPath)
    const adapter = adapterObj.getInterface(IF_ADAPTER) as AdapterIface

    this.bus = bus
    this.om = om
    this.adapterPath = adapterPath
    this.adapter = adapter
  }

  private pickAdapter(managed: ManagedObjects): string | null {
    const adapters = Object.keys(managed).filter((path) => managed[path]?.[IF_ADAPTER])
    if (adapters.length === 0) return null
    return adapters.includes('/org/bluez/hci0') ? '/org/bluez/hci0' : adapters[0]!
  }

  private async managedObjects(): Promise<ManagedObjects> {
    if (!this.om) throw new BleUnavailableError('BlueZ 后端未初始化')
    return (this.om as ObjectManagerIface).GetManagedObjects()
  }

  private async proxy(path: string): Promise<ProxyObject> {
    if (!this.bus) throw new BleUnavailableError('BlueZ 后端未初始化')
    let pending = this.proxyCache.get(path)
    if (!pending) {
      pending = this.bus.getProxyObject(BLUEZ_SERVICE, path)
      pending.catch(() => this.proxyCache.delete(path))
      this.proxyCache.set(path, pending)
    }
    return pending
  }

  private async getProperty(path: string, iface: string, property: string): Promise<unknown> {
    const obj = await this.proxy(path)
    const props = obj.getInterface(IF_PROPS) as PropertiesIface
    return unwrap(await props.Get(iface, property))
  }

  private collectDevices(managed: ManagedObjects, filter?: (d: BleDeviceInfo) => boolean): BleDeviceInfo[] {
    const devices: BleDeviceInfo[] = []
    for (const [path, ifaces] of Object.entries(managed)) {
      const device = ifaces[IF_DEVICE]
      if (!device) continue
      const address = normalizeAddress(String(unwrap(device['Address']) ?? deviceAddressFromPath(path) ?? ''))
      if (!address) continue
      const name = String(unwrap(device['Name']) ?? unwrap(device['Alias']) ?? '').trim()
      const rssiRaw = unwrap(device['RSSI'])
      const info: BleDeviceInfo = { name, address }
      if (typeof rssiRaw === 'number') info.rssi = rssiRaw
      if (filter && !filter(info)) continue
      devices.push(info)
    }
    devices.sort((a, b) => a.name.localeCompare(b.name))
    return devices
  }

  async scan(options?: ScanOptions): Promise<BleDeviceInfo[]> {
    await this.ensureReady()
    const timeoutMs = Math.max(500, Math.min(options?.timeoutMs ?? 5000, 30_000))
    const adapter = this.adapter!

    try {
      await adapter.SetDiscoveryFilter({ Transport: new Variant('s', 'le') })
    } catch {
      // Older BlueZ without SetDiscoveryFilter: keep scanning everything.
    }
    await adapter.StartDiscovery()
    try {
      await sleep(timeoutMs)
      return this.collectDevices(await this.managedObjects(), options?.filter)
    } finally {
      try {
        await adapter.StopDiscovery()
      } catch {
        // Already stopped / adapter gone — harmless during teardown.
      }
    }
  }

  private async waitForDevicePath(address: string, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const managed = await this.managedObjects()
      for (const [path, ifaces] of Object.entries(managed)) {
        const device = ifaces[IF_DEVICE]
        if (!device) continue
        const addr = normalizeAddress(String(unwrap(device['Address']) ?? ''))
        if (addr === address) return path
      }
      if (Date.now() >= deadline) {
        throw new BleDeviceNotFoundError(`在 ${timeoutMs}ms 内未发现设备 ${address}`)
      }
      // Actively discover while waiting for the peripheral to show up.
      try {
        await this.adapter!.StartDiscovery()
      } catch {
        // Already discovering.
      }
      await sleep(500)
    }
  }

  private async waitForProperty(
    path: string,
    iface: string,
    property: string,
    expected: unknown,
    timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const value = unwrap(await this.getProperty(path, iface, property).catch(() => undefined))
      if (value === expected) return
      if (Date.now() >= deadline) {
        throw new BleError('timeout', `等待 ${iface}.${property} 变为 ${String(expected)} 超时`)
      }
      await sleep(100)
    }
  }

  async connect(address: string, options: ConnectOptions): Promise<BleConnection> {
    await this.ensureReady()
    const target = normalizeAddress(address)
    const path = await this.waitForDevicePath(target, options.scanTimeoutMs ?? 10_000)
    try {
      await this.adapter!.StopDiscovery()
    } catch {
      // Not discovering — fine.
    }

    const obj = await this.proxy(path)
    const device = obj.getInterface(IF_DEVICE) as DeviceIface

    const connected = unwrap(await this.getProperty(path, IF_DEVICE, 'Connected').catch(() => false))
    if (connected !== true) {
      let connectError: unknown
      await Promise.race([
        device.Connect(),
        sleep(DEFAULT_CONNECT_TIMEOUT_MS).then(() => {
          connectError = new BleError('timeout', `连接 ${target} 超时（${DEFAULT_CONNECT_TIMEOUT_MS}ms）`)
        }),
      ])
      if (connectError) throw connectError
    }
    await this.waitForProperty(path, IF_DEVICE, 'ServicesResolved', true, SERVICES_RESOLVED_TIMEOUT_MS)

    const managed = await this.managedObjects()
    const servicePaths = Object.entries(managed)
      .filter(([, ifaces]) => {
        const service = ifaces[IF_GATT_SERVICE]
        return (
          service !== undefined &&
          uuidMatches(String(unwrap(service['UUID']) ?? ''), options.serviceUuid) &&
          String(unwrap(service['Device']) ?? '') === path
        )
      })
      .map(([servicePath]) => servicePath)

    const charPaths = new Map<string, string>()
    for (const [charPath, ifaces] of Object.entries(managed)) {
      const char = ifaces[IF_GATT_CHAR]
      if (!char) continue
      const servicePath = String(unwrap(char['Service']) ?? '')
      if (!servicePaths.includes(servicePath)) continue
      const uuid = String(unwrap(char['UUID']) ?? '')
      for (const wanted of options.characteristicUuids) {
        if (uuidMatches(uuid, wanted)) charPaths.set(wanted.toLowerCase(), charPath)
      }
    }

    const serviceUuids = [
      ...new Set(
        Object.values(managed)
          .map((ifaces) => ifaces[IF_GATT_SERVICE])
          .filter((service) => service !== undefined)
          .filter((service) => String(unwrap(service!['Device']) ?? '') === path)
          .map((service) => String(unwrap(service!['UUID']) ?? '').toLowerCase()),
      ),
    ]

    return new BluezConnection(this, target, path, charPaths, serviceUuids)
  }

  /** Internal helpers used by BluezConnection. */
  async writeCharacteristic(charPath: string, data: Uint8Array, withResponse: boolean): Promise<void> {
    const obj = await this.proxy(charPath)
    const char = obj.getInterface(IF_GATT_CHAR) as GattCharIface
    await char.WriteValue(Array.from(data), {
      type: new Variant('s', withResponse ? 'request' : 'command'),
    })
  }

  async startNotify(charPath: string, handler: (data: Uint8Array) => void): Promise<void> {
    const obj = await this.proxy(charPath)
    const props = obj.getInterface(IF_PROPS)
    props.on('PropertiesChanged', (iface: string, changed: Record<string, unknown>) => {
      if (iface !== IF_GATT_CHAR) return
      const value = unwrap(changed['Value'])
      if (value instanceof Uint8Array || Array.isArray(value)) {
        handler(new Uint8Array(value))
      }
    })
    const char = obj.getInterface(IF_GATT_CHAR) as GattCharIface
    await char.StartNotify()
  }

  async rawDisconnect(devicePath: string): Promise<void> {
    const obj = await this.proxy(devicePath)
    const device = obj.getInterface(IF_DEVICE) as DeviceIface
    await device.Disconnect()
  }

  async isDeviceConnected(devicePath: string): Promise<boolean> {
    const value = unwrap(await this.getProperty(devicePath, IF_DEVICE, 'Connected').catch(() => false))
    return value === true
  }

  onDeviceDisconnect(devicePath: string, handler: () => void): void {
    void this.proxy(devicePath).then((obj) => {
      const props = obj.getInterface(IF_PROPS)
      props.on('PropertiesChanged', (iface: string, changed: Record<string, unknown>) => {
        if (iface !== IF_DEVICE) return
        if (unwrap(changed['Connected']) === false) handler()
      })
    })
  }

  async dispose(): Promise<void> {
    const bus = this.bus
    this.bus = null
    this.om = null
    this.adapter = null
    this.adapterPath = null
    this.proxyCache.clear()
    bus?.disconnect()
  }
}

class BluezConnection implements BleConnection {
  readonly backendName = 'bluez-dbus'
  private connected = true

  constructor(
    private readonly backend: BluezBackend,
    readonly address: string,
    private readonly devicePath: string,
    private readonly charPaths: Map<string, string>,
    private readonly serviceUuids: string[],
  ) {}

  isConnected(): boolean {
    return this.connected
  }

  async listServiceUuids(): Promise<string[]> {
    return [...this.serviceUuids]
  }

  private charPath(charUuid: string): string {
    const path =
      this.charPaths.get(charUuid.toLowerCase()) ??
      [...this.charPaths.entries()].find(([known]) => uuidMatches(known, charUuid))?.[1]
    if (!path) throw new BleError('gatt_error', `特征 ${charUuid} 不在已发现集合中`)
    return path
  }

  async write(charUuid: string, data: Uint8Array, withResponse: boolean): Promise<void> {
    await this.backend.writeCharacteristic(this.charPath(charUuid), data, withResponse)
  }

  async subscribe(charUuid: string, handler: (data: Uint8Array) => void): Promise<void> {
    await this.backend.startNotify(this.charPath(charUuid), handler)
  }

  onDisconnect(handler: () => void): void {
    this.backend.onDeviceDisconnect(this.devicePath, () => {
      this.connected = false
      handler()
    })
  }

  async disconnect(): Promise<void> {
    this.connected = false
    await this.backend.rawDisconnect(this.devicePath).catch(() => {})
  }
}
