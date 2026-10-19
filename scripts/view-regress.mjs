// 视图层用户消息去重回归（v0.7.10）
// 用法：node scripts/view-regress.mjs
//
// 为什么要有它：2026-10-19 用户报「发送后能看到自己的消息，AI 回复后消失」。
// 根因不在折叠管线，而在视图层：send() 把文本登记进 _userTextsSent 防 WS 回推重复；
// turn 结束后的对账（reconcileFromHistory → loadHistory）会清空 DOM 重建，
// 重建时若仍走文本去重，**同一会话里先前那条同文历史消息**会把最新一条顶掉。
// 修法：历史回放（fromHistory=true）绕过文本去重。
//
// 本回归求值**真 main.js**，只把 DOM 依赖替换成桩（addUserBubble 记账），
// 直接验证 addUserBubbleFromEvent 的两条路径。
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
    class Notice { constructor() {} }
    class Component { load() {} unload() {} }
    class Modal { constructor(app) { this.app = app; } }
    class MarkdownView {}
    function requestUrl() { return Promise.reject(new Error("stub")); }
    return { Plugin, PluginSettingTab, Setting, ItemView, Notice, MarkdownRenderer: {}, Component, Modal, MarkdownView, requestUrl };
}

let View;
try {
    const src = fs.readFileSync(MAIN, "utf8");
    const mod = { exports: {} };
    const req = (id) => (id === "obsidian" ? obsidianStub() : require2(/^node:/.test(id) ? id.slice(5) : id));
    new Function("require", "module", "exports", "__filename", "__dirname",
        src + "\n;module.exports.__View = DshNativeView;\n",
    )(req, mod, mod.exports, MAIN, path.dirname(MAIN));
    View = mod.exports.__View;
} catch (e) {
    console.log("FAIL 求值真 main.js 失败：" + ((e && e.message) || e));
    process.exit(1);
}

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " -> " + detail : ""}`);
    ok ? pass++ : fail++;
};

/** 造一个"只有去重相关字段"的视图实例；addUserBubble 记账不碰 DOM。 */
function makeView() {
    const v = Object.create(View.prototype);
    v.rendered = [];
    v._userTextsSent = new Set();
    v._wsCatchup = false;
    v.messagesEl = null; // 不走"末尾活跃气泡/末尾同文"的实时兜底分支
    v.app = {};
    v.addUserBubble = (text) => { v.rendered.push(text); };
    return v;
}

// 1. 历史回放：即使文本已在 _userTextsSent（send() 登记过），也必须渲染
{
    const v = makeView();
    v._userTextsSent.add("你好");
    v.addUserBubbleFromEvent({ data: { text: "你好" } }, false, true);
    check("历史回放绕过「本地已发送」文本去重（对账重建后消息不消失）", v.rendered.length === 1 && v.rendered[0] === "你好", JSON.stringify(v.rendered));
}

// 2. 历史回放：同一文本出现两条（用户重复发送同一句话）→ 两条都要渲染
{
    const v = makeView();
    v.addUserBubbleFromEvent({ data: { text: "你好" } }, false, true);
    v.addUserBubbleFromEvent({ data: { text: "你好" } }, false, true);
    check("历史里重复同文消息逐条渲染（不再被前一条顶掉）", v.rendered.length === 2, JSON.stringify(v.rendered));
    check("历史回放不污染 _userTextsSent", v._userTextsSent.size === 0, `size=${v._userTextsSent.size}`);
}

// 3. 实时 WS 回推：send() 已登记的文本必须被去重（原有防重复不能回退）
{
    const v = makeView();
    v._userTextsSent.add("你好");
    v.addUserBubbleFromEvent({ data: { text: "你好" } }, false, false);
    check("实时回推仍按文本去重（防重复气泡）", v.rendered.length === 0, JSON.stringify(v.rendered));
}

// 4. 实时新消息（不在登记集）→ 正常渲染并登记
{
    const v = makeView();
    v.addUserBubbleFromEvent({ data: { text: "新消息" } }, false, false);
    check("实时新消息正常渲染", v.rendered.length === 1 && v.rendered[0] === "新消息", JSON.stringify(v.rendered));
    check("实时新消息登记进去重集", v._userTextsSent.has("新消息"));
}

// 5. 注入帧文本在视图层仍被剥（兜底；权威过滤在 fold 的 source.kind）
{
    const v = makeView();
    v.addUserBubbleFromEvent({ data: { text: 'Current working directory: "D:\\02-bywork".\n\nYou are the Team Lead named "lead".' } }, false, true);
    check("历史回放遇到注入文本不渲染", v.rendered.length === 0, JSON.stringify(v.rendered));
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
