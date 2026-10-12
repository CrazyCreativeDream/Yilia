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
export {};
