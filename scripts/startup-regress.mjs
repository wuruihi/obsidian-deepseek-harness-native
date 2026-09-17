// DSH 探测 / 启动命令解析 回归（离线、确定性）—— 用法：node scripts/startup-regress.mjs
//
// 守的契约（v0.7.5 修「一键启动永远超时」时定下；改 detectDsh / resolveStartupCommand /
// DEFAULT_SETTINGS / loadSettings 必跑）：
//   1) **默认设置里不许出现任何机器专属路径**——0.7.4 内置过一条写死作者用户名的命令，
//      换机/改名后必崩，且症状是「120s 无声超时」，与「启动慢」无法区分（VSCode 0.18.5 同款事故）。
//   2) npm 部署形态必须按**结构**判定（<dir>/node_modules/@deepseek-ai/dsh/lib/bin.js），
//      不能按仓库特征猜：本机 ~/dsh 无 .git、package.json 既无 name 也无 scripts。
//   3) 显式配置优先，但升级遗留 / 换机失效的显式路径要被**报出并绕过**（回退自动探测），
//      不允许静默失败。
//   4) 探测失败时消息要列出已探测目录（可诊断），并优先 PATH 上的 dsh。
//
// 做法：把 require("obsidian") 换成桩件、用 new Function 求值真 main.js，导出私有函数后
//   用**临时目录夹具**伪造各种安装布局；PATH 在断言期间被缩到系统目录，保证 hasBin("dsh")
//   不受本机实际环境影响（否则本机装了 dsh 就会短路掉结构判定分支）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require2 = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.join(here, "..", "main.js");
const WIN = process.platform === "win32";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " -> " + detail : ""}`);
    ok ? pass++ : fail++;
};

// ---- 桩件 + 求值真 main.js（导出本回归需要的私有符号）----
function obsidianStub() {
    class Plugin { constructor(app, manifest) { this.app = app; this.manifest = manifest; } async loadData() { return {}; } async saveData() {} addRibbonIcon() { return {}; } registerView() {} addSettingTab() {} registerEvent() {} addCommand() {} registerDomEvent() {} async onload() {} async onunload() {} }
    class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; } }
    class Setting { setName() { return this; } setDesc() { return this; } addText() { return this; } addToggle() { return this; } addDropdown() { return this; } addButton() { return this; } addTextArea() { return this; } addSlider() { return this; } }
    class ItemView { constructor(leaf) { this.leaf = leaf; } }
    class Notice { constructor(msg) { console.log("[Notice]", msg); } }
    class Component { load() {} unload() {} }
    class Modal { constructor(app) { this.app = app; } }
    class MarkdownView {}
    const requestUrl = async () => ({ status: 200, headers: {}, text: "{}", json: {} });
    return { Plugin, PluginSettingTab, Setting, ItemView, Notice, MarkdownRenderer: {}, Component, Modal, MarkdownView, requestUrl };
}

let detectDsh, resolveStartupCommand, DEFAULT_SETTINGS, LEGACY_STARTUP_COMMANDS, defaultDshCandidates;
try {
    const src = fs.readFileSync(MAIN, "utf8") +
        "\n;module.exports.__x = { detectDsh, resolveStartupCommand, DEFAULT_SETTINGS, LEGACY_STARTUP_COMMANDS, defaultDshCandidates };\n";
    const stub = obsidianStub();
    const moduleShim = { exports: {} };
    const fakeRequire = (id) => (id === "obsidian" ? stub : require2(id));
    new Function("require", "module", "exports", "__filename", "__dirname", src)(
        fakeRequire, moduleShim, moduleShim.exports, MAIN, path.dirname(MAIN));
    ({ detectDsh, resolveStartupCommand, DEFAULT_SETTINGS, LEGACY_STARTUP_COMMANDS, defaultDshCandidates } = moduleShim.exports.__x);
    check("求值真 main.js 并取到探测函数族", typeof detectDsh === "function" && typeof resolveStartupCommand === "function");
} catch (e) {
    check("求值真 main.js 并取到探测函数族", false, String(e && e.message || e));
}
if (typeof detectDsh !== "function") { console.log(`\n${pass}/${pass + fail} passed`); process.exit(1); }

// ---- 临时目录夹具 ----
const ROOT = path.join(os.tmpdir(), "dsh-startup-regress");
fs.rmSync(ROOT, { recursive: true, force: true });
const mkdir = (p) => fs.mkdirSync(p, { recursive: true });
const touch = (p, body = "") => { mkdir(path.dirname(p)); fs.writeFileSync(p, body); return p; };

/** 夹具 1：npm 部署形态（对齐本机 ~/dsh 的真实长相：无 .git、package.json 无 name/scripts） */
const homeInstall = path.join(ROOT, "home-install");
const installBin = touch(path.join(homeInstall, "dsh", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"), "// bin");
touch(path.join(homeInstall, "dsh", "package.json"), JSON.stringify({ private: true }));
/** 夹具 2：源码仓库形态 */
const homeRepo = path.join(ROOT, "home-repo");
touch(path.join(homeRepo, "deepseek-harness", "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
/** 夹具 3：什么都没有 */
const homeNone = path.join(ROOT, "home-none");
mkdir(homeNone);
/** 夹具 4：PATH 上有一个可执行的 dsh */
const binDir = path.join(ROOT, "bin");
touch(path.join(binDir, WIN ? "dsh.cmd" : "dsh"), WIN ? "@echo off\r\n" : "#!/bin/sh\n");
if (!WIN) fs.chmodSync(path.join(binDir, "dsh"), 0o755);

const SYSTEM_PATH = WIN ? "C:\\Windows\\System32;C:\\Windows" : "/usr/bin:/bin";
/** 断言期间把 PATH 缩到系统目录：保证 hasBin("dsh") 只反映我们塞进去的夹具 */
function withPath(extra, fn) {
    const old = process.env.PATH;
    process.env.PATH = extra ? `${extra}${path.delimiter}${SYSTEM_PATH}` : SYSTEM_PATH;
    try { return fn(); } finally { process.env.PATH = old; }
}

try {
    // 1) 默认设置里不许有机器专属路径（公开仓库红线）
    withPath(null, () => {
        const json = JSON.stringify(DEFAULT_SETTINGS);
        check("默认设置不含机器专属路径（写死盘符/用户名即回归）",
            DEFAULT_SETTINGS.startupCommand === "" && !/[A-Za-z]:\\\\|wurui/i.test(json),
            `startupCommand=${JSON.stringify(DEFAULT_SETTINGS.startupCommand)}`);
        check("旧内置默认值已在 LEGACY_STARTUP_COMMANDS 里登记（loadSettings 迁移依赖它）",
            Array.isArray(LEGACY_STARTUP_COMMANDS) && LEGACY_STARTUP_COMMANDS.some((c) => /deepseek-harness/.test(c)),
            `${LEGACY_STARTUP_COMMANDS.length} 条`);
    });

    // 2) PATH 上的 dsh 优先
    withPath(binDir, () => {
        const r = detectDsh(homeInstall, ROOT);
        check("PATH 上有 dsh 时优先用 PATH（kind=path）",
            r.found && r.kind === "path" && r.startupCommand === "dsh web --port {port}", r.message);
    });

    // 3) npm 部署形态：按结构判定（本机 ~/dsh 这种）
    withPath(null, () => {
        const r = detectDsh(homeInstall, ROOT);
        check("npm 部署形态被结构判定认出（kind=install，不再要求仓库特征）",
            r.found && r.kind === "install" && r.dir === path.join(homeInstall, "dsh"), r.message);
        check("启动命令从 bin.js 派生（node \"<bin.js>\" web --port {port}）",
            r.startupCommand === `node "${installBin}" web --port {port}`
            || r.startupCommand === `node ${installBin} web --port {port}`,
            r.startupCommand);
    });

    // 4) 源码仓库形态仍然认得出
    withPath(null, () => {
        const r = detectDsh(homeRepo, ROOT);
        check("源码仓库形态仍被认出（kind=repo，pnpm-workspace.yaml）",
            r.found && r.kind === "repo", r.message);
    });

    // 5) 显式配置优先；升级遗留的旧默认值被忽略 → 自动探测
    withPath(null, () => {
        const legacy = LEGACY_STARTUP_COMMANDS[0];
        const r = resolveStartupCommand(legacy, homeInstall, ROOT);
        check("升级遗留的机器专属命令被忽略并回退自动探测",
            r.command.includes(installBin) && /0\.7\.4|自动探测/.test(r.warning), r.warning);
        const ok = resolveStartupCommand(`node "${installBin}" web --port {port}`, homeInstall, ROOT);
        check("用户手填且有效的命令原样使用（不覆盖用户意图）",
            ok.command === `node "${installBin}" web --port {port}` && ok.warning === "", ok.source);
        const stale = resolveStartupCommand('node "C:\\nope\\dsh\\lib\\bin.js" web --port {port}', homeInstall, ROOT);
        check("陈旧显式路径被报出并绕过（回退探测，而不是静默 120s 超时）",
            stale.command.includes(installBin) && /不存在/.test(stale.warning), stale.warning);
    });

    // 6) 什么都探测不到：大声失败 + 列出已探测目录
    withPath(null, () => {
        const r = detectDsh(homeNone, ROOT);
        check("探测不到时消息列出已探测目录（可诊断）",
            !r.found && /已探测/.test(r.message) && Array.isArray(r.probed) && r.probed.length > 0, r.message);
        const res = resolveStartupCommand("", homeNone, ROOT);
        check("探测不到且未配置 → 命令为空 + 明确原因（不静默）",
            res.command === "" && !!res.warning, res.warning);
        const cands = defaultDshCandidates(homeInstall, ROOT);
        check("候选目录包含 ~/dsh（本机真实布局）与 ~/deepseek-harness",
            cands.includes(path.join(homeInstall, "dsh")) && cands.includes(path.join(homeInstall, "deepseek-harness")),
            cands.join(" | "));
    });
} finally {
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
