/*
 * obsidian-dsh-native — 原生 Obsidian 聊天客户端（驱动本地 DeepSeek Harness / DSH）
 *
 * 架构（第一性原理）：
 * DSH(`@deepseek-ai/dsh`) 是完整 agent harness。它起一个本地 Web 服务，暴露：
 *   - REST 命令： POST /api/<method>  {type:"client-request", rpcId, method, payload}
 *   - 事件流（WebSocket）： ws://127.0.0.1:{port}/api/events.mux （upgrade 端点；普通 GET 返回 426；session/event、projection、approval/*、question/*）
 * 本插件不再裸嵌 DSH GUI（那会重复显示文件列表），而是用 Obsidian 原生 UI 直连这套 API：
 * 工作区自动绑定 vault 并固定、完全 Obsidian 主题化、无冗余文件列表。
 *
 * 协议已实测（参考 dsh-vsc 与现场抓包）：
 *   workspace.list / workspace.create{path}
 *   session.list / session.create{workspaceId} / session.prompt{sessionId,mode,content:[{type:"text",text}]}
 *   session.cancel / respond(rpcId, {ok, value})  // 审批/提问
 *   session/event: turn/start, step/start, assistant/chunk{chunk:{type:text|reasoning|block|usage|final,text}}, assistant/message, step/end, turn/end
 *   session/projection: title, sessionStats, tokenUsage, contextPressure ...
 *   approval/requested{approvalId,toolName,reason?} -> respond {sessionId, approvalId, outcome}
 *   question/requested{questions}                   -> respond {sessionId, answer:{answers:[...]}}
 */

const {
    Plugin,
    PluginSettingTab,
    Setting,
    ItemView,
    Notice,
    MarkdownRenderer,
    Component,
    Modal,
    MarkdownView,
    requestUrl,
} = require("obsidian");
const net = require("net");
const child_process = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");

const VIEW_TYPE = "dsh-native-view";

const DEFAULT_DSH_REPO_URL = "https://github.com/deepseek-ai/deepseek-harness.git";

const DEFAULT_SETTINGS = {
    port: 3080,
    startupCommand:
        'node "C:\\Users\\wurui\\deepseek-harness\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" web --port {port}',
    autoStart: true,
    detached: true,
    vaultPath: "", // 空 = 用 app.vault.adapter.basePath
    pollIntervalMs: 5000,
    readyTimeoutMs: 120000,
    mode: "queue", // session.prompt 的 mode: "queue" | "steer"
    installDir: "", // 一键安装目标目录（默认 ~\\deepseek-harness）
    installUrl: DEFAULT_DSH_REPO_URL, // 克隆地址（国内可换 gh-proxy 镜像）
    selectionButton: false, // 框选后显示「发送到 DSH」浮动按钮
    openPanelOnSend: false, // 发送后自动打开/聚焦 DSH 面板
    manualTitles: {}, // 会话手动重命名覆盖表：{ [sessionId]: 自定义标题 }，持久化以跨重启保留
    autoTitles: {}, // DSH 自动命名的缓存（session.list 不带 title，探测 history 尾页投影后缓存，跨重启保留）
    modelMemory: {}, // 按工作区记忆默认模型（v0.5.2 对齐）：{ [workspaceId]: {provider, model} }，新会话只继承本项目的
    authToken: "", // v012 鉴权兜底：手动填启动 token（正常留空——铸 cookie 自动搞定）
};

/* ====================================================================
 * DSH 安装检测 + 一键安装（从 dsh-harness 旧插件移植，简化版）
 * ================================================================== */
const INSTALL_TIMEOUT_MS = 600000; // git clone / pnpm install 单步上限

function isDshRepo(dir) {
    const fs = require("fs");
    const path = require("path");
    if (!dir) return false;
    try {
        if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return true;
        const pkgPath = path.join(dir, "package.json");
        if (!fs.existsSync(pkgPath)) return false;
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        if (pkg.name && typeof pkg.name === "string" && pkg.name.includes("deepseek-harness")) return true;
        return Boolean(pkg.scripts && typeof pkg.scripts.dsh === "string");
    } catch (_e) { return false; }
}
function defaultDshCandidates(homeDir, cwd) {
    const os = require("os");
    const path = require("path");
    homeDir = homeDir || os.homedir();
    cwd = cwd || process.cwd();
    const winPaths = process.platform === "win32" ? ["D:\\deepseek-harness", "C:\\deepseek-harness"] : [];
    const posixPaths = process.platform === "darwin" ? ["/opt/deepseek-harness", "/usr/local/deepseek-harness"] : [];
    return [...new Set([cwd, path.join(homeDir, "deepseek-harness"), ...posixPaths, ...winPaths].filter(Boolean))];
}
function hasBin(name) {
    const cp = require("child_process");
    const probe = process.platform === "win32" ? "where" : "which";
    try { cp.execFileSync(probe, [name], { stdio: "ignore" }); return true; }
    catch (_e) { return false; }
}
function detectDsh(homeDir, cwd) {
    // 1) PATH 里有没有 dsh
    if (hasBin("dsh")) {
        return {
            found: true,
            kind: "path",
            dir: "",
            startupCommand: "dsh web --port {port}",
            startupCwd: cwd || process.cwd(),
            message: "已在 PATH 中找到 dsh（直接用 `dsh web` 启动）",
        };
    }
    // 2) 常见目录扫描
    const fs = require("fs");
    for (const dir of defaultDshCandidates(homeDir, cwd)) {
        if (fs.existsSync(dir) && isDshRepo(dir)) {
            const cmd = hasBin("pnpm") ? "pnpm dsh web --port {port}" : "npm run dsh -- web --port {port}";
            return {
                found: true,
                kind: "repo",
                dir,
                startupCommand: cmd,
                startupCwd: dir,
                message: "已找到 DSH 仓库：" + dir,
            };
        }
    }
    return { found: false, kind: "none", dir: "", startupCommand: "", startupCwd: "", message: "未检测到 DSH 安装（PATH 与常见目录均无）" };
}
/** 用 spawn 跑一条命令并实时把进度通过 onStep 回调上抛（避免长任务阻塞 UI） */
function spawnStep(cmd, args, opts, onStep) {
    const cp = require("child_process");
    return new Promise((resolve) => {
        let child;
        try { child = cp.spawn(cmd, args, { windowsHide: true, ...opts }); }
        catch (e) { resolve({ ok: false, out: "", err: "spawn 失败：" + (e && e.message || String(e)) }); return; }
        let out = "", err = "";
        let killed = false;
        const killTimer = setTimeout(() => {
            killed = true;
            try { child.kill(); } catch (_e) {}
            resolve({ ok: false, out, err: (err || "（超时，已终止）") + " [timeout " + (opts && opts.timeout || INSTALL_TIMEOUT_MS) + "ms]" });
        }, (opts && opts.timeout) || INSTALL_TIMEOUT_MS);
        child.stdout.on("data", (b) => {
            const s = b.toString(); out += s;
            if (onStep) onStep({ stream: "stdout", text: s });
        });
        child.stderr.on("data", (b) => {
            const s = b.toString(); err += s;
            if (onStep) onStep({ stream: "stderr", text: s });
        });
        child.on("error", (e) => { clearTimeout(killTimer); resolve({ ok: false, out, err: "spawn error: " + (e.message || String(e)) }); });
        child.on("close", (code) => {
            clearTimeout(killTimer);
            if (killed) return;
            if (code === 0) resolve({ ok: true, out, err });
            else resolve({ ok: false, out, err: (err || "exit " + code) });
        });
    });
}
async function installDsh(targetDir, onStep, repoUrl) {
    const fs = require("fs");
    const path = require("path");
    if (!targetDir) return { ok: false, message: "目标目录为空" };
    if (fs.existsSync(targetDir) && isDshRepo(targetDir)) {
        return { ok: true, message: "目录已是 DSH 仓库：" + targetDir, dir: targetDir };
    }
    if (fs.existsSync(targetDir)) {
        // 非空且不是 DSH 仓库——不动用户的目录，告知手动
        return { ok: false, message: "目标目录已存在且不是 DSH 仓库，请先清空或换一个目录：" + targetDir };
    }
    // 依赖检查
    if (!hasBin("git")) return { ok: false, message: "缺少依赖：git（请先安装 git）" };
    if (!hasBin("node")) return { ok: false, message: "缺少依赖：node（请先安装 Node.js）" };
    const stepNotify = (msg) => { if (onStep) onStep({ phase: msg }); };
    // 1) git clone
    stepNotify("正在 clone DSH 仓库（首次可能较慢）…");
    const r1 = await spawnStep("git", [
        "clone", "--depth", "1",
        "--config", "http.postBuffer=524288000",
        "--config", "http.lowSpeedLimit=1000",
        "--config", "http.lowSpeedTime=30",
        repoUrl || DEFAULT_DSH_REPO_URL, targetDir,
    ], { timeout: INSTALL_TIMEOUT_MS });
    if (!r1.ok) return { ok: false, message: "git clone 失败：" + (r1.err || r1.out).slice(0, 300) };
    if (!fs.existsSync(targetDir) || !isDshRepo(targetDir)) {
        return { ok: false, message: "clone 完成但目录不是 DSH 仓库，请检查网络或目录权限" };
    }
    // 2) pnpm install（有 pnpm 用 pnpm，否则 npm install）
    if (hasBin("pnpm")) {
        stepNotify("正在 pnpm install（首次较慢，可能数分钟）…");
        const r2 = await spawnStep("pnpm", ["-C", targetDir, "install"], { timeout: INSTALL_TIMEOUT_MS });
        if (!r2.ok) {
            return { ok: true, message: "clone 成功，但 pnpm install 失败：\n" + (r2.err || r2.out).slice(0, 500) + "\n\n请手动到 " + targetDir + " 跑 `pnpm install`", dir: targetDir };
        }
    } else {
        stepNotify("未检测到 pnpm，跳过 install（请手动跑 npm install）…");
    }
    return { ok: true, message: "DSH 安装完成：" + targetDir, dir: targetDir };
}

/* ====================================================================
 * 服务生命周期（启动 / 探活 / 停止 dsh web）—— 沿用已验证机制
 * ================================================================== */
function tokenizeCommand(template) {
    const trimmed = (template || "").trim();
    if (!trimmed) return { command: "", args: [] };
    const tokens = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < trimmed.length; i++) {
        const ch = trimmed[i];
        if (ch === '"') {
            inQuotes = !inQuotes;
        } else if (/\s/.test(ch) && !inQuotes) {
            if (cur) {
                tokens.push(cur);
                cur = "";
            }
        } else {
            cur += ch;
        }
    }
    if (cur) tokens.push(cur);
    return { command: tokens[0] || "", args: tokens.slice(1) };
}

function tcpProbe(port, timeoutMs) {
    return new Promise((resolve) => {
        const socket = net.connect({ host: "127.0.0.1", port });
        const timer = setTimeout(() => {
            socket.destroy();
            resolve(false);
        }, timeoutMs);
        socket.once("connect", () => {
            clearTimeout(timer);
            socket.destroy();
            resolve(true);
        });
        socket.once("error", () => {
            clearTimeout(timer);
            resolve(false);
        });
    });
}

function winQuote(part) {
    return /\s/.test(part) ? '"' + part + '"' : part;
}

function winSpawnHidden(command, args, cwd, detached) {
    const cmdLine = [winQuote(command), ...args.map(winQuote)].join(" ");
    const vbsPath = path.join(os.tmpdir(), `dsh-launch-${process.pid}-${Date.now()}.vbs`);
    const body =
        'Set sh = CreateObject("WScript.Shell")\r\n' +
        "On Error Resume Next\r\n" +
        `Set ex = sh.Run("cmd.exe /d /s /c ${cmdLine.replaceAll('"', '""')}", 0, True)\r\n` +
        "If Err.Number = 0 And Not ex Is Nothing Then WScript.Quit ex.ExitCode\r\n";
    fs.writeFileSync(vbsPath, "﻿" + body, "utf16le");
    const child = child_process.spawn("wscript.exe", ["//nologo", "//b", vbsPath], {
        cwd,
        detached,
        stdio: "ignore",
        windowsHide: true,
    });
    const cleanup = () => {
        try {
            fs.unlinkSync(vbsPath);
        } catch (e) {
            /* ignore */
        }
    };
    child.once("exit", cleanup);
    child.once("error", cleanup);
    return child;
}

function spawnLaunch(command, args, cwd, detached) {
    if (process.platform === "win32") return winSpawnHidden(command, args, cwd, detached);
    return child_process.spawn(command, args, { cwd, detached: true, stdio: "ignore", windowsHide: true });
}

function killPort(port) {
    return new Promise((resolve) => {
        if (process.platform !== "win32") return resolve(false);
        const ps = `try { $p = (Get-NetTCPConnection -LocalPort ${port} -ErrorAction Stop).OwningProcess | Sort-Object -Unique; foreach ($id in $p) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue } } catch { }`;
        const child = child_process.spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
            stdio: "ignore",
            windowsHide: true,
        });
        child.once("exit", () => resolve(true));
        child.once("error", () => resolve(false));
    });
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

class ServiceManager {
    constructor(opts) {
        this.opts = opts;
        this.child = null;
        this.spawned = false;
        this.spawnError = null;
        this.disposed = false;
    }
    async probe() {
        return tcpProbe(this.opts.port, 3000);
    }
    describeOffline() {
        if (this.spawnError) return this.spawnError;
        if (!this.opts.autoStart) return `127.0.0.1:${this.opts.port} 无服务，且自动启动已关闭`;
        if (this.spawned) return `DSH 服务已停止（进程退出或端口 ${this.opts.port} 无响应）`;
        return `127.0.0.1:${this.opts.port} 无服务`;
    }
    async ensureOnline() {
        if (await this.probe()) return { kind: "online" };
        if (!this.opts.autoStart) return { kind: "failed", message: this.describeOffline() };
        this.start();
        const deadline = Date.now() + this.opts.readyTimeoutMs;
        while (Date.now() < deadline) {
            if (this.disposed) return { kind: "failed", message: "插件已卸载" };
            if (this.spawnError) return { kind: "failed", message: "启动失败：" + this.spawnError };
            await delay(this.opts.pollIntervalMs);
            if (await this.probe()) return { kind: "online" };
        }
        return { kind: "failed", message: `等待服务就绪超时（${Math.ceil(this.opts.readyTimeoutMs / 1000)}s）` };
    }
    start() {
        if (this.disposed || this.child) return;
        const { command, args } = tokenizeCommand(this.opts.startupCommand);
        if (!command) {
            this.spawnError = "启动命令为空，请在设置里填写";
            return;
        }
        const child = spawnLaunch(command, args, this.opts.startupCwd, this.opts.detached);
        this.child = child;
        this.spawned = true;
        child.on("exit", (code) => {
            this.child = null;
            if (code !== 0 && code !== null) this.spawnError = this.spawnError || `进程退出，代码 ${code}`;
        });
        child.on("error", (err) => {
            this.spawnError = err.message;
            this.child = null;
        });
    }
    dispose() {
        this.disposed = true;
        if (this.child && !this.opts.detached) {
            const pid = this.child.pid;
            if (pid && process.platform === "win32") {
                try {
                    child_process.execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
                } catch (e) {
                    /* ignore */
                }
            } else if (pid) {
                try {
                    process.kill(-pid, "SIGTERM");
                } catch (e) {
                    /* ignore */
                }
            } else {
                this.child.kill();
            }
            this.child = null;
        }
    }
    reset() {
        this.child = null;
        this.disposed = false;
        this.spawnError = null;
        this.spawned = false;
    }
}

/* ====================================================================
 * DSH REST API 客户端
 * ================================================================== */
function rpcId() {
    return typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : "id-" + Math.random().toString(36).slice(2);
}
function normPath(p) {
    // 两种分隔符都归一成 "/"，并去掉首尾空白与尾部分隔符，避免 DSH 返回的反斜杠与
    // Obsidian basePath 的正斜杠比对失败（曾导致误判"无匹配 workspace"而去重复创建/报错）。
    return (p || "")
        .replace(/[\\/]+/g, "/")
        .replace(/^\s+|\s+$/g, "")
        .replace(/\/+$/, "")
        .toLowerCase();
}

/* ====================================================================
 * dsh-ui 富卡片渲染器
 * 搬运自 VSCode DSH 扩展 dsh-ui-inject.js（community patch 2026-08-17），
 * 逻辑保持一致；类名沿用 dui-*，配色在 styles.css 里用 Obsidian 变量接管。
 * 调用方：把 ```dsh-ui 围栏块（Obsidian 渲染成 <pre><code class="language-dsh-ui">）
 * 解析 JSON spec 后替换成卡片。
 * ================================================================== */
function dshUiEsc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
// ====================================================================
// Phase I：mermaid / plot 自研 SVG 渲染（移植自 VSCode dshui.tsx / mermaid.tsx）
// 不依赖 mermaid.js；mermaid 仅支持 flowchart 子集（graph TD/LR），plot 仅接受白名单数学表达式。
// 解析失败一律降级为代码块，绝不崩。
// ====================================================================

// 白名单编译 plot 表达式 f(x)：只允许数学函数与常量，杜绝任意代码执行
function dshUiCompileExpr(expr) {
    const src = String(expr == null ? "" : expr).trim();
    if (!src || src.length > 200) return null;
    if (!/^[-+*/%().,\d\sxA-Fa-f]|^(sin|cos|tan|asin|acos|atan|sqrt|cbrt|exp|log|ln|abs|floor|ceil|round|min|max|pow|pi|tau|e|x)/.test(src)) return null;
    const idents = src.match(/[A-Za-z]+/g) || [];
    const ALLOWED = new Set(["sin", "cos", "tan", "asin", "acos", "atan", "sqrt", "cbrt", "exp", "log", "ln", "abs", "floor", "ceil", "round", "min", "max", "pow", "pi", "tau", "e", "x"]);
    for (const id of idents) if (!ALLOWED.has(id)) return null;
    try {
        const f = new Function('"use strict"; const {sin,cos,tan,asin,acos,atan,sqrt,cbrt,exp,abs,floor,ceil,round,min,max,pow}=Math; const log=Math.log, ln=Math.log, pi=Math.PI, tau=Math.PI*2, e=Math.E; return (x) => (' + src + ');')();
        if (typeof f(1) !== "number") return null;
        return f;
    } catch (_e) { return null; }
}

// mermaid flowchart 子集 → SVG 字符串；无法解析返回 null
function dshUiMermaidSvg(code) {
    const lines = String(code == null ? "" : code).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("%%"));
    if (!lines.length) return null;
    const m = /^(?:graph|flowchart)\s+(TD|TB|LR|RL)/i.exec(lines[0]);
    if (!m) return null;
    const lr = /^(LR|RL)$/i.test(m[1]);
    const nodes = new Map();
    const edges = [];
    const edgeRe = /^([\w-]+)\s*(\[[^\]]*\]|\([^)]*\)|\{[^}]*\})?\s*(-{2,3}>|-\.->)\s*([\w-]+)\s*(\[[^\]]*\]|\([^)]*\)|\{[^}]*\})?(?:\s*\|([^|]+)\|)?$/;
    const plainRe = /^([\w-]+)\s*(\[\[.*\]\]|\[.*\]|\(.*\)|\{.*\})$/;
    const labelRe = /^([\w-]+)\s*(-{2,3}>|-\.->)\s*\|([^|]+)\|\s*([\w-]+)\s*(\[[^\]]*\]|\([^)]*\))?$/;
    const labelOf = (raw) => {
        if (!raw) return { text: "", shape: "rect" };
        if (raw.startsWith("[[") && raw.endsWith("]]")) return { text: raw.slice(2, -2), shape: "rect" };
        if (raw.startsWith("[") && raw.endsWith("]")) return { text: raw.slice(1, -1), shape: "round" };
        if (raw.startsWith("(") && raw.endsWith(")")) return { text: raw.slice(1, -1), shape: "stadium" };
        return { text: raw.slice(1, -1), shape: "rect" };
    };
    const upsert = (id, raw) => {
        const info = labelOf(raw);
        const ex = nodes.get(id);
        if (!ex) nodes.set(id, { id, label: info.text || id, shape: info.shape });
        else if (info.text) ex.label = info.text;
    };
    for (const line of lines.slice(1)) {
        const em = edgeRe.exec(line);
        if (em) { upsert(em[1], em[2]); upsert(em[4], em[5]); edges.push({ from: em[1], to: em[4], label: em[6] ? em[6].trim() : undefined, dashed: em[3].indexOf(".") >= 0 }); continue; }
        const pm = plainRe.exec(line);
        if (pm) { upsert(pm[1], pm[2]); continue; }
        const lm = labelRe.exec(line);
        if (lm) { upsert(lm[1]); upsert(lm[4], lm[5]); edges.push({ from: lm[1], to: lm[4], label: lm[3] ? lm[3].trim() : undefined, dashed: lm[2].indexOf(".") >= 0 }); }
    }
    if (nodes.size === 0) return null;
    // 最长路径分层布局（容忍环）
    const NODE_W = 150, NODE_H = 44, GAP_Y = 76, GAP_X = 190;
    const depth = new Map();
    const byId = new Map([...nodes.values()].map((nn) => [nn.id, nn]));
    const setDepth = (id, d, seen) => {
        if (seen.has(id)) return;
        seen.add(id);
        const cur = depth.get(id) || 0;
        depth.set(id, Math.max(cur, d));
        for (const e of edges.filter((x) => x.from === id)) if (byId.has(e.to)) setDepth(e.to, d + 1, seen);
    };
    const targets = new Set(edges.map((e) => e.to));
    for (const nn of nodes.values()) if (!targets.has(nn.id)) setDepth(nn.id, 0, new Set());
    for (const nn of nodes.values()) if (depth.get(nn.id) === undefined) depth.set(nn.id, 0);
    const layers = new Map();
    for (const nn of nodes.values()) {
        const d = depth.get(nn.id) || 0;
        const arr = layers.get(d) || [];
        arr.push(nn.id);
        layers.set(d, arr);
    }
    const pos = new Map();
    for (const [d, ids] of layers) {
        ids.forEach((id, i) => {
            const lane = i - (ids.length - 1) / 2;
            pos.set(id, { x: lr ? d * GAP_X : lane * GAP_X, y: lr ? lane * GAP_Y : d * GAP_Y });
        });
    }
    const xs = [...pos.values()].map((p) => p.x), ys = [...pos.values()].map((p) => p.y);
    const minX = Math.min(...xs) - NODE_W / 2 - 20, maxX = Math.max(...xs) + NODE_W / 2 + 20;
    const minY = Math.min(...ys) - NODE_H / 2 - 20, maxY = Math.max(...ys) + NODE_H / 2 + (edges.some((e) => e.label) ? 30 : 20);
    const w = maxX - minX, h = maxY - minY;
    const edgePath = (from, to) => {
        const a = pos.get(from), b = pos.get(to);
        if (!a || !b) return "";
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        if (lr) return "M " + (a.x + NODE_W / 2) + " " + a.y + " C " + mx + " " + a.y + ", " + mx + " " + b.y + ", " + (b.x - NODE_W / 2) + " " + b.y;
        return "M " + a.x + " " + (a.y + NODE_H / 2) + " C " + a.x + " " + my + ", " + b.x + " " + my + ", " + b.x + " " + (b.y - NODE_H / 2);
    };
    let svg = '<div class="dui-mermaid-wrap"><svg viewBox="' + minX + " " + minY + " " + w + " " + h + '" width="100%" style="max-height:420">';
    svg += '<defs><marker id="dui-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor"/></marker></defs>';
    for (const e of edges) {
        const d = edgePath(e.from, e.to);
        if (!d) continue;
        svg += '<path d="' + d + '" fill="none" stroke="currentColor" stroke-opacity="0.55" stroke-width="1.4"' + (e.dashed ? ' stroke-dasharray="5 4"' : "") + ' marker-end="url(#dui-arrow)"/>';
        if (e.label) {
            const a = pos.get(e.from), b = pos.get(e.to);
            svg += '<text x="' + ((a.x + b.x) / 2) + '" y="' + ((a.y + b.y) / 2 - 6) + '" text-anchor="middle" class="dui-edge-label">' + dshUiEsc(e.label) + "</text>";
        }
    }
    for (const nn of nodes.values()) {
        const p = pos.get(nn.id);
        const rx = nn.shape === "stadium" ? NODE_H / 2 : nn.shape === "round" ? 10 : 4;
        const lbl = nn.label.length > 16 ? nn.label.slice(0, 15) + "…" : nn.label;
        svg += '<g transform="translate(' + (p.x - NODE_W / 2) + "," + (p.y - NODE_H / 2) + ')"><rect width="' + NODE_W + '" height="' + NODE_H + '" rx="' + rx + '" class="dui-mnode"/><text x="' + (NODE_W / 2) + '" y="' + (NODE_H / 2 + 4) + '" text-anchor="middle" class="dui-mnode-label">' + dshUiEsc(lbl) + "</text></g>";
    }
    svg += "</svg></div>";
    return svg;
}

// plot 函数图 → SVG 字符串；无有效序列返回 null
function dshUiPlotSvg(node) {
    const width = 460, height = 240, pad = 28;
    const xMin = typeof node.xMin === "number" ? node.xMin : -5;
    const xMax = typeof node.xMax === "number" ? node.xMax : 5;
    const PALETTE = ["#3794ff", "#3fb950", "#d29922", "#f47067", "#bc8cff", "#39c5cf"];
    const series = Array.isArray(node.series) ? node.series : [];
    const compiled = [];
    for (const s of series) {
        const expr = String(s && s.expr != null ? s.expr : "");
        const f = dshUiCompileExpr(expr);
        if (f) compiled.push({ f, expr, label: s && s.label });
    }
    if (!compiled.length) return null;
    let lo = Infinity, hi = -Infinity;
    for (const s of compiled) for (let i = 0; i <= 200; i++) {
        const v = s.f(xMin + ((xMax - xMin) * i) / 200);
        if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) { const mid = Number.isFinite(lo) ? lo : 0; lo = mid - 1; hi = mid + 1; }
    else { const margin = (hi - lo) * 0.08; lo -= margin; hi += margin; }
    const sx = (x) => pad + ((x - xMin) / (xMax - xMin)) * (width - 2 * pad);
    const sy = (y) => height - pad - ((y - lo) / (hi - lo)) * (height - 2 * pad);
    let svg = '<div class="dui-plot-wrap">';
    if (node.title) svg += '<div class="dui-text dui-text-h3">' + dshUiEsc(String(node.title)) + "</div>";
    svg += '<svg viewBox="0 0 ' + width + " " + height + '" width="100%">';
    svg += '<rect x="' + pad + '" y="' + pad + '" width="' + (width - 2 * pad) + '" height="' + (height - 2 * pad) + '" fill="none" stroke="currentColor" stroke-opacity="0.2" rx="6"/>';
    if (lo < 0 && hi > 0) svg += '<line x1="' + pad + '" x2="' + (width - pad) + '" y1="' + sy(0) + '" y2="' + sy(0) + '" stroke="currentColor" stroke-opacity="0.25"/>';
    if (xMin < 0 && xMax > 0) svg += '<line x1="' + sx(0) + '" x2="' + sx(0) + '" y1="' + pad + '" y2="' + (height - pad) + '" stroke="currentColor" stroke-opacity="0.25"/>';
    compiled.forEach((s, i) => {
        const pts = [];
        for (let k = 0; k <= 200; k++) {
            const x = xMin + ((xMax - xMin) * k) / 200;
            const y = s.f(x);
            if (Number.isFinite(y)) pts.push(sx(x) + "," + sy(y));
        }
        svg += '<polyline points="' + pts.join(" ") + '" fill="none" stroke="' + PALETTE[i % PALETTE.length] + '" stroke-width="1.8"/>';
    });
    svg += "</svg>";
    svg += '<div class="dui-plot-legend">';
    compiled.forEach((s, i) => { svg += '<span class="dui-dot" style="background:' + PALETTE[i % PALETTE.length] + '"></span>' + dshUiEsc(s.label ? String(s.label) : s.expr); });
    svg += "</div></div>";
    return svg;
}

function dshUiRenderNode(n, deep) {
    if (n == null) return "";
    const t = n.type || "";
    switch (t) {
        case "text": {
            const size = n.size || "body";
            const cls = "dui-t-" + size + (n.center ? " dui-center" : "");
            return '<div class="' + cls + '">' + dshUiEsc(n.content) + "</div>";
        }
        case "callout": {
            const tone = n.tone || "info";
            const title = n.title ? '<div class="dui-callout-title">' + dshUiEsc(n.title) + "</div>" : "";
            return '<div class="dui-callout dui-co-' + dshUiEsc(tone) + '">' + title + '<div class="dui-callout-content">' + dshUiEsc(n.content) + "</div></div>";
        }
        case "badge": {
            const b = n.tone ? " dui-bd-" + dshUiEsc(n.tone) : "";
            const icon = n.icon ? dshUiEsc(n.icon) + " " : "";
            return '<span class="dui-badge' + b + '">' + icon + dshUiEsc(n.label) + "</span>";
        }
        case "stat": {
            const delta = n.delta ? '<span class="dui-stat-delta ' + (String(n.delta).startsWith("-") ? "dui-delta-down" : "dui-delta-up") + '">' + dshUiEsc(n.delta) + "</span>" : "";
            return '<div class="dui-stat"><span class="dui-stat-label">' + dshUiEsc(n.label) + '</span><span class="dui-stat-value">' + dshUiEsc(n.value) + "</span>" + delta + "</div>";
        }
        case "progress": {
            const v = Math.max(0, Math.min(100, Number(n.value) || 0));
            const vl = n.valueLabel != null ? dshUiEsc(n.valueLabel) : v + "%";
            return '<div class="dui-progress"><div class="dui-progress-label"><span>' + dshUiEsc(n.label || "") + "</span><span>" + vl + '</span></div><div class="dui-progress-bar"><div class="dui-progress-fill" style="width:' + v + '%"></div></div></div>';
        }
        case "table": {
            const cols = (n.columns || []).map((c) => "<th>" + dshUiEsc(c) + "</th>").join("");
            const rows = (n.rows || []).map((r) => "<tr>" + (Array.isArray(r) ? r : []).map((c) => "<td>" + dshUiEsc(c) + "</td>").join("") + "</tr>").join("");
            return '<table class="dui-table"><thead><tr>' + cols + "</tr></thead><tbody>" + rows + "</tbody></table>";
        }
        case "list": {
            const items = Array.isArray(n.items) ? n.items.map((it) => {
                if (typeof it === "string") return "<li>" + dshUiEsc(it) + "</li>";
                if (it && typeof it === "object") {
                    const tt = it.title ? '<div class="dui-list-item-title">' + dshUiEsc(it.title) + "</div>" : "";
                    const dd = it.desc ? '<div class="dui-list-item-desc">' + dshUiEsc(it.desc) + "</div>" : "";
                    return "<li>" + tt + dd + "</li>";
                }
                return "<li>" + dshUiEsc(it) + "</li>";
            }).join("") : "";
            return '<ul class="dui-list">' + items + "</ul>";
        }
        case "keyvalue": {
            const rows = (n.pairs || []).map((p) => "<tr><td>" + dshUiEsc(p.key) + "</td><td>" + dshUiEsc(p.value) + "</td></tr>").join("");
            return '<table class="dui-kv">' + rows + "</table>";
        }
        case "steps": {
            const cur = Number(n.current) || 0;
            const steps = (n.steps || []).map((s, i) => '<div class="dui-step' + (i === cur ? " current" : "") + '"><span class="dui-step-num">' + (i + 1) + '</span><div><div class="dui-step-title">' + dshUiEsc(s.title) + '</div>' + (s.desc ? '<div class="dui-step-desc">' + dshUiEsc(s.desc) + "</div>" : "") + "</div></div>").join("");
            return '<div class="dui-steps">' + steps + "</div>";
        }
        case "divider":
            return '<hr class="dui-divider">';
        case "spacer":
            return '<div class="dui-spacer" style="height:' + (Number(n.size) || 10) + 'px"></div>';
        case "grid": {
            const cols = Math.max(1, Number(n.cols) || 1);
            const inner = (n.items || []).map((i) => "<div>" + dshUiRenderNode(i, deep + 1) + "</div>").join("");
            return '<div class="dui-grid" style="grid-template-columns:repeat(' + cols + ',minmax(0,1fr))">' + inner + "</div>";
        }
        case "row":
            return '<div class="dui-row">' + (n.items || []).map((i) => "<div>" + dshUiRenderNode(i, deep + 1) + "</div>").join("") + "</div>";
        case "col":
            return '<div class="dui-col">' + (n.items || []).map((i) => dshUiRenderNode(i, deep + 1)).join("") + "</div>";
        case "card": {
            const title = n.title ? '<div class="dui-card-title">' + dshUiEsc(n.title) + "</div>" : "";
            return '<div class="dui-card">' + title + (n.items || []).map((i) => dshUiRenderNode(i, deep + 1)).join("") + "</div>";
        }
        case "link":
            return n.href ? '<a class="dui-link" href="' + dshUiEsc(n.href) + '" target="_blank" rel="noreferrer">' + dshUiEsc(n.label || n.href) + "</a>" : "<span>" + dshUiEsc(n.label || "") + "</span>";
        case "json":
            return '<div class="dui-json">' + dshUiEsc(typeof n.value === "string" ? n.value : JSON.stringify(n.value, null, 2)) + "</div>";
        case "code":
            return '<div class="dui-codeblock">' + dshUiEsc(n.code) + "</div>";
        case "copy": {
            const label = n.label || "复制";
            return '<span class="dui-copy" data-copy="' + dshUiEsc(n.text || "") + '" data-label="' + dshUiEsc(label) + '" title="点击复制">' + dshUiEsc(label) + " 📋</span>";
        }
        case "tabs": {
            const tabs = n.tabs || [];
            const heads = tabs.map((tb, i) => '<span class="dui-tab' + (i === 0 ? " active" : "") + '" data-idx="' + i + '">' + dshUiEsc(tb.label) + "</span>").join("");
            const bodies = tabs.map((tb, i) => '<div class="dui-tab-panel" data-idx="' + i + '" style="' + (i === 0 ? "" : "display:none") + '">' + (tb.items || []).map((x) => dshUiRenderNode(x, deep + 1)).join("") + "</div>").join("");
            return '<div class="dui-tabs"><div class="dui-tab-head">' + heads + "</div>" + bodies + "</div>";
        }
        case "accordion": {
            const items = (n.items || []).map((a) => "<details><summary>" + dshUiEsc(a.title) + '</summary><div class="dui-acc-body">' + (a.items || []).map((i) => dshUiRenderNode(i, deep + 1)).join("") + "</div></details>").join("");
            return '<div class="dui-acc">' + items + "</div>";
        }
        case "timeline": {
            const items = (n.items || []).map((it) => '<div class="dui-tl-item"><span class="dui-tl-dot"></span><div><span class="dui-tl-title">' + dshUiEsc(it.title) + "</span>" + (it.time ? '<span class="dui-tl-time">' + dshUiEsc(it.time) + "</span>" : "") + (it.desc ? '<div class="dui-tl-desc">' + dshUiEsc(it.desc) + "</div>" : "") + "</div></div>").join("");
            return '<div class="dui-timeline">' + items + "</div>";
        }
        case "chart": {
            const data = n.data || [];
            const max = Math.max(1, ...data.map((d) => Math.abs(Number(d.value) || 0)));
            const bars = data.map((d) => {
                const v = Number(d.value) || 0;
                const w = Math.max(2, Math.round((Math.abs(v) / max) * 100));
                const color = d.color || "";
                return '<div class="dui-bar-row"><span class="dui-bar-label">' + dshUiEsc(d.label) + '</span><div class="dui-bar-track"><div class="dui-bar-fill" style="width:' + w + "%;" + (color ? "background:" + dshUiEsc(color) : "") + '"></div></div><span class="dui-bar-val">' + v + "</span></div>";
            }).join("");
            return '<div class="dui-chart">' + bars + "</div>";
        }
        case "button":
        case "input":
        case "textarea":
        case "select":
        case "checkbox":
        case "switch":
        case "slider":
        case "radio":
        case "submit":
        case "quiz": {
            const label = n.label || n.title || n.question || "";
            const extra = n.content ? " — " + n.content : "";
            return '<span class="dui-ro-input">🔒 ' + dshUiEsc(label) + dshUiEsc(extra) + "</span>";
        }
        case "mermaid": {
            const svg = dshUiMermaidSvg(n.code);
            return svg || '<div class="dui-callout dui-co-info"><div class="dui-callout-title">Mermaid 图</div><div class="dui-callout-content">' + dshUiEsc(n.code || "") + "</div></div>";
        }
        case "plot": {
            const svg = dshUiPlotSvg(n);
            return svg || '<div class="dui-callout dui-co-info"><div class="dui-callout-title">函数图</div><div class="dui-callout-content">该组件无法在本地渲染（表达式不支持或超出白名单）。</div></div>';
        }
        case "scene3d":
            return '<div class="dui-callout dui-co-info"><div class="dui-callout-title">3D 场景</div><div class="dui-callout-content">该组件仅在网页版渲染。</div></div>';
        case "avatar":
            return '<span class="dui-badge">👤 ' + dshUiEsc(n.name || "") + "</span>";
        case "breadcrumb":
            return '<div class="dui-note">' + (n.items || []).map((i) => dshUiEsc(i)).join(" › ") + "</div>";
        case "file-tree": {
            const renderTree = (items) => '<ul class="dui-list">' + (items || []).map((it) => "<li>" + (it.type === "dir" ? "📁" : "📄") + " " + dshUiEsc(it.name) + (it.children ? renderTree(it.children) : "") + "</li>").join("") + "</ul>";
            return renderTree(n.items);
        }
        default:
            return '<div class="dui-json">' + dshUiEsc(JSON.stringify(n, null, 2)) + "</div>";
    }
}
function dshUiRenderSpec(spec) {
    const title = spec.title ? '<div class="dui-title">' + dshUiEsc(spec.title) + "</div>" : "";
    const gap = Number(spec.gap) || 10;
    const items = (spec.items || []).map((i) => dshUiRenderNode(i, 0)).join("");
    return '<div class="dui-wrap" style="gap:' + gap + 'px">' + title + items + "</div>";
}

/* ====================================================================
 * V012 协议层（对齐 dsh-vscode src/connection/{browser-auth,auth,client,remote}.ts）
 * —— 双协议：legacy(0.1.1-rc.x) 与 v012(0.1.2-alpha.4+) 自动探测切换。
 * 规约：v012 = /api/<ns>/<method> 斜杠端点 + payload={args} 信封 + 鉴权 cookie；
 *       WS 走 /api/remote.mux 帧协议（open/cancel ↔ item/end/error）。
 * ================================================================== */

/* ==== AUTH-PURE-BEGIN — v012 铸 cookie 纯函数区（回归：node scripts/auth-regress.mjs） ==== */
const AUTH_COOKIE_PREFIX = "dsh-auth-";
const AUTH_SECRET_RECORD = /browser-session:[\s\S]*?secret:\s*([A-Za-z0-9_-]+)/;
const AUTH_COOKIE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000; // 远低于服务器 30 天上限
const AUTH_SECRET_BYTES = 32;

