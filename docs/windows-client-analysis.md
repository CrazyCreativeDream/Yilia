# 心跳元力 0.9.0 Windows 客户端分析

## 实际捕获结果（2026-10-12）

`.vendor/yillia-window-ble.json` 实际记录的设备名称和 profile 均为 **DK-BH2PRO**，不是 META2。
用户验证的是活塞模式；记录中客户端也发出 vibration 指令，但这不证明震动能力可用。
yilia 的 BH2PRO profile 支持 `linear` 和 `vibration=09`；用户后续已确认实机成功。

- 活塞：写 ffb7 without-response，命令 `0c`。记录中的非零示例：`0c 02 00 03 0c 04 f0`。
- 震动：写 ffb7 without-response，命令 `09`。记录示例：`0e 02 00 03 09 07 f0`。
- 两种动作输入范围均为 0–100 整数，不做额外缩放。
- 全停止：写 ffb7 without-response，`ff 00`。示例：`06 02 00 03 ff 00 01`。
- 心跳：ffb5 with-response，`ef 01`；与现有实现相同。
- 原有 META2 的 `linear=0b` 不适用于这个 profile。按地址连接时默认套用 META2 会掩盖实际型号，已改为查询扫描名称。

捕获不能映射 Windows 的不透明设备 ID 到 Linux MAC；如果两边是同一台实机，这个型号差异解释了此前错误命令。

输入文件：`.vendor/心跳元力-0.9.0-win-x64.exe`。
NSIS 安装包包含 Electron `resources/app.asar`；应用 JavaScript 未混淆。
解包分析位置：`/tmp/opencode/yilia-client/app`（临时文件）。

## 静态分析结果

`package.json` 标识应用为 DOKIDOKI 0.9.0，作者 TryJoy，描述为视频运动追踪与设备同步工具。
这些元数据本身不能证明其为设备厂商官方客户端。

`src/renderer/dokidoki-web-bluetooth.js`：

| 位置 | 行号 | 结果 |
| --- | --- | --- |
| 帧构建 | 59–83 | `[消息ID, 02, 00, payload长度+1, payload..., -sum(payload)&ff]` |
| DK-META2 profile | 138–147 | vibration=08，linear=0b，rotary=0e |
| connect | 394–435 | 选择设备、按名称选择 profile、连接 GATT、发现特征、订阅、启动心跳 |
| 特征发现 | 474–537 | 服务 ffac；写 ffb5/ffb7；通知 ffb8；无额外初始化写入 |
| 强度 | 601–611、94–96 | vibration/linear 为四舍五入并限制到 0–100；不额外缩放 |
| 动作发送 | 900–940、1045–1098 | META2 无多指令启动序列；优先 ffb7 without-response，缺失则 ffb5 with-response |
| 心跳 | 1114–1135 | 每 2000ms 在 ffb5 with-response 发送 ef 01 |
| 停止 | 621–687 | META2 按 linear、rotary、vibration 顺序发送 0 |

`src/main/main.js` 蓝牙逻辑主要为 Electron Web Bluetooth 设备选择与权限处理；
实际 GATT 操作在 renderer 通过 Web Bluetooth 完成。

结论：与当前 yilia 的 META2 控制协议相同，静态分析没有找到能解释不动作的差异。
设备通知与请求消息 ID 对应证明有应用层回复，但该客户端没有解析 DokiDoki 回复的成功含义。
不能据此宣称设备执行成功，也不能把固件模式、握手或未知命令当作已确认原因。

## Windows 实际工作流记录

1. 关闭 yilia 的设备连接；完全退出 Windows 客户端。
2. 启动已安装客户端。在窗口使用 Ctrl+Shift+I 打开开发者工具，选择主窗口 Console。
3. 若快捷键无法打开，启动客户端时加 `--remote-debugging-port=9222`；
   在同一台 Windows 的 Chrome 打开 `chrome://inspect/#devices`，Configure 添加
   `localhost:9222`，inspect 主窗口 renderer。
4. 连接设备前，将 `scripts/capture-windows-ble.js` 全文粘贴执行。
5. 按客户端正常工作流程连接和控制，确认实际动作。
   可以用 `yiliaBleCapture.mark('此时实际震动，界面强度为…')` 标记观察结果。
6. 执行 `yiliaBleCapture.save()` 导出 `yilia-windows-ble.json`。
   若下载不可用，可执行 `copy(JSON.stringify(yiliaBleCapture.records, null, 2))`，
   将剪贴板保存为 JSON 文件。
7. 将 JSON 放入项目 `.vendor/` 进行对照分析。

脚本记录写入特征、实际字节、读值、通知、动作与连接诊断，保持原方法返回值和错误行为。
它记录客户端调用及设备回复，不是射频抓包；必须在连接之前安装，才能覆盖初始化过程。
