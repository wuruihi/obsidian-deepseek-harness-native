// 实例选择 + 端口发现 真机回归（只读：不建会话、不改配置）。
// 用法：node scripts/instance-live.mjs
//
// 为什么需要它：instance-regress 是纯函数（注入端口），盖不到「discoverDesktopPorts 真能发现
// 这台机器的端口」「resolveInstance auto 真的选中它」。2026-10-19 DSH 0.2.1 把桌面版端口改成
// 系统分配后，这两层任意一层坏掉，用户看到的就是"连不上"。
//
// 做法与 wsgroup/execute 一致：require("obsidian") 换桩件 → new Function 求值真 main.js →
// 导出私有函数 → 打真机。
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require2 = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.join(here, "..", "main.js");

function obsidianStub() {
    class Plugin { constructor(app, manifest) { this.app = app; this.manifest = manifest; } async loadData() { return {}; } async saveData() {} }
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

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " -> " + detail : ""}`);
    ok ? pass++ : fail++;
};

let resolveInstance, discoverDesktopPorts, lastDiscoveryNote;
try {
    const src = fs.readFileSync(MAIN, "utf8");
    const moduleShim = { exports: {} };
    const req = (id) => {
        if (id === "obsidian") return obsidianStub();
        const builtin = /^node:/.test(id) ? id.slice(5) : id;
        return require2(builtin);
    };
    new Function("require", "module", "exports", "__filename", "__dirname",
        src + "\n;module.exports.__resolveInstance = resolveInstance; module.exports.__discoverDesktopPorts = discoverDesktopPorts; module.exports.__lastDiscoveryNote = lastDiscoveryNote;\n",
    )(req, moduleShim, moduleShim.exports, MAIN, path.dirname(MAIN));
    resolveInstance = moduleShim.exports.__resolveInstance;
    discoverDesktopPorts = moduleShim.exports.__discoverDesktopPorts;
    lastDiscoveryNote = moduleShim.exports.__lastDiscoveryNote;
    check("求值真 main.js 并取到 resolveInstance / discoverDesktopPorts",
        typeof resolveInstance === "function" && typeof discoverDesktopPorts === "function");
} catch (e) {
    check("求值真 main.js 并取到 resolveInstance / discoverDesktopPorts", false, String((e && e.message) || e));
}

if (typeof resolveInstance === "function") {
    const ports = await discoverDesktopPorts();
    check("真机发现桌面版端口（DSH 0.2.1+ 每次启动都变）", ports.length > 0,
        ports.length ? ports.join(",") : "未发现" + (lastDiscoveryNote() ? "（" + lastDiscoveryNote() + "）" : ""));

    if (ports.length) {
        const auto = await resolveInstance({ instance: "auto", port: 3080 });
        check("auto 模式选中发现到的桌面版端口",
            auto.kind === "desktop" && ports.includes(auto.port) && auto.alive === true,
            `${auto.kind}:${auto.port} alive=${auto.alive} discovered=${(auto.discovered || []).join(",")}`);

        const desktop = await resolveInstance({ instance: "desktop", port: 3080 });
        check("desktop 模式同样选中发现到的端口（不再写死 19387）",
            desktop.kind === "desktop" && ports.includes(desktop.port) && desktop.alive === true,
            `${desktop.kind}:${desktop.port}`);

        const legacy = await resolveInstance({ instance: "legacy", port: 3080 });
        check("legacy 模式只探自定义端口（不被自动发现顶掉）",
            legacy.kind === "legacy" && legacy.port === 3080, `${legacy.kind}:${legacy.port}`);
    }
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