function authB64u(buf) { return Buffer.from(buf).toString("base64url"); }

/** cookie 权威串 = URL host（fetch 会原样发 Host 头） */
function authAuthorityOf(baseUrl) {
    return new URL(baseUrl).host;
}

/** 从 credentials.yaml 解析 browser-session 32B 签名密钥 */
function authReadSecret(credentialsPath) {
    let text;
    try { text = require("fs").readFileSync(credentialsPath, "utf8"); } catch (_e) { return undefined; }
    const m = AUTH_SECRET_RECORD.exec(text);
    if (!m) return undefined;
    const secret = Buffer.from(m[1], "base64url");
    return secret.byteLength === AUTH_SECRET_BYTES ? secret : undefined;
}

/** 铸签名 cookie：name = "dsh-auth-"+b64u(sha256(authority))；value = v1.<payload>.<hmac> */
function authMintCookie(authority, secret) {
    const name = AUTH_COOKIE_PREFIX + authB64u(crypto.createHash("sha256").update(authority).digest());
    const issuedAt = Date.now() - 1000; // 容忍时钟偏移（issuedAt <= now）
    const body = authB64u(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt: issuedAt + AUTH_COOKIE_LIFETIME_MS })));
    const value = `v1.${body}.${authB64u(crypto.createHmac("sha256", secret).update(body).digest())}`;
    return { name, value };
}

/** 完整路径：credentials → secret → "name=value" 串 */
function authMintFromCredentials(baseUrl, credentialsPath) {
    const secret = authReadSecret(credentialsPath);
    if (!secret) return undefined;
    const minted = authMintCookie(authAuthorityOf(baseUrl), secret);
    return `${minted.name}=${minted.value}`;
}
/* ==== AUTH-PURE-END ==== */

/** 鉴权链：手动 token(设置项) → 铸 cookie(credentials 持久密钥) → 日志捞启动 token 兑换。 */
class DshAuth {
    constructor(opts) {
        this.opts = opts || {}; // { getManualToken, home }
        this.cookie = undefined; // undefined=未获取; ""=无鉴权服务器
        this.inFlight = null;
    }
    get hasCookie() { return this.cookie !== undefined; }
    cookieHeader() { return this.cookie ? { cookie: this.cookie } : {}; }
    invalidate() { this.cookie = undefined; }
    /** GET /?token= → set-cookie（旧服务器无鉴权则置空串） */
    async exchange(baseUrl, token) {
        try {
            const u = new URL("/", new URL(baseUrl));
            u.searchParams.set("token", token);
            const res = await requestUrl({ url: u.toString(), method: "GET", throw: false });
            const sc = res.headers && (res.headers["set-cookie"] || res.headers["Set-Cookie"]);
            if (sc) { this.cookie = String(sc).split(";")[0].trim(); return true; }
            if (res.status === 200 || res.status === 302) { this.cookie = ""; return true; }
            return false;
        } catch (_e) { return false; }
    }
    /** 日志尾捞启动 token（自家服务 / ~/.dsh 下最新 .log） */
    async discoverToken() {
        const fs = require("fs");
        const home = this.opts.home || "";
        const candidates = [];
        try {
            for (const dir of [require("path").join(home, ".dsh", "logs"), require("path").join(home, ".dsh")]) {
                const names = fs.readdirSync(dir).filter((n) => n.endsWith(".log"));
                const withTime = names.map((n) => {
                    const p = require("path").join(dir, n);
                    return { path: p, mtime: fs.statSync(p).mtimeMs };
                }).sort((a, b) => b.mtime - a.mtime);
                candidates.push(...withTime.map((x) => x.path));
            }
        } catch (_e) { /* best effort */ }
        for (const file of candidates) {
            try {
                const st = fs.statSync(file);
                const fh = fs.openSync(file, "r");
                const start = Math.max(0, st.size - 262144);
                const buf = Buffer.alloc(st.size - start);
                fs.readSync(fh, buf, 0, buf.length, start);
                fs.closeSync(fh);
                const m = /token=([A-Za-z0-9_-]+)/.exec(buf.toString("utf8"));
                if (m) return m[1];
            } catch (_e) { /* next */ }
        }
        return undefined;
    }
    /** 确保拿到 cookie（并发去重）。false=所有来源都失败。 */
    ensureCookie(baseUrl) {
        if (this.cookie !== undefined) return Promise.resolve(true);
        if (this.inFlight) return this.inFlight;
        this.inFlight = (async () => {
            // 1. 手动 token（显式用户意图优先）
            const manual = (this.opts.getManualToken ? this.opts.getManualToken() : "") || "";
            if (manual && (await this.exchange(baseUrl, manual.trim()))) return true;
            // 2. 铸 cookie：零配置、跨服务器重启有效（alpha.5 主通道）
            const minted = authMintFromCredentials(baseUrl, require("path").join(this.opts.home || "", ".dsh", ".credentials.yaml"));
            if (minted) { this.cookie = minted; return true; }
            // 3. 日志 token 兑换（pre-alpha.5 / 异机启动）
            const token = await this.discoverToken();
            if (token && (await this.exchange(baseUrl, token))) return true;
            return false;
        })().finally(() => { this.inFlight = null; });
        return this.inFlight;
    }
}

/** v012 能力探测（对齐 dsh-vscode protocol.ts detectFlavor）：
 *  v012 探针 = session/list + {args}；401/403 也证明是 v012（要先鉴权）。
 *  不中再探 legacy 点端点；host.describe 兜底极老版本。 */
async function detectFlavor(baseUrl, timeoutMs = 3000) {
    const probe = async (method, envelope) => {
        try {
            const res = await withTimeout(requestUrl({
                url: `${baseUrl}/api/${method}`,
                method: "POST",
                contentType: "application/json",
                body: JSON.stringify(envelope),
                throw: false,
                headers: { accept: "application/json" },
            }), timeoutMs);
            let json = null;
            try { json = typeof res.json === "function" ? res.json : JSON.parse(res.text || "null"); } catch (_e) { /* 非 JSON 也算探测信息 */ }
            return { status: res.status, json };
        } catch (_e) { return null; }
    };
    const p1 = await probe("session/list", { type: "client-request", rpcId: rpcId(), method: "session/list", payload: { args: {} } });
    if (p1) {
        if (p1.status === 401 || p1.status === 403) return { flavor: "v012", needsAuth: true };
        if (p1.status === 200 && p1.json && p1.json.type === "server-response") return { flavor: "v012", needsAuth: false };
    }
    const p2 = await probe("session.list", { type: "client-request", rpcId: rpcId(), method: "session.list", payload: {} });
    if (p2 && p2.status === 200 && p2.json && p2.json.type === "server-response") return { flavor: "legacy", needsAuth: false };
    const p3 = await probe("host.describe", { type: "client-request", rpcId: rpcId(), method: "host.describe", payload: {} });
    if (p3 && p3.status === 200 && p3.json && p3.json.type === "server-response") return { flavor: "legacy", needsAuth: false };
    return undefined; // 服务不在 / 不是 DSH
}

/** 竞速超时包装（requestUrl 无原生超时） */
function withTimeout(promise, ms) {
    return Promise.race([promise, new Promise((_res, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
}

/** v012 流桥：单条 /api/remote.mux WS + 帧协议（open/cancel ↔ item/end/error），
 *  对上层合成 legacy 形状的 {rpcId, payload:{type,...}} 帧 —— 视图订阅代码零改动。
 *  帧解析复用插件里已有的手写 WS 客户端思路（握手不带 Origin、客户端帧必须 mask）。 */
/* ==== V012-PURE-BEGIN — v012 流桥（回归：node scripts/auth-regress.mjs） ==== */
class V012Mux {
    constructor(opts) {
        this.opts = opts; // { port, getCookie, onFrame, onReady, onBroken }
        this.stopped = false;
        this.ws = null;
        this.buf = Buffer.alloc(0);
        this.streams = new Map();
        this.pendingOpens = [];
        this.nextStreamId = 0;
        this.clientId = undefined; // $events ready
        this.desiredFollow = undefined;
        this.reconnectTimer = null;
        this.backoffMs = 1000;
    }
    get eventsClientId() { return this.clientId; }
    start() { this.stopped = false; this.connect(); }
    stop() {
        this.stopped = true;
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
        this.teardown("stopped");
    }
    /** 跟随当前会话（legacy 全广播无此概念；v012 必须显式 follow） */
    follow(sessionId) {
        this.desiredFollow = sessionId || undefined;
        if (sessionId && this.ws) this.openFollow(sessionId);
    }
    /** 一次性历史尾页（session.history 首屏）：session/follow 快照帧 */
    snapshotOnce(sessionId, maxMessages, timeoutMs = 10000) {
        return new Promise((resolve) => {
            let settled = false;
            const finish = (value) => { if (settled) return; settled = true; handle.cancel(); clearTimeout(timer); resolve(value); };
            const timer = setTimeout(() => finish({ entries: [], hasMore: false }), timeoutMs);
            const handle = this.openStream("session/follow",
                { request: { address: { kind: "session", sessionId }, ...(maxMessages !== undefined ? { maxMessages } : {}) } },
                {
                    onItem: (value) => {
                        if (value && value.type === "snapshot") {
                            finish({
                                entries: (value.records || []).map((r) => ({ event: r.event, view: r.view })),
                                hasMore: !!value.hasMore,
                                projections: value.projections,
                                cursor: value.cursor,
                            });
                        }
                    },
                    onError: () => finish({ entries: [], hasMore: false }),
                });
        });
    }
    /** 一次性工作区基线：workspace/follow baseline 帧 */
    workspacesOnce(timeoutMs = 10000) {
        return new Promise((resolve) => {
            let settled = false;
            const finish = (value) => { if (settled) return; settled = true; handle.cancel(); clearTimeout(timer); resolve(value); };
            const timer = setTimeout(() => finish({ items: [] }), timeoutMs);
            const handle = this.openStream("workspace/follow", {}, {
                onItem: (value) => {
                    if (value && value.type === "baseline") finish({ items: (value.value && value.value.items) || [] });
                },
                onError: () => finish({ items: [] }),
            });
        });
    }
    /** 开（或排队）一条逻辑流 */
    openStream(endpoint, args, cbs) {
        const streamId = "s" + (this.nextStreamId++);
        this.streams.set(streamId, { onItem: cbs.onItem, onEnd: cbs.onEnd || (() => {}), onError: cbs.onError || (() => {}) });
        if (this.ws) {
            this.sendJson({ type: "open", streamId, endpoint, payload: { args } });
        } else {
            this.pendingOpens.push({ streamId, endpoint, args });
        }
        return {
            cancel: () => {
                this.streams.delete(streamId);
                this.pendingOpens = this.pendingOpens.filter((p) => p.streamId !== streamId);
                if (this.ws) this.sendJson({ type: "cancel", streamId });
            },
        };
    }
    connect() {
        if (this.stopped) return;
        this.teardown("reconnect");
        const port = this.opts.port;
        const key = crypto.randomBytes(16).toString("base64");
        const headers = {
            Connection: "Upgrade",
            Upgrade: "websocket",
            "Sec-WebSocket-Key": key,
            "Sec-WebSocket-Version": "13",
            Host: `127.0.0.1:${port}`,
            // 故意不带 Origin —— 规避 DSH isTrustedApiRequest 的 origin 检查（同 legacy 桥）
        };
        const cookie = this.opts.getCookie ? this.opts.getCookie() : undefined;
        if (cookie) headers.Cookie = cookie; // v012 鉴权：WS 升级也要 cookie
        this.buf = Buffer.alloc(0);
        const req = http.request({ host: "127.0.0.1", port, path: "/api/remote.mux", headers });
        req.on("upgrade", (res, socket, head) => {
            this.ws = { req, socket };
            this.backoffMs = 1000;
            this.buf = Buffer.concat([this.buf, Buffer.from(head || [])]);
            socket.on("data", (chunk) => this.onData(chunk));
            socket.on("close", () => this.onDown("ws:close"));
            socket.on("error", () => this.onDown("ws:err"));
            this.openPersistentStreams();
            for (const p of this.pendingOpens) this.sendJson({ type: "open", streamId: p.streamId, endpoint: p.endpoint, payload: { args: p.args } });
            this.pendingOpens = [];
            if (this.opts.onReady) this.opts.onReady();
        });
        req.on("response", (res) => {
            console.error("[dsh-native v012] mux 握手失败:", res.statusCode);
            res.resume();
            req.destroy();
            this.scheduleReconnect();
        });
        req.on("error", (e) => {
            console.error("[dsh-native v012] mux request error:", e && e.message);
            this.scheduleReconnect();
        });
        req.end();
    }
    onData(chunk) {
        this.buf = Buffer.concat([this.buf, chunk]);
        let buf = this.buf;
        while (buf.length >= 2) {
            const b0 = buf[0], b1 = buf[1];
            const opcode = b0 & 0x0f;
            const masked = (b1 & 0x80) !== 0;
            let len = b1 & 0x7f;
            let offset = 2;
            if (len === 126) {
                if (buf.length < 4) break;
                len = buf.readUInt16BE(2); offset = 4;
            } else if (len === 127) {
                if (buf.length < 10) break;
                len = buf.readUInt32BE(6); offset = 10;
            }
            if (buf.length < offset + len) break;
            const payload = buf.slice(offset, offset + len);
            buf = buf.slice(offset + len);
            if (opcode === 0x1 || opcode === 0x2) this.dispatchJson(payload.toString("utf8"));
            else if (opcode === 0x8) { this.onDown("ws:close-frame"); return; }
            else if (opcode === 0x9) this.wsSend(0xa, payload);
        }
        this.buf = buf;
    }
    dispatchJson(text) {
        let frame;
        try { frame = JSON.parse(text); } catch (_e) { return; }
        if (!frame || typeof frame !== "object") return;
        if (frame.type === "item" || frame.type === "end" || frame.type === "error") {
            const entry = this.streams.get(frame.streamId);
            if (!entry) return;
            if (frame.type === "item") entry.onItem(frame.value);
            else if (frame.type === "end") { this.streams.delete(frame.streamId); entry.onEnd(); }
            else { this.streams.delete(frame.streamId); entry.onError({ code: String((frame.error && frame.error.code) || "stream-error"), message: String((frame.error && frame.error.message) || "stream error") }); }
            return;
        }
        console.warn("[dsh-native v012] 未预期帧类型:", frame.type);
    }
    openPersistentStreams() {
        // 旧代句柄随 socket 一起死了：全部丢弃重开
        for (const h of [this._ctl, this._wsp, this._evt, this._flw]) { try { h && h.cancel(); } catch (_e) {} }
        this._ctl = this.openStream("session/control", {}, { onItem: (v) => this.onControl(v), onError: () => {} });
        this._wsp = this.openStream("workspace/follow", {}, { onItem: () => {}, onError: () => {} });
        this._evt = this.openStream("$events", {}, { onItem: (v) => this.onRemoteEvent(v), onError: () => {} });
        if (this.desiredFollow) this.openFollow(this.desiredFollow);
    }
    openFollow(sessionId) {
        if (this._flw) { try { this._flw.cancel(); } catch (_e) {} }
        this._flw = this.openStream("session/follow",
            { request: { address: { kind: "session", sessionId } } },
            {
                onItem: (v) => {
                    if (v && v.type === "event" && v.event) {
                        this.emit({ rpcId: "", payload: { type: "session/event", sessionId, event: v.event, ...(v.view !== undefined ? { view: v.view } : {}) } });
                    }
                    // snapshot 帧是 REST 历史的事，这里忽略
                },
                onError: () => console.warn(`[dsh-native v012] follow 错误: ${sessionId}`),
            });
    }
    onControl(value) {
        if (!value || typeof value !== "object") return;
        if (value.type === "baseline") {
            const queues = (value.value && value.value.queues) || {};
            for (const sid of Object.keys(queues)) this.emitQueue(sid, queues[sid]);
            const projections = (value.value && value.value.projections) || {};
            for (const sid of Object.keys(projections)) {
                const values = (projections[sid] && projections[sid].values) || {};
                for (const key of Object.keys(values)) {
                    this.emit({ rpcId: "", payload: { type: "session/projection", sessionId: sid, key, value: values[key] } });
                }
            }
            return;
        }
        if (value.type === "queue") { this.emitQueue(value.sessionId, value.items || []); return; }
        if (value.type === "projection") {
            this.emit({ rpcId: "", payload: { type: "session/projection", sessionId: value.sessionId, key: value.key, value: value.value } });
        }
    }
    emitQueue(sessionId, items) {
        const normalized = items.map((raw) => ({
            id: String((raw && raw.id) || ""),
            placement: String((raw && raw.placement) || "queued"),
            content: (raw && raw.message && raw.message.content) || (raw && raw.content) || [],
        }));
        this.emit({ rpcId: "", payload: { type: "session/queue", sessionId, items: normalized } });
    }
    onRemoteEvent(value) {
        if (!value || typeof value !== "object") return;
        if (value.type === "ready") { this.clientId = value.clientId; return; }
        if (value.type === "emit") {
            // api-session/* 取代 legacy host/* —— 会话列表刷新信号（视图暂不消费，留口）
            return;
        }
        if (value.type === "waterfall") {
            if (value.event === "approval/request") {
                const req = value.request || {};
                this.emit({
                    rpcId: value.eventId,
                    payload: {
                        type: "approval/requested",
                        sessionId: value.agentId,
                        approvalId: value.eventId,
                        toolName: req.toolName,
                        reason: req.reason,
                        ...(req.callId ? { callId: String(req.callId) } : {}),
                    },
                });
                return;
            }
            if (value.event === "user-questions/request") {
                this.emit({
                    rpcId: value.eventId,
                    payload: { type: "question/requested", sessionId: value.agentId, questions: (value.request && value.request.questions) || [] },
                });
            }
            return;
        }
        if (value.type === "cancel") {
            this.emit({ rpcId: value.eventId, payload: { type: "approval/resolved", approvalId: value.eventId, outcome: "other" } });
            this.emit({ rpcId: value.eventId, payload: { type: "question/resolved", questionRpcId: value.eventId } });
        }
    }
    emit(frame) { if (this.opts.onFrame) this.opts.onFrame(frame); }
    /** socket 断开统一走重连（scheduleReconnect 内含 teardown + 退避） */
    onDown(_reason) {
        this.scheduleReconnect();
    }
    scheduleReconnect() {
        if (this.stopped || this.reconnectTimer) return;
        const wait = this.backoffMs;
        this.backoffMs = Math.min(this.backoffMs * 2, 15000);
        this.teardown("broken");
        this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, wait);
    }
    teardown(reason) {
        const ws = this.ws;
        this.ws = null;
        if (ws) {
            try { if (ws.socket) ws.socket.destroy(); if (ws.req) ws.req.destroy(); } catch (_e) { /* ignore */ }
        }
        const dead = [...this.streams.values()];
        this.streams.clear();
        this.pendingOpens = [];
        for (const e of dead) e.onError({ code: "stream/socket-closed", message: `remote.mux closed (${reason})` });
        if (this.opts.onBroken) this.opts.onBroken();
    }
    sendJson(frame) {
        if (!this.ws || !this.ws.socket) return;
        this.wsSend(0x1, JSON.stringify(frame));
    }
    wsSend(opcode, data) {
        if (!this.ws || !this.ws.socket) return;
        const sock = this.ws.socket;
        const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
        const len = payload.length;
        let header;
        if (len < 126) header = Buffer.from([0x80 | opcode, 0x80 | len]);
        else if (len < 65536) {
            header = Buffer.alloc(4);
            header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2);
        } else {
            header = Buffer.alloc(10);
            header[0] = 0x80 | opcode; header[1] = 0x80 | 127;
            header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6);
        }
        const mask = crypto.randomBytes(4);
        const masked = Buffer.alloc(len);
        for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
        try { sock.write(Buffer.concat([header, mask, masked])); } catch (_e) { /* ignore */ }
    }
}
/* ==== V012-PURE-END ==== */

class DshApi {
    constructor(baseUrl) {
        this.baseUrl = baseUrl.replace(/\/+$/u, "");
        // ---- v012 双协议状态 ----
        this.flavor = "legacy"; // "legacy" | "v012"
        this.auth = null; // DshAuth（plugin 注入）
        this.mux = null; // V012Mux（plugin 注入；workspace.list/session.history 用）
        this.historyCursor = new Map(); // sessionId → follow cursor（session/page 上界）
    }
    setFlavor(flavor) {
        this.flavor = flavor;
        this.historyCursor.clear();
    }
    bindAuth(auth) { this.auth = auth; }
    bindMux(mux) { this.mux = mux; }

    async call(method, payload = {}) {
        if (this.flavor === "v012") return this.v012Call(method, payload);
        return this.legacyCall(method, payload);
    }

    /** legacy(0.1.1-rc.x)：点端点 + payload 原样 + 无鉴权。 */
    async legacyCall(method, payload = {}) {
        // 用 Obsidian 的 requestUrl 而不是原生 fetch：renderer 进程的 fetch 受 CSP 限制
        // (默认 connect-src 不含 http://127.0.0.1:任意port)，会直接抛 "Failed to fetch"。
        // requestUrl 走宿主进程，绕开 CSP/沙箱。
        const url = `${this.baseUrl}/api/${method}`;
        const body = JSON.stringify({ type: "client-request", rpcId: rpcId(), method, payload });
        let resp;
        try {
            resp = await requestUrl({
                url,
                method: "POST",
                contentType: "application/json",
                body,
                throw: false,
            });
        } catch (e) {
            throw new Error(`DSH RPC ${method} 网络错误：${e && e.message ? e.message : String(e)} (${url})`);
        }
        if (resp.status < 200 || resp.status >= 300) {
            throw new Error(`DSH RPC ${method} HTTP ${resp.status} (${url})`);
        }
        let json;
        try { json = typeof resp.json === "function" ? resp.json : JSON.parse(resp.text || ""); }
        catch (e) { throw new Error(`DSH RPC ${method} 返回非 JSON：${(resp.text || "").slice(0, 200)}`); }
        if (json.result && json.result.ok) return json.result.value;
        const err = json.result && json.result.error ? JSON.stringify(json.result.error) : "unknown";
        throw new Error(`DSH RPC ${method} 失败: ${err}`);
    }

    /** v012(0.1.2+)：斜杠端点 + {args} 信封 + cookie。结构特殊的方法逐一适配，
     *  其余走「request 包装表 / 通用斜杠映射」。对齐 dsh-vscode client.ts。 */
    async v012Call(method, payload) {
        // 结构特殊方法优先
        if (method === "session.history") return this.v012History(payload);
        if (method === "workspace.list") {
            if (!this.mux) throw new Error("workspace.list: v012 流桥未就绪");
            const res = await this.mux.workspacesOnce();
            return { items: res.items || [] };
        }
        if (method === "session.models") {
            const cat = await this.v012Request("session/modelCatalog", {});
            return { current: cat && cat.default, groups: cat && cat.groups, failures: cat && cat.failures };
        }
        if (method === "session.list") {
            const value = await this.v012Request("session/list", { _request: {} });
            const items = (value && value.items) || [];
            // v012 行的 agentPreset 只在 projections.values 里；抬到顶层统一形状
            return { items: items.map((i) => (i && typeof i === "object" ? { ...i, agentPreset: i.agentPreset || (i.projections && i.projections.values && i.projections.values.agentPreset) } : i)) };
        }
        if (method === "agentPreset.list") return this.v012Request("agentPresets/list", {});
        if (method === "agentPreset.select") {
            return this.v012Request("agentPresets/select", { agentId: payload && payload.sessionId, agentPreset: payload && payload.agentPreset });
        }
        if (method === "skill.list") return this.v012Request("skills/list", { request: { sessionId: payload && payload.sessionId } });
        if (method === "commands/list") return this.v012Request("commands/list", { agentId: payload && payload.args && payload.args.agentId });
        if (method === "commands/execute") {
            return this.v012Request("commands/execute", {
                agentId: payload && payload.args && payload.args.agentId,
                line: payload && payload.args && payload.args.line,
                images: (payload && payload.args && payload.args.images) || [],
            });
        }
        if (method === "settings.mutate") {
            // rc.x settings.mutate {ns, ops:[{op:"set",path,value}]} → v012 settings/update {ns, patch, expectedRevision}
            const patch = {};
            for (const op of ((payload && payload.ops) || [])) {
                if (op && op.op === "set" && Array.isArray(op.path) && op.path.length) patch[op.path.join(".")] = op.value;
            }
            return this.v012Request("settings/update", {
                ns: payload && payload.ns,
                patch,
                expectedRevision: payload && payload.expectedRevision,
            });
        }
        if (method === "session.create") {
            // 0.1.2 精确参数：request 只收 cwd
            return this.v012Request("session/create", { request: { cwd: payload && (payload.cwd || payload.workspaceId) } });
        }
        // request 包装表（字段名一致，仅套 {request}）
        const WRAPPED = new Set([
            "session.cancel", "session.rename", "session.fork",
            "session.attachment", "session.updateQueue", "session.selectModel",
            "workspace.create", "workspace.archiveSession",
            "workspace.rename", "workspace.insertBefore", "workspace.delete",
            "workspace.insertSessionBefore",
        ]);
        if (WRAPPED.has(method)) {
            const endpoint = method.replace(/\./g, "/");
            const request = method === "workspace.archiveSession"
                ? { sessionId: payload && payload.sessionId } // 0.1.2 起去掉 workspaceId
                : { ...(payload || {}) };
            return this.v012Request(endpoint, { request });
        }
        if (method === "session.prompt") {
            // 0.1.2 要求客户端铸 requestId
            return this.v012Request("session/prompt", { request: { ...(payload || {}), requestId: `obs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}` } });
        }
        // 未知方法：斜杠映射 + args 原样（让服务器大声报错而不是静默猜测）
        return this.v012Request(method.replace(/\./g, "/"), payload);
    }

    /** legacy session.history 在 v012 上的实现：首屏 = session/follow 一次性快照
     *  （顺带拿翻页游标），更早页 = session/page。 */
    async v012History(payload) {
        if (!this.mux) throw new Error("session.history: v012 流桥未就绪");
        if (!payload || payload.beforeSeq === undefined || payload.beforeSeq === null) {
            const snap = await this.mux.snapshotOnce(payload.sessionId, payload.maxMessages != null ? payload.maxMessages : 24);
            if (snap.cursor !== undefined) this.historyCursor.set(payload.sessionId, snap.cursor);
            return { events: snap.entries, hasMore: snap.hasMore, projections: snap.projections };
        }
        const throughSeq = this.historyCursor.get(payload.sessionId) != null
            ? this.historyCursor.get(payload.sessionId)
            : payload.beforeSeq;
        const value = await this.v012Request("session/page", {
            request: {
                address: { kind: "session", sessionId: payload.sessionId },
                throughSeq,
                beforeSeq: payload.beforeSeq,
                ...(payload.maxMessages !== undefined ? { maxMessages: payload.maxMessages } : {}),
            },
        });
        return {
            events: (value && value.records || []).map((r) => ({ event: r && r.event, view: r && r.view })),
            hasMore: !!(value && value.hasMore),
        };
    }

    /** v012 POST：{args} 信封 + cookie（401/403 → 重铸一次重试）。 */
    async v012Request(endpoint, args, isRetry = false) {
        const id = rpcId();
        const envelope = { type: "client-request", rpcId: id, method: endpoint, payload: { args } };
        const url = `${this.baseUrl}/api/${endpoint}`;
        let resp;
        try {
            resp = await requestUrl({
                url,
                method: "POST",
                contentType: "application/json",
                body: JSON.stringify(envelope),
                throw: false,
                headers: { ...(this.auth ? this.auth.cookieHeader() : {}) },
            });
        } catch (e) {
            throw new Error(`DSH RPC ${endpoint} 网络错误：${e && e.message ? e.message : String(e)}`);
        }
        if ((resp.status === 401 || resp.status === 403) && !isRetry && this.auth) {
            this.auth.invalidate();
            const ok = await this.auth.ensureCookie(this.baseUrl);
            if (!ok) throw new Error("DSH 0.1.2+ 服务器需要授权（token/credentials 均不可用）");
            return this.v012Request(endpoint, args, true);
        }
        if (resp.status === 401 || resp.status === 403) {
            throw new Error("DSH 0.1.2+ 认证失败：token 无效或已过期");
        }
        if (resp.status < 200 || resp.status >= 300) {
            throw new Error(`DSH RPC ${endpoint} HTTP ${resp.status} (${url})`);
        }
        let json;
        try { json = typeof resp.json === "function" ? resp.json : JSON.parse(resp.text || ""); }
        catch (e) { throw new Error(`DSH RPC ${endpoint} 返回非 JSON：${(resp.text || "").slice(0, 200)}`); }
        if (json && json.type === "server-response" && json.result && json.result.ok) return json.result.value;
        const err = json && json.result && json.result.error ? JSON.stringify(json.result.error) : "unknown";
        throw new Error(`DSH RPC ${endpoint} 失败: ${err}`);
    }

    async respond(rpcIdValue, value) {
        if (this.flavor === "v012") {
            // v012：审批/提问应答走 $events/result（需要 $events 的 clientId）
            const v = (value || {});
            const outcomeValue = "answer" in v ? v.answer : ("outcome" in v ? v.outcome : value);
            const clientId = this.mux && this.mux.eventsClientId;
            if (!clientId) return { ok: false, error: "$events 未就绪（clientId 未知）" };
            try {
                const res = await this.v012Request("$events/result", {
                    clientId,
                    eventId: rpcIdValue,
                    outcome: { kind: "result", value: outcomeValue },
                });
                if (res && typeof res === "object" && "accepted" in res) {
                    return res.accepted === true ? { ok: true } : { ok: false, error: res.reason || "not-accepted" };
                }
                return { ok: true };
            } catch (e) {
                return { ok: false, error: e && e.message ? e.message : String(e) };
            }
        }
        // legacy：POST /api/respond {type:"client-response", rpcId, result:{ok,value}}
        const url = `${this.baseUrl}/api/respond`;
        const body = JSON.stringify({ type: "client-response", rpcId: rpcIdValue, result: { ok: true, value } });
        const resp = await requestUrl({
            url,
            method: "POST",
            contentType: "application/json",
            body,
            throw: false,
        });
        let json;
        try { json = typeof resp.json === "function" ? resp.json : JSON.parse(resp.text || ""); }
        catch (e) { return { ok: false, error: e.message }; }
        return json;
    }
    async ensureWorkspace(vaultPath) {
        const wl = await this.call("workspace.list");
        let ws = wl.items.find((i) => normPath(i.path) === normPath(vaultPath));
        if (!ws) ws = await this.call("workspace.create", { path: vaultPath });
        return ws;
    }
    // v0.5.0 工作区管理（对齐 VSCode manager.workspace*：rename/insertBefore/delete/create/insertSessionBefore）
    async listWorkspaces() { return this.call("workspace.list"); }
    async workspaceRename(workspaceId, title) { return this.call("workspace.rename", { workspaceId, title }); }
    async workspaceMove(workspaceId, beforeWorkspaceId) {
        const p = { workspaceId };
        if (beforeWorkspaceId) p.beforeWorkspaceId = beforeWorkspaceId;
        return this.call("workspace.insertBefore", p);
    }
    async workspaceDelete(workspaceId) { return this.call("workspace.delete", { workspaceId }); }
    async workspaceCreate(path) { return this.call("workspace.create", { path }); }
    async workspaceMoveSession(sessionId, toWorkspaceId) { return this.call("workspace.insertSessionBefore", { workspaceId: toWorkspaceId, sessionId }); }
    // v0.6.0 子代理（对齐 VSCode 0.16：child 是 session，list 走 session.list 的 origin/parentSessionId，
    // 追问/打断 = session.prompt / session.cancel 指向 childId —— subagent.* 网关不开放）
    async listSubagents(parentSessionId) {
        const sl = await this.call("session.list", {});
        return ((sl && sl.items) || [])
            .filter((i) => i.origin === "subagent" && i.parentSessionId === parentSessionId)
            .map((i) => ({ sessionId: i.sessionId, title: typeof i.title === "string" && i.title ? i.title : "（子代理）", running: !!i.running, updatedAt: i.updatedAt }));
    }
    async subagentPrompt(childId, text) {
        return this.call("session.prompt", { sessionId: childId, mode: "queue", content: [{ type: "text", text }] });
    }
    async subagentInterrupt(childId) {
        return this.cancel(childId);
    }
    // v0.6.0 服务器设置（对齐 VSCode 0.15：describe → schema 驱动表单 → update 带乐观 revision）
    async describeSettings() {
        return this.call("settings.describe", {});
    }
    async saveSetting(ns, patch, expectedRevision) {
        // v012 映射：settings.mutate → settings/update {ns, patch, expectedRevision}
        return this.call("settings.mutate", { ns, patch, expectedRevision });
    }
    async listSessions(workspaceId) {
        const wl = await this.call("workspace.list");
        const ws = wl.items.find((w) => w.workspaceId === workspaceId);
        const ids = new Set(ws ? ws.sessionIds : []);
        const archived = new Set(wl.archivedSessionIds || []);
        const sl = await this.call("session.list");
        return sl.items
            .filter((i) => ids.has(i.sessionId))
            .filter((i) => !archived.has(i.sessionId))
            .filter((i) => i.origin !== "subagent")
            .filter((i) => !i.blank)
            // 把后端返回的 title 拾起来；空 title 的留给 UI 显示「未命名」；agentPreset/blank 供头部模式选择器用
            .map((i) => ({
                sessionId: i.sessionId,
                title: typeof i.title === "string" ? i.title : "",
                updatedAt: i.updatedAt,
                blank: !!i.blank,
                agentPreset: typeof i.agentPreset === "string" ? i.agentPreset : undefined,
            }))
            .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    }
    async createSession(workspace) {
        // 接收工作区对象或裸 id：v012 的 session/create 精确收 cwd（对象里有 path）
        const payload = (workspace && typeof workspace === "object")
            ? { workspaceId: workspace.workspaceId, cwd: workspace.path }
            : { workspaceId: workspace };
        return this.call("session.create", payload);
    }
    async prompt(sessionId, textOrParts, mode = "queue") {
        // 支持字符串（向后兼容）或 content parts 数组（含 file/image 附件）
        const content = Array.isArray(textOrParts)
            ? textOrParts
            : [{ type: "text", text: textOrParts }];
        return this.call("session.prompt", {
            sessionId,
            mode,
            content,
        });
    }
    async getModels(sessionId) {
        // DSH 真实结构：{current:{provider,model,reasoningEffort?}, groups:[{id, name, models:[{id, name, description?, reasoning?: {efforts, defaultEffort}}]}]}
        // 失败时返回空目录（不抛，避免破坏面板）
        try { return await this.call("session.models", { sessionId }); }
        catch (_e) { return { current: null, groups: [] }; }
    }
    async selectModel(sessionId, provider, model, effort) {
        // DSH 的 selectModel 接受 reasoningEffort（"low"/"medium"/"high"），没有则省略
        const payload = { sessionId, provider, model };
        if (effort) payload.reasoningEffort = effort;
        return this.call("session.selectModel", payload);
    }
    async getPermissionPreset() {
        // 走 settings.describe 拿 permission namespace 当前的 defaultPreset（projection 通道只推变化，初值拿不到）
        try {
            const d = await this.call("settings.describe", {});
            const ns = Array.isArray(d && d.namespaces) ? d.namespaces.find((n) => n.ns === "permission") : null;
            if (ns && ns.value && typeof ns.value.defaultPreset === "string") {
                return {
                    value: ns.value.defaultPreset,
                    revision: typeof ns.revision === "number" ? ns.revision : null,
                    presets: extractPresetOptionsFromSchema(ns.schema)
                };
            }
            return { value: null, revision: null, presets: [] };
        } catch (_e) {
            return { value: null, revision: null, presets: [] };
        }
    }
    async setPermissionPreset(preset, expectedRevision) {
        // 写入：permission.defaultPreset；DSH 要求 expectedRevision 防止冲突
        return this.call("settings.mutate", {
            ns: "permission",
            ops: [{ op: "set", path: ["defaultPreset"], value: preset }],
            expectedRevision: typeof expectedRevision === "number" ? expectedRevision : undefined
        });
    }
    async cancel(sessionId) {
        try {
            await this.call("session.cancel", { sessionId });
        } catch (e) {
            /* ignore */
        }
    }
    async getHistory(sessionId, beforeSeq = null, maxMessages = 24) {
        // session.history 返回 { events:[{event:{type,seq,time,data}}], hasMore, projections }
        // 是新建会话也能可靠拿到完整 turn（含 turn/end），用来兜底渲染（WS 对新会话不推事件）
        // beforeSeq：向上翻页游标（取当前最旧事件的 seq，拉取更早的一批）；maxMessages：单批上限
        const payload = { sessionId, maxMessages };
        if (beforeSeq != null) payload.beforeSeq = beforeSeq;
        try { return await this.call("session.history", payload); }
        catch (_e) { return { events: [], hasMore: false }; }
    }
    async renameSession(sessionId, title) {
        // DSH 支持 session.rename（VSCode manager.ts:409 同款）。手动编辑会话名。
        return this.call("session.rename", { sessionId, title });
    }
    // Phase F：从排队队列移除一项（运行中追加的消息可撤回）
    async queueRemove(sessionId, itemId) {
        return this.call("session.updateQueue", { sessionId, itemId, action: { kind: "remove" } });
    }
    async archiveSession(sessionId) {
        // DSH 支持 workspace.archiveSession（VSCode manager.ts:276）。归档会话。
        return this.call("workspace.archiveSession", { workspaceId: this.workspace.workspaceId, sessionId });
    }
    async forkSession(sessionId, atSeq) {
        // DSH 支持 session.fork（VSCode manager.forkSessionInternal 同款）。
        // atSeq：从此事件号分叉（TurnActions「从此处分叉」）；缺省=最后一个完成的轮次。
        const payload = { sessionId };
        if (atSeq != null) payload.atSeq = atSeq;
        return this.call("session.fork", payload);
    }
    // v0.4.0 队列操作（对齐 VSCode manager.queueEdit/queueSteer）
    async queueEdit(sessionId, itemId, text) {
        return this.call("session.updateQueue", { sessionId, itemId, action: { kind: "edit", content: [{ type: "text", text }] } });
    }
    async queueSteer(sessionId, itemId) {
        return this.call("session.updateQueue", { sessionId, itemId, action: { kind: "steer" } });
    }
    // v0.4.0 消息内图片：拉取持久化附件字节（对齐 VSCode manager.getAttachment / session.attachment）
    async getAttachment(sessionId, attachmentId) {
        return this.call("session.attachment", { sessionId, attachmentId });
    }
    // ---- Agent 模式（对齐 VSCode manager.refreshPresets/selectPreset）----
    async getAgentPresets() {
        return this.call("agentPreset.list", {});
    }
    async selectAgentPreset(sessionId, agentPreset) {
        return this.call("agentPreset.select", { sessionId, agentPreset });
    }
    // 会话级命令执行（VSCode manager.setSessionPermission 同款通道）。
    // 注意：session.prompt 在本 host 上不分发斜杠命令，会把文本当用户消息漏给模型，
    // 所以 /permission 这类命令必须走 commands/execute。
    async executeCommand(agentId, line) {
        return this.call("commands/execute", { args: { agentId, line } });
    }
    // Phase B：/ 技能菜单候选——技能（skill.list 单数）+ 命令（commands/list）。
    // 与 VSCode manager.ts:419 listSlash 同款契约；任一方失败都用另一方兜底。
    async listSlash(sessionId) {
        const out = [];
        // DSH 若未实现 skill.list / commands/list，RPC 可能挂起（requestUrl 无超时），
        // 用 3s 竞速兜底，挂起时按“无数据”处理，避免 / 弹窗永远卡在加载态。
        const TIMEOUT = 3000;
        const guarded = (p) => Promise.race([
            p,
            new Promise((res) => setTimeout(() => res({ __timeout: true }), TIMEOUT)),
        ]);
        const [skills, commands] = await Promise.allSettled([
            guarded(this.call("skill.list", { sessionId })),
            guarded(this.call("commands/list", { args: { agentId: sessionId } })),
        ]);
        if (skills.status === "fulfilled" && !skills.value.__timeout) {
            const list = (skills.value && skills.value.skills) || (Array.isArray(skills.value) ? skills.value : []);
            for (const s of list) {
                if (s && typeof s.name === "string") out.push({ kind: "skill", name: s.name, description: String(s.description || "") });
            }
        }
        if (commands.status === "fulfilled" && !commands.value.__timeout) {
            const list = Array.isArray(commands.value) ? commands.value : [];
            for (const c of list) {
                // 同名技能优先：同名的命令不再重复列出
                if (c && typeof c.name === "string" && !out.some((o) => o.name === c.name)) {
                    out.push({ kind: "command", name: c.name, description: String(c.description || "") });
                }
            }
        }
        return out;
    }
}

/* 把 settings schema 里 union→const 的可选 preset 名挑出来（从 namespace.schema 反查）
 * DSH schema 形态：{type:"union", list:["#presetA","#presetB"]} → schema.refs[list[i]] = {type:"const", value:"x", meta?:{description:"…"}}
 */
function extractPresetOptionsFromSchema(schema) {
    try {
        if (!schema || typeof schema !== "object") return [];
        const refs = schema.refs || {};
        if (!refs || typeof refs !== "object") return [];
        // DSH 真实结构：schema.refs 里有一个 object 节点，其 dict.defaultPreset 指向 union 节点；
        // union.list 是一组 const 节点（每个 value 是一个预设名）。退化：全局找第一个 union。
        let union = null;
        for (const k of Object.keys(refs)) {
            const node = refs[k];
            if (node && node.type === "object" && node.dict && node.dict.defaultPreset != null) {
                const target = refs[String(node.dict.defaultPreset)] || node.dict.defaultPreset;
                if (target && target.type === "union") { union = target; break; }
            }
        }
        if (!union) {
            for (const k of Object.keys(refs)) {
                const node = refs[k];
                if (node && node.type === "union" && Array.isArray(node.list)) { union = node; break; }
            }
        }
        if (!union || !Array.isArray(union.list)) return [];
        const out = [];
        for (const ref of union.list) {
            const choice = (typeof ref === "string" || typeof ref === "number") ? refs[String(ref)] : ref;
            if (!choice || choice.type !== "const" || typeof choice.value !== "string") continue;
            const label = (choice.meta && typeof choice.meta.description === "string") ? choice.meta.description : choice.value;
            out.push({ id: choice.value, label });
        }
        return out;
    } catch (_e) { return []; }
}
/* ====================================================================
 * 助手文本预处理（修复 Bug 1: 隐藏系统上下文；修复 Bug 2: JSON 自动渲染为 dsh-ui）
 * 参考 dsh-vscode/webview/src/fold.ts 的段落级 stripSystemContext（更稳健）
 * ================================================================== */
// 段落开头标记：DSH 注入的块（运行快照 / 策略通知 / 技能目录变更等）
const INJECTED_HEADS = [
    /^Current runtime context\b/,
    /^Current DSH file policy:/,
    /^The DSH file policy changed\b/,
    /^Approval policy:/,
    /^Approval prompts are disabled\b/,
    /^The approval policy changed\b/,
    /^This snapshot supersedes\b/,
    /^The available skill catalog changed\b/,
    // 扩展：技能目录 / 运行时上下文 / 策略的其它常见形态（截图实测泄露项）
    /^A skill is\b/,
    /^The following skills\b/,
    /^Available skills\b/,
    /^Your (?:available|installed) skills\b/i,
    /^Tool (?:policy|permissions)\b/,
    /^File policy\b/,
    /^Here (?:is|are) (?:your|the) (?:current |available )?(?:context|skills|tools|policy)/i,
];

function isSystemContextStart(s) {
    if (!s) return false;
    return /Current runtime context\b/.test(s)
        || /<system\b/.test(s)
        || /<available_skills>/.test(s)
        || /Current DSH file policy:/.test(s)
        || /Approval prompts are disabled/.test(s);
}

function isInjectedParagraphStart(para) {
    const trimmed = (para || "").trim();
    if (!trimmed) return false;
    const first = trimmed.split("\n", 1)[0];
    // 段落首行命中（原有逻辑）
    if (INJECTED_HEADS.some((re) => re.test(first))) return true;
    // 扩展：注入头可能内联在段落中部（DSH 不总是用空行分隔），整段命中即剥除
    if (INJECTED_HEADS.some((re) => re.test(trimmed))) return true;
    return isSystemContextStart(first);
}

function findSystemContextEnd(s) {
    if (!s) return -1;
    // 优先匹配 </available_skills> —— DSH 注入块的结尾
    let i = s.search(/<\/available_skills>/i);
    if (i >= 0) return i + "</available_skills>".length;
    // 其次匹配 </system-reminder>（DSH 注入提醒块，结尾是区别于 </system> 的变体）
    i = s.search(/<\/system-reminder>/i);
    if (i >= 0) return i + "</system-reminder>".length;
    // 泛化匹配 </system-xxx>（如 </system-message> 等）
    const m = /<\/system-[a-z-]*>/i.exec(s);
    if (m) return m.index + m[0].length;
    // 最后匹配 </system>
    i = s.search(/<\/system>/i);
    if (i >= 0) return i + "</system>".length;
    return -1;
}
// 剥掉 DSH 注入的系统上下文。三段式：① 删除 <system-reminder> 包裹的 span（含流式未闭合）② 剥头部遗留 tag 块 ③ 删除段落级注入；无清晰边界则保留，绝不误删。
function stripSystemContext(text) {
    if (!text) return text;
    // 1) 删除 <system-reminder>…</system-reminder>（含未闭合：截断到结尾）
    let s = text
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
        .replace(/<system-reminder>[\s\S]*$/, "");
    // 2) 头部遗留 tag 块（<system> / <available_skills>）；找不到边界则保留
    let guard = 0;
    while (guard++ < 8 && isSystemContextStart(s)) {
        const end = findSystemContextEnd(s);
        if (end < 0) break;
        s = s.slice(end).replace(/^\s*\n+/, "");
    }
    // 3) 段落级注入（运行快照 / 策略通知）：独立段落或追加在用户文本后，按段落头剔除
    const paras = s.split(/\n\s*\n/);
    const kept = paras.filter((p) => !isInjectedParagraphStart(p.trim()));
    return kept.join("\n\n").trim();
}
// 把单行/多行裸 dsh-ui JSON 自动包进 ```dsh-ui``` 代码块，postProcessDshUi 就能识别
// 启发式：根对象有 "items" 数组 且 顶层有 "type" 或 "title" 字段（命中 dsh-ui spec 形态）
function wrapDshUiJson(text) {
    if (!text || text.indexOf('"items"') < 0) return text;
    // 找到所有可能的 JSON 起点：行首或非 ASCII 字符后的 {
    // 用非贪婪匹配，匹配到配对 }（简化：取首个 "{...}" 顶层对象 —— 不嵌套内层）
    let out = "";
    let i = 0;
    let n = text.length;
    while (i < n) {
        const ch = text[i];
        // 只在"看起来是 JSON 起点"的位置尝试
        const tryHere = ch === "{" && (i === 0 || /\s|^\s*$/.test(text[i - 1]) || text[i - 1] === "\n");
        if (!tryHere) {
            out += ch;
            i++;
            continue;
        }
        // 找到匹配的右括号（顶层平衡）
        let depth = 0;
        let inStr = false;
        let esc = false;
        let j = i;
        while (j < n) {
            const c = text[j];
            if (esc) { esc = false; j++; continue; }
            if (c === "\\") { esc = true; j++; continue; }
            if (c === '"') { inStr = !inStr; j++; continue; }
            if (inStr) { j++; continue; }
            if (c === "{") { depth++; j++; continue; }
            if (c === "}") { depth--; j++; if (depth === 0) break; }
            j++;
        }
        if (depth !== 0 || j > n) {
            // 未闭合（流式传输中）：若已出现 "items"，视为 dsh-ui 雏形，先包围栏，
            // 由 postProcessDshUi 显示「⚙️ 组件生成中…」占位，落定后再渲染。
            const partial = text.slice(i);
            if (/"items"/.test(partial)) {
                const before = out.slice(Math.max(0, out.length - 30));
                if (/`{3,}dsh-ui\s*$/i.test(before)) {
                    out += partial;
                } else {
                    out += "```dsh-ui\n" + partial + "\n```";
                }
                i = n; // 消费剩余文本
            } else {
                out += ch;
                i++;
            }
            continue;
        }
        const candidate = text.slice(i, j);
        // 解析试一下（v0.1.12：lenientJsonParse 兜底处理未转义引号）
        let spec = null;
        try { spec = JSON.parse(candidate); } catch (_e) { spec = lenientJsonParse(candidate); }
        const isDshUi = spec
            && typeof spec === "object"
            && Array.isArray(spec.items)
            && (typeof spec.type === "string" || typeof spec.title === "string");
        if (isDshUi) {
            // 已是 dsh-ui 代码块就不重复包
            const before = out.slice(Math.max(0, out.length - 30));
            if (/```dsh-ui\s*$/i.test(before)) {
                out += candidate;
            } else {
                out += "```dsh-ui\n" + candidate + "\n```";
            }
            i = j;
        } else {
            out += ch;
            i++;
        }
    }
    return out;
}

// ====================================================================
// dsh-ui spec 容错解析（移植自 VSCode webview/src/components/dshui.tsx）
// 解决 Bug 2：流式期间 JSON 未闭合 → 原 wrapDshUiJson 平衡括号失败 → 裸 JSON 泄漏。
// 这里负责「解析失败时的占位」，配合下方 postProcessDshUi。
// ====================================================================
/* ==== FENCE-PURE-BEGIN（纯函数区：node scripts/fence-regress.mjs 会整段提取跑回归）==== */
// 智能引号 → 直引号；删除 ] / } 前的尾随逗号
function cheapRepairs(s) {
    return s.replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'").replace(/,\s*([}\]])/g, "$1");
}
// 兜底：剥离文本首尾的 markdown 围栏标记（```dsh-ui / ``` / ````dsh-ui 等），
// 用于 postProcessDshUi / renderDshUiSegment 中，防止残留围栏行导致 JSON.parse 失败。
function stripFenceMarkers(text) {
    if (!text) return text;
    let s = text.trim();
    // 去掉首行的开栏符（3+ 反引号 + 可选语言标签）
    s = s.replace(/^`{3,}[^\n]*\n?/, "");
    // 去掉末行的闭合栏（3+ 反引号）
    s = s.replace(/\n?`{3,}\s*$/, "");
    return s.trim();
}
// 括号平衡修复（对齐 VSCode dshui.tsx balanceClose，v0.4.11）：
// `}` 到来时栈顶是 `[`（合法 JSON 不可能的形态——模型提前闭 root 漏关 items）→ 补 `]`；
// 结束时还有开的容器（截断尾巴）→ 全部自动闭合。上限 8 处；字符串中间截断绝不猜。
function balanceClose(s) {
    const stack = [];
    let out = "";
    let inStr = false;
    let esc = false;
    let fixes = 0;
    for (const ch of s) {
        if (inStr) {
            out += ch;
            if (esc) esc = false;
            else if (ch === "\\") esc = true;
            else if (ch === '"') inStr = false;
            continue;
        }
        if (ch === '"') { inStr = true; out += ch; continue; }
        if (ch === "{" || ch === "[") { stack.push(ch); out += ch; continue; }
        if (ch === "}") {
            if (stack[stack.length - 1] === "[") {
                if (++fixes > 8) return null;
                out += "]";
                stack.pop();
            }
            if (stack.pop() !== "{") return null;
            out += ch;
            continue;
        }
        if (ch === "]") {
            if (stack.pop() !== "[") return null;
            out += ch;
            continue;
        }
        out += ch;
    }
    if (inStr) return null;
    while (stack.length) out += stack.pop() === "{" ? "}" : "]";
    return out;
}
// 从 start 扫描一个完整 JSON 值，返回 [endIndex, value] 或 null（尊重字符串/转义/嵌套括号）。
// endIndex 越过闭合符（对齐 VSCode scanValue 的 k+1 语义——调用方要从该处继续扫孤儿值）。
// 平衡但非法（如 items [ 被 root 提前闭合卡住）时先用 balanceClose 修一轮再放弃（v0.4.11）。
// v0.1.12 本质修复：对齐 VSCode scanValue——只追踪匹配的括号对（{→} 或 [→]），
// 忽略另一种括号。原实现把 {/[ 都 depth++、}/] 都 depth--，混合计数导致畸形 JSON
// （rows 数组漏闭合 } 提前关 table）时平衡终点算到文件末尾，切片含 callout+尾巴，
// balanceClose 遇空栈 ] 返回 null → repairSpec 整体失败。
function scanJsonValue(text, start) {
    let i = start;
    const n = text.length;
    while (i < n && /\s/.test(text[i])) i++;
    if (i >= n) return null;
    const open = text[i];
    const close = open === "{" ? "}" : open === "[" ? "]" : null;
    if (!close) {
        // 非括号值（数字/字符串/布尔/null）：扫到分隔符为止
        let j = i;
        while (j < n && !",]}".includes(text[j])) j++;
        try { return [j, JSON.parse(text.slice(i, j).trim())]; } catch (_e) { return null; }
    }
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < n; j++) {
        const c = text[j];
        if (esc) { esc = false; continue; }
        if (c === "\\") { esc = true; continue; }
        if (c === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (c === open) depth++;
        else if (c === close) {
            depth--;
            if (depth === 0) {
                const slice = text.slice(i, j + 1);
                try { return [j + 1, JSON.parse(slice)]; } catch (_e) {}
                const balanced = balanceClose(slice);
                if (balanced) {
                    try { return [j + 1, JSON.parse(balanced)]; } catch (_e) {}
                }
                return null;
            }
        }
    }
    return null; // 括号从未归零：流式半截或截断
}
// 根形态修复（对齐 VSCode repairSpec，v0.4.12）：支持三种 root——
// ① {items:[…]} 信封 ② 裸 [组件…] 数组 ③ 裸组件序列（无外壳无分隔）——后两种自动包壳。
// root 完整后的非结构尾巴（漏闭合栏吞进的正文）直接忽略；孤儿值合并回 items。
function repairSpec(raw) {
    const text = raw.trim();
    if (!text.startsWith("{") && !text.startsWith("[")) return null;
    const first = scanJsonValue(text, 0);
    if (!first) return null;
    const [end1, v1] = first;
    let root;
    let componentMode = false;
    if (Array.isArray(v1)) {
        root = { items: v1 };
        componentMode = true;
    } else if (v1 && typeof v1 === "object" && Array.isArray(v1.items)) {
        root = v1;
    } else if (v1 && typeof v1 === "object" && typeof v1.type === "string") {
        root = { items: [v1] };
        componentMode = true;
    } else {
        return null;
    }
    let pos = end1;
    const orphans = [];
    let guard = 0;
    while (guard++ < 50) {
        while (pos < text.length && /[\s,]/.test(text[pos])) pos++;
        if (pos >= text.length) break;
        if (text[pos] === "]" || text[pos] === "}") {
            if (/^[\]}]+$/.test(text.slice(pos))) break; // 尾部游离闭合符
            return null; // 看不懂的结构形态——宁可放弃也不猜
        }
        // 未闭合围栏吞正文：spec JSON 已完整、模型的正文继续留在栏内——
        // 非结构（非 {/[）开头就是正文污染，root 本身有效，忽略尾巴（v0.4.11 正文容忍）
        if (text[pos] !== "{" && text[pos] !== "[") break;
        const nxt = scanJsonValue(text, pos);
        if (!nxt) break; // 解析不了的孤儿：保住已有的，丢掉尾巴（不整体报废）
        const v = nxt[1];
        if (componentMode && Array.isArray(v)) orphans.push(...v);
        else if (componentMode && v && typeof v === "object" && Array.isArray(v.items)) orphans.push(...v.items);
        else if (v && typeof v === "object") orphans.push(v);
        else break;
        pos = nxt[0];
    }
    if (orphans.length > 0) root.items = [...root.items, ...orphans];
    return root;
}
// v0.1.12 宽松 JSON 解析器：处理 LLM 输出中字符串值内含未转义双引号的情况。
// 启发式：在字符串内遇到 " 时，看下一个非空白字符是否为 JSON 分隔符（, : } ]）或结束。
// 是 → 视为字符串闭合引号；否 → 视为字符串内容中的字面引号，转义为 \"。
// 这是 VSCode/DSH 网页版能正常渲染而 Obsidian 版不能的本质差异——它们的 markdown 渲染器
// 提取完整围栏内容后，有类似的宽松解析兜底；Obsidian 版原 parseSpec 全链路依赖 inStr 状态机，
// 被未转义引号搞乱后所有修复策略（cheapRepairs/balanceClose/repairSpec/scanJsonValue）全部失效。
function lenientJsonParse(s) {
    if (typeof s !== "string") return null;
    let out = "";
    let inStr = false;
    let esc = false;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (esc) { out += ch; esc = false; continue; }
        if (ch === "\\") { out += ch; esc = true; continue; }
        if (ch === '"') {
            if (!inStr) {
                inStr = true;
                out += ch;
            } else {
                // 潜在闭合引号：向后跳过空白，看下一个字符
                let j = i + 1;
                while (j < s.length && /\s/.test(s[j])) j++;
                const next = s[j];
                if (next === undefined || next === "," || next === ":" || next === "}" || next === "]") {
                    inStr = false;
                    out += ch;
                } else {
                    // 未转义引号在字符串内部 → 转义
                    out += '\\"';
                }
            }
            continue;
        }
        out += ch;
    }
    if (inStr) return null; // 字符串未闭合，放弃
    try { return JSON.parse(out); } catch (_e) { return null; }
}
// v0.1.12 移植自 VSCode dshui.tsx wrapBareMembers：
// 修复数组内裸 key/value 对（模型漏写元素的 {）：如 [{callout},"type":"table","rows":[…]]
// 合法 JSON 中数组元素不会是 "key":value 对，所以元素位置出现字符串后跟 : 是明确的畸形信号。
function wrapBareMembers(s) {
    let out = "";
    let i = 0;
    let fixed = 0;
    const stack = []; // "a"=array, "o"=object, "p"=pseudo-object (we opened it)
    let expect = "elem"; // elem|value|key|sep
    const top = () => stack[stack.length - 1];
    const readString = (from) => {
        let j = from + 1;
        while (j < s.length) {
            if (s[j] === "\\") j += 2;
            else if (s[j] === '"') break;
            else j++;
        }
        return [s.slice(from, j + 1), j + 1];
    };
    while (i < s.length) {
        while (i < s.length && /\s/.test(s[i])) { out += s[i]; i++; }
        if (i >= s.length) break;
        const ch = s[i];
        if (ch === '"') {
            const [tok, after] = readString(i);
            let k = after;
            while (k < s.length && /\s/.test(s[k])) k++;
            const isKey = k < s.length && s[k] === ":";
            if (expect === "elem" && isKey) {
                out += "{" + tok + ":";
                stack.push("p");
                fixed++;
                expect = "value";
                i = k + 1;
                continue;
            }
            if (!isKey && (expect === "elem" || expect === "value")) {
                out += tok;
                i = after;
                expect = "sep";
                continue;
            }
            if (expect === "key" && isKey) {
                out += tok + ":";
                expect = "value";
                i = k + 1;
                continue;
            }
            return null;
        }
        if (ch === "{" || ch === "[") {
            if (expect === "key") return null;
            stack.push(ch === "{" ? "o" : "a");
            out += ch;
            i++;
            expect = ch === "{" ? "key" : "elem";
            continue;
        }
        if (ch === "}" || ch === "]") {
            if (top() === "p") { out += "}"; stack.pop(); continue; }
            const want = ch === "}" ? "o" : "a";
            if (top() === want) { stack.pop(); out += ch; i++; expect = "sep"; continue; }
            if (stack.length === 0 && expect === "sep") { out += ch; i++; continue; }
            return null;
        }
        if (ch === ",") {
            if (top() === "p") {
                let k = i + 1;
                while (k < s.length && /\s/.test(s[k])) k++;
                if (k < s.length && s[k] === '"') {
                    const [, after] = readString(k);
                    let m = after;
                    while (m < s.length && /\s/.test(s[m])) m++;
                    if (m < s.length && s[m] === ":") {
                        out += ","; expect = "key"; i = k; continue;
                    }
                }
                out += "}"; stack.pop(); out += ","; expect = "elem"; i++; continue;
            }
            out += ",";
            expect = top() === "a" ? "elem" : "key";
            i++;
            continue;
        }
        if (expect === "value" || expect === "elem") {
            let j = i;
            while (j < s.length && !",]}".includes(s[j])) j++;
            out += s.slice(i, j);
            i = j;
            expect = "sep";
            continue;
        }
        return null;
    }
    if (top() === "p") { out += "}"; stack.pop(); }
    if (stack.length > 0) return null;
    return fixed > 0 ? out : null;
}
function parseSpec(raw) {
    if (typeof raw !== "string") return null;
    // v0.4.12 对齐：裸数组 / 单个裸组件在任意层级解析成功后都包壳成 {items:[…]}，
    // 否则 postProcessDshUi 的 items 判定会把它们当失败
    const norm = (v) => {
        if (Array.isArray(v)) return { items: v };
        if (v && typeof v === "object" && !Array.isArray(v.items) && typeof v.type === "string") return { items: [v] };
        return v;
    };
    try { const v = JSON.parse(raw); return v && typeof v === "object" ? norm(v) : null; } catch (_e) {}
    const cheap = cheapRepairs(raw);
    try { const v = JSON.parse(cheap); return v && typeof v === "object" ? norm(v) : null; } catch (_e) {}
    // v0.1.12：宽松解析——处理字符串值内未转义双引号（LLM 常见输出缺陷）
    const lenient = lenientJsonParse(cheap);
    if (lenient && typeof lenient === "object") return norm(lenient);
    // v0.1.12：移植自 VSCode——数组内裸 key/value 对（模型漏写元素的 {）
    const wrapped = wrapBareMembers(cheap);
    if (wrapped) {
        try { const v = JSON.parse(wrapped); if (v && typeof v === "object") return norm(v); } catch (_e) {}
        const wl = lenientJsonParse(wrapped);
        if (wl && typeof wl === "object") return norm(wl);
    }
    // 截断尾巴：栏落定时容器还开着 → 自动闭合再试（v0.4.11）
    const closed = balanceClose(cheap);
    if (closed) {
        try { const v = JSON.parse(closed); return v && typeof v === "object" ? norm(v) : null; } catch (_e) {}
    }
    return repairSpec(cheap);
}

