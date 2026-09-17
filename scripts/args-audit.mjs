/**
 * args-audit.mjs — typert 网关参数契约审计（离线、确定性，不需要 token / 不连服务器）。
 * 用法：node scripts/args-audit.mjs          退出码 0 = 全部匹配，1 = 有漂移或找不到 DSH
 *      DSH_ROOT=<dsh 运行目录> node scripts/args-audit.mjs
 *
 * 为什么需要它：v012 的 args 必须与网关描述符**逐参数精确匹配**
 * （dsh-api-gateway assertExactArguments）：多键 / 缺键 / 改名都会被拒，且只在运行期
 * 报 `gateway/arguments-invalid`。这类契约随 DSH 版本漂移，而 7 个纯函数回归 + 真机
 * 回归都盖不到「端点的参数名」这一层，于是漏网。
 * 实测教训（0.1.2-alpha.4 → 0.1.5-rc.2）：
 *   commands/execute  images → submittedAttachments   ← 本插件 v0.7.4 踩中（权限切换全哑）
 *   subagents/list    {request:{...}} → 平铺 {parentSessionId}
 *
 * 做法（对齐 VSCode 插件 v0.18.4 引入的同名脚本）：
 *   从**已安装的 DSH**解析网关描述符（ground truth），与本仓库 main.js 里实际发送的
 *   顶层参数名比对。升级 DSH 后先跑它，能立刻知道有没有端点漂移。
 *
 * 三类断言：
 *   A) 字面量 v012Request(endpoint, {...}) 的顶层键 == 描述符要求的参数集合
 *   B) WRAPPED 集合里的 legacy 方法（session.cancel 等）映射到斜杠端点后必须**只**要求 request
 *   C) 覆盖度：main.js 里出现的每个 `a/b` 端点都得在描述符里；每个 `call("a.b")` 都得
 *      要么被显式分派（走 A/B），要么在 EXCEPTIONS 里写明「为什么网关没有这个端点」
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const MAIN_JS = join(REPO, "main.js");

/** 网关没有对应端点、但插件是**本地实现**的 legacy 方法（必须写明理由，否则 C 类断言会红） */
const EXCEPTIONS = new Map([
    ["session.history", "本地实现 v012History（流桥一次性快照 + session/page），网关无 session/history"],
    ["session.models", "本地映射 session/modelCatalog（该端点不接受 sessionId，返回宿主全局默认）"],
    ["workspace.list", "非一元端点（POST /api/workspace/list → 404），走 workspace/follow 流桥"],
]);

// ---------- 定位已安装的 DSH ----------
function locateDshRoot() {
    const cands = [
        process.env.DSH_ROOT,
        join(process.env.USERPROFILE ?? "", "dsh"),
        join(process.env.HOME ?? "", "dsh"),
        join(process.env.USERPROFILE ?? "", "deepseek-harness"),
    ].filter(Boolean);
    for (const c of cands) {
        const gw = join(c, "node_modules", "@deepseek-ai", "dsh-api-remotes", "lib", "client.js");
        if (existsSync(gw)) return { root: c, gateway: gw };
    }
    return null;
}

// ---------- 从网关源码提取描述符（endpoint → args wire 名数组）----------
function parseDescriptors(gatewaySrc) {
    const desc = new Map();
    const idRe = /id:\s*"([^"]+)"/g;
    const marks = [];
    let m;
    while ((m = idRe.exec(gatewaySrc))) marks.push({ id: m[1], at: m.index });
    for (let i = 0; i < marks.length; i++) {
        const seg = gatewaySrc.slice(marks[i].at, i + 1 < marks.length ? marks[i + 1].at : gatewaySrc.length);
        const ps = seg.indexOf("parameters:");
        let names = [];
        if (ps >= 0) {
            let pe = seg.indexOf("cancellation:", ps);
            if (pe < 0) pe = seg.indexOf("result:", ps);
            if (pe < 0) pe = seg.length;
            names = [...seg.slice(ps, pe).matchAll(/name:\s*"([^"]+)",\s*wire:\s*"([^"]+)"/g)].map((x) => x[2]);
        }
        const ep = marks[i].id.split("#").pop();
        if (ep && !desc.has(ep)) desc.set(ep, names);
    }
    return desc;
}

