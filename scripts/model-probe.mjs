/** 复现 v2：create->selectModel->prompt->REST 轮询事件，抓真实错误 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import crypto from "node:crypto";
import { createRequire } from "node:module";
const require2 = createRequire(import.meta.url);

const src = fs.readFileSync("D:/repos/obsidian-deepseek-harness-native/main.js", "utf8");
const authB = /\/\* ==== AUTH-PURE-BEGIN[\s\S]*?AUTH-PURE-END ==== \*\//.exec(src)[0];
const ns = new Function("crypto", "require", `${authB}
return { authMintFromCredentials };`)(crypto, require2);
const cookie = ns.authMintFromCredentials("http://127.0.0.1:3080", path.join(os.homedir(), ".dsh", ".credentials.yaml"));

const BASE = "http://127.0.0.1:3080";
let rid = 0;
const post = (ep, args) => new Promise((res, rej) => {
    const d = JSON.stringify({ type: "client-request", rpcId: "probe" + (++rid), method: ep, payload: { args } });
    const r = http.request(BASE + "/api/" + ep, { method: "POST", headers: { "content-type": "application/json", cookie } }, (x) => {
        let b = ""; x.on("data", (c) => (b += c)); x.on("end", () => {
            try { const j = JSON.parse(b); if (j.result && j.result.ok) return res(j.result.value); rej(new Error(ep + " -> " + JSON.stringify(j.result.error).slice(0, 300))); }
            catch (e) { rej(e); }
        });
    });
    r.on("error", rej); r.end(d);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readEvents(sid) {
    const snap = await post("session/page", { request: { address: { kind: "session", sessionId: sid }, throughSeq: 9999999999999, maxMessages: 100 } }).catch(async (e) => {
        const m = /cursor (\d+)/.exec(e.message || "");
        if (m) return post("session/page", { request: { address: { kind: "session", sessionId: sid }, throughSeq: Number(m[1]), maxMessages: 100 } });
        throw e;
    });
    return ((snap && snap.records) || []).map((r) => r.event);
}

async function tryProvider(provider, model) {
    console.log(`\n===== ${provider}/${model} =====`);
    const created = await post("session/create", { request: { cwd: "D:\\bywork" } });
    const sid = created.sessionId;
    await post("session/selectModel", { request: { sessionId: sid, provider, model } });
    await post("session/prompt", { request: { sessionId: sid, mode: "queue", content: [{ type: "text", text: "回复ok两个字母即可" }], requestId: "probe-" + Date.now() } });
    let evs = [];
    for (let i = 0; i < 8; i++) {
        await sleep(2500);
        evs = await readEvents(sid).catch(() => []);
        if (evs.some((e) => e.type === "turn/end")) break;
    }
    console.log("events:", evs.length, "| types:", [...new Set(evs.map((e) => e.type))].join(","));
    for (const e of evs) {
        const s = JSON.stringify(e);
        if (/error|fail|denied|invalid/i.test(e.type || "") || /error|fail/i.test(s.slice(0, 300))) {
            console.log("  WARN-EV", s.slice(0, 600));
        }
    }
    const chunkTexts = evs.filter((e) => e.type === "assistant/chunk" && e.data && e.data.chunk && e.data.chunk.type === "text-delta").map((e) => e.data.chunk.text).join("") + evs.filter((e) => e.type === "chunkrow/text-chunks").map((e) => (e.data.texts || []).join("")).join("") + evs.filter((e) => e.type === "assistant/message").map((e) => { const m = e.data && (e.data.message || e.data.content); const t = typeof m === "string" ? m : (m && m.content); return typeof t === "string" ? t : ""; }).join("");
    console.log("assistant text:", JSON.stringify(chunkTexts.slice(0, 100)));
}

await tryProvider("deepseek-official", "deepseek-v4-flash");
await tryProvider("comleader", "glm-5.3-flash");
process.exit(0);