// ---- 结构化围栏切分器（对齐 VSCode markdown.tsx splitDshUiSegments，v0.5.0）----
// 在进 MarkdownRenderer 之前就把 dsh-ui 段切出来：围栏边界 = 「开栏符之后第一个括号平衡的
// JSON 值」，与 CommonMark 围栏语义解耦——开栏符粘句尾、漏写闭合栏、栏内混正文等崩法
// 统一走同一条管道。逐行扫描带普通代码围栏状态，代码示例里的字面 ```dsh-ui 不会误触发。
/** pos 起跳过空白后的首个 { 或 [ 下标；无则 -1 */
function specStart(s, pos) {
    let i = pos;
    while (i < s.length && /\s/.test(s[i])) i++;
    return s[i] === "{" || s[i] === "[" ? i : -1;
}
/** pos 处括号平衡 JSON 值的结束下标（越过该值）；字符串感知、{}[] 混合计数。只管平衡，合法性归 parseSpec */
function balancedEnd(s, pos) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let k = pos; k < s.length; k++) {
        const ch = s[k];
        if (inStr) {
            if (esc) esc = false;
            else if (ch === "\\") esc = true;
            else if (ch === '"') inStr = false;
            continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === "{" || ch === "[") depth++;
        else if (ch === "}" || ch === "]") {
            depth--;
            if (depth === 0) return k + 1;
        }
    }
    return -1;
}
/** 把助手文本切成 {kind:"text"|"fence", text} 段；fence 段是裸 spec 文本 */
// v0.1.12 本质重写：逐行扫描围栏结构（开栏行→收集内容行→闭合栏行），
// 完全不依赖 JSON 括号平衡。原实现用 balancedEnd（inStr 状态机）切分，
// LLM 输出的 JSON 字符串值里常有未转义双引号（如 你没有被"AI 漏一整章"坑过），
// 会搞乱 inStr 状态机，在错误位置找到括号平衡、把 JSON 截断为 517/626 字符导致 parseSpec 失败。
// 闭合围栏（行首 3+ 反引号）是可靠的结构边界，不受 JSON 内部内容影响——这也是 VSCode/DSH 网页版的做法。
function splitDshUiSegments(text) {
    const openerRe = /(`{3,})\s*dsh-ui\b/i;
    if (!openerRe.test(text)) return [{ kind: "text", text }];
    const lines = text.split("\n");
    const segs = [];
    let proseBuf = [];
    let inPlainFence = false;
    let plainFenceTicks = 0;
    let i = 0;
    const flushProse = () => {
        if (proseBuf.length > 0) {
            segs.push({ kind: "text", text: proseBuf.join("\n") });
            proseBuf = [];
        }
    };
    while (i < lines.length) {
        const line = lines[i];
        if (inPlainFence) {
            proseBuf.push(line);
            const closeMatch = /^\s*(`{3,})/.exec(line);
            if (closeMatch && closeMatch[1].length >= plainFenceTicks) inPlainFence = false;
            i++;
            continue;
        }
        const hit = openerRe.exec(line);
        if (hit) {
            const openerTicks = hit[1].length;
            const prefix = line.slice(0, hit.index);
            if (prefix.trim()) proseBuf.push(prefix);
            flushProse();
            i++; // 跳过开栏行
            const fenceLines = [];
            let foundClose = false;
            while (i < lines.length) {
                const fline = lines[i];
                // 闭合围栏：行首可选空白 + 与开栏相同或更多的反引号。
                // 宽松匹配（不要求行尾空白/结束），兼容 LLM 输出的非标准闭合栏（如 ``` 后带语言标签）。
                const closeMatch = /^\s*(`{3,})/.exec(fline);
                if (closeMatch && closeMatch[1].length >= openerTicks) {
                    foundClose = true;
                    i++; // 跳过闭合行
                    break;
                }
                fenceLines.push(fline);
                i++;
            }
            const fenceText = fenceLines.join("\n");
            const start = specStart(fenceText, 0);
            if (start >= 0) {
                segs.push({ kind: "fence", text: fenceText.slice(start).trim() });
            } else {
                // 开栏后没有 JSON（空栏/纯文本）：当正文处理
                if (fenceText.trim()) segs.push({ kind: "text", text: fenceText });
            }
            // 未找到闭合栏：流式半截（永不平衡）仍全归 fence；
            // 但 JSON 已括号平衡时（LLM 忘写闭合栏+后面还有正文）只吃 JSON，
            // 尾巴递归回收成正文——混合策略，兼顾「引号混乱」与「漏闭合吞正文」两类崩法。
            if (!foundClose) {
                if (start >= 0) {
                    const end2 = balancedEnd(fenceText, start);
                    if (end2 >= 0) {
                        segs.pop(); // 弹掉整段 fence，重切成 JSON + 尾巴
                        segs.push({ kind: "fence", text: fenceText.slice(start, end2) });
                        const tail = fenceText.slice(end2);
                        const tailSegs = tail.trim() ? splitDshUiSegments(tail) : [];
                        for (const s2 of tailSegs) segs.push(s2);
                    }
                }
                break;
            }
            continue;
        }
        // 普通代码围栏（记录反引号数量，避免其内部的 ```dsh-ui 误触发）
        const plainMatch = /^\s*(`{3,})/.exec(line);
        if (plainMatch) {
            inPlainFence = true;
            plainFenceTicks = plainMatch[1].length;
        }
        proseBuf.push(line);
        i++;
    }
    flushProse();
    return segs.length > 0 ? segs : [{ kind: "text", text }];
}
/* ==== FENCE-PURE-END ==== */

/* ==== FOLD-PURE-BEGIN — 折叠管线 v2（对齐 dsh-vscode webview/src/fold.ts；回归：node scripts/fold-regress.mjs） ====
 * 事实源：交错 segments（text|thinking|tool 按真实到达顺序）。
 * v2 关键点：chunkrow/text-chunks + chunkrow/reasoning-chunks（历史页正文压缩形态，
 * texts[] 拼接——不接这两个 case 重载必丢正文）；tool/result 的 callId 三级取值
 * （data.callId | data.message.source.callId | data.message.content[0].toolCallId）；
 * 跨回合回溯（turn/end 后落地的结果仍能找到它的活动卡）；步骤卡（step/* → 📍）。 */
class DshFold {
    constructor() {
        this.items = [];
        this._lastSeq = -1;
        this._firstSeq = -1;
        this._turnCounter = 0;
        this._running = false;
    }
    get seq() { return this._lastSeq; }
    get oldestSeq() { return this._firstSeq; }
    get isRunning() { return this._running; }
    /** 收一条：mux 帧（session/event）/ 历史条目（{event,view?}）/ 裸事件。 */
    push(entryOrEvent) {
        const anyE = entryOrEvent;
        let ev; let view;
        if (anyE && anyE.type === "session/event" && anyE.event && typeof anyE.event === "object") {
            ev = anyE.event; view = anyE;
        } else if (anyE && anyE.event && typeof anyE.event === "object") {
            ev = anyE.event; view = anyE;
        } else {
            ev = anyE;
        }
        if (!ev || typeof ev.type !== "string") return;
        if (typeof ev.seq === "number") {
            if (ev.seq <= this._lastSeq) return; // WS 重连/历史重叠去重
            if (this._firstSeq < 0) this._firstSeq = ev.seq;
            this._lastSeq = ev.seq;
        }
        switch (ev.type) {
            case "user/message": {
                const r = foldExtractUserPayload(ev.data);
                if (r.text || (r.files && r.files.length) || (r.images && r.images.length)) {
                    this.items.push({ kind: "user", key: `u${this._lastSeq}-${this.items.length}`, text: r.text, files: r.files, images: r.images });
                }
                break;
            }
            case "turn/start": {
                this._running = true;
                this._turnCounter += 1;
                this.items.push({ kind: "turn", key: `t${this._turnCounter}-${this._lastSeq}`, text: "", thinking: "", activities: [], segments: [], ended: false, turnNo: this._turnCounter });
                break;
            }
            case "turn/end": {
                this._running = false;
                const cur = this._currentTurn();
                if (cur) { cur.ended = true; cur.liveTool = undefined; cur.lastSeq = this._lastSeq; }
                break;
            }
            case "assistant/chunk": {
                this._applyChunk(ev.data && ev.data.chunk, view);
                break;
            }
            // 历史回放（session/page）把 text/reasoning 压成 chunkrow 行；text-delta 不持久化。
            case "chunkrow/text-chunks": {
                const texts = ev.data && ev.data.texts;
                if (Array.isArray(texts) && texts.length > 0) this._appendSeg("text", texts.join(""));
                break;
            }
            case "chunkrow/reasoning-chunks": {
                const texts = ev.data && ev.data.texts;
                if (Array.isArray(texts) && texts.length > 0) this._appendSeg("thinking", texts.join(""));
                break;
            }
            case "assistant/message": {
                const cur = this._currentTurn();
                if (cur && !cur.text) {
                    const m = (ev.data && (ev.data.message || ev.data.content)) || ev.data;
                    const mt = typeof m === "string" ? m : (m && m.content);
                    if (typeof mt === "string") cur.text = stripSystemContext(mt);
                }
                break;
            }
            case "tool/call": {
                const d = (ev.data || {});
                const args = foldParseJson(d.arguments);
                const meta = foldSubagentMeta(d.name, args);
                this._toolActivity({
                    key: String(d.callId != null ? d.callId : `tc${this._lastSeq}`),
                    name: meta ? meta.displayName : d.name,
                    args,
                    label: meta ? meta.label : String(d.name || "工具"),
                });
                break;
            }
            case "tool/result": {
                const d = (ev.data || {});
                const preview = foldExtractResultPreview(d, view && view.view);
                const isError = foldIsErrorResult(d);
                this._finishTool(foldResultCallId(d), preview, isError);
                break;
            }
            case "step/start": {
                const d = (ev.data || {});
                const key = `st:${d.id != null ? d.id : `${d.turn != null ? d.turn : "?"}-${d.step != null ? d.step : "?"}`}`;
                this._toolActivity({ key, name: d.title || d.name, label: `📍 ${d.title || d.name || `步骤 ${d.step != null ? d.step : ""}`}`.trim() });
                break;
            }
            case "step/end": {
                const d = (ev.data || {});
                const key = `st:${d.id != null ? d.id : `${d.turn != null ? d.turn : "?"}-${d.step != null ? d.step : "?"}`}`;
                this._finishTool(key, "", false);
                break;
            }
            default:
                break;
        }
    }
    pushMany(entries) { for (const e of (entries || [])) this.push(e); }
    /** 前插更早的历史页（条目按时间正序到达）。 */
    unshiftMany(entries) {
        const scratch = new DshFold();
        scratch.pushMany(entries);
        if (scratch.oldestSeq >= 0 && (this._firstSeq < 0 || scratch.oldestSeq < this._firstSeq)) {
            this._firstSeq = scratch.oldestSeq;
        }
        this.items = [...scratch.items, ...this.items];
    }
    reset() {
        this.items = []; this._lastSeq = -1; this._firstSeq = -1; this._turnCounter = 0; this._running = false;
    }
    _applyChunk(chunk, view) {
        if (!chunk || typeof chunk.type !== "string") return;
        this._ensureTurn(); // turn/start 之前的早到 chunk 也归一轮
        switch (chunk.type) {
            case "text-delta":
                if (typeof chunk.text === "string") this._appendSeg("text", chunk.text);
                break;
            case "reasoning-delta":
                if (typeof chunk.text === "string") this._appendSeg("thinking", chunk.text);
                break;
            case "usage":
            case "finish":
                break; // 纯元数据
            case "tool-call":
            case "tool-call-delta": {
                const name = chunk.name != null ? chunk.name : chunk.toolName;
                const args = foldParseJson(chunk.arguments != null ? chunk.arguments : (chunk.args != null ? chunk.args : chunk.input));
                const meta = foldSubagentMeta(name, args);
                this._toolActivity({
                    key: String(chunk.callId != null ? chunk.callId : (chunk.toolCallId != null ? chunk.toolCallId : (chunk.id != null ? chunk.id : `c${this._lastSeq}`))),
                    name: meta ? meta.displayName : name,
                    args,
                    label: meta ? meta.label : String(name || "工具"),
                });
                break;
            }
            case "tool-result":
            case "tool-call-result": {
                const preview = foldExtractResultPreview(chunk, view && view.view);
                const isError = foldIsErrorResult(chunk);
                this._finishTool(foldResultCallId(chunk), preview, isError);
                break;
            }
            case "agent-start":
                this._toolActivity({ key: `ag:${chunk.agentId != null ? chunk.agentId : (chunk.id != null ? chunk.id : this._lastSeq)}`, name: chunk.name, label: `👤 Agent ${chunk.name || ""}` });
                break;
            case "agent-end":
                this._finishTool(`ag:${chunk.agentId != null ? chunk.agentId : (chunk.id != null ? chunk.id : "")}`, foldResultPreviewOf(chunk.result), !!chunk.error);
                break;
            case "subagent-start":
                this._toolActivity({
                    key: `sa:${chunk.subagentId != null ? chunk.subagentId : (chunk.id != null ? chunk.id : this._lastSeq)}`,
                    name: chunk.name != null ? chunk.name : chunk.agentId,
                    label: `👥 子代理 ${chunk.name || chunk.agentId || ""}${chunk.task ? `（${String(chunk.task).slice(0, 30)}）` : ""}`,
                });
                break;
            case "subagent-end":
                this._finishTool(`sa:${chunk.subagentId != null ? chunk.subagentId : (chunk.id != null ? chunk.id : "")}`, foldResultPreviewOf(chunk.result), !!chunk.error);
                break;
            case "step-start":
                this._toolActivity({ key: `st:${chunk.id != null ? chunk.id : this._lastSeq}`, name: chunk.title, label: `📍 ${chunk.title || chunk.name || "步骤"}` });
                break;
            case "step-end":
                this._finishTool(`st:${chunk.id != null ? chunk.id : ""}`, "", false);
                break;
            case "block-start":
            case "block-end":
                break; // 噪音
            default:
                break;
        }
    }
    _ensureTurn() {
        let cur = this._currentTurn();
        if (!cur || cur.ended) {
            this._turnCounter += 1;
            cur = { kind: "turn", key: `t${this._turnCounter}-${this._lastSeq}`, text: "", thinking: "", activities: [], segments: [], ended: false, turnNo: this._turnCounter };
            this.items.push(cur);
            this._running = true;
        }
        return cur;
    }
    /** 同类尾段拼接，异类新开——segments 保持真实到达顺序（text→tool→text 就按这个序渲染）。 */
    _appendSeg(kind, delta) {
        const cur = this._ensureTurn();
        if (kind === "text") cur.text += delta;
        else cur.thinking += delta;
        const last = cur.segments[cur.segments.length - 1];
        if (last && last.kind === kind) last.text += delta;
        else cur.segments.push(kind === "text" ? { kind: "text", text: delta } : { kind: "thinking", text: delta });
    }
    _currentTurn() {
        for (let i = this.items.length - 1; i >= 0; i--) {
            const it = this.items[i];
            if (it.kind === "user") return undefined;
            if (it.kind === "turn") return it;
        }
        return undefined;
    }
    _toolActivity(init) {
        const cur = this._ensureTurn();
        const existing = cur.activities.find((a) => a.key === init.key);
        if (existing) {
            if (init.name) existing.name = init.name;
            if (init.args !== undefined) existing.args = init.args;
            return;
        }
        const act = {
            key: init.key,
            kind: init.kind != null ? init.kind : (init.label.startsWith("👥") ? "subagent" : (init.label.startsWith("👤") ? "agent" : (init.label.startsWith("📍") ? "step" : "tool"))),
            label: init.label,
            detail: foldArgsPreview(init.args),
            state: "running",
            callId: init.key,
            name: init.name,
            args: init.args,
        };
        cur.activities.push(act);
        cur.segments.push({ kind: "tool", act });
        cur.liveTool = act.name ? `${act.name}${act.detail ? ` · ${act.detail.slice(0, 60)}` : ""}` : act.label;
    }
    _finishTool(key, preview, isError) {
        if (!key) return;
        // 先当前轮，再有限回溯——turn/end 之后才落地的结果也要能找到它的活动卡
        const turns = [];
        for (let i = this.items.length - 1; i >= 0 && turns.length < 5; i--) {
            const it = this.items[i];
            if (it.kind === "turn") turns.push(it);
        }
        for (const turn of turns) {
            const act = turn.activities.find((a) => a.key === key);
            if (act) {
                act.state = isError ? "error" : "done";
                if (preview) act.resultPreview = preview;
                break;
            }
        }
        const turn = turns[0];
        if (!turn) return;
        for (let i = turn.activities.length - 1; i >= 0; i--) {
            const a = turn.activities[i];
            if (a.state === "running") { turn.liveTool = a.name ? `${a.name}${a.detail ? ` · ${a.detail.slice(0, 60)}` : ""}` : a.label; return; }
        }
        turn.liveTool = undefined;
    }
}

/** 子代理伪装成普通 tool/call（name=subagent/workflow/ralph/…）→ 👥 换脸 */
function foldSubagentMeta(name, args) {
    const n = typeof name === "string" ? name.toLowerCase() : "";
    if (!["subagent", "subagent_fork", "ralph", "workflow", "agent_teams_add_member"].includes(n)) return null;
    const a = args || {};
    const desc =
        (typeof a.description === "string" && a.description) ||
        (typeof a.prompt === "string" ? a.prompt.split("\n", 1)[0].slice(0, 40) : "") ||
        (typeof a.objective === "string" ? a.objective.split("\n", 1)[0].slice(0, 40) : "") ||
        "";
    return { label: `👥 子代理${desc ? ` · ${desc.slice(0, 50)}` : ""}`, displayName: desc.slice(0, 50) || String(name) };
}

function foldArgsPreview(args) {
    if (args === undefined) return "";
    try {
        const s = typeof args === "string" ? args : JSON.stringify(args);
        return s.length > 160 ? `${s.slice(0, 160)}…` : s;
    } catch (_e) { return ""; }
}

function foldResultPreviewOf(result) {
    if (result === undefined || result === null) return undefined;
    try {
        const s = typeof result === "string" ? result : JSON.stringify(result);
        return s.length > 200 ? `${s.slice(0, 200)}…` : s;
    } catch (_e) { return undefined; }
}

/** wire fact（rc.2 + alpha.5 实测）：tool/result 的 callId 在 data.callId、
 *  data.message.source.callId 或 data.message.content[0].toolCallId —— 三级都收。 */
function foldResultCallId(d) {
    return String(
        (d && (d.callId != null ? d.callId : (d.toolCallId != null ? d.toolCallId
            : (d.message && d.message.source && d.message.source.callId)))) ||
        (d && d.message && d.message.content && d.message.content[0] && d.message.content[0].toolCallId) ||
        (d && d.id) || ""
    );
}

function foldExtractResultPreview(data, view) {
    const d = data || {};
    const text =
        (d.message && d.message.content && d.message.content[0] && d.message.content[0].content && d.message.content[0].content[0] && d.message.content[0].content[0].text) ||
        (d.message && d.message.content && d.message.content[0] && d.message.content[0].text) ||
        (d.content && d.content[0] && d.content[0].text) ||
        d.text;
    if (typeof text === "string" && text) return text.length > 200 ? `${text.slice(0, 200)}…` : text;
    if (view && typeof view.card === "string") {
        return view.card.length > 200 ? `${view.card.slice(0, 200)}…` : view.card;
    }
    return foldResultPreviewOf(d.result);
}

function foldIsErrorResult(data) {
    const d = data || {};
    if (d.isError === true) return true;
    const content = d.message && d.message.content && d.message.content[0];
    return !!(content && content.isError === true);
}

function foldParseJson(raw) {
    if (typeof raw !== "string") return raw;
    try { return JSON.parse(raw); } catch (_e) { return undefined; }
}

/** user/message → (人类文本, 附件标签, 图片)。引用文件部件只留标签不留正文。 */
function foldExtractUserPayload(data) {
    const d = data || {};
    const parts = [];
    const files = [];
    const images = [];
    const consider = (t) => {
        const m = /^\[引用文件 (.+?)\]\n?/.exec(String(t).trim());
        if (m) { files.push(m[1]); return; }
        parts.push(t);
    };
    if (typeof d.text === "string") consider(d.text);
    else if (Array.isArray(d.content)) {
        for (const c of d.content) {
            if (c && c.type === "image" && c.attachment && typeof c.attachment.attachmentId === "string" && c.attachment.attachmentId) {
                images.push({ attachmentId: c.attachment.attachmentId, mediaType: c.attachment.mediaType || "image/png", name: c.attachment.name });
                continue;
            }
            if (c && typeof c.text === "string" && c.text) consider(c.text);
        }
    } else if (typeof d.content === "string") consider(d.content);
    const raw = parts.join("\n\n");
    // 指令注入（AGENTS.md/技能文档）以独立多段文档到达：首段是指令头 → 整条丢弃
    const firstLine = ((raw.split(/\n\s*\n/, 1)[0] || "").split("\n", 1)[0] || "").trim();
    if (/^Instructions from\b/.test(firstLine)) return { text: "", files, images };
    return { text: stripSystemContext(raw), files, images };
}
/* ==== FOLD-PURE-END ==== */

// 入口：先剥系统块，再走 v0.5.0 同款结构化切分——fence 段重排成规范 dsh-ui 代码块；
// 纯文本段保留 wrapDshUiJson 兜底（无栏裸 JSON 自动包栏，Obsidian 原有能力不回退）
function preprocessAssistantText(text) {
    if (!text) return text;
    const s = stripSystemContext(text);
    const segs = splitDshUiSegments(s);
    let out = "";
    for (const seg of segs) {
        if (seg.kind === "fence") {
            out += "\n```dsh-ui\n" + seg.text.trim() + "\n```\n";
        } else {
            out += wrapDshUiJson(seg.text);
        }
    }
    return out;
}

// 子代理换脸（移植自 VSCode fold.ts:319）：本宿主把子代理委派伪装成普通 tool/call
// （name ∈ subagent/subagent_fork/ralph/workflow/agent_teams_add_member），没有独立的
// agent-/subagent- chunk。识别后换成 👥 子代理标签，否则它们会被误标成「🔧 调用工具」而隐形。
function subagentMeta(name, args) {
    const n = typeof name === "string" ? name.toLowerCase() : "";
    if (!["subagent", "subagent_fork", "ralph", "workflow", "agent_teams_add_member"].includes(n)) return null;
    const a = (args && typeof args === "object") ? args : {};
    const desc =
        (typeof a.description === "string" && a.description) ||
        (typeof a.prompt === "string" ? a.prompt.split("\n", 1)[0].slice(0, 40) : "") ||
        (typeof a.objective === "string" ? a.objective.split("\n", 1)[0].slice(0, 40) : "") ||
        "";
    return "👥 子代理" + (desc ? " · " + desc.slice(0, 50) : "");
}

/* ====================================================================
 * 聊天视图（原生 Obsidian UI）
 * ================================================================== */
class DshNativeView extends ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this.api = plugin.api;
        this.workspace = null;
        this.sessionId = null;
        this.sessions = [];
        this.ws = null;
        this.wsConnected = false;
        this.wsReconnectTimer = null;
        this.assistantEl = null;
        this.assistantMd = "";
        this.thinkingMd = "";
        this.renderPending = false;
        this.pending = new Map(); // key -> {rpcId, kind, ...}
        // 轮询渲染（兜底新会话 WS 不推事件）+ turn 生命周期标志
        this._pollTimer = null;
        this._turnDone = false;
        this._contentSetByWs = false;
        this._pollStart = 0;
        this._modelFixPromise = null;
        // Phase 6：附件（@ 文件补全 / 图片粘贴）
        this._attachments = [];      // [{kind:"file", file:TFile} | {kind:"image", part:{type,image,...}}]
        this._vaultMdFiles = null;   // 懒缓存：vault 内 markdown 文件列表
        this._atPopup = null;        // {@ popup DOM 与状态：{el, items, index, isVisible}}
        // Phase 7：向上翻页状态
        this._hasMore = false;
        this._oldestSeq = null;
        this._loadingOlder = false;
        // Phase E：plan/todos 投影状态
        this._planActive = false;
        this._todos = null;
        this._todoOpen = false;
        // Phase A：运行中中断标志
        this._running = false;
        // Phase B：/ 技能菜单缓存
        this._slashCache = null;
        this._slashErr = null;
        this._slashPopup = null;
        // Phase F：排队队列条
        this._queueItems = null;
    }

    getViewType() {
        return VIEW_TYPE;
    }
    getDisplayText() {
        return "DeepSeek Harness";
    }
    getIcon() {
        return "bot";
    }

    /* ---------- DOM ---------- */
    async onOpen() {
        const root = this.contentEl;
        root.empty();
        root.addClass("dsh-native-container");

        // 报告函数：把错误以纯文本直接渲染到 panel，永远不会再"静默白板"
        const fatal = (where, e) => {
            const msg = (e && (e.stack || e.message)) ? (e.stack || e.message) : String(e);
            console.error(`[dsh-native] onOpen @ ${where}:`, e);
            try {
                root.empty();
                const box = root.createDiv();
                box.style.cssText = "padding:16px;font-family:var(--font-monospace,monospace);font-size:12px;line-height:1.5;color:#c00;background:#fff;white-space:pre-wrap;word-break:break-word;overflow:auto;height:100%;box-sizing:border-box;";
                const t = box.createEl("div");
                t.textContent = `❌ DSH 面板初始化失败 @ ${where}`;
                t.style.cssText = "font-weight:700;color:#c00;";
                const pre = box.createEl("pre");
                pre.textContent = msg;
                pre.style.cssText = "white-space:pre-wrap;margin:8px 0 0 0;color:#333;";
                const hint = box.createEl("div");
                hint.textContent = "→ 把这段红字截图给我，我会按堆栈定位修复。";
                hint.style.cssText = "color:#666;margin-top:12px;";
            } catch (_) {
                root.textContent = `DSH 面板初始化失败 @ ${where}: ${msg}`;
            }
        };

        // 0) 视觉信号已移除：调试期的大红字标题（"DSH panel — vX — onOpen reached"）不再展示；
        //    版本号改在「设置」面板展示（见 DshNativeSettingTab）。

        // 1) overlay
        try { this.overlay = root.createDiv("dsh-native-overlay"); }
        catch (e) { return fatal("createDiv overlay", e); }

        // 2) header
        let header;
        try { header = root.createDiv("dsh-native-header"); this.header = header; }
        catch (e) { return fatal("createDiv header", e); }
        // 2.1) 顶部条（对齐 VSCode .header）：状态点 + 标题下拉按钮 + 重命名 + spacer + 新建
        let headerTop;
        try { headerTop = header.createDiv("dsh-native-header-top"); }
        catch (e) { return fatal("createDiv headerTop", e); }
        try { this.statusDot = headerTop.createSpan("dsh-status-dot"); }
        catch (e) { return fatal("createSpan statusDot", e); }
        // 标题按钮：显示当前会话标题 + 下拉箭头，点击展开会话列表（对齐 VSCode title-btn）
        try {
            this.titleBtn = headerTop.createEl("button", { cls: "dsh-title-btn", attr: { title: "点击切换会话" } });
            this.titleBtn.type = "button";
            this.titleText = this.titleBtn.createSpan("dsh-title-text");
            this.titleText.textContent = "—";
            this.titleChev = this.titleBtn.createSpan("dsh-chev");
            this.titleChev.textContent = "⌄";
            // 仅展开/收起会话列表；重命名只经 ✎ 图标（对齐 VSCode，双击不再触发改名框）
            this.titleBtn.addEventListener("click", () => this.toggleSessionList());
        } catch (e) { return fatal("createEl titleBtn", e); }
        // 重命名图标（对齐 VSCode icon-btn mini ✎）
        try {
            this.renameIcon = headerTop.createEl("button", { cls: "dsh-icon-btn dsh-icon-mini", attr: { title: "重命名会话" } });
            this.renameIcon.textContent = "✎";
            this.renameIcon.addEventListener("click", () => this.openRenameBar());
        } catch (e) { return fatal("createEl renameIcon", e); }
        // Agent 模式选择（对齐 VSCode PresetPicker：发消息前可切换，发出后锁定 🔒）
        try { this.presetSlot = headerTop.createSpan("dsh-preset-slot"); }
        catch (e) { return fatal("createSpan presetSlot", e); }
        try { this.headerSpacer = headerTop.createDiv("dsh-spacer"); }
        catch (e) { return fatal("createDiv spacer", e); }
        try {
            this.newBtn = headerTop.createEl("button", { cls: "dsh-icon-btn", attr: { title: "新建会话" } });
            this.newBtn.textContent = "＋";
            this.newBtn.addEventListener("click", () => this.newSession());
        } catch (e) { return fatal("createEl newBtn", e); }
        // v0.5.0 工作区管理入口（对齐 VSCode header folder 图标）
        try {
            this.wsBtn = headerTop.createEl("button", { cls: "dsh-icon-btn", attr: { title: "工作区管理" } });
            this.wsBtn.textContent = "▤";
            this.wsBtn.addEventListener("click", () => this.openWorkspaceSheet());
        } catch (e) { /* 非致命 */ }
        // v0.6.0 子代理面板（对齐 VSCode header subs 图标）
        try {
            this.subsBtn = headerTop.createEl("button", { cls: "dsh-icon-btn", attr: { title: "子代理" } });
            this.subsBtn.textContent = "👥";
            this.subsBtn.addEventListener("click", () => this.openSubagentsSheet());
        } catch (e) { /* 非致命 */ }
        // v0.6.0 服务器设置（对齐 VSCode header settings 图标）
        try {
            this.srvBtn = headerTop.createEl("button", { cls: "dsh-icon-btn", attr: { title: "服务器设置" } });
            this.srvBtn.textContent = "⚙";
            this.srvBtn.addEventListener("click", () => this.openSettingsSheet());
        } catch (e) { /* 非致命 */ }
        // 2.2) 会话列表改为右侧滑出 Sheet（v0.5.0，对齐 VSCode sessions drawer；旧下拉退役）

        // 3) messages
        try { this.messagesEl = root.createDiv("dsh-native-messages"); }
        catch (e) { return fatal("createDiv messages", e); }
        // 3.1) dsh-ui 卡片交互委托（tab 切换 + 复制）——挂一次在容器上
        try {
            this.messagesEl.addEventListener("click", (e) => {
                const t = e.target;
                if (!t || !t.closest) return;
                const tab = t.closest(".dui-tab");
                if (tab) {
                    const wrap = tab.closest(".dui-tabs");
                    if (!wrap) return;
                    const idx = tab.getAttribute("data-idx");
                    wrap.querySelectorAll(".dui-tab").forEach((x) => x.classList.toggle("active", x.getAttribute("data-idx") === idx));
                    wrap.querySelectorAll(".dui-tab-panel").forEach((p) => { p.style.display = p.getAttribute("data-idx") === idx ? "" : "none"; });
                    return;
                }
                const copy = t.closest(".dui-copy");
                if (copy) {
                    const txt = copy.getAttribute("data-copy") || "";
                    const label = copy.getAttribute("data-label") || "复制";
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        navigator.clipboard.writeText(txt).then(() => {
                            copy.textContent = "已复制 ✓";
                            setTimeout(() => { copy.textContent = label + " 📋"; }, 1200);
                        }).catch(() => {});
                    }
                }
            });
        } catch (e) { /* 委托失败不影响主流程 */ }
        // 3.2) 向上翻页 + 自动滚动追踪：滚到顶部拉更早历史；用户上滑后暂停自动滚动，回到底部恢复
        try {
            this.messagesEl.addEventListener("scroll", () => {
                if (this._loadingOlder) return;
                if (!this.messagesEl) return;
                // 自动滚动追踪：距底部 <= 100px 视为"在底部"，恢复自动滚动；否则暂停
                const distFromBottom = this.messagesEl.scrollHeight - this.messagesEl.scrollTop - this.messagesEl.clientHeight;
                this._autoScroll = distFromBottom < 100;
                if (this.messagesEl.scrollTop < 48 && this._hasMore && this._oldestSeq != null && this.sessionId) {
                    this.loadOlder();
                }
            });
        } catch (e) { /* 非致命 */ }
        // status line
        try { this.statusLine = root.createDiv("dsh-native-statusline"); }
        catch (e) { return fatal("createDiv statusline", e); }

        // 3.5) controls bar（模式 / 模型 / 权限 — 对齐 VSCode DSH 底部下拉）
        try {
            this.controlsBar = root.createDiv("dsh-native-controls");
            // 模式（queue / steer）：单按钮切换，无前缀标签（对齐 VSCode composer-actions 的 chip-btn 切换）
            this.modeBtn = this.controlsBar.createEl("button", {
                cls: "dsh-chip-btn",
                attr: { title: "点击切换：队列（等当前轮结束）/ 引导（运行中插队）" },
            });
            this.modeBtn.type = "button";
            const curMode = (this.plugin && this.plugin.settings && this.plugin.settings.mode) || "queue";
            this._applyModeUi(curMode);
            this.modeBtn.addEventListener("click", () => this.setMode((this.plugin.settings.mode || "queue") === "queue" ? "steer" : "queue"));

            // 提供方/模型（session.models RPC 驱动）：chip-btn 下拉，当前值直接显示 provider/model，无前缀（对齐 VSCode）
            this.modelSelect = this.controlsBar.createEl("select", { cls: "dsh-chip-btn dsh-model-select" });
            const phOpt = this.modelSelect.createEl("option", { value: "" });
            phOpt.textContent = "加载中…";
            this.modelSelect.disabled = true;
            this.modelSelect.addEventListener("change", () => {
                const v = this.modelSelect.value;
                if (!v) return;
                const parts = v.split("::");
                const provider = parts[0] || "";
                const model = parts[1] || "";
                const effort = parts[2] || undefined;
                this.switchModel(provider, model, effort);
            });

            // 思考强度（对齐 VSCode EffortPicker）：仅当前模型支持 reasoning 时显示
            this.effortSelect = this.controlsBar.createEl("select", { cls: "dsh-chip-btn dsh-effort-select" });
            this.effortSelect.style.display = "none";
            this.effortSelect.addEventListener("change", () => {
                const v = this.effortSelect.value;
                if (!v) return;
                const cur = this._currentModels && this._currentModels.current;
                if (cur) this.switchModel(cur.provider, cur.model, v);
            });

            // 权限（对齐 VSCode：会话级预设，经 /permission 命令立即生效；选项初值来自 settings.describe，实时值由投影更新）
            // chip-btn 下拉，无前缀（对齐 VSCode）
            this.permSelect = this.controlsBar.createEl("select", { cls: "dsh-chip-btn dsh-perm-select", attr: { title: "权限预设（当前会话，立即生效）" } });
            const ph = this.permSelect.createEl("option", { value: "" });
            ph.textContent = "加载中…";
            this.permSelect.disabled = true;
            this.permSelect.addEventListener("change", () => this.switchPermission());
            // 兼容旧字段 permValue（占位符，给 setSession 用）
            this.permValue = this.permSelect;
            // token 用量行（对齐 VSCode .composer-meta）：控制条下方右对齐小字
            try {
                this.composerMeta = root.createDiv("dsh-composer-meta");
                this.composerMeta.style.display = "none";
            } catch (e) { /* 非致命 */ }
        }
        catch (e) { return fatal("createDiv controls", e); }

        // 4) input
        let inputBar;
        // 4.5) 实时活动指示条（composer 上方）：子代理/工具执行中可见（Bug 4 次要增强）
        // 内含「停止」按钮：运行中可中断当前 turn（Phase A）
        try {
            const liveBar = root.createDiv("dsh-native-livebar");
            liveBar.style.display = "none";
            this.liveBar = liveBar;
            liveBar.createSpan("dsh-spinner"); // 对齐 VSCode live-bar 的旋转指示
            this.liveBarLabel = liveBar.createSpan("dsh-livebar-label");
            this.stopBtn = liveBar.createEl("button", {
                cls: "dsh-native-stopbtn",
                text: "停止",
                attr: { title: "中断当前生成 (Esc)", "aria-label": "停止" },
            });
            this.stopBtn.type = "button";
            this.stopBtn.addEventListener("click", (e) => { e.preventDefault(); this.requestCancel(); });
        }
        catch (e) { /* 非致命 */ }
        // 4.6) Plan 模式横幅 + Todo 进度条（Phase E，由 session/projection 的 plan/todos 驱动）
        try {
            this.planStrip = root.createDiv("dsh-plan-strip");
            this.planStrip.style.display = "none";
        }
        catch (e) { /* 非致命 */ }
        // 4.7) 排队队列条（Phase F，由 session/queue 帧驱动，展示运行中追加的消息）
        try {
            this.queueStrip = root.createDiv("dsh-queue-strip");
            this.queueStrip.style.display = "none";
        }
        catch (e) { /* 非致命 */ }
        try { inputBar = root.createDiv("dsh-native-inputbar"); }
        catch (e) { return fatal("createDiv inputbar", e); }
        this.inputBar = inputBar; // Phase B/@：弹窗锚点，必须挂到 this，否则 showSlashPopup/showAtPopup 因 this.inputBar 为 undefined 直接 return
        // Phase 6：附件 chip 容器（位于 textarea 上方）
        try { this.attachmentsEl = inputBar.createDiv("dsh-native-attachments"); this.attachmentsEl.style.display = "none"; }
        catch (e) { /* 非致命 */ }
        // Phase D：引用选区/笔记按钮（等价于 Alt+K 命令），加入输入框作为内容块
        try {
            this.refBtn = inputBar.createEl("button", {
                cls: "dsh-native-refbtn",
                text: "📎 引用",
                attr: { title: "引用当前选区/笔记到输入框（可绑定 Alt+K）", "aria-label": "引用" },
            });
            this.refBtn.type = "button";
            this.refBtn.addEventListener("click", (e) => { e.preventDefault(); this.attachActiveContext(); });
        }
        catch (e) { /* 非致命 */ }
        try {
            this.inputEl = inputBar.createEl("textarea", {
                cls: "dsh-native-input",
                placeholder: "给 DSH 发消息…（Enter 发送，Shift+Enter 换行，输入 @ 引用 vault 文件，粘贴图片作为附件）",
            });
            this.inputEl.addEventListener("keydown", (e) => {
                // @ 弹窗可见时，方向键/Enter/Esc 由弹窗接管；否则 Enter 发送
                if (this._atPopup && this._atPopup.isVisible && this.handleAtKeydown(e)) return;
                // Phase B：/ 技能菜单可见时，方向键/Enter/Esc 由弹窗接管
                if (this._slashPopup && this._slashPopup.isVisible && this.handleSlashKeydown(e)) return;
                // Phase A：运行中按 Esc 中断当前 turn（DSH 走 session.cancel）
                if (e.key === "Escape" && this._running) {
                    e.preventDefault();
                    this.requestCancel();
                    return;
                }
                if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    this.send();
                }
            });
            this.inputEl.addEventListener("input", () => { this.updateAtTrigger(); this.updateSlashTrigger(); });
            this.inputEl.addEventListener("paste", (e) => this.handlePaste(e));
            this.inputEl.addEventListener("blur", () => {
                // 延迟关闭，确保 mousedown 选中文件先生效
                setTimeout(() => {
                    if (this._atPopup && this._atPopup.isVisible) this.hideAtPopup();
                    if (this._slashPopup && this._slashPopup.isVisible) this.hideSlashPopup();
                }, 160);
            });
            this.inputEl.addEventListener("input", () => this.updateSendState());
        } catch (e) { return fatal("createEl textarea", e); }
        // 发送按钮：浮于输入框内右下角（点击或 Enter 均触发 send）
        try {
            this.sendBtn = inputBar.createEl("button", {
                cls: "dsh-native-send",
                attr: { title: "发送 (Enter)", "aria-label": "发送" },
            });
            this.sendBtn.textContent = "➤"; // ▶ 发送图标
            this.sendBtn.type = "button";
            this.sendBtn.addEventListener("click", (e) => {
                e.preventDefault();
                if (this._running) { this.requestCancel(); return; } // v0.4.0 红色停止键
                this.send();
            });
            this.updateSendState();
        } catch (e) { /* 非致命：按钮缺失不影响 Enter 发送 */ }

        // 5) 启动后台连接（boot 内部已自捕获异常并显式浮出）
        this.boot().catch((e) => {
            console.error("[dsh-native] onOpen boot 异常:", e);
            this.setStatus("offline");
            this.showOverlay("初始化失败：" + (e && e.message ? e.message : String(e)), true);
        });
    }

    async onClose() {
        this.stopElapsed();
        this.closeWs();
        if (this.messagesEl) this.messagesEl.empty();
    }

    showOverlay(message, withReconnect) {
        if (!this.overlay) return;
        this.overlay.empty();
        const msgEl = this.overlay.createEl("div", { cls: "dsh-native-msg" });
        msgEl.textContent = message;
        if (withReconnect) {
            const btn = this.overlay.createEl("button", { cls: "mod-cta" });
            btn.textContent = "重连";
            btn.addEventListener("click", () => this.boot());
            const testBtn = this.overlay.createEl("button", { cls: "dsh-btn" });
            testBtn.textContent = "诊断 DSH";
            testBtn.style.marginLeft = "8px";
            testBtn.addEventListener("click", () => this.diagnose());
        }
        // 用 class 控制显隐（避免 obsidian 的 show()/hide() 与 CSS display 冲突，导致空 overlay 永久盖住界面）
        this.overlay.addClass("is-visible");
    }
    hideOverlay() {
        if (this.overlay) this.overlay.removeClass("is-visible");
    }

    /* ---------- 启动流程 ---------- */
    async boot() {
        this.setStatus("connecting");
        this.showOverlay("正在连接 DSH 服务…");
        try {
            const online = await this.plugin.ensureServiceOnline();
            if (online.kind !== "online") {
                this.setStatus("offline");
                this.showOverlay("DSH 服务未启动：" + online.message, true);
                return;
            }
            this.workspace = await this.api.ensureWorkspace(this.plugin.getVaultPath());
            await this.loadSessions();
            // 全局默认权限（DSH 不分会话：permission.defaultPreset 写一次即可）
            await this.loadPermissions();
            // Agent 模式目录（对齐 VSCode：agentPreset.list，头部选择器用）
            try { this._presets = await this.api.getAgentPresets(); }
            catch (_e) { this._presets = { presets: [] }; }
            this.renderPresetPicker();
            this.hideOverlay();
            this.setStatus("online");
            this.connectWs();
        } catch (e) {
            console.error("[dsh-native] boot 失败:", e);
            const msg = e && e.message ? e.message : String(e);
            this.setStatus("offline");
            this.showOverlay(
                "初始化失败：" + msg +
                "\n\n可能原因：\n• DSH 服务没在监听 127.0.0.1:" + this.plugin.settings.port + "（终端跑 curl -sf http://127.0.0.1:" + this.plugin.settings.port + "/ 验证）\n• 端口被防火墙/别的程序占用\n• 设置里的 startupCommand 路径不对（打开 DSH 设置核对）",
                true
            );
            new Notice("DSH 面板初始化失败：" + msg);
        }
    }

    async diagnose() {
        // 用 requestUrl 直接打 DSH 根 URL + /api/workspace.list 双重验证，把结果写到 overlay
        const base = this.api.baseUrl;
        const probeUrl = base + "/";
        const rpcUrl = base + "/api/workspace.list";
        const lines = [];
        const pings = await this.plugin.ensureServiceOnline();
        lines.push("• 127.0.0.1:" + this.plugin.settings.port + " TCP: " + (pings.kind === "online" ? "✅ 通" : "❌ 不通 — " + (pings.message || "")));
        try {
            const r = await requestUrl({ url: probeUrl, method: "GET", throw: false });
            lines.push("• GET " + probeUrl + " → HTTP " + r.status);
        } catch (e) {
            lines.push("• GET " + probeUrl + " → 抛错：" + (e && e.message ? e.message : String(e)));
        }
        try {
            const r = await requestUrl({
                url: rpcUrl,
                method: "POST",
                contentType: "application/json",
                body: JSON.stringify({ type: "client-request", rpcId: "diag", method: "workspace.list", payload: {} }),
                throw: false,
            });
            lines.push("• POST " + rpcUrl + " → HTTP " + r.status + (r.status === 200 ? " ✅" : " ❌"));
        } catch (e) {
            lines.push("• POST " + rpcUrl + " → 抛错：" + (e && e.message ? e.message : String(e)));
        }
        this.showOverlay("诊断结果：\n" + lines.join("\n") + "\n\n把这段截图给我。", true);
    }

    async loadSessions() {
        this.sessions = await this.api.listSessions(this.workspace.workspaceId);
        this.applyCachedTitles();
        if (this.sessions.length > 0) {
            this.openTabs = [this.sessions[0].sessionId];
            this.setSession(this.sessions[0].sessionId);
        } else {
            const s = await this.api.createSession(this.workspace);
            this.sessions = [{ sessionId: s.sessionId, title: "新会话", blank: true }];
            this.openTabs = [s.sessionId];
            this.setSession(s.sessionId);
            void this.applyModelMemory(s.sessionId);
        }
        this.renderSessionList();
        this.updateTitleBtn();
        void this.enrichSessionsInBackground();
    }

    _resolveTitle(s) {
        // 手动重命名 > DSH 标题 > 自动命名缓存（探测 history 投影所得，跨重启保留）
        if (s && s.sessionId && this.plugin && this.plugin.settings && this.plugin.settings.manualTitles) {
            const mt = this.plugin.settings.manualTitles[s.sessionId];
            if (mt) return mt;
        }
        if (s && s.title) return s.title;
        if (s && s.sessionId && this.plugin && this.plugin.settings && this.plugin.settings.autoTitles) {
            const at = this.plugin.settings.autoTitles[s.sessionId];
            if (at) return at;
        }
        return "";
    }

    _tabTitle(s) {
        const t = this._resolveTitle(s);
        if (t) return t;
        if (s && s.sessionId) return "（未命名会话）"; // 兜底文案对齐 VSCode 会话列表
        return "未命名";
    }

    // 把缓存的自动命名套到刚拉取的会话行上（对齐 VSCode applyCachedTitles）
    applyCachedTitles() {
        const at = (this.plugin && this.plugin.settings && this.plugin.settings.autoTitles) || {};
        for (const s of this.sessions) {
            if (s && s.sessionId && !s.title && at[s.sessionId]) s.title = at[s.sessionId];
        }
    }

    // session.list 不携带 title（projection-only 域）：后台逐个探测该会话 history 尾页的
    // title 投影。并发受限、结果写 settings.autoTitles 缓存；学到新名字立即重渲染
    // （对齐 dsh-vscode manager.enrichTitlesInBackground）
    async enrichSessionsInBackground() {
        if (this._enrichInFlight) return;
        this._enrichInFlight = true;
        try {
            const st = this.plugin && this.plugin.settings ? this.plugin.settings : null;
            if (!st) return;
            st.autoTitles = st.autoTitles || {};
            const targets = this.sessions
                .filter((s) => s.sessionId && !s.title && !(st.manualTitles || {})[s.sessionId] && !st.autoTitles[s.sessionId])
                .slice(0, 30);
            if (targets.length === 0) return;
            let learned = false;
            let cursor = 0;
            const worker = async () => {
                while (cursor < targets.length) {
                    const row = targets[cursor++];
                    try {
                        const h = await this.api.getHistory(row.sessionId, null, 1);
                        const p = h && h.projections;
                        const title = p && typeof p === "object" ? ((p.values && p.values.title) ?? p.title) : null;
                        if (typeof title === "string" && title) {
                            row.title = title;
                            st.autoTitles[row.sessionId] = title;
                            learned = true;
                        }
                    } catch (_e) { /* 单个失败忽略 */ }
                }
            };
            await Promise.all(Array.from({ length: Math.min(6, targets.length) }, () => worker()));
            if (learned) {
                try { await this.plugin.saveSettings(); } catch (_e) {}
                this.renderSessionList();
                this.updateTitleBtn();
            }
        } finally {
            this._enrichInFlight = false;
        }
    }

    // （v0.5.0 会话列表已迁移为右侧 Sheet —— 见 openSessionsSheet/_renderSessionsBody/renderSessionList）

    // 分叉会话（对齐 VSCode fork-session）
    async forkSessionRow(id) {
        try {
            const child = await this.api.forkSession(id);
            await this.refreshSessions();
            this.toggleSessionList(false);
            this.openSessionAsTab(child.sessionId);
            new Notice("已分叉出新会话");
        } catch (e) {
            new Notice("分叉失败：" + (e && e.message ? e.message : String(e)));
        }
    }

    // v0.4.0 从指定事件分叉（对齐 VSCode fork-at：TurnActions「从此处分叉」）
    async forkSessionRowAt(id, atSeq) {
        if (!id || atSeq == null) return;
        try {
            const child = await this.api.forkSession(id, atSeq);
            await this.refreshSessions();
            this.toggleSessionList(false);
            this.openSessionAsTab(child.sessionId);
            new Notice(`已从第 ${atSeq} 号事件处分叉出新会话`);
        } catch (e) {
            const msg = e && e.message ? e.message : String(e);
            new Notice(/fork-unavailable/.test(msg) ? "该会话还没有已完成的轮次，无法分叉" : "分叉失败：" + msg);
        }
    }

    // 归档会话（对齐 VSCode archive-session）：从列表隐藏；归档当前会话则顺延切换
    async archiveSessionRow(id) {
        try {
            await this.api.archiveSession(id);
        } catch (e) {
            new Notice("归档失败：" + (e && e.message ? e.message : String(e)));
            return;
        }
        this.openTabs = (this.openTabs || []).filter((x) => x !== id);
        if (id === this.sessionId) {
            const next = this.sessions.find((x) => x.sessionId !== id);
            if (next && next.sessionId) {
                this.setSession(next.sessionId);
            } else {
                try {
                    const s = await this.api.createSession(this.workspace);
                    this.sessions = [{ sessionId: s.sessionId, title: "新会话", blank: true }];
                    this.openTabs = [s.sessionId];
                    this.setSession(s.sessionId);
                    void this.applyModelMemory(s.sessionId);
                } catch (_e) { /* 极端情况：保留当前态 */ }
            }
        }
        await this.refreshSessions();
        new Notice("已归档会话（可在 DSH 网页版找回）");
    }

    // 轻量刷新：重拉列表但不打断当前会话（分叉/归档/外部变更后用）
    async refreshSessions() {
        try {
            const listed = await this.api.listSessions(this.workspace.workspaceId);
            const curEntry = this.sessions.find((x) => x.sessionId === this.sessionId);
            this.sessions = listed;
            if (curEntry && !listed.some((x) => x.sessionId === curEntry.sessionId)) this.sessions.unshift(curEntry);
            this.applyCachedTitles();
        } catch (_e) { /* 刷新失败保留现有列表 */ }
        this.renderSessionList();
        this.updateTitleBtn();
        this.renderPresetPicker();
        void this.enrichSessionsInBackground();
    }

    // v0.5.0 右侧滑出 Sheet（对齐 VSCode Sheet：0.16s 滑入 / Esc / 点遮罩关闭）
    openSheet(title, build, kind = "") {
        this.closeSheet();
        if (!this.contentEl) return;
        const overlay = this.contentEl.createDiv("dsh-sheet-overlay");
        const sheet = overlay.createDiv("dsh-sheet");
        const head = sheet.createDiv("dsh-sheet-head");
        head.createSpan("dsh-sheet-title").textContent = title;
        const close = head.createEl("button", { cls: "dsh-icon-btn dsh-sheet-close", text: "×", attr: { title: "关闭 (Esc)" } });
        close.addEventListener("click", () => this.closeSheet());
        overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) this.closeSheet(); });
        const body = sheet.createDiv("dsh-sheet-body");
        const escHandler = (e) => { if (e.key === "Escape") this.closeSheet(); };
        document.addEventListener("keydown", escHandler);
        this._sheet = { overlay, body, kind, escHandler };
        build(body);
        requestAnimationFrame(() => sheet.addClass("is-open"));
    }
    closeSheet() {
        if (!this._sheet) return;
        document.removeEventListener("keydown", this._sheet.escHandler);
        this._sheet.overlay.remove();
        this._sheet = null;
    }

    // v0.5.0 会话面板（对齐 VSCode sessions drawer：搜索 + 行操作）
    openSessionsSheet() {
        this.openSheet("会话列表", (body) => this._renderSessionsBody(body), "sessions");
        void this.enrichSessionsInBackground();
    }
    _renderSessionsBody(body) {
        body.empty();
        const search = body.createEl("input", { cls: "dsh-sheet-search", attr: { type: "text", placeholder: "搜索会话…" } });
        const list = body.createDiv("dsh-sheet-sessions");
        const render = (q) => {
            list.empty();
            const needle = (q || "").trim().toLowerCase();
            const rows = this.sessions.filter((s) => !needle || (this._tabTitle(s) || "").toLowerCase().includes(needle));
            if (!rows.length) { list.createDiv("dsh-sheet-empty").textContent = "（暂无会话）"; return; }
            for (const s of rows) {
                const id = s.sessionId;
                const row = list.createDiv("dsh-session-row" + (id === this.sessionId ? " is-current" : ""));
                const dot = row.createSpan("dsh-dot" + (s.running ? " dsh-dot-running" : " dsh-dot-idle"));
                const title = row.createSpan("dsh-session-title");
                title.textContent = this._tabTitle(s);
                if (this._unread && this._unread.has(id)) row.createSpan("dsh-unread-dot").setAttribute("title", "有新消息");
                const ren = row.createEl("button", { cls: "dsh-icon-btn dsh-icon-mini", attr: { title: "重命名" } });
                ren.textContent = "✎";
                ren.addEventListener("click", (e) => { e.stopPropagation(); this.openRenameBar(id); });
                const forkBtn = row.createEl("button", { cls: "dsh-icon-btn dsh-icon-mini", attr: { title: "分叉会话" } });
                forkBtn.textContent = "⑂";
                forkBtn.addEventListener("click", (e) => { e.stopPropagation(); this.forkSessionRow(id); });
                const arc = row.createEl("button", { cls: "dsh-icon-btn dsh-icon-mini", attr: { title: "归档（从列表隐藏，可在 DSH 网页版找回）" } });
                arc.textContent = "🗄";
                arc.addEventListener("click", (e) => { e.stopPropagation(); this.archiveSessionRow(id); });
                row.addEventListener("click", () => { this.closeSheet(); this.openSessionAsTab(id); });
            }
        };
        search.addEventListener("input", () => render(search.value));
        render("");
    }

    // v0.5.0 工作区面板（对齐 VSCode workspace drawer：真分组管理）
    async openWorkspaceSheet() {
        this.openSheet("工作区", (body) => this._renderWorkspaceBody(body), "workspace");
    }
    async _renderWorkspaceBody(body) {
        body.empty();
        body.createDiv("dsh-sheet-hint").textContent = "工作区=会话分组（按项目目录）。此处重命名/排序/删除分组，或把当前会话移入其他分组。";
        let wl;
        try { wl = await this.api.listWorkspaces(); }
        catch (e) {
            body.createDiv("dsh-sheet-empty").textContent = "读取失败：" + (e && e.message ? e.message : String(e));
            return;
        }
        const items = wl.items || [];
        const curWs = this.workspace && this.workspace.workspaceId;
        const reload = async () => {
            try {
                const fresh = await this.api.listWorkspaces();
                const me = (fresh.items || []).find((w) => w.workspaceId === curWs);
                if (me) this.workspace = me; // title/path 可能已变
            } catch (_e) { /* 保留旧值 */ }
            await this.refreshSessions();
            this._renderWorkspaceBody(body);
        };
        const guard = (label, p) => p.then(
            () => new Notice(label + "完成"),
            (e) => new Notice(label + "失败：" + (e && e.message ? e.message : String(e))),
        ).then(reload);
        // 新建行
        const newRow = body.createDiv("dsh-ws-new-row");
        const inp = newRow.createEl("input", { cls: "dsh-sheet-input", attr: { type: "text", placeholder: "新分组目录路径，如 D:\\project" } });
        const add = newRow.createEl("button", { cls: "mod-cta", text: "添加" });
        add.addEventListener("click", () => {
            const v = inp.value.trim();
            if (v) guard("工作区添加", this.api.workspaceCreate(v));
        });
        inp.addEventListener("keydown", (e) => { if (e.key === "Enter") add.click(); });
        // 工作区行
        for (let i = 0; i < items.length; i++) {
            const ws = items[i];
            const row = body.createDiv("dsh-ws-row" + (ws.workspaceId === curWs ? " is-current" : ""));
            const head = row.createDiv("dsh-ws-row-head");
            const name = head.createSpan("dsh-ws-name");
            name.textContent = (ws.title || (ws.path || "").split(/[\\/]/).filter(Boolean).pop() || "（未命名）") + (ws.workspaceId === curWs ? " ·当前" : "");
            name.title = ws.path || "";
            const cnt = head.createSpan("dsh-ws-count");
            cnt.textContent = ((ws.sessionIds || []).length) + " 会话";
            const up = head.createEl("button", { cls: "dsh-icon-btn dsh-icon-mini", text: "↑", attr: { title: "上移" } });
            up.addEventListener("click", () => { if (i > 0) guard("工作区移动", this.api.workspaceMove(ws.workspaceId, items[i - 1].workspaceId)); });
            const down = head.createEl("button", { cls: "dsh-icon-btn dsh-icon-mini", text: "↓", attr: { title: "下移" } });
            down.addEventListener("click", () => { if (i < items.length - 1) guard("工作区移动", this.api.workspaceMove(items[i + 1].workspaceId, ws.workspaceId)); });
            const ren = head.createEl("button", { cls: "dsh-icon-btn dsh-icon-mini", text: "✎", attr: { title: "重命名" } });
            ren.addEventListener("click", async () => {
                const v = await this._promptModal("重命名工作区", ws.title || "");
                if (v != null && v.trim()) guard("工作区重命名", this.api.workspaceRename(ws.workspaceId, v.trim()));
            });
            const del = head.createEl("button", { cls: "dsh-icon-btn dsh-icon-mini", text: "🗑", attr: { title: "删除分组（会话不会被删）" } });
            del.addEventListener("click", () => {
                if (!confirm("删除工作区分组「" + (ws.title || ws.path) + "」？分组内会话不会被删除。")) return;
                guard("工作区删除", this.api.workspaceDelete(ws.workspaceId));
            });
            if (ws.workspaceId !== curWs && this.sessionId) {
                const mv = head.createEl("button", { cls: "dsh-icon-btn dsh-icon-mini", text: "⇤", attr: { title: "把当前会话移入此分组" } });
                mv.addEventListener("click", () => guard("会话移组", this.api.workspaceMoveSession(this.sessionId, ws.workspaceId)));
            }
        }
        if (!items.length) body.createDiv("dsh-sheet-empty").textContent = "（暂无工作区）";
    }

    // v0.5.0 通用单行输入弹窗（工作区重命名等）
    _promptModal(title, initial) {
        return new Promise((resolve) => {
            const modal = new Modal(this.app);
            modal.titleEl.setText(title);
            const inp = modal.contentEl.createEl("input", { cls: "dsh-sheet-input", attr: { type: "text" } });
            inp.value = initial || "";
            const row = modal.contentEl.createDiv("dsh-modal-row");
            const ok = row.createEl("button", { cls: "mod-cta", text: "保存" });
            ok.addEventListener("click", () => { modal.close(); resolve(inp.value); });
            const cancel = row.createEl("button", { text: "取消" });
            cancel.addEventListener("click", () => { modal.close(); resolve(null); });
            inp.addEventListener("keydown", (e) => {
                if (e.key === "Enter") { modal.close(); resolve(inp.value); }
                else if (e.key === "Escape") { modal.close(); resolve(null); }
            });
            modal.open();
            inp.focus();
        });
    }

    // v0.6.0 子代理面板（对齐 VSCode subs drawer：目录 + 回放 + 追问 + 打断）
    async openSubagentsSheet() {
        this.openSheet("子代理", (body) => this._renderSubagentsBody(body), "subs");
    }
    async _renderSubagentsBody(body) {
        body.empty();
        if (!this.sessionId) { body.createDiv("dsh-sheet-empty").textContent = "（先选择一个会话）"; return; }
        let subs;
        try { subs = await this.api.listSubagents(this.sessionId); }
        catch (e) { body.createDiv("dsh-sheet-empty").textContent = "读取失败：" + (e && e.message ? e.message : String(e)); return; }
        if (!subs.length) { body.createDiv("dsh-sheet-empty").textContent = "（当前会话还没有子代理）"; return; }
        for (const sa of subs) {
            const row = body.createDiv("dsh-sub-row");
            row.createSpan("dsh-dot" + (sa.running ? " dsh-dot-running" : " dsh-dot-idle"));
            const t = row.createSpan("dsh-sub-title");
            t.textContent = sa.title;
            const view = row.createEl("button", { cls: "dsh-icon-btn dsh-icon-mini", text: "›", attr: { title: "查看对话" } });
            view.addEventListener("click", () => this._renderSubagentTranscript(body, sa));
            row.addEventListener("click", () => this._renderSubagentTranscript(body, sa));
        }
    }
    async _renderSubagentTranscript(body, sa) {
        body.empty();
        const back = body.createDiv("dsh-sub-back");
        back.textContent = "‹ 返回目录";
        back.addEventListener("click", () => this._renderSubagentsBody(body));
        const head = body.createDiv("dsh-sub-head");
        head.createSpan("dsh-dot" + (sa.running ? " dsh-dot-running" : " dsh-dot-idle"));
        head.createSpan("dsh-sub-title").textContent = sa.title;
        if (sa.running) {
            const stop = head.createEl("button", { cls: "dsh-icon-btn dsh-icon-mini dsh-sub-stop", text: "■", attr: { title: "打断子代理" } });
            stop.addEventListener("click", () => {
                this.api.subagentInterrupt(sa.sessionId).then(
                    () => new Notice("已请求打断子代理"),
                    (e) => new Notice("打断失败：" + (e && e.message ? e.message : String(e))),
                ).then(() => this._renderSubagentTranscript(body, sa));
            });
        }
        const list = body.createDiv("dsh-sub-transcript");
        let events;
        try {
            const h = await this.api.getHistory(sa.sessionId, null, 100);
            events = (h.events || []).map((r) => r.event || r);
        } catch (e) { list.createDiv("dsh-sheet-empty").textContent = "对话读取失败"; return; }
        const fold = new DshFold();
        fold.pushMany(events);
        for (const it of fold.items) {
            if (it.kind === "user") {
                const ub = list.createDiv("dsh-msg dsh-msg-user");
                const uc = ub.createDiv("dsh-msg-content");
                uc.textContent = it.text || ""; // 面板内纯文本渲染（不经主容器/去重管线）
            } else {
                const bubble = list.createDiv("dsh-msg dsh-msg-assistant");
                bubble.createDiv("dsh-msg-role").textContent = "DSH";
                const content = bubble.createDiv("dsh-msg-content");
                this.renderFoldSegments(content, it);
            }
        }
        if (!fold.items.length) list.createDiv("dsh-sheet-empty").textContent = "（无对话内容）";
        // 追问输入
        const bar = body.createDiv("dsh-sub-ask");
        const inp = bar.createEl("input", { cls: "dsh-sheet-input", attr: { type: "text", placeholder: "向子代理追加指令…" } });
        const send = bar.createEl("button", { cls: "mod-cta", text: "发送" });
        const ask = () => {
            const v = inp.value.trim();
            if (!v) return;
            send.disabled = true;
            this.api.subagentPrompt(sa.sessionId, v).then(
                () => { new Notice("已发送给子代理"); setTimeout(() => this._renderSubagentTranscript(body, sa), 800); },
                (e) => { send.disabled = false; new Notice("追问失败：" + (e && e.message ? e.message : String(e))); },
            );
        };
        send.addEventListener("click", ask);
        inp.addEventListener("keydown", (e) => { if (e.key === "Enter") ask(); });
    }

    // v0.6.0 服务器设置表单（对齐 VSCode SettingsSheet：describe schema 驱动，按命名空间保存）
    async openSettingsSheet() {
        this.openSheet("服务器设置", (body) => this._renderSettingsBody(body), "settings");
    }
    async _renderSettingsBody(body) {
        body.empty();
        let data;
        try { data = await this.api.describeSettings(); }
        catch (e) { body.createDiv("dsh-sheet-empty").textContent = "读取失败：" + (e && e.message ? e.message : String(e)); return; }
        const namespaces = (data && data.namespaces) || [];
        if (!namespaces.length) { body.createDiv("dsh-sheet-empty").textContent = "（该服务器未开放设置描述）"; return; }
        if (data.writable === false) body.createDiv("dsh-sheet-hint").textContent = "⚠️ 服务器标记为只读，保存会被拒绝。";
        for (const ns of namespaces) {
            // alpha.5 真实形状：字段表在 schema.refs[schema.uid].dict，当前值在 value/user，密钥标记在 secrets
            const refs = (ns.schema && ns.schema.refs) || {};
            const root = ns.schema ? refs[ns.schema.uid] : null;
            const dict = (root && root.dict) || {};
            const fields = Object.entries(dict)
                .map(([field, refId]) => ({ field, ref: refs[refId] || refs[String(refId)] }))
                .filter((f) => f && f.ref);
            if (!fields.length) continue;
            const secrets = new Set(ns.secrets || []);
            const det = body.createEl("details", { cls: "dsh-settings-ns" });
            det.createEl("summary").textContent = ns.ns || "（命名空间）";
            const holder = det.createDiv("dsh-settings-fields");
            const edits = {};
            const dirty = () => Object.keys(edits).length > 0;
            const saveBtn = holder.createEl("button", { cls: "mod-cta dsh-settings-save", text: "保存", attr: { disabled: "true" } });
            saveBtn.addEventListener("click", () => {
                if (!dirty()) return;
                this.api.saveSetting(ns.ns, { ...edits }, ns.revision).then(
                    () => { new Notice("已保存：" + ns.ns); this._renderSettingsBody(body); },
                    (e) => new Notice("保存失败：" + (e && e.message ? e.message : String(e))),
                );
            });
            for (const { field, ref } of fields) {
                const cur = (ns.user && ns.user[field] !== undefined) ? ns.user[field]
                    : (ns.value && ns.value[field] !== undefined) ? ns.value[field]
                    : (ref.meta && ref.meta.default);
                const row = holder.createDiv("dsh-settings-row");
                const lab = row.createSpan("dsh-settings-label");
                lab.textContent = field + (secrets.has(field) ? " 🔒" : "");
                lab.title = (ref.meta && ref.meta.description) || "";
                const isSecret = secrets.has(field);
                let input;
                if (typeof cur === "boolean") {
                    input = row.createEl("input", { cls: "toggle", attr: { type: "checkbox" } });
                    input.checked = !!cur;
                    input.addEventListener("change", () => { edits[field] = input.checked; saveBtn.toggleAttribute("disabled", !dirty()); });
                } else if (typeof cur === "number") {
                    input = row.createEl("input", { attr: { type: "number" } });
                    input.value = String(cur);
                    input.addEventListener("input", () => { edits[field] = Number(input.value); saveBtn.toggleAttribute("disabled", !dirty()); });
                } else {
                    input = row.createEl("input", { attr: { type: isSecret ? "password" : "text" } });
                    input.value = cur == null ? "" : String(cur);
                    input.addEventListener("input", () => { edits[field] = input.value; saveBtn.toggleAttribute("disabled", !dirty()); });
                }
            }
        }
    }

    toggleSessionList(force) {
        // v0.5.0：会话列表迁移为右侧 Sheet；旧调用点语义不变（false=收起）
        if (force === false) this.closeSheet();
        else this.openSessionsSheet();
    }

    renderSessionList() {
        // v0.5.0：会话 Sheet 打开时刷新其内容（未读徽标/列表变化）
        if (this._sheet && this._sheet.kind === "sessions") this._renderSessionsBody(this._sheet.body);
    }

    updateTitleBtn() {
        if (!this.titleText) return;
        const s = this.sessions.find((x) => x.sessionId === this.sessionId);
        if (!s) { this.titleText.textContent = this.sessionId ? "新会话" : "—"; return; }
        const t = this._resolveTitle(s);
        this.titleText.textContent = t || (s.blank ? "新会话" : "（未命名会话）"); // 对齐 VSCode 标题按钮兜底
    }

    // 重命名会话（对齐 VSCode .rename-bar：标题按钮 ✎ / 双击标题 打开输入框，Enter 保存）
    openRenameBar(id) {
        const sid = id || this.sessionId;
        if (!sid) return;
        const s = this.sessions.find((x) => x.sessionId === sid);
        if (!s) return;
        this.closeRenameBar();
        if (!this.header) return;
        const bar = this.header.createDiv("dsh-rename-bar");
        this._renameBar = bar;
        const cur = this._tabTitle(s);
        const input = bar.createEl("input", { cls: "dsh-rename-input", type: "text" });
        input.placeholder = "会话标题…";
        input.value = (cur === "新会话" || cur === "未命名" || cur === "—") ? "" : cur;
        const save = bar.createEl("button", { cls: "dsh-btn mod-cta", text: "保存" });
        const cancel = bar.createEl("button", { cls: "dsh-btn", text: "取消" });
        const commit = async () => {
            const v = input.value.trim();
            if (v && v !== cur) {
                try {
                    await this.api.renameSession(sid, v);
                    s.title = v;
                    // 持久化本地覆盖：无论 DSH 是否回写 title 投影，重启后都按手动名显示
                    if (this.plugin && this.plugin.settings) {
                        this.plugin.settings.manualTitles = this.plugin.settings.manualTitles || {};
                        this.plugin.settings.manualTitles[sid] = v;
                        this.plugin.saveSettings();
                    }
                    new Notice("已重命名会话");
                    this.updateTitleBtn();
                    this.renderSessionList();
                } catch (e) {
                    new Notice("重命名失败：" + (e && e.message ? e.message : String(e)));
                }
            }
            this.closeRenameBar();
        };
        save.addEventListener("click", () => { commit(); });
        cancel.addEventListener("click", () => this.closeRenameBar());
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") { e.preventDefault(); commit(); }
            else if (e.key === "Escape") { e.preventDefault(); this.closeRenameBar(); }
        });
        input.focus();
        input.select();
    }
    closeRenameBar() {
        if (this._renameBar) { this._renameBar.remove(); this._renameBar = null; }
    }

    openSessionAsTab(id) {
        if (!this.openTabs) this.openTabs = [];
        if (!this.openTabs.includes(id)) {
            this.openTabs.push(id);
            // 超过 6 个标签回收最旧（最左）
            while (this.openTabs.length > 6) this.openTabs.shift();
        }
        // v0.4.0 打开即清未读
        if (this._unread && this._unread.delete(id)) this.renderSessionList();
        // 已是当前会话：不重建 DOM（否则会销毁正在双击的 label，导致 dblclick 收不到）
        if (id === this.sessionId) return;
        this.setSession(id);
        this.renderSessionList();
    }

    setSession(id) {
        this.sessionId = id;
        this.clearConversation();
        // 清空待处理审批
        this.pending.clear();
        // Phase B：切换会话重置 / 技能菜单缓存（skill.list 按会话返回）
        this._slashCache = null;
        this._slashErr = null;
        if (this._slashPopup) this.hideSlashPopup();
        // Phase E：切换会话重置 plan/todos 投影状态，避免上一个会话的横幅残留
        this._planActive = false;
        this._todos = null;
        this._todoOpen = false;
        this.renderPlanStrip();
        // Phase F：切换会话清空排队条
        if (this.queueStrip) this.queueStrip.style.display = "none";
        this.setStatus("online");
        // 会话切换后重新拉模型目录 + 权限（投影 + settings.describe 双通道）
        this.loadModels();
        this.loadPermissions();
        // 渲染该会话的历史消息（对齐 VSCode/Claudian：切到会话即看到完整对话）
        this.loadHistory(id);
        this.updateTitleBtn();
        this.renderPresetPicker();
        // v012：会话事件必须显式 follow 才推送（legacy 全广播，此调用无副作用）
        if (this.plugin && this.plugin.wsFollow) this.plugin.wsFollow(id);
    }

    async switchSession(id) {
        this.openSessionAsTab(id);
    }

    openHistory() {
        try { new HistoryModal(this.app, this).open(); }
        catch (e) { new Notice("打开历史会话失败：" + (e && e.message ? e.message : String(e))); }
    }

    async newSession() {
        const s = await this.api.createSession(this.workspace);
        this.sessions.unshift({ sessionId: s.sessionId, title: "新会话", blank: true });
        this.openSessionAsTab(s.sessionId);
        this.updateTitleBtn();
        void this.applyModelMemory(s.sessionId);
    }

    // v0.5.2 对齐：新建会话时主动应用本工作区记忆的默认模型（宿主原生行为是全局最近一次
    // 会话的模型，并行项目会互相污染）；模型下架导致应用失败 → 清记忆自愈
    async applyModelMemory(sessionId) {
        try {
            const wsId = this.workspace && this.workspace.workspaceId;
            const mem = wsId && this.plugin.settings.modelMemory ? this.plugin.settings.modelMemory[wsId] : null;
            if (!mem || !mem.provider || !mem.model) { return; }
            await this.api.selectModel(sessionId, mem.provider, mem.model);
            this.loadModels(); // 让当前下拉反映应用后的值
        } catch (_e) {
            const wsId = this.workspace && this.workspace.workspaceId;
            if (wsId && this.plugin.settings.modelMemory) {
                delete this.plugin.settings.modelMemory[wsId];
                try { await this.plugin.saveSettings(); } catch (_e2) {}
            }
        }
    }

    /* ---------- 模式 / 模型 / 权限 ---------- */
    _applyModeUi(mode) {
        if (!this.modeBtn) return;
        const isQueue = mode !== "steer";
        this.modeBtn.textContent = isQueue ? "排队" : "引导"; // 文案与已装 VSCode 0.5.1 完全一致（排队/引导）
        this.modeBtn.classList.toggle("is-on", !isQueue); // steer = 激活态（对齐 VSCode）
        this.modeBtn.setAttribute("aria-pressed", (!isQueue).toString());
        // 引导（steer）模式：输入框青色边，作为「计划待确认」的可视化信号（对齐 Claudian）
        if (this.inputEl) this.inputEl.classList.toggle("is-steer", !isQueue);
    }
    async setMode(mode) {
        if (mode !== "queue" && mode !== "steer") return;
        this._applyModeUi(mode);
        if (this.plugin && this.plugin.settings) {
            this.plugin.settings.mode = mode;
            try { await this.plugin.saveSettings(); } catch (_e) {}
        }
    }
    /* ---------- Agent 模式（agentPreset，对齐 VSCode PresetPicker） ---------- */
    renderPresetPicker() {
        if (!this.presetSlot) return;
        this.presetSlot.empty();
        const list = (this._presets && Array.isArray(this._presets.presets)) ? this._presets.presets : [];
        if (list.length === 0) return; // 无目录则整个部件不出现（同 VSCode）
        const s = this.sessions.find((x) => x.sessionId === this.sessionId);
        const active = (s && s.agentPreset) || (list.find((p) => p.isDefault) || {}).id || "标准";
        const activeLabel = ((list.find((p) => p.id === active) || {}).name) || active;
        // DSH 在首轮后锁定组装（agent-preset-locked）：非空白会话只展示 🔒 徽标
        if (!s || !s.blank) {
            const chip = this.presetSlot.createSpan("dsh-chip-btn is-locked");
            chip.textContent = "🔒 " + activeLabel;
            chip.setAttribute("title", "会话已发过消息，模式已固定");
            return;
        }
        const sel = this.presetSlot.createEl("select", { cls: "dsh-chip-btn dsh-preset-select" });
        sel.setAttribute("title", "Agent 模式（发消息前可切换，发出后固定）");
        for (const p of list) {
            const o = sel.createEl("option", { value: p.id });
            o.textContent = (p.name || p.id)
                + (p.isDefault ? "（默认）" : "")
                + (p.broken ? "（不可用：" + String(p.broken).slice(0, 30) + "）" : "");
            if (p.broken) o.disabled = true;
            if (p.id === active) o.selected = true;
        }
        sel.addEventListener("change", () => {
            const v = sel.value;
            if (!v || v === active) return;
            this.applyAgentPreset(v);
        });
    }
    async applyAgentPreset(presetId) {
        if (!this.sessionId) return;
        try {
            await this.api.selectAgentPreset(this.sessionId, presetId);
            const s = this.sessions.find((x) => x.sessionId === this.sessionId);
            if (s) s.agentPreset = presetId;
            new Notice("已切换 Agent 模式：" + presetId);
            this.loadModels(); // 模型目录可能随 preset 变化
        } catch (e) {
            const msg = e && e.message ? e.message : String(e);
            if (msg.includes("agent-preset-locked")) new Notice("会话已发过消息，模式已固定，不能切换（新建会话可选）");
            else new Notice("切换模式失败：" + msg);
        }
        this.renderPresetPicker();
    }

    async loadModels() {
        if (!this.sessionId || !this.modelSelect) return;
        try {
            // DSH 真实结构：{ current:{provider,model,reasoningEffort?}, groups:[{id, name, models:[{id, name, description?, reasoning?: {efforts, defaultEffort}}]}] }
            // 不是扁平的 models:[]，所以必须从 groups[].models[] 平铺出来。
            const r = await this.api.getModels(this.sessionId);
            this._currentModels = r;
            const groups = Array.isArray(r && r.groups) ? r.groups : [];
            const current = r && r.current;

            this.modelSelect.empty();
            let flatCount = 0;
            for (const g of groups) {
                const models = Array.isArray(g && g.models) ? g.models : [];
                if (models.length === 0) continue;
                // 用 <optgroup> 把不同 provider 分组显示（对齐 VSCode DSH 弹层体验）
                const og = this.modelSelect.createEl("optgroup");
                og.label = g.name || g.id || g.provider || "未知分组";
                for (const m of models) {
                    // 优先从 m.id 解析 provider（DSH 用 "provider/model" 格式），其次 m.provider
                    let provider = m.provider || "";
                    let model = m.model || "";
                    if ((!provider || !model) && typeof m.id === "string" && m.id.includes("/")) {
                        const idx = m.id.indexOf("/");
                        provider = provider || m.id.slice(0, idx);
                        model = model || m.id.slice(idx + 1);
                    } else if (!model && typeof m.id === "string") {
                        // m.id 是规范模型 id（如 deepseek-v4-flash，小写）。优先用它而非 m.name（大写 DeepSeek-V4-Flash），
                        // 否则把大写 id 发给后端、转发到 LLM API 时会被 400 拒绝（见下方 autoCorrectModel）。
                        model = m.id;
                    }
                    if (!model) model = m.name || "";
                    provider = provider || g.id || "";
                    if (!provider || !model) continue;
                    const effort = m.reasoning && m.reasoning.defaultEffort ? m.reasoning.defaultEffort : "";
                    // 选项文本 = 提供方 / 模型（对齐 VSCode chip 显示 provider/model，无冗余描述）
                    const provName = g.name || g.id || provider;
                    const label = provName + "/" + (m.name || model); // 与 VSCode 同款「提供方/模型」无空格
                    const opt = og.createEl("option", {
                        value: provider + "::" + model + (effort ? "::" + effort : "")
                    });
                    opt.textContent = label;
                    // 大小写不敏感匹配当前模型，避免规范 id 与 current.model 大小写不一致时无法选中
                    if (current && current.provider === provider && (current.model || "").toLowerCase() === model.toLowerCase()) {
                        opt.selected = true;
                    }
                    flatCount++;
                }
            }
            // 自动纠正默认模型大小写：harness 给新会话的默认模型常是大写（如 DeepSeek-V4-Flash），
            // 但 LLM API 只接受小写规范 id（deepseek-v4-flash），不纠正会让每次 prompt 被 400 拒绝、新会话“不回复”。
            // 加载模型后静默把它纠正为规范 id；已正确则跳过（不会循环触发）。
            if (current && current.provider && current.model) {
                const g = groups.find((gg) => gg.id === current.provider || gg.provider === current.provider);
                const provName = (g && (g.name || g.id)) || current.provider;
                // (chip 已移除：下拉框当前选中项的 "提供方 / 模型" 文本本身已是当前值指示)

                const mm = g && Array.isArray(g.models) ? g.models.find((x) => (x.id || "").toLowerCase() === current.model.toLowerCase()) : null;
                const canonical = mm && mm.id;
                if (canonical && canonical !== current.model) {
                    // 记录纠正 promise，send() 会 await 它，避免用户极快发送时 prompt 抢在纠正之前、仍用错误模型
                    this._modelFixPromise = this.api.selectModel(this.sessionId, current.provider, canonical, current.reasoningEffort || undefined)
                        .then(() => { /* 纠正成功，后续 prompt 即用正确模型 */ })
                        .catch(() => { /* 忽略，下拉仍可手选 */ });
                } else {
                    this._modelFixPromise = null;
                }
            }
            if (flatCount === 0) {
                // 真没目录时给个提示，仍展示 current 让用户至少看到当前值
                const o = this.modelSelect.createEl("option", { value: "" });
                o.textContent = current
                    ? ((current.provider || "") + "/" + (current.model || "") + "（无目录）")
                    : "未发现模型目录";
                this.modelSelect.disabled = true;
            } else {
                this.modelSelect.disabled = false;
            }
            // 思考强度下拉跟随当前模型（对齐 VSCode EffortPicker）
            this.renderEfforts(current, groups);
            // v0.5.2 对齐：本项目真实会话（非空白）的当前模型也作为工作区记忆来源
            const wsId = this.workspace && this.workspace.workspaceId;
            if (wsId && current && current.provider && current.model && this.plugin.settings.modelMemory) {
                const sRow = this.sessions.find((x) => x.sessionId === this.sessionId);
                if (sRow && !sRow.blank) {
                    const mem = this.plugin.settings.modelMemory[wsId];
                    if (!mem || mem.provider !== current.provider || mem.model !== current.model) {
                        this.plugin.settings.modelMemory[wsId] = { provider: current.provider, model: current.model };
                        try { await this.plugin.saveSettings(); } catch (_e) {}
                    }
                }
            }
        } catch (_e) {
            this.modelSelect.empty();
            const o = this.modelSelect.createEl("option", { value: "" });
            o.textContent = "模型加载失败";
            this.modelSelect.disabled = true;
            if (this.effortSelect) this.effortSelect.style.display = "none";
        }
    }
    renderEfforts(current, groups) {
        if (!this.effortSelect) return;
        let efforts = [];
        if (current) {
            // 与 VSCode 同款：按 provider 先匹配（同一 model id 可能出现在多个 provider 下，
            // 别处的同名模型可能带 reasoning 而当前的没有，取错会让切换被服务端拒绝）
            const own = (groups || []).find((g) => g.id === current.provider || g.provider === current.provider);
            const hit = own && Array.isArray(own.models)
                ? own.models.find((x) => (x.id || "").toLowerCase() === (current.model || "").toLowerCase())
                : null;
            efforts = hit && hit.reasoning && Array.isArray(hit.reasoning.efforts) ? hit.reasoning.efforts : [];
        }
        this.effortSelect.empty();
        if (!current || efforts.length === 0) { this.effortSelect.style.display = "none"; return; }
        if (!current.reasoningEffort) {
            const ph = this.effortSelect.createEl("option", { value: "" });
            ph.textContent = "思考强度…";
        }
        for (const ef of efforts) {
            const o = this.effortSelect.createEl("option", { value: ef.id });
            o.textContent = ef.name || ef.id;
            if (current.reasoningEffort && ef.id === current.reasoningEffort) o.selected = true;
        }
        this.effortSelect.title = "思考强度";
        this.effortSelect.disabled = false;
        this.effortSelect.style.display = "";
    }
    async switchModel(provider, model, effort) {
        if (!this.sessionId) return;
        try {
            const rpcResult = await this.api.selectModel(this.sessionId, provider, model, effort);
            new Notice("已切换模型：" + provider + "/" + model);
            // v0.5.2 对齐：手动切模型 → 记入本工作区记忆（新会话只继承本项目的，不吃宿主全局最近值）
            const wsId = this.workspace && this.workspace.workspaceId;
            if (wsId && this.plugin.settings.modelMemory) {
                this.plugin.settings.modelMemory[wsId] = { provider, model };
                try { await this.plugin.saveSettings(); } catch (_e) {}
            }
            // 重拉目录：不同模型的 reasoning.efforts 不同，思考强度下拉要跟随
            await this.loadModels();
        } catch (e) {
            new Notice("切换模型失败：" + (e && e.message ? e.message : String(e)));
            // 失败后回滚下拉（重拉）
            await this.loadModels();
        }
    }
    async loadPermissions() {
        if (!this.permSelect) return;
        try {
            const r = await this.api.getPermissionPreset();
            const presets = Array.isArray(r.presets) ? r.presets : [];
            const cur = r.value;
            this._permRevision = r.revision;
            this.permSelect.empty();
            if (presets.length === 0) {
                // 没枚举到选项：单值展示 + 不可切换
                const opt = this.permSelect.createEl("option", { value: cur || "" });
                opt.textContent = cur || "未配置";
                this.permSelect.disabled = true;
            } else {
                for (const p of presets) {
                    const opt = this.permSelect.createEl("option", { value: p.id });
                    opt.textContent = p.label || p.id;
                    if (p.id === cur) opt.selected = true;
                }
                this.permSelect.disabled = false;
            }
        } catch (_e) {
            this.permSelect.empty();
            const opt = this.permSelect.createEl("option", { value: "" });
            opt.textContent = "加载失败";
            this.permSelect.disabled = true;
        }
    }
    async switchPermission() {
        const target = this.permSelect.value;
        if (!target || !this.sessionId) return;
        try {
            // 对齐 VSCode：会话级权限经 /permission 命令立即生效（settings.defaultPreset 只影响未来会话，
            // 旧实现写全局值却显示会话值，语义是拧的）
            const r = await this.api.executeCommand(this.sessionId, "/permission " + target);
            if (!r) { new Notice("当前主机没有 /permission 命令"); return; }
            if (r.result && r.result.kind === "error") {
                new Notice("权限切换被拒绝：" + (r.result.text || ""));
                return;
            }
            new Notice("已切换权限预设（当前会话）：" + target);
            // 写完后 DSH 会推 projection 更新当前值；不主动 reload，避免抢投影
        } catch (e) {
            new Notice("切换权限失败：" + (e && e.message ? e.message : String(e)));
            // 失败回滚：重拉
            await this.loadPermissions();
        }
    }

    clearConversation() {
        this._stopPoll();
        this._turnDone = true; // 切会话即终止上一个 turn 的轮询
        // 修复：切换/新建会话必须把「运行中」状态连同实时活动条一并归零，
        // 否则旧会话正在跑的任务会让新会话误显示「正在执行」（运行态属会话内部，不能跨会话泄漏）
        this._running = false;
        this.clearLiveBar();
        if (this.messagesEl) this.messagesEl.empty();
        if (this.statusLine) this.statusLine.setText("");
        this.assistantEl = null;
        this.assistantContent = null;
        this.assistantMd = "";
        this.thinkingMd = "";
        this._contentSetByWs = false;
        // 重置工具/子代理活动跟踪（Bug 4）
        this._activities = new Map();
        this._activityHolder = null;
        // 切换会话清空已发送用户文本去重集合，避免跨会话泄漏导致历史消息被误删
        this._userTextsSent = new Set();
        // 切换会话重置 WS catchup 标志，新会话的历史加载会重新设置
        this._wsCatchup = false;
        this._lastHistorySeq = null;
        // 取消待执行的对账定时器
        if (this._reconcileTimer) { clearTimeout(this._reconcileTimer); this._reconcileTimer = null; }
    }

    setStatus(state) {
        if (!this.statusDot) return;
        this.statusDot.className = "dsh-status-dot " + (state === "online" ? "online" : state === "connecting" ? "connecting" : "offline");
    }

    /* ---------- Phase 6：附件 + @ 文件补全 + 图片粘贴 ---------- */
    // 发送按钮可用态：有文本或附件才启用
    updateSendState() {
        if (!this.sendBtn) return;
        // v0.4.0 运行中=红色停止键（对齐 VSCode send-fab 红方块形态）
        if (this._running) {
            this.sendBtn.textContent = "■";
            this.sendBtn.setAttribute("title", "停止 (Esc)");
            this.sendBtn.setAttribute("aria-label", "停止");
            this.sendBtn.disabled = false;
            this.sendBtn.classList.add("is-stop");
            this.sendBtn.classList.remove("is-disabled");
            return;
        }
        this.sendBtn.textContent = "➤";
        this.sendBtn.setAttribute("title", "发送 (Enter)");
        this.sendBtn.setAttribute("aria-label", "发送");
        this.sendBtn.classList.remove("is-stop");
        const hasText = this.inputEl && this.inputEl.value.trim().length > 0;
        const hasAtt = this._attachments && this._attachments.length > 0;
        const enabled = !!(hasText || hasAtt);
        this.sendBtn.disabled = !enabled;
        this.sendBtn.classList.toggle("is-disabled", !enabled);
    }

    // v0.4.0 运行计时（对齐 VSCode Elapsed）：turn/start 起表、turn/end 停表，显示在 composer-meta
    startElapsed() {
        this._elapsedSec = 0;
        this.stopElapsed();
        this.updateComposerMeta();
        this._elapsedTimer = setInterval(() => {
            this._elapsedSec = (this._elapsedSec || 0) + 1;
            this.updateComposerMeta();
        }, 1000);
    }
    stopElapsed() {
        if (this._elapsedTimer) { clearInterval(this._elapsedTimer); this._elapsedTimer = null; }
    }
    _elapsedText() {
        if (!this._running || !this._elapsedSec) return "";
        const s = this._elapsedSec;
        return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}`;
    }

    renderAttachments() {
        const box = this.attachmentsEl;
        if (!box) return;
        box.empty();
        const atts = this._attachments || [];
        if (!atts.length) { box.style.display = "none"; this.updateSendState(); return; }
        box.style.display = "flex";
        for (let i = 0; i < atts.length; i++) {
            const a = atts[i];
            const chip = box.createDiv("dsh-atchip");
            const label = chip.createSpan("dsh-atchip-label");
            label.textContent = a.kind === "file"
                ? ("📄 " + a.file.name)
                : a.kind === "image"
                    ? ("🖼️ " + (a.part.name || "图片"))
                    : ("📝 " + (a.path ? a.path + " 选区" : "选区"));
            const x = chip.createSpan("dsh-atchip-x");
            x.textContent = "×";
            x.addEventListener("click", () => {
                this._attachments.splice(i, 1);
                this.renderAttachments();
            });
        }
        this.updateSendState();
    }

    addAttachmentFile(file) {
        if (!this._attachments) this._attachments = [];
        if (this._attachments.some((a) => a.kind === "file" && a.file.path === file.path)) return; // 去重
        this._attachments.push({ kind: "file", file });
        this.renderAttachments();
    }

    addAttachmentImage(part) {
        if (!this._attachments) this._attachments = [];
        this._attachments.push({ kind: "image", part });
        this.renderAttachments();
    }

    // Phase D：把 Obsidian 活动编辑器选区作为「真实内容块」加入输入框
    // （区别于 @ 假引用：选区文本会被实际嵌入 prompt；无选区时退回整文件 file part）
    addAttachmentSelection(text, path) {
        if (!this._attachments) this._attachments = [];
        const t = (text || "").trim();
        if (!t) return;
        if (this._attachments.some((a) => a.kind === "selection" && a.text === t)) return; // 去重
        this._attachments.push({ kind: "selection", text: t, path: path || null });
        this.renderAttachments();
    }

    // Phase D：Alt+K 等价操作——抓取活动编辑器选区或整文件，作为内容块加入输入框
    // 用户可继续输入，随下一条消息一起发送（与 @/图片 同模型）
    attachActiveContext() {
        const ws = this.app && this.app.workspace;
        if (!ws) return;
        const file = ws.getActiveFile();
        const editor = ws.activeEditor;
        const sel = (editor && editor.getSelection && editor.getSelection && editor.getSelection()) || "";
        if (sel.trim()) {
            this.addAttachmentSelection(sel, file ? file.path : null);
            new Notice("已加入选区作为内容块");
        } else if (file) {
            this.addAttachmentFile(file);
            new Notice("已加入文件：" + file.path);
        } else {
            new Notice("没有打开的笔记或选区");
            return;
        }
        if (this.inputEl) this.inputEl.focus();
    }

    buildPromptParts(text, attachments) {
        const parts = [{ type: "text", text: text || "" }];
        const vaultRoot = (this.plugin && this.plugin.getVaultPath && this.plugin.getVaultPath()) || "";
        for (const a of (attachments || [])) {
            if (a.kind === "file") {
                const f = a.file;
                const abs = vaultRoot ? (vaultRoot.replace(/\/$/, "") + "/" + f.path) : f.path;
                parts.push({ type: "file", path: abs, rel: f.path });
            } else if (a.kind === "image") {
                parts.push(a.part);
            } else if (a.kind === "selection") {
                // 选区文本作为真实内容块嵌入（带来源标注，便于 DSH 区分上下文与指令）
                const label = a.path ? `引用 ${a.path} 选区` : "引用选区";
                parts.push({ type: "text", text: `\n\n--- ${label} ---\n${a.text}\n--- 选区结束 ---\n` });
            }
        }
        return parts;
    }

    buildUserBubbleText(text, attachments) {
        let s = (text || "").trim();
        if (attachments && attachments.length) {
            const names = attachments.map((a) => a.kind === "file" ? ("📄 " + a.file.name)
                : a.kind === "image" ? ("🖼️ " + (a.part.name || "图片"))
                    : ("📝 " + (a.path ? a.path + " 选区" : "选区")));
            s += (s ? "\n\n" : "") + "📎 " + names.join("、");
        }
        return s || "（空消息 + 附件）";
    }

    /* @ 文件补全 */
    ensureVaultMdFiles() {
        if (!this._vaultMdFiles && this.app && this.app.vault) {
            try { this._vaultMdFiles = this.app.vault.getMarkdownFiles().slice(); }
            catch (_e) { this._vaultMdFiles = []; }
        }
        return this._vaultMdFiles || [];
    }

    updateAtTrigger() {
        const ta = this.inputEl;
        if (!ta) return;
        const pos = ta.selectionStart;
        const before = ta.value.slice(0, pos);
        const m = before.match(/(?:^|\s)@([^\s@]*)$/);
        if (!m) { if (this._atPopup && this._atPopup.isVisible) this.hideAtPopup(); return; }
        this.showAtPopup(m[1]);
    }

    showAtPopup(query) {
        const files = this.ensureVaultMdFiles();
        const q = (query || "").toLowerCase();
        const matched = files
            .filter((f) => !q || f.path.toLowerCase().includes(q))
            .sort((a, b) => a.path.length - b.path.length)
            .slice(0, 50);
        let popup = this._atPopup;
        if (!popup) {
            const el = this.inputEl.parentElement.createDiv("dsh-at-popup");
            el.style.display = "none";
            popup = this._atPopup = { el, items: [], index: 0, isVisible: false };
        }
        if (!matched.length) {
            popup.el.empty();
            const empty = popup.el.createDiv("dsh-at-empty");
            empty.textContent = "无匹配文件";
            popup.items = [];
            popup.index = 0;
            popup.el.style.display = "block";
            popup.isVisible = true;
            return;
        }
        popup.el.empty();
        popup.items = matched;
        popup.index = 0;
        for (let i = 0; i < matched.length; i++) {
            const f = matched[i];
            const item = popup.el.createDiv("dsh-at-item");
            item.textContent = f.path;
            item.addEventListener("mousedown", (ev) => { ev.preventDefault(); this.selectAtFile(f); });
            if (i === 0) item.addClass("is-active");
        }
        popup.el.style.display = "block";
        popup.isVisible = true;
    }

    hideAtPopup() {
        if (this._atPopup) { this._atPopup.el.style.display = "none"; this._atPopup.isVisible = false; }
    }

    highlightAtItem() {
        if (!this._atPopup) return;
        const items = this._atPopup.el.querySelectorAll(".dsh-at-item");
        items.forEach((el, i) => el.toggleClass("is-active", i === this._atPopup.index));
    }

    handleAtKeydown(e) {
        const p = this._atPopup;
        if (!p || !p.isVisible) return false;
        if (e.key === "ArrowDown") {
            e.preventDefault();
            p.index = Math.min(p.index + 1, p.items.length - 1);
            this.highlightAtItem();
            return true;
        }
        if (e.key === "ArrowUp") {
            e.preventDefault();
            p.index = Math.max(p.index - 1, 0);
            this.highlightAtItem();
            return true;
        }
        if (e.key === "Enter" || e.key === "Tab") {
            e.preventDefault();
            if (p.items.length) this.selectAtFile(p.items[p.index]);
            return true;
        }
        if (e.key === "Escape") {
            e.preventDefault();
            this.hideAtPopup();
            return true;
        }
        return false;
    }

    selectAtFile(file) {
        const ta = this.inputEl;
        const pos = ta.selectionStart;
        const val = ta.value;
        const before = val.slice(0, pos);
        const atIdx = before.lastIndexOf("@");
        if (atIdx >= 0) {
            const after = val.slice(pos);
            ta.value = val.slice(0, atIdx) + after;
            ta.selectionStart = ta.selectionEnd = atIdx;
        }
        this.addAttachmentFile(file);
        this.hideAtPopup();
        ta.focus();
    }

    /* ---------- / 技能菜单（Phase B）---------- */
    // 触发检测：光标前为「行首或空白后跟 /，且 / 到光标间无空格」时弹出
    updateSlashTrigger() {
        const ta = this.inputEl;
        if (!ta) return;
        const pos = ta.selectionStart;
        const before = ta.value.slice(0, pos);
        const m = /(?:^|\s)\/([^\s/]*)$/.exec(before);
        if (!m) { this.hideSlashPopup(); return; }
        const query = m[1];
        this._slashAnchor = pos - query.length - 1; // '/' 字符位置
        this._slashQuery = query;
        this.showSlashPopup(query);
    }

    async showSlashPopup(query) {
        let popup = this._slashPopup;
        if (!popup) {
            // 复用 inputbar 作为容器（与 @ 弹窗同级锚定）
            const el = this.inputBar && this.inputBar.createDiv("dsh-slash-popup");
            if (!el) return;
            el.style.display = "none";
            popup = this._slashPopup = { el, items: [], index: 0, isVisible: false };
        }
        // 先立即显示「加载中…」占位：即便 listSlash 慢或 DSH RPC 挂起，也要先弹出来，
        // 否则 await 期间弹窗一直是 display:none，表现为“输入 / 不弹出”。
        popup.el.empty();
        const loading = popup.el.createDiv("dsh-slash-empty");
        loading.textContent = "加载中…";
        popup.el.style.display = "block";
        popup.isVisible = true;
        // 列表按需懒加载（每个会话缓存一次）
        if (this._slashCache == null) {
            try { this._slashCache = await this.api.listSlash(this.sessionId); }
            catch (e) { this._slashCache = []; this._slashErr = (e && e.message) ? e.message : String(e); }
        }
        const all = this._slashCache || [];
        const ql = (query || "").toLowerCase();
        const matched = ql
            ? all.filter((s) => s.name.toLowerCase().includes(ql) || (s.description || "").toLowerCase().includes(ql))
            : all;
        popup.items = matched;
        popup.index = 0;
        popup.el.empty();
        if (matched.length === 0) {
            const empty = popup.el.createDiv("dsh-slash-empty");
            empty.textContent = all.length
                ? "无匹配技能/命令"
                : ("暂无可用技能（" + (this._slashErr || "DSH 未返回") + "）");
        } else {
            for (let i = 0; i < matched.length; i++) {
                const s = matched[i];
                const item = popup.el.createDiv("dsh-slash-item");
                const nameEl = item.createSpan("dsh-slash-name");
                nameEl.textContent = "/" + s.name;
                const tag = item.createSpan("dsh-slash-tag");
                tag.textContent = s.kind === "skill" ? "技能" : "命令";
                const desc = item.createSpan("dsh-slash-desc");
                desc.textContent = s.description || "";
                item.addEventListener("mousedown", (ev) => { ev.preventDefault(); this.selectSlashItem(s); });
                if (i === 0) item.addClass("is-active");
            }
        }
        popup.el.style.display = "block";
        popup.isVisible = true;
    }

    hideSlashPopup() {
        if (this._slashPopup) { this._slashPopup.el.style.display = "none"; this._slashPopup.isVisible = false; }
    }

    highlightSlashItem() {
        if (!this._slashPopup) return;
        const items = this._slashPopup.el.querySelectorAll(".dsh-slash-item");
        items.forEach((el, i) => el.toggleClass("is-active", i === this._slashPopup.index));
    }

    handleSlashKeydown(e) {
        const p = this._slashPopup;
        if (!p || !p.isVisible) return false;
        if (e.key === "ArrowDown") {
            e.preventDefault();
            p.index = Math.min(p.index + 1, p.items.length - 1);
            this.highlightSlashItem();
            return true;
        }
        if (e.key === "ArrowUp") {
            e.preventDefault();
            p.index = Math.max(p.index - 1, 0);
            this.highlightSlashItem();
            return true;
        }
        if (e.key === "Enter" || e.key === "Tab") {
            e.preventDefault();
            if (p.items.length) this.selectSlashItem(p.items[p.index]);
            return true;
        }
        if (e.key === "Escape") {
            e.preventDefault();
            this.hideSlashPopup();
            return true;
        }
        return false;
    }

    selectSlashItem(item) {
        const ta = this.inputEl;
        const pos = ta.selectionStart;
        const val = ta.value;
        const anchor = (this._slashAnchor != null) ? this._slashAnchor : pos;
        const before = val.slice(0, anchor);
        const after = val.slice(pos);
        // 插入 /name + 空格，焦点留在空格后
        ta.value = before + "/" + item.name + " " + after;
        const np = before.length + item.name.length + 2;
        ta.selectionStart = ta.selectionEnd = np;
        this.hideSlashPopup();
        ta.focus();
    }

    /* 图片粘贴 → base64 → image content part */
    handlePaste(e) {
        const items = e.clipboardData && e.clipboardData.items;
        if (!items || !items.length) return;
        for (const it of items) {
            if (it.type && it.type.indexOf("image/") === 0) {
                e.preventDefault();
                const blob = it.getAsFile();
                if (!blob) return;
                const reader = new FileReader();
                reader.onload = () => {
                    const dataUrl = reader.result;
                    const comma = dataUrl.indexOf(",");
                    const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : "";
                    const bytes = Math.ceil((base64.length * 3) / 4);
                    const MAX = 8 * 1024 * 1024; // 8MB 本地预检
                    if (bytes > MAX) { new Notice("图片过大（>" + Math.round(MAX / 1048576) + "MB），已跳过"); return; }
                    const ext = (blob.type.split("/")[1] || "png").replace(/[^a-z0-9]/gi, "");
                    this.addAttachmentImage({ type: "image", mediaType: blob.type, data: base64, name: "pasted-" + Date.now() + "." + ext });
                };
                reader.readAsDataURL(blob);
                return;
            }
        }
    }

    /* ---------- 发送 ---------- */
    async send() {
        const text = (this.inputEl && this.inputEl.value || "").trim();
        const hasAtt = (this._attachments && this._attachments.length > 0);
        if (!text && !hasAtt) return;
        if (!this.sessionId) {
            new Notice("请先选择或新建一个会话");
            return;
        }
        // 关闭 @ 弹窗，快照并清空附件
        this.hideAtPopup();
        const attachments = (this._attachments || []).slice();
        this._attachments = [];
        this.renderAttachments();

        this.lastUserText = text;
        this.inputEl.value = "";
        // 快照：发送前是否已有正在生成的 turn（steer 模式判断必须用发送前状态，
        // 否则下面 this._running=true 会让 curMode 永远是 steer）
        const wasRunning = !!this._running;
        // 无论上一轮是否还在跑，只要有残留 assistantEl 就先收尾。
        // 原因：①上一轮已结束但 turn/end 事件迟到/丢失 → 不收尾会让 beginAssistantBubble 幂等返回，新内容写进旧气泡；
        //       ②steer 模式（用户在 AI 生成中插话）→ 收尾把已生成部分固化为独立气泡，用户消息在其后，新气泡续写，
        //         这是标准聊天 UI 行为（Claude/ChatGPT 均如此）；
        //       ③竞态（turn/end 在途 + 用户同时发送）→ 收尾确保用户消息永远在上一条 AI 回复之后，
        //         不会被 addUserBubble 的"插到活跃气泡前"逻辑插到旧气泡前面。
        if (this.assistantEl) {
            this.finalizeAssistant();
        }
        await this.addUserBubble(this.buildUserBubbleText(text, attachments));
        // 登记已本地发送的用户文本，防止 DSH 经 WS 回推同一 user/message 时重复渲染（Bug 3）
        if (!this._userTextsSent) this._userTextsSent = new Set();
        this._userTextsSent.add(((stripSystemContext(text) || "").replace(/\s+/g, " ").trim()));
        // 重置 turn 生命周期标志，启动「轮询 history 兜底渲染」
        // —— 新建会话的 WS 事件不会被 mux 推送（无 session/subscribed），只能靠 REST history 拿回复
        // 取消待执行的对账：用户发新消息意味着新 turn 开始，此时对账会清空刚发的用户消息
        if (this._reconcileTimer) { clearTimeout(this._reconcileTimer); this._reconcileTimer = null; }
        // 用户主动发消息 → 强制开启自动滚动（上滑暂停状态重置）
        this._autoScroll = true;
        this._turnDone = false;
        this._contentSetByWs = false;
        this._gotAssistantChunks = false;
        this._pollStart = Date.now();
        // 用户主动发消息 → 退出 WS catchup，后续 assistant 事件正常处理
        this._wsCatchup = false;
        this.beginAssistantBubble();
        this._running = true;
        this.setLiveBar("思考中…");
        this.startTurnPoll();
        try {
            // 若加载会话时正在后台纠正默认模型大小写，先等它完成，避免 prompt 抢跑仍用错误模型
            if (this._modelFixPromise) {
                try { await this._modelFixPromise; } catch (_e) { /* 忽略，继续用原模型发送 */ }
                this._modelFixPromise = null;
            }
            // 当前 mode：默认取 settings；若正在生成中又发消息，则走 steer（运行中追加/引导，Phase F）
            const curMode = wasRunning
                ? "steer"
                : ((this.plugin && this.plugin.settings && this.plugin.settings.mode) || "queue");
            const parts = this.buildPromptParts(text, attachments);
            const resp = await this.api.prompt(this.sessionId, parts, curMode);
            this.diagLastPrompt = "prompt:ok " + JSON.stringify(resp || {}).slice(0, 120);
            this.updateDiag();
        } catch (e) {
            const msg = e && e.message ? e.message : String(e);
            this.diagLastPrompt = "prompt:err " + msg.slice(0, 200);
            this.updateDiag();
            this.appendAssistant("*\n\n> ⚠️ 发送失败：" + msg + "\n");
            this.finalizeAssistant();
        }
    }

    async addUserBubble(text, atTop = false, images = null) {
        const bubble = this.messagesEl.createDiv("dsh-msg dsh-msg-user");
        // 修复 Bug 3：强制可见，避免被父级 flex 容器异常折叠
        bubble.style.display = "flex";
        const content = bubble.createDiv("dsh-msg-content");
        content.style.minHeight = "1.5em";
        const stamp = "u-" + (++this._userSeq || (this._userSeq = 1));
        bubble.dataset.stamp = stamp;
        // 向上翻页时插到顶部，保持阅读位置
        if (atTop) {
            this.messagesEl.insertBefore(bubble, this.messagesEl.firstChild);
        } else if (this.assistantEl && this.assistantEl.parentNode === this.messagesEl) {
            // steer 模式 / 上一轮未收尾：用户消息必须插到活跃助手气泡前面，
            // 否则 createDiv 追加到末尾会让用户消息出现在 AI 回复下方（错位根因）。
            this.messagesEl.insertBefore(bubble, this.assistantEl);
        }
        const idx = Array.from(this.messagesEl.children).indexOf(bubble);
        console.log(`[DSH MSG] addUserBubble stamp=${stamp} atTop=${atTop} idx=${idx}/${this.messagesEl.children.length} preview=${JSON.stringify(text.slice(0,60))}`);
        try {
            await MarkdownRenderer.render(this.app, text, content, "", this);
        } catch (_e) {
            // 兜底：渲染失败时显示纯文本，保证不消失
            const pre = content.createEl("pre", { cls: "dsh-msg-fallback" });
            pre.textContent = text;
        }
        // v0.4.0 消息内图片（对齐 VSCode MsgImage）：attachmentId → session.attachment 拉字节渲染
        if (Array.isArray(images) && images.length) this._renderUserImages(bubble, images);
        // 渲染完成后再滚到底（仅首屏/实时发送，翻页由 loadHistory 自行控制位置）
        if (!atTop) {
            // 修复"发送后看不到自己消息"：MarkdownRenderer 异步渲染后布局高度未定，
            // 同步 scrollToBottom 会读到一个偏小的 scrollHeight，把新气泡压到可视区下方。
            // 改等一帧布局落地，再用 scrollIntoView 精确把气泡本身顶进视口（兼容嵌套滚动容器）。
            requestAnimationFrame(() => {
                try { bubble.scrollIntoView({ block: "end", inline: "nearest" }); } catch (_) {}
                try { this.scrollToBottom(); } catch (_) {}
            });
        }
    }

    beginAssistantBubble() {
        // 幂等：send() 和 DSH turn/start 都会调用，重复建泡会留一个空 DSH 泡。先到的赢，后到的复用。
        if (this.assistantEl) {
            console.log(`[DSH MSG] beginAssistantBubble SKIP(idempotent) childCount=${this.messagesEl ? this.messagesEl.children.length : '?'}`);
            return;
        }
        this.assistantEl = this.messagesEl.createDiv("dsh-msg dsh-msg-assistant");
        console.log(`[DSH MSG] beginAssistantBubble CREATE childCount=${this.messagesEl ? this.messagesEl.children.length : '?'}`);
        const roleEl = this.assistantEl.createDiv("dsh-msg-role");
        roleEl.textContent = "DSH";
        this.assistantContent = this.assistantEl.createDiv("dsh-msg-content");
        // hover 操作条（复制 / 重试 / 分支）—— 对齐 VSCode DSH 每条消息的 hover 操作
        const bubble = this.assistantEl;
        const actions = bubble.createDiv("dsh-msg-actions");
        const copyBtn = actions.createEl("button", { cls: "dsh-mini-btn", attr: { title: "复制助手回答" } });
        copyBtn.textContent = "复制";
        copyBtn.addEventListener("click", () => {
            const txt = (bubble && bubble._md) || this.assistantMd || "";
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(txt).then(() => {
                    copyBtn.textContent = "已复制";
                    setTimeout(() => { copyBtn.textContent = "复制"; }, 1200);
                }).catch(() => {});
            }
        });
        const retryBtn = actions.createEl("button", { cls: "dsh-mini-btn", attr: { title: "重试：重发上一条用户消息" } });
        retryBtn.textContent = "重试";
        retryBtn.addEventListener("click", () => {
            const t = this.lastUserText;
            if (t) { this.inputEl.value = t; this.send(); }
        });
        const branchBtn = actions.createEl("button", { cls: "dsh-mini-btn", attr: { title: "分支：新会话并重发上一条" } });
        branchBtn.textContent = "分支";
        branchBtn.addEventListener("click", async () => {
            const t = this.lastUserText;
            await this.newSession();
            if (t) { this.inputEl.value = t; this.send(); }
        });
        this.assistantMd = "";
        this.thinkingMd = "";
    }

    appendAssistant(text, isThinking) {
        if (!this.assistantEl) this.beginAssistantBubble();
        if (isThinking) this.thinkingMd += text;
        else this.assistantMd += text;
        this.scheduleRender();
    }

    // 修复 Bug 4：把工具调用 / 子代理 / 步骤等"非文本但用户该看到"的事件
    // 渲染成可滚动看的活动行（不挤进 assistantMd，避免触发 system-context 剥离）。
    // 同 id / 同 type+name 的事件折叠为一行：start 显示进行中；end 追加"完成"标记。
    // block-start/block-end 是 DSH 内部包裹噪音（参考 fold.ts），直接丢弃。
    // 超过 MAX_ACTIVITIES 张后不再创建新行，把多余计数累加到"已折叠"摘要行。
    appendActivity(chunk) {
        if (!this.assistantEl) this.beginAssistantBubble();
        const t = String(chunk.type || "");
        // vscode fold.ts：block-* 直接 ignore；这里保持一致，避免流式每段都多一张卡片
        if (t === "block-start" || t === "block-end") return;
        const data = (chunk && chunk.data) || {};
        // v2（fold.ts 对齐）：tool/result 的 callId 可嵌套在 message.source.callId
        // 或 message.content[0].toolCallId —— 只读顶层会让活动卡永远转圈。
        const nestedCallId = (data.message && data.message.source && data.message.source.callId)
            || (data.message && data.message.content && data.message.content[0] && data.message.content[0].toolCallId);
        // 关键修复：fallback id 去掉 Math.random —— 否则每个流式 tool-call-delta 都会被当成新工具
        // 改为 type+name 合并（同一 type+name 的所有 delta 折成一行）
        const id = String(
            data.toolCallId || data.callId || nestedCallId || data.id
            || data.agentId || data.subagentId || data.sessionId
            || (t + ":" + (data.name || data.toolName || ""))
        );
        if (!this._activities) this._activities = new Map();
        // 活动行挂在 assistantContent 之外的兄弟节点，下次 renderAssistantNow 清空 assistantContent 时不会误删
        if (!this._activityHolder) {
            this._activityHolder = this.assistantEl.createDiv("dsh-activities");
        }
        // 数量上限：超过 5 张就累计到摘要行，不让一屏被工具调用刷满
        const MAX_ACTIVITIES = 5;
        let row = this._activities.get(id);
        if (!row && this._activities.size >= MAX_ACTIVITIES) {
            // 累加到第一张"已折叠"摘要行
            let summary = this._activities.get("__overflow__");
            if (!summary) {
                summary = {};
                summary.root = this._activityHolder.createDiv("dsh-activity is-active dsh-activity-overflow");
                summary.icon = summary.root.createSpan("dsh-activity-icon"); summary.icon.textContent = "📦";
                summary.text = summary.root.createSpan("dsh-activity-text");
                summary.text.textContent = "更多活动";
                summary.detail = summary.root.createSpan("dsh-activity-detail");
                this._activities.set("__overflow__", summary);
            }
            summary._extraCount = (summary._extraCount || 0) + 1;
            const finished = t.endsWith("-end");
            summary.detail.textContent = " — 已折叠 " + summary._extraCount + " 个活动" + (finished ? "（含已完成）" : "（进行中）");
            this.scrollToBottom();
            return;
        }
        // v2 修复：tool-result / tool-call-result 也是完结信号（原只认 *-end →
        // 工具结果到达后活动卡永远转圈，即 VSCode 0.11 同款 bug）。
        const finished = t.endsWith("-end") || t === "tool-result" || t === "tool-call-result";
        const label = (() => {
            if (t.startsWith("tool-")) {
                // 子代理伪装成 tool/call：换脸成 👥 子代理（Bug 4 核心修复）
                const sa = subagentMeta(data.name || data.toolName, data.args || data.input || data);
                if (sa) return sa;
                return "🔧 调用工具：" + (data.name || data.toolName || "工具");
            }
            if (t === "agent-start" || t === "agent-end") return "👥 Agent：" + (data.name || data.agentId || "");
            if (t === "subagent-start" || t === "subagent-end") {
                const task = data.task || data.description || "";
                return "👥 子代理：" + (data.name || data.agentId || data.subagentId || "工作") + (task ? "（" + task.slice(0, 30) + "）" : "");
            }
            if (t === "step-start" || t === "step-end") return "📍 步骤：" + (data.title || data.name || data.step || "");
            return "· " + t;
        })();
        if (!row) {
            row = {};
            row.root = this._activityHolder.createDiv("dsh-activity is-active");
            // 头部行（可点击展开）
            row.head = row.root.createDiv("dsh-activity-head");
            row.icon = row.head.createSpan("dsh-activity-icon"); row.icon.textContent = "⏳";
            row.text = row.head.createSpan("dsh-activity-text"); row.text.textContent = label;
            row.detail = row.head.createSpan("dsh-activity-detail");
            row.chev = row.head.createSpan("dsh-activity-chev");
            row.chev.textContent = "▸";
            // 展开体（args / result），默认隐藏
            row.body = row.root.createDiv("dsh-activity-body");
            row.body.style.display = "none";
            row._args = null;
            row._result = null;
            row._open = false;
            // 点击头部切换展开
            row.head.addEventListener("click", () => {
                row._open = !row._open;
                row.body.style.display = row._open ? "" : "none";
                row.chev.textContent = row._open ? "▾" : "▸";
                if (row._open) this._renderActivityBody(row);
            });
            this._activities.set(id, row);
        }
        if (finished && !row.finished) {
            row.icon.textContent = "✅";
            row.root.removeClass("is-active"); row.root.addClass("is-done");
            row.finished = true;
            try {
                // v2（fold.ts 对齐）：结果文本可嵌套在 message.content[0].content[0].text
                const nestedText = (data.message && data.message.content && data.message.content[0]
                    && ((data.message.content[0].content && data.message.content[0].content[0] && data.message.content[0].content[0].text)
                        || data.message.content[0].text));
                const resultSrc = nestedText != null ? nestedText
                    : (data.result != null ? data.result
                        : (data.content && data.content[0] && data.content[0].text));
                if (resultSrc != null) {
                    row._result = typeof resultSrc === "string" ? resultSrc : JSON.stringify(resultSrc, null, 2);
                    const preview = row._result.slice(0, 200);
                    if (preview) row.detail.textContent = " — " + preview.replace(/\s+/g, " ");
                } else if (data.error) {
                    row._result = "出错：" + String(data.error);
                    row.detail.textContent = " — " + row._result.slice(0, 200);
                } else if (foldIsErrorResult(data)) {
                    row._result = "工具执行出错";
                    row.detail.textContent = " — 工具执行出错";
                }
            } catch (_e) { /* 忽略序列化失败 */ }
            if (row._open) this._renderActivityBody(row);
            // 所有活动都完成后清除 live 指示条
            if (!this._hasRunningActivity()) this.clearLiveBar();
        } else if (!finished) {
            if (data.args || data.input) {
                const a = data.args || data.input;
                try {
                    row._args = typeof a === "string" ? a : JSON.stringify(a, null, 2);
                    row.detail.textContent = " — " + row._args.replace(/\s+/g, " ").slice(0, 200);
                }
                catch (_e) { row.detail.textContent = ""; }
            } else if (data.progress) {
                row.detail.textContent = " — " + String(data.progress).slice(0, 200);
            }
            // 运行中：在 composer 上方显示「正在执行：XXX」（Bug 4 增强）
            this.setLiveBar(label);
        }
        this.scrollToBottom();
    }
    // 渲染活动卡片展开体：args + result（对齐 VSCode ActivityCard 的 args/resultPreview）
    _renderActivityBody(row) {
        if (!row || !row.body) return;
        row.body.empty();
        if (row._args) {
            const lbl = row.body.createDiv("dsh-activity-body-label");
            lbl.textContent = "参数";
            const pre = row.body.createEl("pre", { cls: "dsh-activity-body-pre" });
            pre.textContent = row._args;
        }
        if (row._result) {
            const lbl = row.body.createDiv("dsh-activity-body-label");
            lbl.textContent = "结果";
            const pre = row.body.createEl("pre", { cls: "dsh-activity-body-pre" });
            pre.textContent = row._result;
        }
        if (!row._args && !row._result) {
            row.body.createDiv("dsh-activity-body-empty").textContent = "（无详情）";
        }
    }

    scheduleRender() {
        if (this.renderPending) return;
        this.renderPending = true;
        requestAnimationFrame(() => {
            this.renderPending = false;
            this.renderAssistantNow();
        });
    }

    // 把「思考 + 正文」渲染进指定 content 元素（实时气泡与历史气泡共用）
    // done：true=历史/已结束消息（解析失败显示「渲染失败」），false=流式进行中（显示「生成中」）
    async renderThinkingAndText(contentEl, text, thinking, done) {
        if (done === undefined) done = !!this._turnDone;
        contentEl.empty();
        // 思考折叠（<details>），对齐 VSCode DSH 的 thinking 折叠
        if (thinking) {
            // thinking 也会被 DSH 注入运行时上下文（较罕见但发生过），渲染前先 strip
            const cleanThinking = stripSystemContext(thinking) || "";
            if (cleanThinking.trim()) {
                const det = contentEl.createEl("details", { cls: "dsh-thinking" });
                const sum = det.createEl("summary");
                sum.textContent = "💭 思考过程";
                const tw = det.createDiv("dsh-thinking-body");
                await MarkdownRenderer.render(this.app, cleanThinking, tw, "", this);
                this.postProcessDshUi(tw, done);
            }
        }
        const body = contentEl.createDiv("dsh-msg-md");
        // 核心修复：dsh-ui 段直接渲染，绕过 MarkdownRenderer（避免代码块被语法高亮/转义破坏）
        const s = stripSystemContext(text || "");
        const segs = splitDshUiSegments(s);
        for (const seg of segs) {
            if (seg.kind === "fence") {
                this.renderDshUiSegment(body, seg.text, done);
            } else {
                // 纯文本段：仍走 MarkdownRenderer + postProcessDshUi（兜底裸 JSON）
                const wrapped = wrapDshUiJson(seg.text);
                const segDiv = body.createDiv();
                await MarkdownRenderer.render(this.app, wrapped, segDiv, "", this);
                this.postProcessDshUi(segDiv, done);
            }
        }
        // 修复 Bug 1：若清洗后整段都是系统块（DSH 注入空 turn），隐藏内容元素，避免留空气泡
        if (text && !s.trim()) contentEl.style.display = "none";
        else contentEl.style.display = "";
    }
    // dsh-ui fence 段直接渲染：parseSpec → dshUiRenderSpec，不经 MarkdownRenderer
    // 这是修复「组件渲染失败无法解析 JSON」的核心：原管道把 spec 包进 ```dsh-ui 再让
    // MarkdownRenderer 渲染，代码块可能被语法高亮/实体转义破坏；这里从原始文本直出。
    renderDshUiSegment(container, specText, done) {
        // 兜底剥离残留围栏标记（```dsh-ui / ``` 等），再 trim
        const raw = stripFenceMarkers(specText || "");
        const spec = parseSpec(raw);
        if (spec && Array.isArray(spec.items)) {
            let html;
            try { html = dshUiRenderSpec(spec); } catch (_e) { return; }
            const wrap = document.createElement("div");
            wrap.innerHTML = html;
            container.appendChild(wrap);
            return;
        }
        // 解析失败：流式进行中 → 占位；已结束 → 失败提示 + 原始折叠
        if (done) {
            // v0.1.12 精准诊断：输出 JSON.parse 的具体错误位置
            try {
                JSON.parse(raw);
                console.warn("[dsh-ui PARSE FAIL] JSON.parse succeeded but parseSpec returned null! raw=" + JSON.stringify(raw));
            } catch (e) {
                const m = String(e.message).match(/position (\d+)/);
                const pos = m ? parseInt(m[1]) : -1;
                const ctx = pos >= 0 ? JSON.stringify(raw.slice(Math.max(0, pos-30), pos+30)) : "(no pos)";
                console.warn("[dsh-ui PARSE FAIL] len=" + raw.length + " err=" + e.message + " at pos=" + pos + " ctx=" + ctx);
            }
        }
        const wrap = document.createElement("div");
        wrap.className = "dui " + (done ? "dui-broken" : "dui-pending");
        if (done) {
            const callout = document.createElement("div");
            callout.className = "dui-callout dui-callout-warning";
            callout.textContent = "⚠️ 组件渲染失败（JSON 无法解析）";
            const details = document.createElement("details");
            const sum = document.createElement("summary");
            sum.className = "muted";
            sum.textContent = "原始内容";
            const pre2 = document.createElement("pre");
            pre2.className = "code-block";
            pre2.textContent = raw;
            details.appendChild(sum);
            details.appendChild(pre2);
            wrap.appendChild(callout);
            wrap.appendChild(details);
        } else {
            wrap.textContent = "⚙️ 组件生成中…";
        }
        container.appendChild(wrap);
    }
    async renderAssistantNow() {
        if (!this.assistantContent) return;
        await this.renderThinkingAndText(this.assistantContent, this.assistantMd, this.thinkingMd, this._turnDone);
        this.scrollToBottom();
    }
    // 历史会话里的单条助手回复（静态，不占用 this.assistantEl）
    renderStaticAssistant(text, thinking, atTop = false) {
        const bubble = this.messagesEl.createDiv("dsh-msg dsh-msg-assistant");
        bubble.createDiv("dsh-msg-role").textContent = "DSH";
        const content = bubble.createDiv("dsh-msg-content");
        this.renderThinkingAndText(content, text, thinking, true);
        if (atTop) this.messagesEl.insertBefore(bubble, this.messagesEl.firstChild);
        // 注意：滚动由 loadHistory 控制（首屏到底 / 翻页保持位置），此处不自动滚
    }

    // 把 Obsidian 渲染后的 <pre><code class="language-dsh-ui"> 替换成 dsh-ui 富卡片。
    // 仅用于纯文本段中的裸 JSON 兜底（fence 段已由 renderDshUiSegment 直出）。
    // done：true=已结束（失败显示错误），false=流式中（失败显示占位）。
    postProcessDshUi(el, done) {
        if (!el || !el.querySelectorAll) return;
        if (done === undefined) done = !!this._turnDone;
        const pres = el.querySelectorAll("pre");
        pres.forEach((pre) => {
            const code = pre.querySelector("code");
            if (!code) return;
            const cls = (code.className || "") + " " + (code.getAttribute("data-language") || "") + " " + (code.getAttribute("lang") || "");
            // 兜底剥离残留围栏标记，再 trim
            const text = stripFenceMarkers(code.textContent || "");
            const isDshUi = /dsh-ui/i.test(cls);
            // 裸数组/裸组件序列形态（v0.4.12）以 [ 开头，也要进解析
            const looksLikeSpec = (text.startsWith("{") || text.startsWith("[")) && (text.includes('"items"') || text.includes('"type"') || text.includes('"title"'));
            if (!isDshUi && !looksLikeSpec) return;
            const spec = parseSpec(text);
            // 包壳后的裸数组/序列没有 type/title 字段，只要 items 是数组就接受
            if (spec && Array.isArray(spec.items)) {
                let html;
                try { html = dshUiRenderSpec(spec); } catch (_e) { return; }
                const wrap = document.createElement("div");
                wrap.innerHTML = html;
                try { pre.replaceWith(wrap); } catch (_e) {}
                return;
            }
            // 解析失败：占位处理
            if (done) {
                try { console.warn("[dsh-ui PARSE FAIL postProcess] isDshUi=" + isDshUi + " len=" + text.length + " raw=" + JSON.stringify(text)); } catch (_e) {}
            }
            const wrap = document.createElement("div");
            wrap.className = "dui " + (done ? "dui-broken" : "dui-pending");
            if (done) {
                const callout = document.createElement("div");
                callout.className = "dui-callout dui-callout-warning";
                callout.textContent = "⚠️ 组件渲染失败（JSON 无法解析）";
                const details = document.createElement("details");
                const sum = document.createElement("summary");
                sum.className = "muted";
                sum.textContent = "原始内容";
                const pre2 = document.createElement("pre");
                pre2.className = "code-block";
                pre2.textContent = text;
                details.appendChild(sum);
                details.appendChild(pre2);
                wrap.appendChild(callout);
                wrap.appendChild(details);
            } else {
                wrap.textContent = "⚙️ 组件生成中…";
            }
            try { pre.replaceWith(wrap); } catch (_e) {}
        });
    }

    finalizeAssistant() {
        console.log(`[DSH MSG] finalizeAssistant assistantMdLen=${(this.assistantMd || "").length} hadEl=${!!this.assistantEl}`);
        // 空气泡清理：竞态下迟到的 turn/end 可能 finalize 一个刚创建、还没收到任何内容的新气泡。
        // 这种气泡没有正文、没有思考、也没有活动卡片，直接从 DOM 移除，避免留一个空 "DSH" 泡。
        const hasContent = !!(this.assistantMd && this.assistantMd.trim()) || !!(this.thinkingMd && this.thinkingMd.trim());
        const hasActivities = this.assistantEl && this.assistantEl.querySelector(".dsh-activity, .dsh-activity-holder, [class*=activity]");
        if (this.assistantEl && !hasContent && !hasActivities) {
            console.log("[DSH MSG] finalizeAssistant removing empty bubble");
            try { this.assistantEl.remove(); } catch (_e) {}
            this.assistantEl = null;
            this.assistantContent = null;
            this.assistantMd = "";
            this.thinkingMd = "";
            this._turnDone = true;
            this._running = false;
            this._stopPoll();
            this._activities = new Map();
            this._activityHolder = null;
            this.clearLiveBar();
            return;
        }
        this.renderAssistantNow();
        if (this.assistantEl) this.assistantEl._md = this.assistantMd || "";
        // 记录最后收尾的正文，供 startTurnPoll 判断取到的是不是上一轮的旧内容
        this._lastFinalizedMd = this.assistantMd || "";
        this.assistantEl = null;
        this.assistantContent = null;
        this.assistantMd = "";
        this.thinkingMd = "";
        this._turnDone = true;
        this._running = false;
        this._stopPoll();
        // 重置工具/子代理活动跟踪（Bug 4 —— 下一轮从空开始）
        this._activities = new Map();
        this._activityHolder = null;
        // turn 结束：清除实时活动指示条（无论是否还有残留活动）
        this.clearLiveBar();
    }

    // ===== 全量对账（对齐 VSCode scheduleSettle）=====
    // 第一性原理：history 是唯一真相源，WS 增量渲染只是优化。
    // turn/end 后 400ms 防抖，从 REST history 全量重建 DOM，消除所有增量错误（重复气泡、错位、丢消息）。
    scheduleReconcile() {
        if (this._reconcileTimer) clearTimeout(this._reconcileTimer);
        this._reconcileTimer = setTimeout(() => {
            this._reconcileTimer = null;
            this.reconcileFromHistory();
        }, 400);
    }

    async reconcileFromHistory() {
        if (!this.sessionId || !this.messagesEl) return;
        // 运行中不对账（正在生成的 turn 不能被历史快照覆盖）
        if (this._running) {
            console.log("[DSH reconcile] skip: still running");
            return;
        }
        console.log("[DSH reconcile] rebuilding from authoritative history");
        // 清空所有消息和 turn 状态
        // 必须同时清空 _userTextsSent：否则 loadHistory 渲染历史用户消息时，
        // addUserBubbleFromEvent 检测到 key 已在去重集中（send() 时添加的），直接 return，
        // 导致所有用户消息在对账重建后消失。
        this.messagesEl.empty();
        this.assistantEl = null;
        this.assistantContent = null;
        this.assistantMd = "";
        this.thinkingMd = "";
        this._activities = new Map();
        this._activityHolder = null;
        this._gotAssistantChunks = false;
        this._contentSetByWs = false;
        this._userTextsSent = new Set();
        // 从权威源重建
        try {
            await this.loadHistory(this.sessionId);
        } catch (e) {
            console.log("[DSH reconcile] loadHistory failed:", e && e.message);
        }
        // 重建后恢复自动滚动并滚到底部（重建丢失了滚动位置，停在顶部不合理）
        this._autoScroll = true;
        requestAnimationFrame(() => { try { this.scrollToBottom(); } catch (_) {} });
    }

    _stopPoll() {
        if (this._pollTimer) {
            clearTimeout(this._pollTimer);
            this._pollTimer = null;
        }
    }

    // 从 history 事件里抽取「最新一个 turn」的正文与思考（含是否结束）
    extractLatestTurn(events) {
        if (!Array.isArray(events) || events.length === 0) return null;
        let startIdx = -1;
        for (let i = 0; i < events.length; i++) {
            const t = events[i].event && events[i].event.type;
            if (t === "turn/start") startIdx = i;
        }
        if (startIdx < 0) return null;
        let text = "";
        let thinking = "";
        let ended = false;
        for (let i = startIdx; i < events.length; i++) {
            const ev = events[i].event || {};
            if (ev.type === "turn/end") { ended = true; }
            else if (ev.type === "assistant/chunk") {
                const ch = ev.data && ev.data.chunk;
                if (!ch) continue;
                if (ch.type === "text-delta" && typeof ch.text === "string") text += ch.text;
                else if (ch.type === "reasoning-delta" && typeof ch.text === "string") thinking += ch.text;
            } else if (ev.type === "chunkrow/text-chunks") {
                // v012 历史页正文压缩形态（texts[] 拼接）
                const texts = ev.data && ev.data.texts;
                if (Array.isArray(texts)) text += texts.join("");
            } else if (ev.type === "chunkrow/reasoning-chunks") {
                const texts = ev.data && ev.data.texts;
                if (Array.isArray(texts)) thinking += texts.join("");
            } else if (ev.type === "assistant/message") {
                // 退化：个别版本把整段回复放在 assistant/message
                const m = ev.data && (ev.data.message || ev.data.content || ev.data);
                const mt = typeof m === "string" ? m : (m && m.content);
                if (typeof mt === "string" && !text) text = mt;
            }
        }
        return { text, thinking, ended };
    }

    // 把最新 turn 的内容渲染进当前助手气泡（轮询兜底用，authoritative）
    renderAssistantFull(text, thinking) {
        if (!this.assistantEl) this.beginAssistantBubble();
        this.assistantMd = text || "";
        this.thinkingMd = thinking || "";
        this.renderAssistantNow();
    }

    // 发消息后启动轮询：新建会话的 WS 不推事件，只能靠 REST history 兜底渲染
    startTurnPoll() {
        this._stopPoll();
        const tick = async () => {
            if (this._turnDone) return;
            if (!this.sessionId) return;
            try {
                const h = await this.api.getHistory(this.sessionId);
                const events = (h && h.events) || (h && h.result && h.result.value && h.result.value.events) || [];
                const turn = this.extractLatestTurn(events);
                if (!turn) return;
                // history 比当前已渲染的更长才覆盖（避免把 WS 实时增量截断回落后的 history）
                const historyAhead =
                    turn.text.length > (this.assistantMd || "").length ||
                    turn.thinking.length > (this.thinkingMd || "").length;
                if (turn.ended) {
                    if (this._turnDone) return;
                    // 空 turn（warmup 占位）不算真正结束：继续轮询等真实回复，否则会漏掉后续正文
                    const hasContent = turn.text || turn.thinking;
                    if (!hasContent) return;
                    // 防旧 turn 内容误渲染：send() 后立即 poll，新 turn 还没在服务端开始，
                    // extractLatestTurn 取到的是上一轮已结束的内容。若当前轮还没收到任何 WS 数据，
                    // 且取到的正文与上一轮收尾正文一致，判定为旧数据，跳过。
                    const noWsContentYet = !this._gotAssistantChunks && !this._contentSetByWs;
                    // 防旧 turn 内容误渲染：send() 后立即 poll，新 turn 还没在服务端开始，
                    // extractLatestTurn 取到的是上一轮已结束的内容。若当前轮还没收到任何 WS 数据，
                    // 且取到的正文与上一轮收尾正文一致（trim 后比较，避免空白字符差异），判定为旧数据。
                    const lastFin = (this._lastFinalizedMd || "").trim();
                    const turnTxt = (turn.text || "").trim();
                    const sameAsLastFinalized = lastFin.length > 0 && turnTxt.length > 0 && turnTxt === lastFin;
                    if (noWsContentYet && sameAsLastFinalized) {
                        console.log(`[DSH MSG] startTurnPoll SKIP stale turn (text len=${turn.text.length} matches lastFinalized len=${lastFin.length})`);
                        return;
                    }
                    if (historyAhead) this.renderAssistantFull(turn.text, turn.thinking);
                    this.finalizeAssistant();
                    // 全量对账：poll 检测到 turn 结束也触发，400ms 后从权威 history 重建
                    this.scheduleReconcile();
                    return;
                }
                // 未结束：history 领先时补齐（新建会话 WS 不推事件 / 仅思考漏正文等场景）
                if (historyAhead) {
                    this.renderAssistantFull(turn.text, turn.thinking);
                }
            } catch (_e) {
                /* 轮询失败不影响 WS 实时路径 */
            } finally {
                if (!this._turnDone && Date.now() - this._pollStart < 120000) {
                    this._pollTimer = setTimeout(tick, 700);
                } else if (!this._turnDone) {
                    // 超过 120s 仍未结束（DSH 卡住）：强制收尾 + 对账
                    this.finalizeAssistant();
                    this.scheduleReconcile();
                }
            }
        };
        tick();
    }

    // 渲染某会话的历史对话（切到该会话时调用，对齐 VSCode/Claudian）
    // beforeSeq：向上翻页游标（传当前最旧事件 seq 拉更早一批）；null 表示首屏最近 24 条
    async loadHistory(id, beforeSeq = null) {
        if (!this.messagesEl) return;
        try {
            const h = await this.api.getHistory(id, beforeSeq, 24);
            const events = (h && h.events) || (h && h.result && h.result.value && h.result.value.events) || [];
            // 记录翻页边界（events 按时间正序，[0] 是最旧一条的 seq）
            if (events.length) {
                const firstSeq = events[0].event && events[0].event.seq;
                if (typeof firstSeq === "number") this._oldestSeq = firstSeq;
            }
            this._hasMore = !!h.hasMore;
            const items = this._eventsToItems(events);
            if (!beforeSeq) {
                // 首屏：只渲染最近 24 条，滚到底
                const recent = items.slice(-24);
                for (const it of recent) this._renderHistoryItem(it, false);
                this.scrollToBottom();
                // 记录最后一条历史事件的 seq，WS 重放时 seq <= 此值的事件全部跳过（精确去重，替代布尔 catchup）
                if (events.length) {
                    const lastEv = events[events.length - 1];
                    const lastSeq = lastEv && lastEv.event && lastEv.event.seq;
                    if (typeof lastSeq === "number") this._lastHistorySeq = lastSeq;
                }
                const lastTurn = this.extractLatestTurn(events);
                this._wsCatchup = !!(lastTurn && lastTurn.ended);
                // 记录最后一轮 AI 正文，供 startTurnPoll 的 stale-turn guard 比较。
                // loadHistory 不经过 finalizeAssistant，若不设置，_lastFinalizedMd 为 undefined，
                // stale guard 的 `!= null` 检查会失效，poll 会把上一轮内容渲染进新气泡（重复回复根因）。
                if (lastTurn && lastTurn.ended && lastTurn.text) {
                    this._lastFinalizedMd = lastTurn.text;
                }
                console.log(`[DSH MSG] loadHistory done, items=${items.length} lastSeq=${this._lastHistorySeq} lastTurnEnded=${!!(lastTurn && lastTurn.ended)} lastFinalizedLen=${(this._lastFinalizedMd || "").length} wsCatchup=${this._wsCatchup}`);
            } else {
                // 向上翻页：在顶部插入更早的一批，保持当前阅读位置（不跳动）
                const oldHeight = this.messagesEl.scrollHeight;
                const oldTop = this.messagesEl.scrollTop;
                for (const it of items) this._renderHistoryItem(it, true);
                const newHeight = this.messagesEl.scrollHeight;
                this.messagesEl.scrollTop = newHeight - oldHeight + oldTop;
            }
        } catch (_e) {
            /* 历史加载失败不阻塞 */
        }
    }

    _eventsToItems(events) {
        // v2：走 DshFold（交错段 + chunkrow + 嵌套 callId + 步骤卡 + 跨回合回溯）
        const fold = new DshFold();
        fold.pushMany(events || []);
        return fold.items.map((it) => (it.kind === "user"
            ? { role: "user", text: it.text, files: it.files }
            : { role: "assistant", turn: it }));
    }

    _renderHistoryItem(it, atTop) {
        if (it.role === "user") this.addUserBubbleFromEvent({ data: { text: it.text, images: it.images } }, atTop);
        else this.renderStaticTurn(it.turn, atTop);
    }

    /** 历史回合气泡：按 segments 真实到达顺序渲染（正文/思考/活动卡交错，
     *  对齐 VSCode fold v2 —— 不再把工具全抹掉、不会思考正文错位）。 */
    renderStaticTurn(turn, atTop = false) {
        const bubble = this.messagesEl.createDiv("dsh-msg dsh-msg-assistant");
        bubble.createDiv("dsh-msg-role").textContent = "DSH";
        const content = bubble.createDiv("dsh-msg-content");
        this.renderFoldSegments(content, turn);
        // v0.4.0 TurnActions（对齐 VSCode TurnActions：复制 + 从此处分叉；👍👎 在 VSCode 侧仅日志桩，不搬死按钮）
        if (turn && typeof turn.text === "string" && turn.text.trim()) {
            const bar = bubble.createDiv("dsh-msg-actions");
            const cp = bar.createEl("button", { cls: "dsh-msg-action-btn", attr: { title: "复制回答" } });
            cp.textContent = "📋";
            cp.addEventListener("click", () => {
                navigator.clipboard.writeText(turn.text || "").then(
                    () => new Notice("已复制"),
                    () => new Notice("复制失败"),
                );
            });
            if (turn.lastSeq != null) {
                const fk = bar.createEl("button", { cls: "dsh-msg-action-btn", attr: { title: "从此处分叉出新会话" } });
                fk.textContent = "⑂";
                fk.addEventListener("click", () => this.forkSessionRowAt(this.sessionId, turn.lastSeq));
            }
        }
        if (atTop) this.messagesEl.insertBefore(bubble, this.messagesEl.firstChild);
    }

    /** 交错段渲染：text→围栏切分+Markdown；thinking→折叠块；tool→活动行。 */
    async renderFoldSegments(contentEl, turn) {
        const segs = (turn && turn.segments) || [];
        let holder = null;
        const ensureHolder = () => {
            if (!holder) holder = contentEl.createDiv("dsh-activities");
            return holder;
        };
        if (segs.length === 0) {
            // 空段兜底：整轮按「思考+正文」整段渲染（老路径）
            await this.renderThinkingAndText(contentEl, (turn && turn.text) || "", (turn && turn.thinking) || "", true);
            return;
        }
        for (const seg of segs) {
            if (seg.kind === "tool") {
                this.renderFoldActivityRow(ensureHolder(), seg.act);
            } else if (seg.kind === "thinking") {
                const clean = stripSystemContext(seg.text || "") || "";
                if (!clean.trim()) continue;
                const det = contentEl.createEl("details", { cls: "dsh-thinking" });
                det.createEl("summary").textContent = "💭 思考过程";
                const tw = det.createDiv("dsh-thinking-body");
                await MarkdownRenderer.render(this.app, clean, tw, "", this);
                this.postProcessDshUi(tw, true);
            } else {
                const s = stripSystemContext(seg.text || "");
                if (!s.trim()) continue;
                const body = contentEl.createDiv("dsh-msg-md");
                for (const fs of splitDshUiSegments(s)) {
                    if (fs.kind === "fence") this.renderDshUiSegment(body, fs.text, true);
                    else {
                        const segDiv = body.createDiv();
                        await MarkdownRenderer.render(this.app, wrapDshUiJson(fs.text), segDiv, "", this);
                        this.postProcessDshUi(segDiv, true);
                    }
                }
            }
        }
    }

    /** 静态活动行（历史回放用；与实时 appendActivity 同一套样式类，默认折叠 args/结果）。 */
    renderFoldActivityRow(holder, act) {
        if (!act) return;
        const MAX = 5;
        if (holder.childElementCount >= MAX) {
            let summary = holder.querySelector(".dsh-activity-overflow");
            if (!summary) {
                summary = holder.createDiv("dsh-activity dsh-activity-overflow");
                summary.createSpan("dsh-activity-icon").textContent = "📦";
                summary.createSpan("dsh-activity-text").textContent = "更多活动";
                summary.createSpan("dsh-activity-detail").className = "dsh-activity-detail";
            }
            const d = summary.querySelector(".dsh-activity-detail") || summary.createSpan("dsh-activity-detail");
            const n = holder.querySelectorAll(".dsh-activity:not(.dsh-activity-overflow)").length - MAX + 1;
            d.textContent = ` — 已折叠 ${Math.max(n, 1)} 个活动`;
            return;
        }
        const row = holder.createDiv(`dsh-activity ${act.state === "running" ? "is-active" : act.state === "error" ? "is-error" : "is-done"}`);
        const head = row.createDiv("dsh-activity-head");
        head.createSpan("dsh-activity-icon").textContent = act.state === "error" ? "❌" : act.state === "running" ? "⏳" : act.kind === "step" ? "📍" : "✅";
        head.createSpan("dsh-activity-text").textContent = act.label;
        const detail = head.createSpan("dsh-activity-detail");
        const prev = act.resultPreview || act.detail || "";
        if (prev) detail.textContent = " — " + String(prev).replace(/\s+/g, " ").slice(0, 200);
        const argsStr = act.args != null ? (typeof act.args === "string" ? act.args : (() => { try { return JSON.stringify(act.args, null, 2); } catch (_e) { return ""; } })()) : "";
        if (argsStr || act.resultPreview) {
            const body = row.createDiv("dsh-activity-body");
            body.style.display = "none";
            if (argsStr) {
                body.createDiv("dsh-activity-body-label").textContent = "参数";
                body.createEl("pre", { cls: "dsh-activity-body-pre" }).textContent = argsStr;
            }
            if (act.resultPreview) {
                body.createDiv("dsh-activity-body-label").textContent = "结果";
                body.createEl("pre", { cls: "dsh-activity-body-pre" }).textContent = act.resultPreview;
            }
            const chev = head.createSpan("dsh-activity-chev");
            chev.textContent = "▸";
            let open = false;
            head.addEventListener("click", () => {
                open = !open;
                body.style.display = open ? "" : "none";
                chev.textContent = open ? "▾" : "▸";
            });
        }
    }

    // 向上翻页：拉取比当前最旧事件更早的一批历史
    async loadOlder() {
        if (this._loadingOlder || !this._hasMore || this._oldestSeq == null || !this.sessionId) return;
        this._loadingOlder = true;
        try {
            await this.loadHistory(this.sessionId, this._oldestSeq);
        } catch (_e) { /* 忽略 */ }
        finally { this._loadingOlder = false; }
    }

    addUserBubbleFromEvent(ev, atTop = false) {
        const d = ev.data || ev;
        let text = "";
        if (typeof d.text === "string") text = d.text;
        else if (Array.isArray(d.content)) {
            // vscode fold.ts extractUserText：用 \n\n join，让注入的段落与用户文本保持空行分隔，
            // 否则段落级 stripSystemContext 会把注入合并到用户文本里、剥不掉
            text = d.content.map((c) => (c && typeof c.text === "string") ? c.text : "").filter(Boolean).join("\n\n");
        } else if (typeof d.content === "string") text = d.content;
        if (!text) return;
        // 剥注入（运行时快照/策略变更以 user/message 形式回推时必须 strip）
        const cleaned = stripSystemContext(text);
        if (!cleaned) return; // 整段都是注入就别渲染
        // 去重：send() 已本地渲染过的、DSH 又回推的 user/message 不显示第二次
        const key = (cleaned.replace(/\s+/g, " ").trim());
        if (!this._userTextsSent) this._userTextsSent = new Set();
        if (this._userTextsSent.has(key)) return;
        if (this._userTextsSent.size >= 64) this._userTextsSent.clear(); // 简单抗膨胀
        this._userTextsSent.add(key);
        // 收到一条不在历史里的新 user/message → 退出 WS catchup，后续 assistant 事件正常处理
        if (this._wsCatchup) {
            console.log(`[DSH MSG] exit catchup due to new user/message key=${JSON.stringify(key.slice(0,50))}`);
            this._wsCatchup = false;
        }
        // 实时候推防重复（关键修复）：DSH 会在发送后以 user/message 回推同一条消息。
        // 仅当末尾是「活跃助手气泡」(this.assistantEl) 时跳过——此时本地用户消息已在其上方。
        // 历史首屏渲染末尾是静态助手气泡（非 assistantEl），不能跳过，否则交替 U/A 中 user 消息会丢失。
        if (!atTop && this.messagesEl) {
            const last = this.messagesEl.lastElementChild;
            if (last) {
                if (last === this.assistantEl) {
                    console.log(`[DSH MSG] fromEvent SKIP(last is active assistant) key=${JSON.stringify(key.slice(0,50))}`);
                    return;
                }
                if (last.classList.contains("dsh-msg-user")) {
                    const c = last.querySelector(".dsh-msg-content");
                    if (c && (c.textContent || "").replace(/\s+/g, " ").trim() === key) {
                        console.log(`[DSH MSG] fromEvent SKIP(last user matches) key=${JSON.stringify(key.slice(0,50))}`);
                        return;
                    }
                }
            }
        }
        console.log(`[DSH MSG] fromEvent ADD atTop=${atTop} key=${JSON.stringify(key.slice(0,50))} childCount=${this.messagesEl ? this.messagesEl.children.length : '?'}`);
        this.addUserBubble(cleaned, atTop, Array.isArray(d.images) && d.images.length ? d.images : null);
    }

    // v0.4.0 用户消息图片渲染：attachmentId → dataUrl（带进程内缓存，失败降级占位）
    _renderUserImages(bubble, images) {
        if (!this._attachCache) this._attachCache = new Map();
        const box = bubble.createDiv("dsh-msg-images");
        for (const img of images) {
            const id = img && img.attachmentId;
            if (!id) continue;
            const el = box.createEl("img", { cls: "dsh-msg-image", attr: { alt: img.name || "图片", loading: "lazy" } });
            const cached = this._attachCache.get(id);
            if (cached) { el.src = cached; continue; }
            el.addClass("is-loading");
            const sid = this.sessionId;
            this.api.getAttachment(sid, id).then((v) => {
                const mediaType = (v && v.attachment && v.attachment.mediaType) || img.mediaType || "image/png";
                const data = v && typeof v.data === "string" ? v.data : "";
                if (!data) throw new Error("empty attachment data");
                const url = `data:${mediaType};base64,${data}`;
                this._attachCache.set(id, url);
                el.src = url;
                el.removeClass("is-loading");
            }).catch(() => {
                el.removeClass("is-loading");
                el.addClass("is-broken");
                el.replaceWith(Object.assign(document.createElement("span"), { textContent: "🖼️（图片加载失败）", className: "dsh-msg-image-fallback" }));
            });
        }
    }

    scrollToBottom() {
        if (!this.messagesEl) return;
        // 用户上滑后 _autoScroll=false，不自动滚动；回到底部后 scroll 事件会恢复为 true
        if (this._autoScroll === false) return;
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    }

    // 实时活动指示条（composer 上方）：子代理/工具执行中显示「正在执行：XXX」（Bug 4 增强）
    // 内含停止按钮（仅运行中可见），Esc 亦可中断（Phase A）
    setLiveBar(text) {
        if (!this.liveBar) return;
        if (this.liveBarLabel) this.liveBarLabel.textContent = text; // 文案与 VSCode 一致（正在执行：… / 思考中…），旋转指示由 .dsh-spinner 承担
        this.liveBar.style.display = "flex";
    }
    clearLiveBar() {
        if (!this.liveBar) return;
        this.liveBar.style.display = "none";
        if (this.liveBarLabel) this.liveBarLabel.textContent = "";
    }
    // Phase A：向 DSH 发送 session.cancel，中断当前生成中的 turn
    requestCancel() {
        if (!this.sessionId) return;
        this.api.cancel(this.sessionId).catch(() => {});
        new Notice("已发送中断请求");
    }
    // 检查是否还有未完成的工具/子代理活动
    _hasRunningActivity() {
        if (!this._activities) return false;
        for (const [k, v] of this._activities) {
            if (k === "__overflow__") continue;
            if (v && !v.finished) return true;
        }
        return false;
    }

    /* ---------- WebSocket 事件流（订阅 plugin 主进程手写 WS 客户端，规避 Chromium 全局 WS 的 Origin 拦截） ---------- */
    connectWs() {
        // 主进程已经在 plugin onload 里建好 WS；view 只是订阅
        // 先取消旧订阅（idempotent）
        this.plugin.wsUnsubscribe(this._frameHandler);
        this.plugin.wsStatusUnsubscribe(this._statusHandler);

        this._frameHandler = (frame) => {
            // 计数 + 诊断
            const ft = frame?.payload?.type;
            if (ft) {
                this.diagLastFrameTypes = (this.diagLastFrameTypes || []);
                this.diagLastFrameTypes.push(ft);
                if (this.diagLastFrameTypes.length > 6) this.diagLastFrameTypes.shift();
            }
            if (ft === "assistant/chunk") this.diagChunkCount = (this.diagChunkCount || 0) + 1;
            this.handleFrame(frame);
        };
        this._statusHandler = () => {
            const s = this.plugin.getWsStatus();
            this.wsConnected = s.connected;
            this.diagReconnectCount = s.reconnectCount;
            this.diagFrameCount = s.frameCount;
            this.diagChunkCount = s.chunkCount;
            this.diagLastFrameTypes = s.lastFrameTypes;
            if (s.connected) {
                this.setStatus("online");
                this.updateDiag();
            } else {
                this.setStatus("offline");
                this.updateDiag(s.closeReason || "ws:off");
            }
        };
        this.plugin.wsSubscribe(this._frameHandler);
        this.plugin.wsStatusSubscribe(this._statusHandler);
        // 立即拉一次当前状态（plugin 可能在 view 打开前就已连上/断了）
        this._statusHandler();
    }

    updateDiag(note) {
        if (!this.statusLine) return;
        const parts = [];
        parts.push(this.wsConnected ? "ws:on" : "ws:off");
        // 构建指纹：明确告诉用户"plugin 加载到的是哪版 main.js"
        const build = (this.plugin && this.plugin._buildTag) ? this.plugin._buildTag.split("-")[2] : "?";
        parts.push("build:" + build);
        if (this.diagReconnectCount) parts.push("re:" + this.diagReconnectCount);
        if (this.diagFrameCount) parts.push("frames:" + this.diagFrameCount);
        if (this.diagChunkCount) parts.push("chunks:" + this.diagChunkCount);
        if (this.diagLastFrameTypes && this.diagLastFrameTypes.length) parts.push("last:" + this.diagLastFrameTypes.join("/"));
        if (this.diagTokens) parts.push("·" + this.diagTokens);
        if (this.diagLastPrompt) parts.push("·" + this.diagLastPrompt);
        // note 只承载"瞬时信号"（close code / reason / ws:err 等），不重复写 ws:on/off
        if (note && !parts.includes(note)) parts.push("·" + note);
        this.statusLine.setText(parts.join("  "));
    }

    // token 用量行（对齐 VSCode .composer-meta）：控制条下方右对齐小字，无数据时隐藏
    updateComposerMeta() {
        if (!this.composerMeta) return;
        // v0.4.0：运行计时前置（对齐 VSCode Elapsed），token 用量随后
        const elapsed = this._elapsedText();
        const t = this.diagTokens || "";
        const text = [elapsed ? `⏱ ${elapsed}` : "", t].filter(Boolean).join("  ");
        if (!text) { this.composerMeta.style.display = "none"; return; }
        this.composerMeta.textContent = text;
        this.composerMeta.style.display = "";
    }

    closeWs() {
        if (this._frameHandler) this.plugin.wsUnsubscribe(this._frameHandler);
        if (this._statusHandler) this.plugin.wsStatusUnsubscribe(this._statusHandler);
        this._frameHandler = null;
        this._statusHandler = null;
        this.wsConnected = false;
    }

    handleFrame(frame) {
        const payload = frame.payload;
        if (!payload) return;
        const sessionId = payload.sessionId;
        // 只处理当前会话（WS 会广播所有会话）；其他会话的新事件 → 未读徽标（v0.4.0 对齐 VSCode unread）
        if (sessionId && this.sessionId && sessionId !== this.sessionId) {
            if (payload.type === "session/event") {
                if (!this._unread) this._unread = new Set();
                if (!this._unread.has(sessionId)) {
                    this._unread.add(sessionId);
                    this.renderSessionList();
                }
            }
            return;
        }

        switch (payload.type) {
            case "session/event":
                this.handleSessionEvent(payload.event);
                break;
            case "session/projection":
                this.handleProjection(payload);
                break;
            case "session/queue":
                // Phase F：运行中追加的排队消息（DSH 在每次连接时重放基线）
                this.renderQueueStrip(payload);
                break;
            case "approval/requested":
                this.handleApproval(payload, frame.rpcId);
                break;
            case "approval/resolved":
                this.clearPending("a:" + payload.approvalId);
                break;
            case "question/requested":
                this.handleQuestion(payload, frame.rpcId);
                break;
            case "question/resolved":
                this.clearPending("q:" + payload.questionRpcId);
                break;
            default:
                break;
        }
    }

    handleSessionEvent(ev) {
        if (!ev) return;
        // 精确过滤 WS 重放：历史已从 REST 渲染后，记录了最后一条事件的 seq。
        // WS 连接后会重放整个会话，seq <= _lastHistorySeq 的事件都是旧数据，直接跳过。
        // 这比布尔 catchup 更精准：不受"用户发消息时重放还没结束"的时序影响。
        if (typeof ev.seq === "number" && typeof this._lastHistorySeq === "number" && ev.seq <= this._lastHistorySeq) {
            console.log(`[DSH MSG] handleSessionEvent SKIP(seq ${ev.seq} <= history ${this._lastHistorySeq}) type=${ev.type}`);
            return;
        }
        // 兼容兜底：WS 事件可能不带 seq（旧版协议），此时用布尔 catchup 过滤 assistant 事件
        if (this._wsCatchup && (ev.type === "turn/start" || ev.type === "assistant/chunk" || ev.type === "turn/end" || ev.type === "assistant/message")) {
            console.log(`[DSH MSG] handleSessionEvent SKIP(catchup fallback) type=${ev.type}`);
            return;
        }
        // 处理新事件后推进 _lastHistorySeq，防止 WS 重连后重放已处理过的新事件
        if (typeof ev.seq === "number" && (typeof this._lastHistorySeq !== "number" || ev.seq > this._lastHistorySeq)) {
            this._lastHistorySeq = ev.seq;
        }
        switch (ev.type) {
            case "user/message": {
                // vscode fold.ts：user/message 走 stripSystemContext；这里补齐 Obsidian 漏掉的事件处理
                // 注入的运行时快照/策略变更以独立 user/message 形式回推，必须 strip 后再渲染
                this.addUserBubbleFromEvent(ev);
                break;
            }
            case "turn/start":
                this._gotAssistantChunks = false;
                this.beginAssistantBubble();
                this._running = true;
                this.startElapsed();
                this.updateSendState();
                this.setLiveBar("思考中…");
                break;
            case "assistant/chunk": {
                const chunk = ev.data && ev.data.chunk;
                if (!chunk) break;
                this.diagChunkCount = (this.diagChunkCount || 0) + 1;
                // 跳过纯元数据 chunk（仅更新内部计数，不渲染）
                if (chunk.type === "usage" || chunk.type === "finish") {
                    break;
                }
                // 真实文字 delta：text-delta (普通文字) / reasoning-delta (思考文字)
                if (chunk.type === "text-delta" || chunk.type === "reasoning-delta") {
                    if (typeof chunk.text !== "string" || chunk.text.length === 0) break;
                    this._contentSetByWs = true;
                    if (chunk.type === "text-delta") this._gotAssistantChunks = true;
                    this.appendAssistant(chunk.text, chunk.type === "reasoning-delta");
                    break;
                }
                // 修复 Bug 4：工具 / 子代理 / 块开始结束等"非文本但用户该看到"的事件 → 渲染成活动卡片
                if (chunk.type === "block-start" || chunk.type === "block-end"
                    || chunk.type === "tool-call" || chunk.type === "tool-call-delta"
                    || chunk.type === "tool-result" || chunk.type === "tool-call-result"
                    || chunk.type === "step-start" || chunk.type === "step-end"
                    || chunk.type === "agent-start" || chunk.type === "agent-end"
                    || chunk.type === "subagent-start" || chunk.type === "subagent-end") {
                    this.appendActivity(chunk);
                    break;
                }
                // 其他未知 chunk：记入诊断，但不当文本渲染（避免把内部协议 JSON 泄漏到气泡里）
                this.diagLastFrameTypes = (this.diagLastFrameTypes || []);
                this.diagLastFrameTypes.push("?chunk:" + chunk.type);
                if (this.diagLastFrameTypes.length > 6) this.diagLastFrameTypes.shift();
                break;
            }
            case "assistant/message": {
                // 兜底：DSH 有时把整段回复（含注入块）放在 assistant/message，而非走
                // assistant/chunk 流式（VSCode fold.ts:129 同样做 strip 兜底）。剥系统上下文后渲染。
                // 若本轮已收到 text-delta 流式内容，跳过避免重复（chunk 与 message 不会同时到）。
                if (this._gotAssistantChunks) break;
                const m = ev.data && (ev.data.message || ev.data.content || ev.data);
                const raw = typeof m === "string" ? m : (m && m.content);
                if (typeof raw === "string" && raw) {
                    const cleaned = preprocessAssistantText(raw);
                    if (cleaned && cleaned.trim()) this.appendAssistant(cleaned, false);
                }
                break;
            }
            case "turn/end":
                this.finalizeAssistant();
                this._running = false;
                this.stopElapsed();
                this.updateSendState();
                // 全量对账：400ms 后从权威 history 重建，消除增量渲染累积的所有错误
                this.scheduleReconcile();
                break;
            // ---- 持久事件（历史页/实时都可能到达；v2 折叠管线对齐）----
            case "chunkrow/text-chunks": {
                // 历史页正文压缩形态：texts[] 拼接（不接必丢正文）
                const texts = ev.data && ev.data.texts;
                if (Array.isArray(texts) && texts.length) {
                    this._contentSetByWs = true;
                    this._gotAssistantChunks = true;
                    this.appendAssistant(texts.join(""), false);
                }
                break;
            }
            case "chunkrow/reasoning-chunks": {
                const texts = ev.data && ev.data.texts;
                if (Array.isArray(texts) && texts.length) {
                    this._contentSetByWs = true;
                    this.appendAssistant(texts.join(""), true);
                }
                break;
            }
            case "tool/call": {
                const d = ev.data || {};
                this.appendActivity({ type: "tool-call", data: { callId: d.callId, name: d.name, toolName: d.name, args: d.arguments != null ? d.arguments : d.args } });
                break;
            }
            case "tool/result": {
                const d = ev.data || {};
                const preview = foldExtractResultPreview(d, undefined);
                this.appendActivity({
                    type: "tool-result",
                    data: {
                        callId: foldResultCallId(d),
                        toolCallId: foldResultCallId(d),
                        result: preview,
                        error: foldIsErrorResult(d) ? "工具执行出错" : undefined,
                    },
                });
                break;
            }
            case "step/start": {
                const d = ev.data || {};
                this.appendActivity({ type: "step-start", data: { id: d.id, title: d.title || d.name, step: d.step } });
                break;
            }
            case "step/end": {
                const d = ev.data || {};
                this.appendActivity({ type: "step-end", data: { id: d.id } });
                break;
            }
            default:
                break;
        }
    }

    handleProjection(p) {
        if (p.key === "tokenUsage" || p.key === "liveTokenUsage") {
            const v = p.value || {};
            const parts = [];
            if (v.outputTokens != null) parts.push(`out ${v.outputTokens}`);
            if (v.uncachedInputTokens != null) parts.push(`in ${v.uncachedInputTokens}`);
            if (v.cacheReadTokens != null) parts.push(`cache ${v.cacheReadTokens}`);
            this.diagTokens = parts.join("  ·  ");
            this.updateDiag();
            this.updateComposerMeta();
        } else if (p.key === "title" && this.sessionId) {
            // 更新当前会话标题；若用户手动重命名过（manualTitles），则不覆盖本地覆盖
            const s = this.sessions.find((x) => x.sessionId === this.sessionId);
            const override = this.plugin && this.plugin.settings && this.plugin.settings.manualTitles
                ? this.plugin.settings.manualTitles[this.sessionId] : null;
            if (s && !override && typeof p.value === "string" && p.value) {
                s.title = p.value;
                // DSH 自动命名也进缓存，重启后会话列表仍能显示（手动重命名优先级更高）
                if (this.plugin && this.plugin.settings) {
                    this.plugin.settings.autoTitles = this.plugin.settings.autoTitles || {};
                    if (!this.plugin.settings.autoTitles[this.sessionId]) {
                        this.plugin.settings.autoTitles[this.sessionId] = p.value;
                        try { this.plugin.saveSettings(); } catch (_e) {}
                    }
                }
                this.renderSessionList();
                this.updateTitleBtn();
            }
        } else if (p.key === "plan") {
            // plan 投影：{active:boolean, ...}（VSCode manager.ts:251 同款）
            this._planActive = !!(p.value && p.value.active);
            this.renderPlanStrip();
        } else if (p.key === "todos") {
            // todos 投影：[{content, status}]（status: pending|in_progress|completed）
            this._todos = Array.isArray(p.value) ? p.value : null;
            this.renderPlanStrip();
        } else if (p.key === "permissions") {
            // 实时更新当前权限值（投影通道），并刷新 revision 以便下次写入不冲突
            if (!this.permSelect) return;
            const v = p.value;
            let cur = null;
            if (typeof v === "string") cur = v;
            else if (v && typeof v === "object") {
                cur = v.currentPreset || v.currentValue || v.preset || v.value || v.name || null;
            }
            // 先看现有 option 里有没有；没有则临时塞一个
            if (cur) {
                let exists = false;
                for (const opt of Array.from(this.permSelect.options)) {
                    if (opt.value === cur) { opt.selected = true; exists = true; break; }
                }
                if (!exists) {
                    const opt = this.permSelect.createEl("option", { value: cur });
                    opt.textContent = cur;
                    opt.selected = true;
                    this.permSelect.disabled = false;
                }
            }
            // revision 同步过来（projection 也带 revision）
            if (typeof p.seq === "number") this._permRevision = p.seq;
            if (typeof p.revision === "number") this._permRevision = p.revision;
        }
    }

    // Phase E：Plan 模式横幅 + Todo 进度条（由 session/projection 的 plan/todos 驱动）
    // 对齐 VSCode dsh-vscode/webview/src/app.tsx:507 的 plan-strip / todo-strip
    renderPlanStrip() {
        const strip = this.planStrip;
        if (!strip) return;
        strip.empty();
        let has = false;
        if (this._planActive) {
            has = true;
            const banner = strip.createDiv("dsh-plan-banner");
            banner.createSpan({ text: "🗺 Plan 模式 — 只读研究，方案需批准后执行" });
            const off = banner.createEl("button", { cls: "dsh-link-btn", text: "退出" });
            off.addEventListener("click", () => {
                if (this.sessionId) {
                    this.api.prompt(this.sessionId, [{ type: "text", text: "/plan off" }], "queue").catch(() => {});
                }
            });
        }
        if (this._todos && this._todos.length) {
            has = true;
            const done = this._todos.filter((t) => t.status === "completed").length;
            const cur = this._todos.find((t) => t.status === "in_progress");
            const head = strip.createEl("div", { cls: "dsh-todo-strip" });
            const count = head.createSpan("dsh-todo-count");
            count.textContent = `${done}/${this._todos.length}`;
            const bar = head.createDiv("dsh-todo-bar");
            const fill = bar.createDiv("dsh-todo-bar-fill");
            fill.style.width = `${this._todos.length ? (done / this._todos.length) * 100 : 0}%`;
            const curEl = head.createSpan("dsh-todo-cur");
            curEl.textContent = cur ? cur.content : (done === this._todos.length ? "全部完成" : "…");
            const chev = head.createSpan("dsh-todo-chev");
            chev.textContent = this._todoOpen ? "▾" : "▸";
            // 点击表头展开/收起任务清单
            if (this._todoOpen == null) this._todoOpen = false;
            head.addEventListener("click", () => {
                this._todoOpen = !this._todoOpen;
                this.renderPlanStrip();
            });
            if (this._todoOpen) {
                const list = strip.createEl("ul", { cls: "dsh-todo-list" });
                for (const t of this._todos) {
                    const li = list.createEl("li", { cls: "dsh-todo-item is-" + (t.status || "pending") });
                    li.createSpan({ cls: "dsh-todo-mark", text: t.status === "completed" ? "✓" : t.status === "in_progress" ? "●" : "○" });
                    li.appendText(t.content || "");
                }
            }
        }
        strip.style.display = has ? "" : "none";
    }

    // Phase F：排队队列条（由 session/queue 帧驱动，展示运行中追加、尚未执行的消息）
    // 对齐 VSCode .queue-strip：虚线 chip 横排，⇢=插队(steering) ⏳=排队
    renderQueueStrip(payload) {
        const strip = this.queueStrip;
        if (!strip) return;
        strip.empty();
        const items = (payload && Array.isArray(payload.items)) ? payload.items : [];
        if (!items.length) { strip.style.display = "none"; return; }
        for (const it of items) {
            const text = ((it.content || []).map((c) => c.text || "").join("") || "").trim() || "（空消息）";
            const chip = strip.createDiv("dsh-queue-chip");
            chip.setAttribute("title", text);
            const pre = chip.createSpan("dsh-queue-pre");
            pre.textContent = it.placement === "steering" ? "⇢" : "⏳";
            const txt = chip.createSpan("dsh-queue-text");
            txt.textContent = text.length > 40 ? text.slice(0, 40) + "…" : text;
            // v0.4.0 队列操作（对齐 VSCode queue-edit/queue-steer）：编辑 / 插队转向 / 移除
            const ed = chip.createEl("span", { cls: "dsh-icon-btn dsh-icon-mini", text: "✎", attr: { title: "编辑排队消息" } });
            ed.addEventListener("click", () => this.queueEditRow(it));
            if (it.placement !== "steering") {
                const st = chip.createEl("span", { cls: "dsh-icon-btn dsh-icon-mini dsh-queue-steer", text: "⇢", attr: { title: "插队转向：立即作用于当前运行轮" } });
                st.addEventListener("click", () => {
                    if (this.sessionId && it.id) {
                        this.api.queueSteer(this.sessionId, it.id).catch((e) => {
                            new Notice("插队失败：" + (e && e.message ? e.message : String(e)));
                        });
                    }
                });
            }
            const rm = chip.createEl("span", { cls: "dsh-icon-btn dsh-icon-mini dsh-queue-rm", text: "×", attr: { title: "移除" } });
            rm.addEventListener("click", () => {
                if (this.sessionId && it.id) {
                    this.api.queueRemove(this.sessionId, it.id).catch(() => {});
                }
            });
        }
        strip.style.display = "";
    }

    // v0.4.0 排队消息编辑弹窗（对齐 VSCode queue-edit：server action kind:"edit"）
    queueEditRow(it) {
        const text = ((it.content || []).map((c) => c.text || "").join("")) || "";
        const modal = new Modal(this.app);
        modal.titleEl.setText("编辑排队消息");
        const ta = modal.contentEl.createEl("textarea", { cls: "dsh-queue-edit-area" });
        ta.value = text;
        ta.rows = 5;
        const row = modal.contentEl.createDiv("dsh-modal-row");
        const ok = row.createEl("button", { cls: "mod-cta", text: "保存" });
        ok.addEventListener("click", () => {
            modal.close();
            if (this.sessionId && it.id && ta.value.trim()) {
                this.api.queueEdit(this.sessionId, it.id, ta.value).catch((e) => {
                    new Notice("编辑失败：" + (e && e.message ? e.message : String(e)));
                });
            }
        });
        const cancel = row.createEl("button", { text: "取消" });
        cancel.addEventListener("click", () => modal.close());
        modal.open();
        ta.focus();
    }

    /* ---------- 审批 / 提问 ---------- */
    handleApproval(payload, rpcIdValue) {
        const key = "a:" + payload.approvalId;
        // 把除已知字段外的额外信息（path / command / args 等）挑出来展示（对齐 Claudian 审批卡）
        const known = new Set(["approvalId", "toolName", "reason", "rpcId"]);
        const extra = {};
        for (const k of Object.keys(payload || {})) {
            if (!known.has(k) && payload[k] != null) {
                const v = payload[k];
                extra[k] = typeof v === "object" ? JSON.stringify(v) : String(v);
            }
        }
        this.pending.set(key, { kind: "approval", rpcId: rpcIdValue, toolName: payload.toolName, reason: payload.reason, extra });
        this.renderPendingCards();
    }

    handleQuestion(payload, rpcIdValue) {
        const key = "q:" + rpcIdValue;
        this.pending.set(key, { kind: "question", rpcId: rpcIdValue, questions: payload.questions });
        this.renderPendingCards();
    }

    clearPending(key) {
        if (this.pending.delete(key)) this.renderPendingCards();
    }

    renderPendingCards() {
        // 移除旧卡片
        this.messagesEl.querySelectorAll(".dsh-pending").forEach((n) => n.remove());
        for (const [key, entry] of this.pending) {
            const card = this.messagesEl.createDiv("dsh-msg dsh-pending");
            if (entry.kind === "approval") {
                const titleEl = card.createDiv("dsh-pending-title");
                titleEl.textContent = "🔐 需要审批：" + (entry.toolName || "");
                if (entry.reason) {
                    const reasonEl = card.createDiv("dsh-pending-reason");
                    reasonEl.textContent = entry.reason;
                }
                if (entry.extra && Object.keys(entry.extra).length) {
                    const kv = card.createDiv("dsh-pending-extra");
                    for (const [k, v] of Object.entries(entry.extra)) {
                        const row = kv.createDiv("dsh-pending-kv");
                        const kk = row.createSpan("dsh-pending-k");
                        kk.textContent = k;
                        const vv = row.createSpan("dsh-pending-v");
                        vv.textContent = v;
                    }
                }
                const actions = card.createDiv("dsh-pending-actions");
                const allowBtn = actions.createEl("button", { cls: "dsh-btn mod-cta" });
                allowBtn.textContent = "允许一次";
                allowBtn.addEventListener("click", () => {
                    this.answerApproval(key, "allowed");
                });
                const denyBtn = actions.createEl("button", { cls: "dsh-btn" });
                denyBtn.textContent = "拒绝";
                denyBtn.addEventListener("click", () => {
                    this.answerApproval(key, "rejected");
                });
            } else {
                // 提问卡片：对齐 VSCode QuestionCardView，支持单选/多选选项 + 自定义回答
                const qTitleEl = card.createDiv("dsh-pending-title");
                qTitleEl.textContent = "❓ DSH 提问";
                const questions = entry.questions || [];
                // 每个问题的答案收集：{ [index]: { selected: Set, custom: string } }
                const answers = {};
                questions.forEach((q, qi) => {
                    const qObj = typeof q === "string" ? { question: q } : q;
                    const label = qObj.label || qObj.question || qObj.text || JSON.stringify(q);
                    const opts = Array.isArray(qObj.options) ? qObj.options : [];
                    const multi = !!qObj.multi;
                    const qWrap = card.createDiv("dsh-question-item");
                    const qLabel = qWrap.createDiv("dsh-question-label");
                    qLabel.textContent = (qi + 1) + ". " + label;
                    answers[qi] = { selected: new Set(), custom: "" };
                    if (opts.length) {
                        const optGroup = qWrap.createDiv("dsh-question-options");
                        opts.forEach((opt, oi) => {
                            const optLabel = typeof opt === "string" ? opt : (opt.label || opt.value || String(opt));
                            const optVal = typeof opt === "string" ? opt : (opt.value || opt.label || String(opt));
                            const row = optGroup.createDiv("dsh-question-option");
                            const cb = row.createEl("input", {
                                attr: { type: multi ? "checkbox" : "radio", name: "q" + qi, value: optVal }
                            });
                            cb.addEventListener("change", () => {
                                if (multi) {
                                    if (cb.checked) answers[qi].selected.add(optVal);
                                    else answers[qi].selected.delete(optVal);
                                } else {
                                    answers[qi].selected.clear();
                                    if (cb.checked) answers[qi].selected.add(optVal);
                                }
                            });
                            const span = row.createSpan("dsh-question-option-text");
                            span.textContent = optLabel;
                            span.addEventListener("click", () => { cb.click(); });
                        });
                    }
                    // 自定义回答输入
                    const customInput = qWrap.createEl("input", {
                        cls: "dsh-native-input dsh-question-custom",
                        attr: { type: "text", placeholder: "或输入自定义回答…" }
                    });
                    customInput.addEventListener("input", () => { answers[qi].custom = customInput.value; });
                });
                const actions = card.createDiv("dsh-pending-actions");
                const ansBtn = actions.createEl("button", { cls: "dsh-btn mod-cta" });
                ansBtn.textContent = "回答";
                ansBtn.addEventListener("click", () => {
                    // 组装答案：优先自定义回答，否则选选项
                    const finalAnswers = questions.map((q, qi) => {
                        const a = answers[qi];
                        if (a.custom) return a.custom;
                        return Array.from(a.selected).join(", ");
                    });
                    this.answerQuestion(key, finalAnswers);
                });
            }
            this.scrollToBottom();
        }
    }

    async answerApproval(key, outcome) {
        const entry = this.pending.get(key);
        if (!entry) return;
        const approvalId = key.slice(2);
        try {
            await this.api.respond(entry.rpcId, {
                sessionId: this.sessionId,
                approvalId,
                outcome,
            });
        } catch (e) {
            new Notice("审批回复失败：" + e.message);
        }
        this.clearPending(key);
    }

    async answerQuestion(key, answers) {
        const entry = this.pending.get(key);
        if (!entry) return;
        // answers 可以是字符串（旧格式）或字符串数组（新格式，每个问题一个答案）
        const ansArr = Array.isArray(answers) ? answers : (entry.questions || []).map(() => answers);
        try {
            await this.api.respond(entry.rpcId, {
                sessionId: this.sessionId,
                answer: { answers: ansArr },
            });
        } catch (e) {
            new Notice("回答失败：" + e.message);
        }
        this.clearPending(key);
    }
}

/* ====================================================================
 * 历史会话浏览器（Modal）
 * ================================================================== */
class HistoryModal extends Modal {
    constructor(app, view) {
        super(app);
        this.view = view;
    }
    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("dsh-history-modal");
        const head = contentEl.createDiv("dsh-history-head");
        head.setText("历史会话");
        const search = contentEl.createEl("input", {
            cls: "dsh-history-search",
            attr: { placeholder: "搜索会话名 / ID…", type: "text" },
        });
        const list = contentEl.createDiv("dsh-history-list");
        const render = (q) => {
            list.empty();
            const all = this.view.sessions || [];
            const ql = (q || "").trim().toLowerCase();
            const filtered = all.filter((s) => {
                if (!ql) return true;
                const t = (s.title || "") + " " + (s.sessionId || "");
                return t.toLowerCase().includes(ql);
            });
            if (filtered.length === 0) {
                list.createDiv("dsh-history-empty").setText("无匹配会话");
                return;
            }
            for (const s of filtered) {
                const row = list.createDiv("dsh-history-row");
                const name = row.createDiv("dsh-history-name");
                name.setText(this.view._tabTitle(s));
                const meta = row.createDiv("dsh-history-meta");
                meta.setText(s.sessionId);
                if (s.sessionId === this.view.sessionId) row.addClass("is-current");
                row.addEventListener("click", () => {
                    this.view.openSessionAsTab(s.sessionId);
                    this.close();
                });
            }
        };
        search.addEventListener("input", () => render(search.value));
        // 自动聚焦搜索框
        setTimeout(() => { try { search.focus(); } catch (_e) {} }, 30);
        render("");
    }
    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

/* ====================================================================
 * 设置页
 * ================================================================== */
class DshNativeSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }
    display() {
        const { containerEl } = this;
        containerEl.empty();
        const buildTag = (this.plugin && this.plugin._buildTag) || "?";
        new Setting(containerEl)
            .setName("插件版本")
            .setDesc("当前加载的 main.js 构建标识（反馈问题时对照用）。")
            .addText((t) => t.setValue(buildTag).setDisabled(true));
        new Setting(containerEl)
            .setName("插件作者")
            .setDesc("本插件的作者。")
            .addText((t) => t.setValue("wupang").setDisabled(true));
        new Setting(containerEl).setName("服务端口").setDesc("DSH Web 服务端口，默认 3080。").addText((t) =>
            t.setPlaceholder("3080").setValue(String(this.plugin.settings.port)).onChange(async (v) => {
                const n = parseInt(v, 10);
                if (!isNaN(n)) {
                    this.plugin.settings.port = n;
                    await this.plugin.saveSettings();
                }
            })
        );
        new Setting(containerEl).setName("启动命令").setDesc("启动 dsh web 的命令，{port} 自动替换。必须以 vault 为 cwd 启动（见 CLAUDE.md）。").addText((t) =>
            t.setPlaceholder('node "..."\\bin.js web --port {port}').setValue(this.plugin.settings.startupCommand).onChange(async (v) => {
                this.plugin.settings.startupCommand = v;
                await this.plugin.saveSettings();
            })
        );
        new Setting(containerEl).setName("自动启动").setDesc("打开面板时若端口无服务，自动运行启动命令。").addToggle((t) =>
            t.setValue(this.plugin.settings.autoStart).onChange(async (v) => {
                this.plugin.settings.autoStart = v;
                await this.plugin.saveSettings();
            })
        );
        new Setting(containerEl).setName("Vault 路径").setDesc("DSH 工作区绑定的文件夹；留空则用当前 vault 根目录。").addText((t) =>
            t.setPlaceholder(this.plugin.app.vault.adapter.basePath).setValue(this.plugin.settings.vaultPath).onChange(async (v) => {
                this.plugin.settings.vaultPath = v.trim();
                await this.plugin.saveSettings();
            })
        );

        // ===== DSH 安装状态 =====
        const os = require("os");
        const path = require("path");
        const defaultInstallDir = this.plugin.settings.installDir || path.join(os.homedir(), "deepseek-harness");
        new Setting(containerEl)
            .setName("DSH 安装状态")
            .setDesc("检查 DSH（@deepseek-ai/dsh）是否已安装；未安装时可一键克隆 + install。")
            .addButton((b) => b.setButtonText("重新检测").onClick(async () => {
                this._dshStatusEl.setText("检测中…");
                const r = detectDsh();
                this._dshStatus(r, defaultInstallDir);
            }))
            .addButton((b) => b.setButtonText("一键安装").onClick(async () => {
                const target = this.plugin.settings.installDir || path.join(os.homedir(), "deepseek-harness");
                this._dshStatusEl.setText("开始安装到 " + target + " …");
                new Notice("DSH 克隆开始（首次较慢，可能 1-5 分钟）", 0);
                const result = await installDsh(target, ({ phase, stream, text }) => {
                    if (phase) this._dshStatusEl.setText(phase);
                    else if (text && stream === "stderr") {
                        // git/pnpm 进度只取末尾几行，避免 statusEl 刷屏
                        const tail = text.trim().split("\n").slice(-1)[0].slice(0, 80);
                        if (tail) this._dshStatusEl.setText("… " + tail);
                    }
                }, this.plugin.settings.installUrl);
                this._dshStatusEl.setText(result.message);
                if (result.ok) {
                    new Notice("DSH 安装完成 ✓", 5000);
                    // 把配置自动填上
                    this.plugin.settings.startupCommand = "pnpm dsh web --port {port}";
                    this.plugin.settings.installDir = result.dir || target;
                    await this.plugin.saveSettings();
                    // 重新刷一下展示
                    this.display();
                } else {
                    new Notice("安装失败：" + result.message, 10000);
                }
            }));
        // 安装目标目录
        new Setting(containerEl)
            .setName("安装目标目录")
            .setDesc("一键安装克隆到此目录。留空用 ~/deepseek-harness。")
            .addText((t) =>
                t.setPlaceholder(defaultInstallDir).setValue(this.plugin.settings.installDir).onChange(async (v) => {
                    this.plugin.settings.installDir = v.trim();
                    await this.plugin.saveSettings();
                })
            );
        // 状态行
        const statusRow = new Setting(containerEl).setName("状态").setDesc("");
        this._dshStatusEl = statusRow.descEl;
        this._dshStatusEl.style.fontFamily = "var(--font-monospace,monospace)";
        // 首次进入页面就跑一次
        const r = detectDsh();
        this._dshStatus(r, defaultInstallDir);

        // ===== 收发模式（mode）=====
        new Setting(containerEl)
            .setName("发送模式")
            .setDesc("session.prompt 的 mode：queue（追加排队）/ steer（打断当前轮，DSH 决定是插入还是转下一条）。")
            .addDropdown((d) =>
                d
                    .addOption("queue", "queue（默认，追加排队）")
                    .addOption("steer", "steer（打断/插队）")
                    .setValue(this.plugin.settings.mode || "queue")
                    .onChange(async (v) => {
                        this.plugin.settings.mode = v;
                        await this.plugin.saveSettings();
                    })
            );

        // ===== 快捷操作 =====
        new Setting(containerEl).setName("在浏览器打开 DSH").setDesc("用系统默认浏览器打开 DSH Web GUI（独立窗口，不受侧栏面板限制）。").addButton((b) =>
            b.setButtonText("打开").onClick(() => this.plugin.openDshInBrowser())
        );
        new Setting(containerEl).setName("重启 DSH 服务").setDesc("结束占用端口的进程并重新启动；用于加载配置改动或面板卡住。").addButton((b) =>
            b.setButtonText("重启").onClick(async () => {
                b.setDisabled(true);
                await this.plugin.restartService();
                b.setDisabled(false);
            })
        );
        new Setting(containerEl).setName("一键检测并填入").setDesc("已安装 DSH 时，自动检测位置并填好启动命令 / 工作目录 / 安装目录。").addButton((b) =>
            b.setButtonText("检测并填入").onClick(async () => {
                b.setDisabled(true);
                const r = detectDsh();
                if (r.found) {
                    this.plugin.settings.startupCommand = r.startupCommand;
                    if (r.startupCwd) this.plugin.settings.vaultPath = r.startupCwd;
                    if (r.dir) this.plugin.settings.installDir = r.dir;
                    await this.plugin.saveSettings();
                    new Notice("已自动填入：" + r.message);
                    this.display();
                } else {
                    new Notice(r.message);
                }
                b.setDisabled(false);
            })
        );

        // ===== 收发 =====
        new Setting(containerEl).setName("框选发送按钮").setDesc("在编辑器框选文字后，选区旁显示「发送到 DSH」浮动按钮（命令面板与右键菜单始终可用）。").addToggle((t) =>
            t.setValue(this.plugin.settings.selectionButton).onChange(async (v) => {
                this.plugin.settings.selectionButton = v;
                await this.plugin.saveSettings();
                if (!v) this.plugin.hideSelectionButton();
            })
        );
        new Setting(containerEl).setName("发送后自动打开面板").setDesc("从笔记发送文字到 DSH 后，自动打开/聚焦 DSH 面板查看回复。").addToggle((t) =>
            t.setValue(this.plugin.settings.openPanelOnSend).onChange(async (v) => {
                this.plugin.settings.openPanelOnSend = v;
                await this.plugin.saveSettings();
            })
        );

        // ===== 高级 =====
        new Setting(containerEl).setName("启动等待时间").setDesc("自动启动后等待服务就绪的最长时间（当前 " + Math.round(this.plugin.settings.readyTimeoutMs / 1000) + " 秒）；首次启动可能需 1–2 分钟。").addSlider((s) =>
            s.setLimits(60, 600, 30).setValue(Math.round(this.plugin.settings.readyTimeoutMs / 1000)).onChange(async (v) => {
                this.plugin.settings.readyTimeoutMs = v * 1000;
                await this.plugin.saveSettings();
                this.plugin.serviceManager.opts = this.plugin.getServiceOpts();
            })
        );
        new Setting(containerEl).setName("进程独立常驻").setDesc("开启后，插件启动的 DSH 进程在 Obsidian 退出后继续运行（默认关：随 Obsidian 退出而终止）。").addToggle((t) =>
            t.setValue(this.plugin.settings.detached).onChange(async (v) => {
                this.plugin.settings.detached = v;
                await this.plugin.saveSettings();
                this.plugin.serviceManager.opts = this.plugin.getServiceOpts();
            })
        );
        new Setting(containerEl).setName("安装地址").setDesc("克隆 DSH 的仓库地址；国内网络受限时可换代理镜像（如 https://gh-proxy.com/https://github.com/deepseek-ai/deepseek-harness.git）。").addText((t) =>
            t.setPlaceholder(DEFAULT_DSH_REPO_URL).setValue(this.plugin.settings.installUrl).onChange(async (v) => {
                this.plugin.settings.installUrl = v.trim() || DEFAULT_DSH_REPO_URL;
                await this.plugin.saveSettings();
            })
        );
        new Setting(containerEl).setName("鉴权 Token（兜底）").setDesc("DSH 0.1.2+ 需要鉴权。正常留空：插件自动从 ~/.dsh/.credentials.yaml 铸永久 cookie。仅在自动鉴权失败时，把浏览器地址栏里的启动 token 粘到这里。").addText((t) =>
            t.setPlaceholder("留空 = 自动铸 cookie").setValue(this.plugin.settings.authToken).onChange(async (v) => {
                this.plugin.settings.authToken = v.trim();
                await this.plugin.saveSettings();
                if (this.plugin.auth) this.plugin.auth.invalidate(); // 下次请求重走鉴权链
            })
        );
    }
    _dshStatus(r, defaultInstallDir) {
        if (!this._dshStatusEl) return;
        if (r.found) {
            this._dshStatusEl.setText(
                "✓ 已找到 (" + r.kind + ")：" + (r.dir || "PATH") +
                "\n启动命令：" + r.startupCommand +
                (r.startupCwd ? "\ncwd：" + r.startupCwd : "")
            );
        } else {
            this._dshStatusEl.setText(
                "✗ " + r.message +
                "\n点击上方「一键安装」将克隆到：" + defaultInstallDir
            );
        }
    }
}

