// 折叠管线 v2 回归（对齐 dsh-vscode scripts/fold-regress.cjs 的用例面）
// 用法：node scripts/fold-regress.mjs
// 原理：从 ../main.js 提取 FOLD-PURE 块 + stripSystemContext 整段 eval 后直接调用。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "main.js"), "utf8");
const foldBlock = /\/\* ==== FOLD-PURE-BEGIN[\s\S]*?FOLD-PURE-END ==== \*\//.exec(src);
const stripBlock = /const INJECTED_HEADS[\s\S]*?function stripSystemContext\(text\) \{[\s\S]*?\n\}/.exec(src);
if (!foldBlock || !stripBlock) {
    console.error("FAIL 找不到 FOLD-PURE / stripSystemContext 块");
    process.exit(1);
}
const ns = new Function(`
    ${stripBlock[0]}
    ${foldBlock[0]}
    return { DshFold, foldResultCallId, foldExtractUserPayload };
`)();
const { DshFold, foldResultCallId } = ns;

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " -> " + detail : ""}`);
    ok ? pass++ : fail++;
};

// 1. chunkrow 正文恢复（v012 历史页压缩形态——不接必丢正文）
{
    const f = new DshFold();
    f.pushMany([
        { event: { type: "user/message", seq: 1, data: { text: "hi" } } },
        { event: { type: "turn/start", seq: 2, data: {} } },
        { event: { type: "chunkrow/reasoning-chunks", seq: 3, data: { texts: ["想", "一想"] } } },
        { event: { type: "chunkrow/text-chunks", seq: 4, data: { texts: ["你好", "，世界"] } } },
        { event: { type: "turn/end", seq: 5, data: {} } },
    ]);
    const turn = f.items.find((i) => i.kind === "turn");
    check("chunkrow 正文拼接", turn && turn.text === "你好，世界", `text=${JSON.stringify(turn && turn.text)}`);
    check("chunkrow 思考拼接", turn && turn.thinking === "想一想", `thinking=${JSON.stringify(turn && turn.thinking)}`);
    check("segments 顺序（thinking 先于 text）", turn && turn.segments.length === 2 && turn.segments[0].kind === "thinking" && turn.segments[1].kind === "text",
        (turn ? turn.segments.map((s) => s.kind).join(",") : "?"));
}

// 2. 交错顺序：text → tool → text 保持真实到达序
{
    const f = new DshFold();
    f.pushMany([
        { event: { type: "turn/start", seq: 1, data: {} } },
        { event: { type: "assistant/chunk", seq: 2, data: { chunk: { type: "text-delta", text: "先说。" } } } },
        { event: { type: "assistant/chunk", seq: 3, data: { chunk: { type: "tool-call", callId: "c1", name: "read" } } } },
        { event: { type: "assistant/chunk", seq: 4, data: { chunk: { type: "text-delta", text: "后说。" } } } },
    ]);
    const turn = f.items[f.items.length - 1];
    const kinds = turn ? turn.segments.map((s) => s.kind).join(",") : "?";
    check("text→tool→text 交错保序", turn && turn.segments.length === 3 && turn.segments[0].kind === "text" && turn.segments[1].kind === "tool" && turn.segments[2].kind === "text", kinds);
}

// 3. 嵌套 callId：持久 tool/result 的 callId 在 message.source.callId
{
    const f = new DshFold();
    f.pushMany([
        { event: { type: "turn/start", seq: 1, data: {} } },
        { event: { type: "assistant/chunk", seq: 2, data: { chunk: { type: "tool-call", callId: "call-7", name: "write" } } } },
        { event: { type: "tool/result", seq: 3, data: { message: { source: { callId: "call-7" }, content: [{ type: "tool-result", content: [{ type: "text", text: "写好了" }] }] } } } },
    ]);
    const turn = f.items[f.items.length - 1];
    const act = turn && turn.activities[0];
    check("嵌套 callId 配对完结", act && act.state === "done", act ? `state=${act.state}` : "no-act");
    check("嵌套结果文本提取", act && act.resultPreview === "写好了", act ? `preview=${JSON.stringify(act.resultPreview)}` : "?");
    check("foldResultCallId 三级取值", foldResultCallId({ message: { source: { callId: "x" } } }) === "x" && foldResultCallId({ callId: "y" }) === "y");
}

// 4. 跨回合回溯：turn/end 之后才落地的结果仍能配对
{
    const f = new DshFold();
    f.pushMany([
        { event: { type: "turn/start", seq: 1, data: {} } },
        { event: { type: "assistant/chunk", seq: 2, data: { chunk: { type: "tool-call", callId: "late-1", name: "bash" } } } },
        { event: { type: "turn/end", seq: 3, data: {} } },
        { event: { type: "tool/result", seq: 4, data: { callId: "late-1" } } },
    ]);
    const turn = f.items.find((i) => i.kind === "turn");
    const act = turn && turn.activities[0];
    check("跨回合回溯配对", act && act.state === "done", act ? `state=${act.state}` : "no-act");
}

// 5. 步骤卡：step/start + step/end（id 缺省用 turn-step 组合键）
{
    const f = new DshFold();
    f.pushMany([
        { event: { type: "turn/start", seq: 1, data: {} } },
        { event: { type: "step/start", seq: 2, data: { turn: 1, step: 3, title: "审查方案" } } },
        { event: { type: "step/end", seq: 3, data: { turn: 1, step: 3 } } },
    ]);
    const turn = f.items[f.items.length - 1];
    const act = turn && turn.activities[0];
    check("步骤卡配对完结", act && act.state === "done" && act.kind === "step" && act.label.includes("📍"), act ? `${act.kind}/${act.state}/${act.label}` : "no-act");
}

// 6. 子代理伪装 tool/call → 👥 换脸
{
    const f = new DshFold();
    f.pushMany([
        { event: { type: "turn/start", seq: 1, data: {} } },
        { event: { type: "tool/call", seq: 2, data: { callId: "sa1", name: "subagent", arguments: JSON.stringify({ description: "调研竞品" }) } } },
    ]);
    const turn = f.items[f.items.length - 1];
    const act = turn && turn.activities[0];
    check("子代理 👥 换脸", act && act.label.startsWith("👥") && act.label.includes("调研竞品"), act ? act.label : "no-act");
}

// 7. 指令注入丢弃（Instructions from 开头的独立注入整条不渲染）
{
    const f = new DshFold();
    f.pushMany([
        { event: { type: "user/message", seq: 1, data: { text: "Instructions from AGENTS.md\n\n全局规则…" } } },
        { event: { type: "user/message", seq: 2, data: { text: "真正的问题" } } },
    ]);
    const users = f.items.filter((i) => i.kind === "user");
    check("指令注入丢弃", users.length === 1 && users[0].text === "真正的问题", `users=${users.length}`);
}

// 8. seq 去重（WS 重连重放）
{
    const f = new DshFold();
    f.pushMany([
        { event: { type: "user/message", seq: 1, data: { text: "a" } } },
        { event: { type: "user/message", seq: 1, data: { text: "a" } } },
        { event: { type: "user/message", seq: 2, data: { text: "b" } } },
    ]);
    check("seq 去重", f.items.filter((i) => i.kind === "user").length === 2 && f.seq === 2);
}

// 9. assistant/message 退化兜底
{
    const f = new DshFold();
    f.pushMany([
        { event: { type: "turn/start", seq: 1, data: {} } },
        { event: { type: "assistant/message", seq: 2, data: { message: { content: "整段回复" } } } },
        { event: { type: "turn/end", seq: 3, data: {} } },
    ]);
    const turn = f.items.find((i) => i.kind === "turn");
    check("assistant/message 兜底", turn && turn.text === "整段回复");
}

// 10. unshiftMany 前插翻页（老页条目插在头部，oldestSeq 前移）
{
    const f = new DshFold();
    f.pushMany([
        { event: { type: "user/message", seq: 10, data: { text: "新" } } },
    ]);
    f.unshiftMany([
        { event: { type: "user/message", seq: 5, data: { text: "老" } } },
    ]);
    check("翻页前插", f.items.length === 2 && f.items[0].text === "老" && f.oldestSeq === 5);
}

// 11. 产物收集（v0.7.0）：diff 卡 locations 进 produced；读类卡不进
{
    const f = new DshFold();
    f.pushMany([
        { event: { type: "turn/start", seq: 1, data: {} } },
        { event: { type: "tool/result", seq: 2, data: { callId: "w1" } }, view: { card: "diff", locations: [{ path: "D:\\work\\a.md" }, { path: "D:\\work\\b.md" }] } },
        { event: { type: "tool/result", seq: 3, data: { callId: "r1" } }, view: { card: "generic", kind: "read", locations: [{ path: "D:\\work\\c.md" }] } },
        { event: { type: "tool/result", seq: 4, data: { callId: "w2" } }, view: { card: "diff", locations: [{ path: "D:\\work\\a.md" }] } },
    ]);
    const turn = f.items[f.items.length - 1];
    const p = (turn && turn.produced) || [];
    check("产物收集", p.length === 2 && p[0] === "D:\\work\\a.md" && p[1] === "D:\\work\\b.md", JSON.stringify(p));
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
