// 打印当前运行的 DSH 实例地址（桌面版端口运行时发现；DSH 0.2.1+ 每次启动都变）。
// 用法：
//   $u = node scripts/which-port.mjs
//   node scripts/auth-regress.mjs $u
//   node scripts/execute-regress.mjs $u
// 找不到实例时 exit 1（避免下游脚本在网络错误上打转）。
//
// 原理：从 ../main.js 提取 DESKTOP-DISCOVERY 块 eval 后直接调用——与插件用的是同一份发现代码，
// 不是另一套"看起来差不多"的实现。
import fs from "node:fs";
import path from "node:path";
import child_process from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "main.js"), "utf8");
const block = /\/\* ==== DESKTOP-DISCOVERY-BEGIN[\s\S]*?DESKTOP-DISCOVERY-END ==== \*\//.exec(src);
if (!block) {
    console.error("FAIL 找不到 DESKTOP-DISCOVERY 块");
    process.exit(1);
}
const ns = new Function("child_process", "path", "process", `
    ${block[0]}
    return { discoverDesktopPorts, lastDiscoveryNote };
`)(child_process, path, process);

const ports = await ns.discoverDesktopPorts();
if (!ports.length) {
    console.error("没发现运行中的桌面版 App 端口" + (ns.lastDiscoveryNote() ? "（" + ns.lastDiscoveryNote() + "）" : ""));
    process.exit(1);
}
// 第一个端口 = 升序最小；同一台机器通常只有一个监听，多个时由调用方自行探测。
console.log(`http://127.0.0.1:${ports[0]}`);