/* ====================================================================
 * 插件主类
 * ================================================================== */
class DshNativePlugin extends Plugin {
    async onload() {
        await this.loadSettings();
        this.api = new DshApi(`http://127.0.0.1:${this.settings.port}`);
        this.serviceManager = new ServiceManager(this.getServiceOpts());
        // v012 鉴权链：手动 token（设置项）→ 铸 cookie（credentials 持久密钥）→ 日志 token
        this.auth = new DshAuth({
            home: process.env.USERPROFILE || process.env.HOME || "",
            getManualToken: () => (this.settings && this.settings.authToken) || "",
        });
        this.api.bindAuth(this.auth);
        this.flavor = "legacy"; // 当前协议代（detectAndConnect 会刷新）
        this._detecting = false;

        // === 版本指纹（用于诊断"Obsidian 是否加载到新版 main.js"） ===
        const BUILD_TAG = "dsh-native-v0.6.0-" + new Date().toISOString();
        console.log("[dsh-native] BUILD_TAG =", BUILD_TAG);
        try {
            require("fs").writeFileSync(
                require("path").join(this.app.vault.adapter.basePath, ".obsidian", "plugins", this.manifest.id, "last_loaded.txt"),
                BUILD_TAG + "\n",
                "utf8"
            );
        } catch (e) { /* ignore */ }
        this._buildTag = BUILD_TAG;

        // ===== WebSocket 事件流状态 + 订阅（主进程级手写 WS 客户端，规避 Chromium 全局 WS 的 Origin 信任拦截） =====
        this.wsConnected = false;
        this.wsFrameCount = 0;
        this.wsChunkCount = 0;
        this.wsReconnectCount = 0;
        this.wsLastFrameTypes = []; // 最近若干帧的 payload.type
        this.wsCloseReason = null; // 最近一次 close 的 code/reason
        this.eventSubs = new Set(); // 收到每条帧时回调
        this.statusSubs = new Set(); // ws 状态变化时回调（立即拿到 getWsStatus）
        this._wsReconnectTimer = null;
        this.ws = null;
        // 协议探测 + WS 桥接（v012→remote.mux 帧协议；legacy→events.mux 原路径）
        this.detectAndConnect();

        this.registerView(VIEW_TYPE, (leaf) => new DshNativeView(leaf, this));

        this.addRibbonIcon("bot", "打开 DeepSeek Harness", () => this.activateView());
        this.addCommand({ id: "open-panel", name: "打开面板", callback: () => this.activateView() });
        this.addCommand({ id: "restart-service", name: "重启 DSH 服务", callback: () => this.restartService() });
        this.addCommand({
            id: "open-in-browser",
            name: "在浏览器打开 DSH",
            callback: () => require("electron").shell.openExternal(`http://127.0.0.1:${this.settings.port}/`),
        });
        this.addCommand({
            id: "send-note-to-dsh",
            name: "发送当前笔记到 DSH",
            callback: () => this.sendCurrentNote(),
        });
        this.addCommand({
            id: "attach-active-context",
            name: "引用选区/笔记到 DSH（Alt+K）",
            callback: () => {
                const view = this.getView();
                if (!view) { new Notice("请先打开 DSH 面板"); return; }
                view.attachActiveContext();
            },
        });

        this.addSettingTab(new DshNativeSettingTab(this.app, this));

        // 框选浮动发送按钮：Obsidian 无选区工作区事件，由文档级 mouseup/keyup/selectionchange 驱动
        const onSel = () => this.onSelectionEvent(true);
        this.registerDomEvent(document, "mouseup", onSel);
        this.registerDomEvent(document, "keyup", onSel);
        this.registerDomEvent(document, "selectionchange", () => this.onSelectionEvent(false));
    }

