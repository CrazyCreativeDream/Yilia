#!/usr/bin/env node
/**
 * yilia-server — start the yilia NApp server with WebSocket + Streamable HTTP entries.
 *
 *   yilia-server [--id yilia] [--backend auto|bluez|noble]
 *         [--ws-host 127.0.0.1] [--ws-port 18900] [--ws-path /nacp] [--no-ws]
 *         [--stream-host 127.0.0.1] [--stream-port 18901] [--stream-path /nacp] [--no-stream]
 */

import process from 'node:process'
import { parseArgs } from 'node:util'
import { createYiliaApp, DEFAULT_STREAM_ENDPOINT, DEFAULT_WEBSOCKET_ENDPOINT } from './napp/app.js'
import type { BleBackendKind } from './ble/index.js'

const { values } = parseArgs({
  options: {
    id: { type: 'string', default: 'yilia' },
    backend: { type: 'string', default: 'auto' },
    'ws-host': { type: 'string', default: DEFAULT_WEBSOCKET_ENDPOINT.host },
    'ws-port': { type: 'string', default: String(DEFAULT_WEBSOCKET_ENDPOINT.port) },
    'ws-path': { type: 'string', default: DEFAULT_WEBSOCKET_ENDPOINT.path },
    'no-ws': { type: 'boolean', default: false },
    'stream-host': { type: 'string', default: DEFAULT_STREAM_ENDPOINT.host },
    'stream-port': { type: 'string', default: String(DEFAULT_STREAM_ENDPOINT.port) },
    'stream-path': { type: 'string', default: DEFAULT_STREAM_ENDPOINT.path },
    'no-stream': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
})

if (values.help) {
  console.log(`yilia-server — 春风（DokiDoki）BLE 设备控制 NApp 服务器

用法: yilia-server [选项]

入口（默认同时开启）:
  --ws-host/--ws-port/--ws-path        WebSocket 入口，默认 ${DEFAULT_WEBSOCKET_ENDPOINT.host}:${DEFAULT_WEBSOCKET_ENDPOINT.port}${DEFAULT_WEBSOCKET_ENDPOINT.path}
  --stream-host/--stream-port/--stream-path
                                       Streamable HTTP 入口，默认 ${DEFAULT_STREAM_ENDPOINT.host}:${DEFAULT_STREAM_ENDPOINT.port}${DEFAULT_STREAM_ENDPOINT.path}
  --no-ws / --no-stream                关闭对应入口

其他:
  --id <name>                          NApp id，默认 yilia
  --backend <auto|bluez|noble>         BLE 后端，默认 auto（Linux 优先 BlueZ，Windows 优先 noble）
  -h, --help                           显示帮助

环境变量:
  YILIA_DEVICE_NAME                    默认设备名（默认 DK-META2）
  YILIA_DEVICE_ADDRESS                 默认设备地址（AA:BB:CC:DD:EE:FF）
`)
  process.exit(0)
}

const backend = values.backend as BleBackendKind
if (!['auto', 'bluez', 'noble'].includes(backend)) {
  console.error(`--backend 只能是 auto|bluez|noble，收到: ${values.backend}`)
  process.exit(2)
}

let yilia: Awaited<ReturnType<typeof createYiliaApp>>
try {
  yilia = await createYiliaApp({
    id: values.id,
    backend,
    websocket: values['no-ws']
      ? false
      : { host: values['ws-host']!, port: Number(values['ws-port']), path: values['ws-path'] },
    stream: values['no-stream']
      ? false
      : { host: values['stream-host']!, port: Number(values['stream-port']), path: values['stream-path'] },
  })
  await yilia.start()
} catch (err) {
  console.error(`[yilia] 启动失败：${err instanceof Error ? err.message : String(err)}`)
  if (process.platform === 'linux') {
    console.error('[yilia] 提示：Linux 下请确认 bluetoothd 正在运行（systemctl start bluetooth），且当前用户有蓝牙权限。')
  } else if (process.platform === 'win32') {
    console.error('[yilia] 提示：Windows 下请确认蓝牙已开启，且 @abandonware/noble 已正确安装。')
  }
  process.exit(1)
}

const decl = yilia.app.buildDecl()
console.log(`[yilia] NApp '${yilia.app.id}' 已启动（BLE 后端: ${yilia.backend.name}）`)
if (!values['no-ws']) console.log(`[yilia] WebSocket 入口:      ws://${values['ws-host']}:${values['ws-port']}${values['ws-path']}`)
if (!values['no-stream']) console.log(`[yilia] Streamable HTTP 入口: http://${values['stream-host']}:${values['stream-port']}${values['stream-path']}`)
console.log(`[yilia] abilities: ${decl.abilities.map((a) => a.name).join(', ')}`)
console.log(`[yilia] events:    ${decl.events.map((e) => e.name).join(', ')}`)

let terminating = false
async function shutdown(signal: string) {
  if (terminating) return
  terminating = true
  console.log(`\n[yilia] 收到 ${signal}，停止输出并关闭…`)
  await yilia.terminate()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
