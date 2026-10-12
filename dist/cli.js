#!/usr/bin/env node
/**
 * yilia — 客户端 CLI：连接一台运行中的 yilia-server 并执行简单控制。
 *
 *   yilia scan [--timeout 5000]
 *   yilia connect [--address AA:BB:..] [--name DK-META2]
 *   yilia status
 *   yilia set <vibration|linear|rotary> <0-100> [--confirm]
 *   yilia vibration|linear|rotary <0-100> [--confirm]
 *   yilia stop
 *   yilia disconnect
 *
 * 连接选项:
 *   --url <url>              默认 ws://127.0.0.1:18900/nacp
 *   --transport <ws|stream>  默认 ws；stream 默认 http://127.0.0.1:18901/nacp
 *   --server <id>            默认 yilia
 */
import process from 'node:process';
import { parseArgs } from 'node:util';
import { NApp } from '@nyirusu/nasdk';
import WebSocketClientProvider from '@nyirusu/nact-websocket-client';
import StreamableHTTPClientProvider from '@nyirusu/nact-streamable-http-client';
import { DEFAULT_STREAM_ENDPOINT, DEFAULT_WEBSOCKET_ENDPOINT } from './napp/app.js';
import { ACTIONS } from './chunfeng/protocol.js';
const DEFAULT_WS_URL = `ws://${DEFAULT_WEBSOCKET_ENDPOINT.host}:${DEFAULT_WEBSOCKET_ENDPOINT.port}${DEFAULT_WEBSOCKET_ENDPOINT.path}`;
const DEFAULT_STREAM_URL = `http://${DEFAULT_STREAM_ENDPOINT.host}:${DEFAULT_STREAM_ENDPOINT.port}${DEFAULT_STREAM_ENDPOINT.path}`;
const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
        url: { type: 'string' },
        transport: { type: 'string', default: 'ws' },
        server: { type: 'string', default: 'yilia' },
        confirm: { type: 'boolean', default: false },
        timeout: { type: 'string' },
        address: { type: 'string' },
        name: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
    },
});
const HELP = `yilia — 春风（DokiDoki）设备控制客户端（连接 yilia-server）

用法: yilia <命令> [参数] [选项]

命令:
  scan                            扫描支持的设备
  connect [--address X] [--name Y] 连接设备（无参连默认设备）
  status                          查看服务器持有的连接状态
  set <action> <level>            设置动作强度（action: vibration|linear|rotary）
  vibration|linear|rotary <level> 设置单项强度
  stop                            全部输出归零
  disconnect                      归零并断开

选项:
  --url <url>             服务器地址，默认 ${DEFAULT_WS_URL}
  --transport <ws|stream> 传输协议；stream 默认 ${DEFAULT_STREAM_URL}
  --server <id>           NApp id，默认 yilia
  --confirm               非零强度必须显式确认
  --timeout <ms>          scan 的扫描窗口，默认 5000
  -h, --help              显示帮助
`;
function fail(message) {
    console.error(`[yilia] ${message}`);
    process.exit(1);
}
async function main() {
    if (values.help || positionals.length === 0) {
        console.log(HELP);
        process.exit(positionals.length === 0 && !values.help ? 2 : 0);
    }
    const [command, ...args] = positionals;
    const transport = values.transport;
    if (transport !== 'ws' && transport !== 'stream')
        fail(`--transport 只能是 ws|stream，收到: ${transport}`);
    const url = values.url ?? (transport === 'ws' ? DEFAULT_WS_URL : DEFAULT_STREAM_URL);
    const serverId = values.server;
    // 解析命令为 ability 调用
    let target;
    let payload = {};
    switch (command) {
        case 'scan':
            target = 'yilia.scan';
            if (values.timeout !== undefined)
                payload['timeoutMs'] = Number(values.timeout);
            break;
        case 'connect':
            target = 'yilia.connect';
            if (values.address !== undefined)
                payload['address'] = values.address;
            if (values.name !== undefined)
                payload['name'] = values.name;
            break;
        case 'status':
            target = 'yilia.status';
            break;
        case 'stop':
            target = 'yilia.stop';
            break;
        case 'disconnect':
            target = 'yilia.disconnect';
            break;
        case 'set': {
            const [action, levelRaw] = args;
            if (!action || !ACTIONS.includes(action)) {
                fail(`set 需要动作名（${ACTIONS.join('|')}），收到: ${action ?? '(无)'}`);
            }
            const level = Number(levelRaw);
            if (!Number.isInteger(level) || level < 0 || level > 100)
                fail(`level 必须是 0 到 100 的整数，收到: ${levelRaw ?? '(无)'}`);
            if (level > 0 && !values.confirm)
                fail('非零强度需要 --confirm 确认。');
            target = 'yilia.set';
            payload = { action, level, confirm: values.confirm };
            break;
        }
        case 'vibration':
        case 'linear':
        case 'rotary': {
            const level = Number(args[0]);
            if (!Number.isInteger(level) || level < 0 || level > 100)
                fail(`level 必须是 0 到 100 的整数，收到: ${args[0] ?? '(无)'}`);
            if (level > 0 && !values.confirm)
                fail('非零强度需要 --confirm 确认。');
            target = `yilia.${command}`;
            payload = { level, confirm: values.confirm };
            break;
        }
        default:
            fail(`未知命令: ${command}（-h 查看帮助）`);
    }
    // 连接服务器
    const client = new NApp({ id: `yilia-cli-${process.pid}` });
    let spec;
    if (transport === 'ws') {
        client.nact.use(new WebSocketClientProvider());
        spec = { type: 'websocket', provider: { url } };
    }
    else {
        client.nact.use(new StreamableHTTPClientProvider());
        spec = { type: 'streamable-http', provider: { url } };
    }
    try {
        await client.start();
        await client.connect(serverId, spec);
    }
    catch (err) {
        await client.terminate().catch(() => { });
        fail(`无法连接服务器 ${serverId}（${url}）：${err instanceof Error ? err.message : String(err)}`);
    }
    try {
        const call = client.request(serverId, { kind: 'ability', target, payload });
        const response = await call.response;
        console.log(JSON.stringify(response.payload, null, 2));
    }
    catch (err) {
        // 请求被拒绝（如 confirm 缺失、设备未连接、型号不支持）
        fail(`请求被拒绝：${err instanceof Error ? err.message : String(err)}`);
    }
    finally {
        await client.terminate().catch(() => { });
    }
}
await main();
//# sourceMappingURL=cli.js.map