    onunload() {
        this.closeDshWs();
        this.serviceManager.dispose();
    }

    /* ========== WebSocket 事件流桥接（主进程级，手写 WS 客户端） ==========
     * DSH 的 /api/events.mux 是 WebSocket upgrade 端点（普通 GET 返回 426）。
     * 不能用全局 `new WebSocket()`：Obsidian/Chromium 的 WebSocket 自动带页面
     * Origin 头，与 Host 127.0.0.1:3080 不匹配，被 DSH 的 isTrustedApiRequest
     * 信任检查拒绝（403 → 客户端看到 1006）。
     * 这里用 Node 内置 http/crypto 手写 WS 客户端：握手时不带 Origin（或带匹配的
     * Origin），通过信任检查；再自行解析 WS 帧（服务端帧未 mask、单文本帧）。
     * 帧解析与重连自控，view 层订阅接口不变。
     * ================================================= */
    /** 协议探测 → 应用 flavor → 建流。服务上线/重启后重调（服务器可能换代）。 */
    async detectAndConnect() {
        if (this._detecting) return;
        this._detecting = true;
        try {
            const detected = await detectFlavor(`http://127.0.0.1:${this.settings.port}`, 2500);
            if (!detected) {
                // 服务不在线：维持现状（ServiceManager 稍后拉起后会再探测）
                return;
            }
            const changed = this.flavor !== detected.flavor;
            this.flavor = detected.flavor;
            this.api.setFlavor(detected.flavor);
            if (detected.flavor === "v012" && detected.needsAuth) {
                await this.auth.ensureCookie(`http://127.0.0.1:${this.settings.port}`);
            }
            if (changed || !this.wsConnected) this.connectDshWs();
            console.log(`[dsh-native] 协议代: ${detected.flavor}${detected.needsAuth ? " (auth)" : ""}`);
        } finally {
            this._detecting = false;
        }
    }

