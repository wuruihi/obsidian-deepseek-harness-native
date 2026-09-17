// 会话级命令执行（commands/execute）真机回归 —— 用法：node scripts/execute-regress.mjs [baseUrl]
//
// 守的契约（实测于 DSH 0.1.5-rc.2；改 commands/execute / executeCommand / 权限切换必跑）：
//   网关对该端点做「逐参数精确匹配」（dsh-api-gateway assertExactArguments）：
//     commands/execute 必填 [agentId, line, submittedAttachments]
//   0.1.2-alpha.4 时该字段叫 images；0.1.5 改名后旧键会被拒
//   （gateway/arguments-invalid ... missing "submittedAttachments"; unexpected "images"）。
//   会话级权限切换（/permission <preset>）与所有斜杠命令都走这条通道——字段名一漂，按钮就哑。
//
// 做法（沿用 wsgroup-regress 的「真代码路径」套路）：把 require("obsidian") 换成桩件、
//   用 new Function 求值**真 main.js**、导出私有的 DshApi/DshAuth/V012Mux，再用插件自己的
//   鉴权链（credentials → cookie）+ {args} 信封打真机。既断言「旧写法必须被拒」，也断言
//   「插件真实入口 executeCommand 必须通」，所以字段名被改回去会立刻红。
//
// 红线：cookie/令牌值不打印、不落盘。副作用：临时目录建一次性工作区 + 探针会话，跑完归档并删除。
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
const PRESET = "danger-full-access"; // 已实测会被服务器接受的取值

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " -> " + detail : ""}`);
    ok ? pass++ : fail++;
};
const samePath = (a, b) => {
    const n = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    return n(a) === n(b);
};
const brief = (s) => String(s || "").replace(/\s+/g, " ").slice(0, 220);

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

// ---- 求值真 main.js，导出私有的 DshApi / DshAuth / V012Mux ----
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
    check("求值真 main.js 并取到 DshApi / DshAuth / V012Mux", typeof DshApi === "function" && typeof V012Mux === "function");
} catch (e) {
    check("求值真 main.js 并取到 DshApi / DshAuth / V012Mux", false, brief(e && e.message || e));
}
if (typeof DshApi !== "function" || typeof V012Mux !== "function") {
    console.log(`\n${pass}/${pass + fail} passed`);
    process.exit(1);
}

// ---- 用插件自己的代码搭客户端 ----
let cookie;
const cookieOf = () => cookie;
const mux = new V012Mux({ port: PORT, getCookie: cookieOf, onFrame: () => {}, onReady: () => {}, onBroken: () => {} });
const api = new DshApi(BASE);
api.setFlavor("v012");
api.bindMux(mux);
const auth = new DshAuth({ home: process.env.USERPROFILE || process.env.HOME || "", getManualToken: () => "" });
api.bindAuth(auth);

const probeDir = path.join(os.tmpdir(), "dsh-execute-regress");
let wsId = null;
let sid = null;
let archived = false;

/** 直接按给定顶层参数名发一次 commands/execute，拿到 {ok, err} */
const rawExecute = async (keys) => {
    try {
        const value = await api.v012Request("commands/execute", keys);
        return { ok: true, value };
    } catch (e) {
        return { ok: false, err: brief(e && e.message || e) };
    }
};

try {
    // 1) 真实鉴权链
    const got = await auth.ensureCookie(BASE);
    cookie = got ? auth.cookieHeader().cookie : undefined;
    check("DshAuth 铸 cookie（真实鉴权链 credentials → cookie）", !!cookie,
        cookie ? `(值不打印, 长度 ${cookie.length})` : "无 cookie");

    mux.start();
    for (let i = 0; i < 100 && !mux.ws; i++) await new Promise((r) => setTimeout(r, 100));
    check("V012Mux 连上 DSH", !!mux.ws);
    if (!mux.ws) throw new Error("mux 未连上");

    // 2) 一次性探针会话（走插件的 ensureWorkspace + createSession，顺带守住工作区归属）
    for (const w of ((await api.listWorkspaces()).items || [])) {
        if (samePath(w.path, probeDir)) await api.call("workspace.delete", { workspaceId: w.workspaceId });
    }
    fs.mkdirSync(probeDir, { recursive: true });
    const ws = await api.ensureWorkspace(probeDir);
    wsId = ws && ws.workspaceId;
    const s = await api.createSession(ws);
    sid = s.sessionId;
    check("建探针会话（临时工作区，跑完归档删除）", !!sid, sid ? `sessionId=${sid}` : "建会话失败");
    if (!sid) throw new Error("没有会话，无法测 commands/execute");

    // 3) 契约反证：旧的 images 键必须被网关拒绝（这就是 0.7.4 用户看到「切权限没反应」的原因）
    const oldShape = await rawExecute({ agentId: sid, line: "/permission " + PRESET, images: [] });
    check("旧参数 images 被网关拒绝（契约证据：字段已改名）",
        !oldShape.ok && /arguments-invalid|submittedAttachments|images/.test(oldShape.err || ""),
        oldShape.ok ? "意外通过（网关又改回去了？）" : oldShape.err);

    // 4) 契约正证：submittedAttachments 必须被接受
    const newShape = await rawExecute({ agentId: sid, line: "/permission " + PRESET, submittedAttachments: [] });
    check("新参数 submittedAttachments 被网关接受", newShape.ok, newShape.ok ? JSON.stringify(newShape.value).slice(0, 160) : newShape.err);

    // 5) 核心：插件真实入口（面板切权限按钮走的就是 executeCommand）必须通、且回执不是 error
    let r = null, threw = null;
    try { r = await api.executeCommand(sid, "/permission " + PRESET); } catch (e) { threw = brief(e && e.message || e); }
    check("插件入口 executeCommand('/permission <preset>') 不再报网关参数错",
        !threw, threw || JSON.stringify(r).slice(0, 160));
    check("权限切换回执不是错误（会话级权限真的生效）",
        !!r && !(r.result && r.result.kind === "error"),
        r ? JSON.stringify(r).slice(0, 200) : (threw || "无回执"));

    // 6) 语义复核：/permission <preset> 后当前会话的权限预设确实变了
    const after = await api.executeCommand(sid, "/permission").catch((e) => ({ __err: brief(e && e.message || e) }));
    const text = JSON.stringify(after || {});
    check("语义复核：/permission 查询回执里出现目标预设名",
        text.includes(PRESET) && !/arguments-invalid/.test(text),
        text.slice(0, 220));
} catch (e) {
    console.error("中断：", brief(e && e.message || e));
} finally {
    try {
        if (sid && !archived) { archived = true; await api.call("workspace.archiveSession", { sessionId: sid }).catch(() => {}); }
        if (wsId) await api.call("workspace.delete", { workspaceId: wsId });
        const after = (await api.listWorkspaces()).items || [];
        check("收尾：探针会话已归档、临时工作区已删除（无残留）",
            after.filter((w) => samePath(w.path, probeDir)).length === 0, `剩余工作区 ${after.length} 个`);
    } catch (e) {
        check("收尾：探针会话已归档、临时工作区已删除（无残留）", false, brief(e && e.message || e));
    }
    try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    mux.stop();
    console.log(`\n${pass}/${pass + fail} passed`);
    process.exit(fail ? 1 : 0);
}