// ---------- 静态解析 main.js ----------
/** 小括号/大括号配对，取 `{` 位置对应的顶层键名 */
function topLevelKeys(src, braceStart) {
    let depth = 0;
    const parts = [];
    let cur = "";
    for (let i = braceStart; i < src.length; i++) {
        const ch = src[i];
        if (ch === "{" || ch === "[" || ch === "(") depth++;
        if (ch === "}" || ch === "]" || ch === ")") {
            depth--;
            if (depth === 0) break;
        }
        if (ch === "," && depth === 1) { parts.push(cur); cur = ""; continue; }
        if (depth >= 1) cur += ch;
        if (depth === 1 && i === braceStart) cur = "";
    }
    if (cur.trim()) parts.push(cur);
    const keys = [];
    for (const p of parts) {
        const k = p.split(":")[0].trim().replace(/^\.\.\./, "").trim();
        if (k && /^[A-Za-z_$][\w$]*$/.test(k)) keys.push(k);
    }
    return keys;
}
/** 取出 `v012Request("ep", { ... })` / `.call("ep", { ... })` 的调用点 */
function parseCallSites(src, fnName) {
    const sites = [];
    const re = new RegExp(fnName + '\\(\\s*"([^"]+)"', "g");
    let m;
    while ((m = re.exec(src))) {
        const after = src.indexOf(",", m.index + m[0].length);
        const brace = src.indexOf("{", after);
        const line = src.slice(0, m.index).split("\n").length;
        if (brace < 0 || brace - after > 40) { sites.push({ endpoint: m[1], keys: null, line }); continue; }
        sites.push({ endpoint: m[1], keys: topLevelKeys(src, brace), line });
    }
    return sites;
}

// ---------- 主流程 ----------
const located = locateDshRoot();
if (!located) {
    console.log("SKIP  未定位到已安装的 DSH（设 DSH_ROOT 指向 dsh 运行目录后重试）");
    process.exit(0);
}
console.log(`DSH 运行目录: ${located.root}`);
const desc = parseDescriptors(readFileSync(located.gateway, "utf8"));
console.log(`网关描述符: ${desc.size} 个方法\n`);

const src = readFileSync(MAIN_JS, "utf8");
const eq = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
let bad = 0;
const fail = (msg, extra = []) => { console.log(msg); for (const e of extra) console.log(e); bad++; };

// ---- A) 字面量 v012Request 调用点 ----
const literal = parseCallSites(src, "v012Request").filter((s) => /^[a-zA-Z]/.test(s.endpoint));
console.log(`---- A) v012Request 字面量调用点：${literal.length} 个 ----`);
for (const s of literal) {
    const where = `main.js:${s.line}`;
    if (!desc.has(s.endpoint)) { fail(`FAIL   ${s.endpoint}（${where}）— 网关无此方法（已改名或移除）`); continue; }
    const expect = desc.get(s.endpoint);
    if (s.keys === null) { console.log(`SKIP   ${s.endpoint}（${where}）— args 动态构造，静态不可判定`); continue; }
    if (eq(s.keys, expect)) console.log(`PASS   ${s.endpoint}  [${s.keys.join(", ")}]`);
    else fail(`FAIL   ${s.endpoint}（${where}）`,
        [`         插件发送: [${s.keys.join(", ")}]`, `         网关要求: [${expect.join(", ")}]`]);
}