    /** 视图切换会话时跟随（v012 必须显式 follow；legacy 全广播无需处理） */
    wsFollow(sessionId) {
        if (this.mux) this.mux.follow(sessionId);
    }

    /** 统一分发：legacy WS 解析帧与 v012 合成帧共用（计数 + 状态 + 订阅回调）。 */
    dispatchMuxFrame(frame) {
        this.wsFrameCount++;
        const ft = frame && frame.payload && frame.payload.type;
        if (ft) {
            this.wsLastFrameTypes.push(ft);
            if (this.wsLastFrameTypes.length > 6) this.wsLastFrameTypes.shift();
            if (ft === "assistant/chunk" || ft === "session/event") this.wsChunkCount++;
        }
        this.notifyStatusSubs();
        for (const cb of this.eventSubs) {
            try {
                cb(frame);
            } catch (e) {
                console.error("[dsh-native] event sub cb err:", e);
            }
        }
    }

    connectDshWs() {
        this.closeDshWs();
        if (this.flavor === "v012") {
            // ---- v012：remote.mux 帧协议，帧经 V012Mux 合成 legacy 形状后走统一分发 ----
            this.wsConnected = false;
            this.mux = new V012Mux({
                port: this.settings.port,
                getCookie: () => (this.auth && this.auth.cookie) || "",
                onFrame: (frame) => this.dispatchMuxFrame(frame),
                onReady: () => {
                    this.wsConnected = true;
                    this.wsCloseReason = null;
                    this.notifyStatusSubs();
                },
                onBroken: () => {
                    this.wsConnected = false;
                    this.notifyStatusSubs();
                },
            });
            this.api.bindMux(this.mux);
            this.mux.start();
            return;
        }
        this.connectLegacyWs();
    }

