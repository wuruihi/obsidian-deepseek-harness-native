// 渲染层结构回归（v0.7.11 批次2：消息级对齐 VSCode）
// 用法：node scripts/render-regress.mjs
//
// 为什么要有它：Obsidian 面板是手写 DOM，没有构建期类型检查；工具组、回合分叉线、
// 附件 chip、跨会话来源徽标这些结构一旦拼错，只有用户打开面板才会发现。
// 本回归求值**真 main.js**，用最小 Fake DOM 替换 Obsidian Element，断言关键结构存在。
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require2 = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.join(here, "..", "main.js");

class FakeEl {
    constructor(tag = "div") {
        this.tagName = String(tag).toUpperCase();
        this.children = [];
        this.classList = new Set();
        this.style = {};
        this.dataset = {};
        this.attrs = {};
        this.parentNode = null;
        this._text = "";
    }
    get className() { return [...this.classList].join(" "); }
    set className(v) { this.classList = new Set(String(v || "").split(/\s+/).filter(Boolean)); }
    get textContent() { return this._text || this.children.map((c) => c.textContent).join(""); }
    set textContent(v) { this._text = String(v); this.children = []; }
    createDiv(cls) { const e = new FakeEl("div"); if (cls) e.className = cls; this.children.push(e); e.parentNode = this; return e; }
    createSpan(cls) { const e = new FakeEl("span"); if (cls) e.className = cls; this.children.push(e); e.parentNode = this; return e; }
    createEl(tag, opts = {}) {
        const e = new FakeEl(tag);
        if (opts && opts.cls) e.className = opts.cls;
        if (opts && opts.text != null) e.textContent = opts.text;
        if (opts && opts.attr) for (const [k, v] of Object.entries(opts.attr)) e.attrs[k] = String(v);
        this.children.push(e); e.parentNode = this; return e;
    }
    empty() { this.children = []; }
    addClass(c) { this.classList.add(c); }
    removeClass(c) { this.classList.delete(c); }
    toggleClass(c) { this.classList.has(c) ? this.classList.delete(c) : this.classList.add(c); }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k]; }
    addEventListener() { /* 结构回归不触发交互 */ }
    querySelector(sel) {
        const cls = String(sel).replace(/^\./, "");
        const walk = (n) => {
            for (const c of n.children) {
                if (c.classList.has(cls)) return c;
                const r = walk(c);
                if (r) return r;
            }
            return null;
        };
        return walk(this);
    }
    querySelectorAll(sel) {
        const cls = String(sel).replace(/^\./, "");
        const out = [];
        const walk = (n) => {
            for (const c of n.children) {
                if (c.classList.has(cls)) out.push(c);
                walk(c);
            }
        };
        walk(this);
        return out;
    }
    get firstChild() { return this.children[0] || null; }
    get lastElementChild() { return this.children[this.children.length - 1] || null; }
    get childElementCount() { return this.children.length; }
    insertBefore(node, ref) {
        const i = ref ? this.children.indexOf(ref) : this.children.length;
        this.children.splice(i < 0 ? this.children.length : i, 0, node);
        node.parentNode = this;
    }
    replaceWith(node) { node.parentNode = this.parentNode; }
    scrollIntoView() {}
}

global.requestAnimationFrame = (cb) => { cb(); return 1; };
global.document = { createElement: (t) => new FakeEl(t) };

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
    const MarkdownRenderer = { render: async (_app, text, el) => { el.textContent = String(text); } };
    return { Plugin, PluginSettingTab, Setting, ItemView, Notice, MarkdownRenderer, Component, Modal, MarkdownView, requestUrl };
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

