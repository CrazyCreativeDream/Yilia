import { systemBus } from 'dbus-next'
import { setTimeout as sleep } from 'node:timers/promises'
import { BluezBackend } from '../dist/ble/bluez.js'
import {
  SERVICE_UUID, CHAR_NOTIFY, CHAR_WRITE_RESPONSE, CHAR_WRITE_NO_RESPONSE,
  MessageIdGenerator, buildActionFrame, buildHeartbeatFrame, normalizeAddress,
} from '../dist/chunfeng/protocol.js'

const args = process.argv.slice(2)
if (args.includes('--help') || !args.includes('--confirm')) {
  console.log('用法: npm run diagnose -- <设备地址> --confirm [--level 19]')
  console.log('先在服务端执行 disconnect，再停止服务器。脚本将测试各写入方式，每次震动 3 秒后归零。')
  process.exit(args.includes('--help') ? 0 : 1)
}
const address = normalizeAddress(args[0])
const levelIndex = args.indexOf('--level')
const level = levelIndex < 0 ? 19 : Number(args[levelIndex + 1])
if (!/^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(address) || !Number.isInteger(level) || level < 1 || level > 100) {
  console.error('需要有效设备地址，level 必须是 1 到 100 的整数。')
  process.exit(1)
}

const backend = new BluezBackend()
const bus = systemBus()
const ids = new MessageIdGenerator()
const hex = (data) => Buffer.from(data).toString('hex').match(/../g)?.join(' ') ?? ''
const value = (v) => v?.value ?? v
let connection
let activeRoute
let interrupted = false
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted = true })

async function write(route, frame) {
  console.log(`[TX] ${route.uuid} ${route.response ? 'request' : 'command'}: ${hex(frame)}`)
  await connection.write(route.uuid, frame, route.response)
  console.log('[TX] BlueZ 写入调用成功（不代表设备已执行）')
}

try {
  connection = await backend.connect(address, {
    serviceUuid: SERVICE_UUID,
    characteristicUuids: [CHAR_WRITE_RESPONSE, CHAR_WRITE_NO_RESPONSE, CHAR_NOTIFY],
  })
  const root = await bus.getProxyObject('org.bluez', '/')
  const objects = await root.getInterface('org.freedesktop.DBus.ObjectManager').GetManagedObjects()
  const devicePath = Object.entries(objects).find(([, interfaces]) =>
    value(interfaces['org.bluez.Device1']?.Address) === address)?.[0]
  const services = new Set(Object.entries(objects).filter(([, interfaces]) => {
    const s = interfaces['org.bluez.GattService1']
    return value(s?.Device) === devicePath && value(s?.UUID)?.toLowerCase() === SERVICE_UUID
  }).map(([path]) => path))
  const flags = new Map()
  for (const [path, interfaces] of Object.entries(objects)) {
    const c = interfaces['org.bluez.GattCharacteristic1']
    if (!services.has(value(c?.Service))) continue
    const uuid = value(c.UUID).toLowerCase().slice(4, 8)
    flags.set(uuid, value(c.Flags))
    console.log(`[GATT] ${uuid} flags=${JSON.stringify(value(c.Flags))} path=${path}`)
  }
  try {
    await connection.subscribe(CHAR_NOTIFY, (data) => console.log(`[RX] ffb8: ${hex(data)}`))
    console.log('[RX] 通知订阅成功')
  } catch (error) {
    console.error(`[RX] 通知订阅失败: ${error.message}`)
  }
  const routes = [
    { uuid: CHAR_WRITE_NO_RESPONSE, response: false },
    { uuid: CHAR_WRITE_RESPONSE, response: true },
    { uuid: CHAR_WRITE_NO_RESPONSE, response: true },
    { uuid: CHAR_WRITE_RESPONSE, response: false },
  ]
  for (const route of routes) {
    if (interrupted) break
    const required = route.response ? 'write' : 'write-without-response'
    if (!flags.get(route.uuid)?.includes(required)) {
      console.log(`[跳过] ${route.uuid} 不支持 ${required}`)
      continue
    }
    console.log(`\n[测试] ${route.uuid} ${route.response ? 'request' : 'command'}，震动 ${level}，观察 3 秒`)
    activeRoute = route
    try {
      await write({ uuid: CHAR_WRITE_RESPONSE, response: true }, buildHeartbeatFrame(ids.next()))
      await write(route, buildActionFrame(ids.next(), 'vibration', level))
      await sleep(1500)
      await write({ uuid: CHAR_WRITE_RESPONSE, response: true }, buildHeartbeatFrame(ids.next()))
      if (!interrupted) await sleep(1500)
    } catch (error) {
      console.error(`[失败] ${error.type ?? error.code ?? error.name}: ${error.message}`)
    } finally {
      await write(route, buildActionFrame(ids.next(), 'vibration', 0))
      activeRoute = undefined
    }
    await sleep(1000)
  }
} catch (error) {
  console.error(`[诊断失败] ${error.type ?? error.code ?? error.name}: ${error.message}`)
  process.exitCode = 1
} finally {
  if (connection) {
    if (activeRoute) await write(activeRoute, buildActionFrame(ids.next(), 'vibration', 0)).catch(console.error)
    await connection.disconnect().catch(console.error)
  }
  await backend.dispose()
  bus.disconnect()
}
