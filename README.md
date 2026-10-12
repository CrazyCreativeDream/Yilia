# yilia

基于 [NASDK](https://github.com/ChenYFan/NASDK) 的春风 DokiDoki 蓝牙控制服务，提供 CLI、WebSocket 和 Streamable HTTP 接口。

## 支持设备

| 设备 | 支持功能 |
| --- | --- |
| DK-META2 | 活塞（`linear`）、震动（`vibration`）、旋转（`rotary`） |
| DK-BH2PRO | 活塞（`linear`）、震动（`vibration`） |

强度为 **0–100 的整数**，0 停止对应动作；非零强度需要 `--confirm`。
`TF-` 型号别名按对应的 `DK-` 型号识别。

## 运行环境

- Node.js 20+
- Linux：BlueZ，需运行 `bluetoothd`，通过 D-Bus 连接。
- Windows 10+：通过可选依赖 `@abandonware/noble` 连接。

## 启动

```bash
npm install
npm run build
npm start
```

默认接口：

| 接口 | 地址 |
| --- | --- |
| WebSocket | `ws://127.0.0.1:18900/nacp` |
| Streamable HTTP | `http://127.0.0.1:18901/nacp` |

也可通过 `node dist/server.js` 启动。服务端会打印请求失败的具体原因。

## 使用

另开终端：

```bash
node dist/cli.js scan
node dist/cli.js connect --name DK-BH2PRO
node dist/cli.js status
node dist/cli.js linear 19 --confirm
node dist/cli.js vibration 19 --confirm
node dist/cli.js vibration 0
node dist/cli.js stop
node dist/cli.js disconnect
```

连接可附加 `--address <蓝牙地址>`；通过 `--transport stream` 使用 HTTP 接口。
环境变量：`YILIA_DEVICE_NAME`（默认 `DK-META2`）、`YILIA_DEVICE_ADDRESS`。

## NApp 接口

- 一次性能力：`yilia.scan`、`connect`、`status`、`set`、`linear`、`vibration`、`rotary`、`stop`、`disconnect`（均带 `yilia.` 前缀）。
- 长时事件：`yilia.session`（交互会话）、`yilia.sequence`（动作序列）。
- 动作参数：`{ level: 19, confirm: true }`；`yilia.set` 额外传入 `action`。
- `stop` 停止全部动作，`disconnect` 停止后断开设备。动作能力以设备型号为准。

## 开发

```bash
npm test
npm run typecheck
npm run build
```

Windows 客户端协议分析与运行时记录方法见 [分析文档](docs/windows-client-analysis.md)。

## 许可证

MIT