// ---- B) WRAPPED 集合：映射成斜杠端点后必须只要求 request ----
const wrappedBlock = /const WRAPPED = new Set\(\[([\s\S]*?)\]\)/.exec(src);
const wrapped = [...(wrappedBlock ? wrappedBlock[1] : "").matchAll(/"([a-zA-Z][\w.]*)"/g)].map((x) => x[1]);
console.log(`\n---- B) WRAPPED 转发端点：${wrapped.length} 个（应全部只要求 request）----`);
if (!wrapped.length) fail("FAIL   没解析到 WRAPPED 集合（main.js 结构变了？）");
for (const method of wrapped) {
    const ep = method.replace(/\./g, "/");
    if (!desc.has(ep)) { fail(`FAIL   ${method} → ${ep} — 网关无此端点`); continue; }
    if (eq(desc.get(ep), ["request"])) console.log(`PASS   ${method} → ${ep}  [request]`);
    else fail(`FAIL   ${method} → ${ep}`, [`         网关要求: [${desc.get(ep).join(", ")}]，但插件按 {request} 转发`]);
}

// ---- C) 覆盖度 ----
const handled = new Set([...src.matchAll(/if \(method === "([^"]+)"\)/g)].map((x) => x[1]));
console.log(`\n---- C) 覆盖度：main.js 显式分派 ${handled.size} 个方法 ----`);
// C1) 只扫「出现在请求上下文里的 a/b 字符串」——流事件名（turn/start、assistant/chunk…）
//     也长这样，但它们在 case 分支/注释里，不是端点，扫进来只会变成噪声。
const seenEndpoints = new Set();
for (const line of src.split("\n")) {
    if (!/(v012Request|\.call\(|\/api\/|\brequest\()/.test(line)) continue;
    for (const m of line.matchAll(/"([a-zA-Z][\w-]*\/[\w/-]+)"/g)) {
        const ep = m[1];
        if (ep.startsWith("$") || ep.includes("://") || ep.includes("application/")) continue;
        seenEndpoints.add(ep);
    }
}
for (const ep of [...seenEndpoints].sort()) {
    if (desc.has(ep)) continue;
    console.log(`WARN   请求上下文里出现的 "${ep}" 不在描述符里（legacy 端点或文案，人工确认）`);
}
// C2) legacy 方法名：**未被显式分派/包装**的会走「未知方法直转发」分支，映射成斜杠端点后
//     必须真实存在，且 args 与描述符逐键相等。已分派的（含 agentPreset.list → agentPresets/list
//     这类在分支里改名的）由 A/B 覆盖——对它们用 `.`→`/` 硬映射是错的判据。
const callSites = parseCallSites(src, "\\.call");
const seenMethods = new Set();
for (const s of callSites) {
    if (seenMethods.has(s.endpoint)) continue;
    seenMethods.add(s.endpoint);
    const ep = s.endpoint.replace(/\./g, "/");
    if (handled.has(s.endpoint) || wrapped.includes(s.endpoint)) continue;
    if (!desc.has(ep)) {
        if (EXCEPTIONS.has(s.endpoint)) console.log(`SKIP   ${s.endpoint} — ${EXCEPTIONS.get(s.endpoint)}`);
        else fail(`FAIL   ${s.endpoint}（main.js:${s.line}）— 网关无此端点，也没在 EXCEPTIONS 里写明理由`);
        continue;
    }
    const expect = desc.get(ep);
    if (s.keys === null) { console.log(`SKIP   ${s.endpoint}（main.js:${s.line}）— 直转发但 args 动态，人工核对`); continue; }
    if (eq(s.keys, expect)) console.log(`PASS   ${s.endpoint} → ${ep}  [${s.keys.join(", ")}]`);
    else fail(`FAIL   ${s.endpoint} → ${ep}（main.js:${s.line}，走「未知方法」直转发分支）`,
        [`         插件发送: [${s.keys.join(", ")}]`, `         网关要求: [${expect.join(", ")}]`]);
}

console.log(`\n${bad === 0 ? "PASS" : "FAIL"}  args 审计：${bad} 处不匹配`);
process.exit(bad === 0 ? 0 : 1);
