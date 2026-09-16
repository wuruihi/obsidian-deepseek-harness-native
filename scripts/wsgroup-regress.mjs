// 会话归属（workspace grouping）真机回归 —— 用法：node scripts/wsgroup-regress.mjs [baseUrl]
//
// 守的契约（实测于 DSH 0.1.5-rc.1；改 session.create / ensureWorkspace 必跑）：
//   session/create 只接受 workspaceId 或 cwd 之一，且**只有 workspaceId 会把会话 attach 进工作区**；
//   只给 cwd 时服务器照建会话、但不登记分组 → DSH 本体显示「未分组」（v0.7.4 修的正是这条）。
//
// 做法（本仓库首次做到「真代码路径」端到端）：不重写一份 HTTP 客户端，而是
//   ①把 require("obsidian") 换成桩件（只有 requestUrl 需要真实现，转成真 HTTP）；
//   ②用 new Function 直接求值**真 main.js** 源码，并把模块内私有的 DshApi / DshAuth / V012Mux 导出来；
//   ③用插件自己的代码（含真实鉴权链 credentials → cookie、v012 {args} 信封、流桥）打真机。
// 这样 main.js 里的映射逻辑一旦被改坏，本回归立刻红，而不是靠读代码确认。
//
// 红线：cookie/令牌值不打印、不落盘。副作用：在系统临时目录建一次性工作区 + 探针会话，跑完归档并删除。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require2 = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.join(here, "..", "main.js");
const BASE = process.argv[2] || "http://127.0.0.1:3080";
const PORT = new URL(BASE).port || "80";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " -> " + detail : ""}`);
    ok ? pass++ : fail++;
};
const samePath = (a, b) => {
    const n = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    return n(a) === n(b);
};

// ---- Obsidian 模块桩件：本次用到的只有 requestUrl，其余是让 main.js 能被求值 ----
function obsidianStub() {
    class Plugin { constructor(app, manifest) { this.app = app; this.manifest = manifest; } async loadData() { return {}; } async saveData() {} addRibbonIcon() { return {}; } registerView() {} addSettingTab() {} registerEvent() {} addCommand() {} registerDomEvent() {} async onload() {} async onunload() {} }
    class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; } }
    class Setting { setName() { return this; } setDesc() { return this; } addText() { return this; } addToggle() { return this; } addDropdown() { return this; } addButton() { return this; } addTextArea() { return this; } addSlider() { return this; } }
    class ItemView { constructor(leaf) { this.leaf = leaf; } }
    class Notice { constructor(msg) { console.log("[Notice]", msg); } }
    class Component { load() {} unload() {} }
    class Modal { constructor(app) { this.app = app; } }
    class MarkdownView {}
    /** 真 HTTP，形状对齐 Obsidian requestUrl（json 是**对象**而非函数：main.js 按 typeof 判断后直接用） */
    function requestUrl(opts) {
        return new Promise((resolve, reject) => {
            const u = new URL(opts.url);
            const headers = { ...(opts.contentType ? { "content-type": opts.contentType } : {}), ...(opts.headers || {}) };
            const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: opts.method || "GET", headers }, (res) => {
                let b = "";
                res.setEncoding("utf8");
                res.on("data", (c) => { b += c; });
                res.on("end", () => {
                    let json;
                    try { json = JSON.parse(b); } catch { json = undefined; }
                    resolve({ status: res.statusCode, headers: res.headers || {}, text: b, json, arrayBuffer: Buffer.from(b) });
                });
            });
            req.on("error", reject);
            if (opts.body !== undefined) req.write(opts.body);
            req.end();
        });
    }
    return { Plugin, PluginSettingTab, Setting, ItemView, Notice, MarkdownRenderer: {}, Component, Modal, MarkdownView, requestUrl };
}

// ---- 求值真 main.js，并导出模块内私有的 DshApi / DshAuth / V012Mux ----
let DshApi, DshAuth, V012Mux;
try {
    const src = fs.readFileSync(MAIN, "utf8")
        + "\n;module.exports.__DshApi = DshApi; module.exports.__DshAuth = DshAuth; module.exports.__V012Mux = V012Mux;\n";
    const stub = obsidianStub();
    const moduleShim = { exports: {} };
    const fakeRequire = (id) => (id === "obsidian" ? stub : require2(id));
    new Function("require", "module", "exports", "__filename", "__dirname", src)(
        fakeRequire, moduleShim, moduleShim.exports, MAIN, path.dirname(MAIN));
    ({ __DshApi: DshApi, __DshAuth: DshAuth, __V012Mux: V012Mux } = moduleShim.exports);
    check("求值真 main.js 并取到 DshApi / DshAuth / V012Mux（main.js 即源码，无构建链）",
        typeof DshApi === "function" && typeof DshAuth === "function" && typeof V012Mux === "function");
} catch (e) {
    check("求值真 main.js 并取到 DshApi / DshAuth / V012Mux（main.js 即源码，无构建链）", false, String(e && e.message || e));
}
if (typeof DshApi !== "function" || typeof V012Mux !== "function") {
    console.log(`\n${pass}/${pass + fail} passed`);
    process.exit(1);
}

// ---- 用插件自己的代码搭客户端（鉴权链 / {args} 信封 / 流桥全是真实现）----
let cookie;
const cookieOf = () => cookie;
const mux = new V012Mux({ port: PORT, getCookie: cookieOf, onFrame: () => {}, onReady: () => {}, onBroken: () => {} });
const api = new DshApi(BASE);
api.setFlavor("v012");
api.bindMux(mux);
const auth = new DshAuth({ home: process.env.USERPROFILE || process.env.HOME || "", getManualToken: () => "" });
api.bindAuth(auth);

const probeDir = path.join(os.tmpdir(), "dsh-wsgroup-regress");
const probeSids = [];
let wsId = null;

try {
    // 1) 真实鉴权链：credentials → 铸 cookie（值不打印）
    const got = await auth.ensureCookie(BASE);
    cookie = got ? auth.cookieHeader().cookie : undefined;
    check("DshAuth 铸 cookie（真实鉴权链 credentials → cookie）", !!cookie,
        cookie ? `(值不打印, 长度 ${cookie.length})` : "无 cookie（服务器可能需要鉴权）");

    mux.start();
    for (let i = 0; i < 100 && !mux.ws; i++) await new Promise((r) => setTimeout(r, 100));
    check("V012Mux 连上 DSH（workspace.list 走 workspace/follow，不是一元端点）", !!mux.ws);
    if (!mux.ws) throw new Error("mux 未连上，后续用例无法进行");

    // 2) 清掉上次崩溃残留的同名工作区，保证下面走的是 workspace.create 路径
    for (const w of ((await api.listWorkspaces()).items || [])) {
        if (samePath(w.path, probeDir)) await api.call("workspace.delete", { workspaceId: w.workspaceId });
    }
    fs.mkdirSync(probeDir, { recursive: true });

    // 3) ensureWorkspace：目录还没有工作区 → 走 workspace.create → 必须解包 {workspace:{...}}
    const ws = await api.ensureWorkspace(probeDir);
    wsId = ws && ws.workspaceId;
    check("ensureWorkspace 解包 workspace/create 回执（拿到 workspaceId + path）",
        !!ws && !!ws.workspaceId && !!ws.path, ws ? `workspaceId=${ws.workspaceId}` : "返回空");

    // 4) 幂等：再来一次必须命中已有工作区（走 workspace.list 匹配分支），不能又建一个
    const wsAgain = await api.ensureWorkspace(probeDir);
    check("ensureWorkspace 幂等（第二次命中已有工作区，不再新建）",
        !!wsAgain && !!wsAgain.workspaceId && wsAgain.workspaceId === ws.workspaceId,
        wsAgain ? `workspaceId=${wsAgain.workspaceId}` : "返回空");

    // 5) 核心：createSession(工作区对象) 必须走 workspaceId → 会话归入该工作区
    const s = await api.createSession(ws);
    probeSids.push(s.sessionId);
    const owner = ((await api.listWorkspaces()).items || []).find((w) => (w.sessionIds || []).includes(s.sessionId));
    check("createSession(工作区对象) 建出的会话已归入工作区（不再是「未分组」）",
        !!owner && owner.workspaceId === ws.workspaceId, owner ? `归入 ${owner.path}` : "未登记进任何工作区");

    // 6) listSessions 路径：新会话是 blank（尚无消息），插件按设计排除、由面板本地占位显示
    const listed = await api.listSessions(ws.workspaceId);
    check("listSessions 按设计过滤 blank 会话（空会话不进列表，非缺陷）",
        !listed.some((i) => i.sessionId === s.sessionId), `列表 ${listed.length} 条`);

    // 7) 反证（同时守住服务器契约）：只给 cwd 的退化调用仍是「未分组」
    const s2 = await api.createSession({ path: probeDir });
    probeSids.push(s2.sessionId);
    const owner2 = ((await api.listWorkspaces()).items || []).find((w) => (w.sessionIds || []).includes(s2.sessionId));
    check("反证：只给 cwd 的调用仍是「未分组」（归属只来自 workspaceId 这一个字段）",
        !owner2, owner2 ? `意外归入 ${owner2.path}` : "未登记（符合预期）");

    // 8) 闸门：拿不到工作区必须抛错。否则 session/create 缺 workspaceId/cwd 时，
    //    服务器会用**自己进程的 cwd** 建会话（静默落到无关目录 + 显示「未分组」）。
    let threw = null;
    try { await api.createSession(null); } catch (e) { threw = e.message; }
    check("拿不到工作区时大声失败（不盲建到服务器 cwd）", !!threw && /工作区尚未就绪/.test(threw), threw || "没有抛错（危险）");
} catch (e) {
    console.error("中断：", e.message);
} finally {
    try {
        for (const sid of probeSids) await api.call("workspace.archiveSession", { sessionId: sid }).catch(() => {});
        if (wsId) await api.call("workspace.delete", { workspaceId: wsId });
        const after = (await api.listWorkspaces()).items || [];
        check("收尾：探针会话已归档、临时工作区已删除（无残留）",
            after.filter((w) => samePath(w.path, probeDir)).length === 0, `剩余工作区 ${after.length} 个`);
    } catch (e) {
        check("收尾：探针会话已归档、临时工作区已删除（无残留）", false, e.message);
    }
    mux.stop();
    console.log(`\n${pass}/${pass + fail} passed`);
    process.exit(fail ? 1 : 0);
}