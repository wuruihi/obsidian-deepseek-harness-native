// v012 协议层真机回归（铸 cookie + 双协议探测 + V012Mux 流桥 E2E）
// 用法：node scripts/auth-regress.mjs [baseUrl]
// 原理：从 ../main.js 提取 AUTH-PURE / V012-PURE 标记块整段 eval 后对真机验证。
// 红线：cookie/密钥值不打印。
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require2 = createRequire(import.meta.url);

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] || "http://127.0.0.1:3080";
const PORT = new URL(BASE).port || "80";

const src = fs.readFileSync(path.join(here, "..", "main.js"), "utf8");
const authBlock = /\/\* ==== AUTH-PURE-BEGIN[\s\S]*?AUTH-PURE-END ==== \*\//.exec(src);
const muxBlock = /\/\* ==== V012-PURE-BEGIN[\s\S]*?V012-PURE-END ==== \*\//.exec(src);
if (!authBlock || !muxBlock) {
    console.error("FAIL 找不到 AUTH-PURE / V012-PURE 标记块");
    process.exit(1);
}
const ns = new Function("crypto", "http", "require", `
    ${authBlock[0]}
    ${muxBlock[0]}
    return { authMintFromCredentials, authAuthorityOf, V012Mux };
`)(crypto, http, require2);

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " -> " + detail : ""}`);
    ok ? pass++ : fail++;
};

// ---- 1. 铸 cookie：credentials → 真机 session/list 必须通 ----
const cred = path.join(os.homedir(), ".dsh", ".credentials.yaml");
const cookie = ns.authMintFromCredentials(BASE, cred);
check("铸 cookie（credentials 密钥存在）", !!cookie, cookie ? "(值不打印, 长度 " + cookie.length + ")" : "无 secret");

const post = (endpoint, body, cookieHeader) => new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request(`${BASE}/api/${endpoint}`, { method: "POST", headers: { "content-type": "application/json", ...(cookieHeader ? { cookie: cookieHeader } : {}) } }, (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => resolve({ status: res.statusCode, text: buf }));
    });
    req.on("error", () => resolve({ status: 0, text: "" }));
    req.end(data);
});

let firstSessionId = null;
if (cookie) {
    const envelope = { type: "client-request", rpcId: "regress-1", method: "session/list", payload: { args: { _request: {} } } };
    const r = await post("session/list", envelope, cookie);
    let ok = r.status === 200;
    try { const j = JSON.parse(r.text); ok = ok && j?.result?.ok === true; if (ok) firstSessionId = j.result.value?.items?.[0]?.sessionId ?? null; } catch { ok = false; }
    check("真机 session/list（铸 cookie 通过）", ok, `HTTP ${r.status}`);

    const bad = cookie.slice(0, -6) + "XXXXXX";
    const r2 = await post("session/list", { ...envelope, rpcId: "regress-2" }, bad);
    check("篡改 cookie 被拒（401/403）", r2.status === 401 || r2.status === 403, `HTTP ${r2.status}`);
}

// ---- 2. 双协议必要性：legacy 点端点在 0.1.2+ 上必须 404 ----
{
    const r = await post("session.list", { type: "client-request", rpcId: "regress-3", method: "session.list", payload: {} }, cookie);
    check("legacy 点端点已死（404，双协议层必要性）", r.status === 404, `HTTP ${r.status}`);
}

// ---- 3. V012Mux E2E：握手 → $events ready → 快照真会话 ----
if (cookie && firstSessionId) {
    const result = await new Promise((resolve) => {
        let clientId = null;
        const frames = [];
        const mux = new ns.V012Mux({
            port: PORT,
            getCookie: () => cookie,
            onFrame: (f) => frames.push(f.payload && f.payload.type),
            onReady: () => {},
            onBroken: () => {},
        });
        const timer = setTimeout(async () => {
            mux.stop();
            resolve({ clientId, frames, snap: null, timeout: true });
        }, 12000);
        mux.start();
        const pollReady = setInterval(async () => {
            if (mux.eventsClientId) {
                clientId = mux.eventsClientId;
                clearInterval(pollReady);
                const snap = await mux.snapshotOnce(firstSessionId, 24, 6000);
                clearTimeout(timer);
                mux.stop();
                resolve({ clientId, frames, snap, timeout: false });
            }
        }, 200);
    });
    check("V012Mux 握手 + $events ready（拿到 clientId）", !!result.clientId, result.clientId ? "(clientId 前 8 位 " + result.clientId.slice(0, 8) + "…)" : "");
    check("V012Mux session/follow 快照（真实会话事件）", !!(result.snap && result.snap.entries && result.snap.entries.length > 0), `entries=${result.snap ? result.snap.entries.length : 0}`);
} else {
    console.log("SKIP V012Mux E2E（无 cookie 或无真实会话）");
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