    /** legacy(0.1.1-rc.x)：/api/events.mux 手写 WS 客户端（原 connectDshWs 实现）。 */
    connectLegacyWs() {
        this.closeDshWs();
        const port = this.settings.port;
        const path = "/api/events.mux";
        const key = crypto.randomBytes(16).toString("base64");
        this._wsBuf = Buffer.alloc(0);
        const req = http.request({
            host: "127.0.0.1",
            port,
            path,
            headers: {
                Connection: "Upgrade",
                Upgrade: "websocket",
                "Sec-WebSocket-Key": key,
                "Sec-WebSocket-Version": "13",
                Host: `127.0.0.1:${port}`,
                // 故意不带 Origin —— 规避 DSH isTrustedApiRequest 的 origin 检查（根因）
            },
        });
        req.on("upgrade", (res, socket, head) => {
            this.wsConnected = true;
            this.wsCloseReason = null;
            this.ws = { req, socket };
            console.log("[dsh-native] WS open:", `ws://127.0.0.1:${port}${path}`);
            this.notifyStatusSubs();
            this._wsBuf = Buffer.concat([this._wsBuf, Buffer.from(head || [])]);
            socket.on("data", (chunk) => this.onWsData(chunk));
            socket.on("close", () => this.onWsDown("ws:close"));
            socket.on("error", () => this.onWsDown("ws:err"));
        });
        req.on("response", (res) => {
            // 非 101（如 403/426）——握手被信任检查拒绝
            console.error("[dsh-native] WS 握手失败:", res.statusCode);
            this.wsCloseReason = `hs:${res.statusCode}`;
            this.notifyStatusSubs();
            res.resume();
            req.destroy();
            this.scheduleDshWsReconnect();
        });
        req.on("error", (e) => {
            console.error("[dsh-native] WS request error:", e && e.message);
            this.wsConnected = false;
            this.wsCloseReason = "ws:reqerr";
            this.notifyStatusSubs();
            this.scheduleDshWsReconnect();
        });
        req.end();
    }