function makeView() {
    const v = Object.create(View.prototype);
    v.messagesEl = new FakeEl("div");
    v.app = {};
    v.sessionId = "session-current";
    v.sessions = [{ sessionId: "session-other", title: "别的会话" }];
    v._activities = new Map();
    v._activityHolder = null;
    v.pending = new Map();
    v._attachCache = new Map();
    v._userTextsSent = new Set();
    v._wsCatchup = false;
    v.scrollToBottom = () => {};
    v.forkSessionRowAt = () => {};
    v.switchSession = () => {};
    v.api = { getAttachment: () => Promise.reject(new Error("stub")) };
    return v;
}

// 1. 历史回合结构：分叉线 / 工具组 / 无 role 行 / 操作条只有复制 / 产出卡
{
    const v = makeView();
    const turn = {
        text: "答案正文",
        thinking: "",
        ended: true,
        turnNo: 2,
        lastSeq: 42,
        segments: [
            { kind: "text", text: "先说" },
            { kind: "tool", act: { key: "c1", name: "read", label: "读文件", state: "done" } },
            { kind: "tool", act: { key: "c2", name: "grep", label: "搜索", state: "done" } },
            { kind: "thinking", text: "想一想" },
            { kind: "tool", act: { key: "c3", name: "write", label: "写文件", state: "done" } },
        ],
        produced: ["a.md"],
    };
    v.renderStaticTurn(turn, false);
    await new Promise((r) => setTimeout(r, 0)); // renderFoldSegments 是异步的（MarkdownRenderer）
    const bubble = v.messagesEl.children[0];
    check("助手气泡不再渲染 role 行", !v.messagesEl.querySelector(".dsh-msg-role"));
    check("回合分叉线（第 N 轮）存在", !!bubble.querySelector(".dsh-fork-divider") && bubble.querySelector(".dsh-fork-divider-btn").textContent.includes("第 2 轮"));
    check("连续工具合并成工具组", !!bubble.querySelector(".dsh-tool-group"));
    check("工具组头显示步数", bubble.querySelector(".dsh-tool-group-count").textContent.includes("2 步"),
        bubble.querySelector(".dsh-tool-group-count").textContent);
    check("单个工具仍是独立活动行", bubble.querySelectorAll(".dsh-activity").length >= 1);
    check("产物卡存在", !!bubble.querySelector(".dsh-files-card"));
    check("操作条只保留复制", bubble.querySelector(".dsh-msg-actions").childElementCount === 1);
}

// 2. 跨会话来源徽标 + 方案审阅样式
{
    const v = makeView();
    v.pending.set("a:x", { kind: "approval", rpcId: "r1", sessionId: "session-other", toolName: "bash", reason: "执行命令", extra: {} });
    v.pending.set("q:r2", {
        kind: "question", rpcId: "r2", sessionId: "session-other",
        questions: [{ id: "q1", question: "是否执行？", detail: "计划内容", intent: { kind: "plan-review", approve: "批准" }, options: [{ label: "批准" }, { label: "拒绝" }] }],
    });
    v.renderPendingCards();
    const cards = v.messagesEl.querySelectorAll(".dsh-pending");
    check("审批/提问卡都渲染", cards.length === 2, `cards=${cards.length}`);
    check("跨会话来源徽标存在", !!v.messagesEl.querySelector(".dsh-pending-source"));
    check("方案审阅标签存在", !!v.messagesEl.querySelector(".dsh-question-intent"));
    const optEls = v.messagesEl.querySelectorAll(".dsh-question-option");
    check("批准选项高亮（is-approve）", optEls.some((el) => el.classList.has("is-approve")),
        optEls.map((el) => [...el.classList].join(".")).join(" | "));
}

// 3. 用户消息附件 chip / 图片
{
    const v = makeView();
    await v.addUserBubble("带附件的消息", false, [{ dataUrl: "data:image/png;base64,AAA", name: "截图" }], ["a.md", "b.md"]);
    const bubble = v.messagesEl.children[0];
    check("用户消息附件 chip 渲染", bubble.querySelectorAll(".dsh-attach-chip").length === 2);
    check("用户消息图片渲染", !!bubble.querySelector(".dsh-msg-image"));
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