    /** 累积并解析 WS 帧：服务端帧未 mask、单文本帧（opcode 0x1）。 */
    onWsData(chunk) {
        this._wsBuf = Buffer.concat([this._wsBuf, chunk]);
        let buf = this._wsBuf;
        while (buf.length >= 2) {
            const b0 = buf[0];
            const b1 = buf[1];
            const opcode = b0 & 0x0f;
            const masked = (b1 & 0x80) !== 0;
            let len = b1 & 0x7f;
            let offset = 2;
            if (len === 126) {
                if (buf.length < 4) break;
                len = buf.readUInt16BE(2);
                offset = 4;
            } else if (len === 127) {
                if (buf.length < 10) break;
                len = buf.readUInt32BE(6); // 帧很小，取低 32 位足够
                offset = 10;
            }
            if (buf.length < offset + len) break; // 等更多数据
            const payload = buf.slice(offset, offset + len);
            buf = buf.slice(offset + len);
            if (opcode === 0x1 || opcode === 0x2) {
                this.deliverWsFrame(payload); // text / binary：DSH 发的是文本 envelope
            } else if (opcode === 0x8) {
                this.onWsDown("ws:close-frame");
                return;
            } else if (opcode === 0x9) {
                this.wsSend(0xa, payload); // ping → 回 pong（echo payload）
            }
            // 0x0 continuation：DSH 单帧发送，忽略
        }
        this._wsBuf = buf;
    }

    /** 解析 envelope 并喂给统一分发（legacy 路径）。 */
    deliverWsFrame(payload) {
        let frame;
        try {
            frame = JSON.parse(payload.toString("utf8"));
        } catch (e) {
            console.warn("[dsh-native] WS frame parse error:", e, payload.slice(0, 100).toString());
            return;
        }
        this.dispatchMuxFrame(frame);
    }

    /** 客户端→服务端发送（必须 mask，RFC 6455）。 */
    wsSend(opcode, data) {
        if (!this.ws || !this.ws.socket) return;
        const sock = this.ws.socket;
        const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
        const len = payload.length;
        let header;
        if (len < 126) {
            header = Buffer.from([0x80 | opcode, 0x80 | len]);
        } else if (len < 65536) {
            header = Buffer.alloc(4);
            header[0] = 0x80 | opcode;
            header[1] = 0x80 | 126;
            header.writeUInt16BE(len, 2);
        } else {
            header = Buffer.alloc(10);
            header[0] = 0x80 | opcode;
            header[1] = 0x80 | 127;
            header.writeUInt32BE(0, 2);
            header.writeUInt32BE(len, 6);
        }
        const mask = crypto.randomBytes(4);
        const masked = Buffer.alloc(len);
        for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
        try {
            sock.write(Buffer.concat([header, mask, masked]));
        } catch (_) { /* ignore */ }
    }

    /** WS 通道断开的统一处理：置状态 + 重连（已是关闭态则跳过，避免重复重连）。 */
    onWsDown(reason) {
        if (this.ws === null) return;
        this.wsConnected = false;
        this.ws = null;
        this.wsCloseReason = reason;
        console.warn("[dsh-native] WS down:", reason);
        this.notifyStatusSubs();
        this.scheduleDshWsReconnect();
    }

    closeDshWs() {
        if (this._wsReconnectTimer) {
            clearTimeout(this._wsReconnectTimer);
            this._wsReconnectTimer = null;
        }
        if (this.mux) {
            try { this.mux.stop(); } catch (e) { /* ignore */ }
            this.mux = null;
        }
        if (this.ws) {
            try {
                this.wsSend(0x8, Buffer.alloc(0)); // 发 close 帧
            } catch (_) { /* ignore */ }
            try {
                if (this.ws.socket) this.ws.socket.destroy();
                if (this.ws.req) this.ws.req.destroy();
            } catch (_) { /* ignore */ }
            this.ws = null;
        }
        this.wsConnected = false;
    }

    scheduleDshWsReconnect() {
        if (this._wsReconnectTimer) return;
        this.wsReconnectCount++;
        this._wsReconnectTimer = setTimeout(() => {
            this._wsReconnectTimer = null;
            if (!this.ws) this.connectDshWs();
        }, 3000);
    }

    wsSubscribe(cb) { this.eventSubs.add(cb); }
    wsUnsubscribe(cb) { this.eventSubs.delete(cb); }
    wsStatusSubscribe(cb) { this.statusSubs.add(cb); }
    wsStatusUnsubscribe(cb) { this.statusSubs.delete(cb); }
    notifyStatusSubs() {
        for (const cb of this.statusSubs) {
            try { cb(); } catch (e) { console.error("[dsh-native] status sub err:", e); }
        }
    }
    getWsStatus() {
        return {
            connected: this.wsConnected,
            reconnectCount: this.wsReconnectCount,
            frameCount: this.wsFrameCount,
            chunkCount: this.wsChunkCount,
            lastFrameTypes: this.wsLastFrameTypes.slice(),
            closeReason: this.wsCloseReason,
        };
    }

    getVaultPath() {
        return this.settings.vaultPath || this.app.vault.adapter.basePath;
    }

    getServiceOpts() {
        return {
            port: this.settings.port,
            startupCommand: this.settings.startupCommand,
            startupCwd: this.getVaultPath(),
            autoStart: this.settings.autoStart,
            detached: this.settings.detached,
            pollIntervalMs: this.settings.pollIntervalMs,
            readyTimeoutMs: this.settings.readyTimeoutMs,
        };
    }

    async ensureServiceOnline() {
        this.serviceManager.opts = this.getServiceOpts();
        this.api.baseUrl = `http://127.0.0.1:${this.settings.port}`;
        const r = await this.serviceManager.ensureOnline();
        if (r.kind === "online") {
            // 服务（重新）上线：协议代可能变了（rc.x ↔ 0.1.2+），重探测再接流
            this.detectAndConnect();
        }
        return r;
    }

    getView() {
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
        return leaves.length ? leaves[0].view : null;
    }

    async activateView() {
        const { workspace } = this.app;
        let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
        if (!leaf) {
            // 用 true：右侧尚无 leaf 时也能创建，避免 getRightLeaf(false) 在无 leaf 时返回空导致空白拆分
            leaf = workspace.getRightLeaf(true);
            await leaf.setViewState({ type: VIEW_TYPE, active: true });
        }
        workspace.revealLeaf(leaf);
    }

    async restartService() {
        await killPort(this.settings.port);
        this.serviceManager.dispose();
        this.serviceManager.reset();
        new Notice("DSH 服务已重启");
        const view = this.getView();
        if (view && view.boot) await view.boot();
    }

    /* ===== 在浏览器打开 DSH Web GUI ===== */
    openInBrowser(url) {
        try {
            const electron = require("electron");
            if (electron && electron.shell) {
                electron.shell.openExternal(url);
                return;
            }
        } catch (e) {
            /* electron 不可用时降级 */
        }
        try {
            if (typeof window !== "undefined" && window.open) window.open(url, "_blank");
        } catch (e2) {
            /* ignore */
        }
    }
    openDshInBrowser() {
        this.openInBrowser(`http://127.0.0.1:${this.settings.port}/`);
    }

    /* ===== 框选文字浮动「发送到 DSH」按钮 ===== */
    onSelectionEvent(reposition) {
        if (!this.settings.selectionButton) {
            this.hideSelectionButton();
            return;
        }
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        const editor = view ? view.editor : null;
        const text = editor && editor.getSelection ? editor.getSelection().trim() : "";
        if (!text) {
            this.hideSelectionButton();
            return;
        }
        const changed = text !== this._lastSelText;
        this._lastSelText = text;
        this._pendingSelText = text;
        if (!this._selBtn) {
            const btn = document.createElement("button");
            btn.className = "dsh-native-send-btn";
            btn.textContent = "发送到 DSH";
            btn.addEventListener("click", () => {
                const send = this._pendingSelText;
                this.hideSelectionButton();
                this.sendCurrentNote();
            });
            btn.style.cssText =
                "position:fixed;z-index:9999;padding:2px 8px;font-size:12px;cursor:pointer;" +
                "background:var(--interactive-accent);color:var(--text-on-accent);border:none;" +
                "border-radius:6px;box-shadow:0 1px 4px rgba(0,0,0,.3);";
            document.body.appendChild(btn);
            this._selBtn = btn;
        }
        if (changed || reposition) this._positionSelBtn(editor);
    }
    _positionSelBtn(editor) {
        if (!this._selBtn) return;
        try {
            const el = editor.containerEl;
            if (!el) return;
            const rect = el.getBoundingClientRect();
            if (!rect.width || !rect.height) return;
            let left = rect.right - 8;
            let top = rect.top + 8;
            if (editor.coordsAtPos) {
                const c = editor.coordsAtPos(editor.getCursor("from"));
                if (c) {
                    left = rect.left + c.left;
                    top = rect.top + c.top - 8;
                }
            }
            this._selBtn.style.left = Math.round(left) + "px";
            this._selBtn.style.top = Math.round(top) + "px";
        } catch (e) {
            /* ignore */
        }
    }
    hideSelectionButton() {
        if (this._selBtn) {
            this._selBtn.remove();
            this._selBtn = null;
        }
        this._lastSelText = "";
        this._pendingSelText = "";
    }

    async sendCurrentNote() {
        const view = this.getView();
        if (!view || !view.sessionId) {
            new Notice("请先打开 DSH 面板并选择会话");
            return;
        }
        const active = this.app.workspace.getActiveFile();
        if (!active) {
            new Notice("没有打开的笔记");
            return;
        }
        let text = await this.app.vault.read(active);
        const sel = this.app.workspace.getActiveViewOfType && null; // placeholder
        // 优先用当前编辑器选区
        const editor = this.app.workspace.activeEditor;
        if (editor && editor.getSelection && editor.getSelection()) {
            text = editor.getSelection();
        }
        const header = `以下是 Obsidian 笔记《${active.path}》的内容，请基于它回答：\n\n`;
        try {
            await this.api.prompt(view.sessionId, header + text.slice(0, 20000));
            new Notice("已发送到 DSH");
            if (this.settings.openPanelOnSend) await this.activateView();
            if (!view.assistantEl) view.beginAssistantBubble();
        } catch (e) {
            new Notice("发送失败：" + e.message);
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }
    async saveSettings() {
        await this.saveData(this.settings);
    }
}

module.exports = DshNativePlugin;
