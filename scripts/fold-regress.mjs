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
    return { DshFold, foldResultCallId, foldExtractUserPayload, foldLatestTurn, foldAssistantParts };
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

// 8. v0.7.1 失败回合：turn/end.reason(kind=error) 必须落到 turn.error（否则空气泡 = 用户以为没生效）
{
    const f = new DshFold();
    f.pushMany([
        { event: { type: "turn/start", seq: 1, data: {} } },
        { event: { type: "turn/end", seq: 2, data: { turn: 1, reason: { kind: "error", error: { message: "DeepSeek request extension preparation failed", code: "REQUEST_EXTENSION" } } } } },
    ]);
    const turn = f.items[f.items.length - 1];
    check("失败回合 reason → turn.error", !!(turn && turn.error) && turn.error.code === "REQUEST_EXTENSION" && /extension preparation/.test(turn.error.message),
        turn && turn.error ? `${turn.error.code} ${turn.error.message}` : "no-error");
}

// 9. 正常结束不产生 error（不能把完成态误判为失败）
{
    const f = new DshFold();
    f.pushMany([
        { event: { type: "turn/start", seq: 1, data: {} } },
        { event: { type: "turn/end", seq: 2, data: { turn: 1, reason: { kind: "completed" } } } },
    ]);
    const turn = f.items[f.items.length - 1];
    check("正常结束不带 error", !!turn && turn.ended === true && turn.error === undefined, `error=${JSON.stringify(turn && turn.error)}`);
}

// 10. v0.7.2 0.1.5 形状：assistant/message 的 content 是**数组**——必须还原正文，
//     且正文要进 segments（渲染层有 segments 时只按段渲染，只写 text 会「有正文但不显示」）
{
    const f = new DshFold();
    f.pushMany([
        { event: { type: "turn/start", seq: 1, data: {} } },
        { event: { type: "step/start", seq: 2, data: { turn: 1, step: 1, title: "回答" } } },
        { event: { type: "assistant/message", seq: 3, data: { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "text", text: "你好，吴胖。" }] } } } },
        { event: { type: "turn/end", seq: 4, data: { turn: 1, reason: { kind: "completed" } } } },
    ]);
    const turn = f.items.filter((i) => i.kind === "turn").pop();
    check("0.1.5 数组正文 → turn.text", !!turn && turn.text === "你好，吴胖。", JSON.stringify(turn && turn.text));
    check("数组正文进 segments（否则渲染层看不到）", !!turn && turn.segments.some((s) => s.kind === "text" && s.text === "你好，吴胖。"),
        turn ? turn.segments.map((s) => s.kind).join(",") : "?");
}

// 11. 混合部件：tool-call 部件不算正文，reasoning 部件进思考
{
    const f = new DshFold();
    f.pushMany([
        { event: { type: "turn/start", seq: 1, data: {} } },
        { event: { type: "assistant/message", seq: 2, data: { turn: 1, step: 1, message: { role: "assistant", content: [
            { type: "reasoning", text: "先想一下" },
            { type: "text", text: "先说结论。" },
            { type: "tool-call", id: "c1", name: "read", arguments: '{"path":"a.md"}' },
        ] } } } },
    ]);
    const turn = f.items.filter((i) => i.kind === "turn").pop();
    check("tool-call 部件不进正文", !!turn && turn.text === "先说结论。", JSON.stringify(turn && turn.text));
    check("reasoning 部件 → thinking", !!turn && turn.thinking === "先想一下", JSON.stringify(turn && turn.thinking));
}

// 12. legacy 字符串形态仍然兼容（{content:"…"} 与裸字符串两种）
{
    const a = new DshFold();
    a.pushMany([
        { event: { type: "turn/start", seq: 1, data: {} } },
        { event: { type: "assistant/message", seq: 2, data: { turn: 1, message: { role: "assistant", content: "旧版整段" } } } },
    ]);
    check("legacy {content:字符串}", a.items.filter((i) => i.kind === "turn").pop().text === "旧版整段", JSON.stringify(a.items.filter((i) => i.kind === "turn").pop().text));
    const b = new DshFold();
    b.pushMany([
        { event: { type: "turn/start", seq: 1, data: {} } },
        { event: { type: "assistant/message", seq: 2, data: "裸字符串正文" } },
    ]);
    check("legacy 裸字符串", b.items.filter((i) => i.kind === "turn").pop().text === "裸字符串正文", JSON.stringify(b.items.filter((i) => i.kind === "turn").pop().text));
}

// 13. foldLatestTurn（轮询兜底路径）同源处理数组正文 + 结束/失败原因
{
    const events = [
        { event: { type: "turn/start", seq: 1, data: {} } },
        { event: { type: "assistant/message", seq: 2, data: { turn: 1, message: { role: "assistant", content: [{ type: "text", text: "轮询正文" }] } } } },
        { event: { type: "turn/end", seq: 3, data: { turn: 1, reason: { kind: "completed" } } } },
    ];
    const t = ns.foldLatestTurn(events);
    check("foldLatestTurn 还原数组正文", !!t && t.text === "轮询正文" && t.ended === true && t.error === null, JSON.stringify(t));
    const t2 = ns.foldLatestTurn([
        { event: { type: "turn/start", seq: 1, data: {} } },
        { event: { type: "turn/end", seq: 2, data: { turn: 1, reason: { kind: "error", error: { message: "炸了", code: "X" } } } } },
    ]);
    check("foldLatestTurn 带出失败 reason", !!t2 && t2.ended === true && t2.error && t2.error.code === "X", JSON.stringify(t2 && t2.error));
    check("foldLatestTurn 无 turn 返回 null", ns.foldLatestTurn([{ event: { type: "user/message", seq: 1, data: {} } }]) === null);
}

// 14. 真实 0.1.5 次序复现（用户 bug）：turn/start → user/message(人类) → 注入帧 → assistant/message
//     → turn/end。旧实现把 user 当回合边界：正文被丢、turn 永远不 ended、DOM 里回复还在用户气泡上面。
{
    const f = new DshFold();
    f.pushMany([
        { event: { type: "agent/inbox/spliced", seq: 4, data: { target: "next-turn", inserted: [{ content: [{ type: "text", text: "你好" }], source: { kind: "user" } }] } } },
        { event: { type: "turn/start", seq: 5, data: { turn: 1 } } },
        { event: { type: "step/start", seq: 7, data: { turn: 1, step: 1, title: "回答" } } },
        { event: { type: "user/message", seq: 9, data: { source: { kind: "user", rpcId: "obs-1" }, content: [{ type: "text", text: "你好" }] } } },
        { event: { type: "user/message", seq: 10, data: { source: { kind: "plugin" }, content: [{ type: "text", text: "<system-reminder>\nMemory context auto-loaded by dsh-memory-loader.</system-reminder>" }] } } },
        { event: { type: "user/message", seq: 13, data: { source: { kind: "skill-catalog" }, content: [{ type: "text", text: "<system-reminder>\n<available_skills></available_skills></system-reminder>" }] } } },
        { event: { type: "assistant/message", seq: 19, data: { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "text", text: "你好！有什么可以帮你的？" }] } } } },
        { event: { type: "step/end", seq: 20, data: { turn: 1, step: 1 } } },
        { event: { type: "turn/end", seq: 21, data: { turn: 1, reason: { kind: "completed" } } } },
    ]);
    const turns = f.items.filter((i) => i.kind === "turn");
    const users = f.items.filter((i) => i.kind === "user");
    const ti = f.items.findIndex((i) => i.kind === "turn");
    const ui = f.items.findIndex((i) => i.kind === "user");
    check("0.1.5 次序：只产生 1 个回合（user 不再切分回合）", turns.length === 1, `turns=${turns.length}`);
    check("0.1.5 次序：正文被还原", turns.length === 1 && turns[0].text === "你好！有什么可以帮你的？", JSON.stringify(turns[0] && turns[0].text));
    check("0.1.5 次序：turn 正确 ended", turns.length === 1 && turns[0].ended === true, `ended=${turns[0] && turns[0].ended}`);
    check("0.1.5 次序：注入帧不入 items（只剩人类消息）", users.length === 1 && users[0].text === "你好", `users=${users.length} ${JSON.stringify(users.map((u) => u.text))}`);
    check("0.1.5 次序：用户气泡排在回合之前（DOM 顺序正确）", ui >= 0 && ti >= 0 && ui < ti, `userIdx=${ui} turnIdx=${ti}`);
}

// 15. legacy 次序（user 在 turn/start 之前）仍然正确：两个回合各自带正文
{
    const f = new DshFold();
    f.pushMany([
        { event: { type: "user/message", seq: 1, data: { source: { kind: "user" }, content: [{ type: "text", text: "第一问" }] } } },
        { event: { type: "turn/start", seq: 2, data: { turn: 1 } } },
        { event: { type: "assistant/message", seq: 3, data: { turn: 1, message: { role: "assistant", content: [{ type: "text", text: "第一答" }] } } } },
        { event: { type: "turn/end", seq: 4, data: { turn: 1, reason: { kind: "completed" } } } },
        { event: { type: "user/message", seq: 5, data: { source: { kind: "user" }, content: [{ type: "text", text: "第二问" }] } } },
        { event: { type: "turn/start", seq: 6, data: { turn: 2 } } },
        { event: { type: "assistant/message", seq: 7, data: { turn: 2, message: { role: "assistant", content: [{ type: "text", text: "第二答" }] } } } },
        { event: { type: "turn/end", seq: 8, data: { turn: 2, reason: { kind: "completed" } } } },
    ]);
    const turns = f.items.filter((i) => i.kind === "turn");
    const kinds = f.items.map((i) => i.kind).join(",");
    check("legacy 次序：两回合各自正文", turns.length === 2 && turns[0].text === "第一答" && turns[1].text === "第二答", turns.map((t) => t.text).join("|"));
    check("legacy 次序：user/turn 交替", kinds === "user,turn,user,turn", kinds);
}

// 16. turn/start 缺 turn/end（丢帧）时不吞下一轮内容
{
    const f = new DshFold();
    f.pushMany([
        { event: { type: "turn/start", seq: 1, data: { turn: 1 } } },
        { event: { type: "assistant/message", seq: 2, data: { turn: 1, message: { role: "assistant", content: [{ type: "text", text: "旧轮" }] } } } },
        { event: { type: "turn/start", seq: 3, data: { turn: 2 } } },
        { event: { type: "assistant/message", seq: 4, data: { turn: 2, message: { role: "assistant", content: [{ type: "text", text: "新轮" }] } } } },
        { event: { type: "turn/end", seq: 5, data: { turn: 2, reason: { kind: "completed" } } } },
    ]);
    const turns = f.items.filter((i) => i.kind === "turn");
    check("丢 turn/end：旧轮被收口、新轮独立", turns.length === 2 && turns[0].ended === true && turns[1].text === "新轮" && turns[1].ended === true,
        turns.map((t) => `${t.text}/${t.ended}`).join(" | "));
}

// 17. v0.7.3（对齐 VSCode v0.18.2）：多步回合——每个 step 各有一条完成消息，正文必须全都收
{
    const f = new DshFold();
    f.pushMany([
        { event: { type: "turn/start", seq: 1, data: { turn: 1 } } },
        { event: { type: "step/start", seq: 2, data: { turn: 1, step: 1, title: "看文件" } } },
        { event: { type: "assistant/message", seq: 3, data: { turn: 1, step: 1, message: { role: "assistant", content: [
            { type: "text", text: "我先看文件。" },
            { type: "tool-call", id: "c1", name: "read", arguments: '{"path":"a.md"}' },
        ] } } } },
        { event: { type: "tool/call", seq: 4, data: { turn: 1, step: 1, callId: "c1", name: "read", arguments: '{"path":"a.md"}' } } },
        { event: { type: "step/end", seq: 5, data: { turn: 1, step: 1 } } },
        { event: { type: "step/start", seq: 6, data: { turn: 1, step: 2, title: "总结" } } },
        { event: { type: "assistant/message", seq: 7, data: { turn: 1, step: 2, message: { role: "assistant", content: [
            { type: "text", text: "结论：这样做。" },
        ] } } } },
        { event: { type: "turn/end", seq: 8, data: { turn: 1, reason: { kind: "completed" } } } },
    ]);
    const turn = f.items.filter((i) => i.kind === "turn").pop();
    check("多步回合：两步正文都在", !!turn && turn.text === "我先看文件。结论：这样做。", JSON.stringify(turn && turn.text));
    check("多步回合：正文按步进 segments", !!turn && turn.segments.filter((s) => s.kind === "text").map((s) => s.text).join("|") === "我先看文件。|结论：这样做。",
        turn ? turn.segments.map((s) => s.kind).join(",") : "?");
}

// 18. 按 step 去重：delta 流过的 step 不重复收完成消息，没流过的 step 必须收
{
    const f = new DshFold();
    f.pushMany([
        { event: { type: "turn/start", seq: 1, data: { turn: 1 } } },
        { event: { type: "assistant/chunk", seq: 2, data: { turn: 1, step: 1, chunk: { type: "text-delta", text: "流式一" } } } },
        { event: { type: "assistant/message", seq: 3, data: { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "text", text: "流式一" }] } } } },
        { event: { type: "assistant/message", seq: 4, data: { turn: 1, step: 2, message: { role: "assistant", content: [{ type: "text", text: "补收二" }] } } } },
        { event: { type: "turn/end", seq: 5, data: { turn: 1, reason: { kind: "completed" } } } },
    ]);
    const turn = f.items.filter((i) => i.kind === "turn").pop();
    check("按 step 去重：delta 步不重复", !!turn && turn.text === "流式一补收二", JSON.stringify(turn && turn.text));
}

// 19. foldLatestTurn（轮询兜底）同样要收多步正文
{
    const t = ns.foldLatestTurn([
        { event: { type: "turn/start", seq: 1, data: { turn: 1 } } },
        { event: { type: "assistant/chunk", seq: 2, data: { turn: 1, step: 1, chunk: { type: "text-delta", text: "流一" } } } },
        { event: { type: "assistant/message", seq: 3, data: { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "text", text: "流一" }] } } } },
        { event: { type: "assistant/message", seq: 4, data: { turn: 1, step: 2, message: { role: "assistant", content: [{ type: "text", text: "步二" }] } } } },
        { event: { type: "turn/end", seq: 5, data: { turn: 1, reason: { kind: "completed" } } } },
    ]);
    check("foldLatestTurn 多步 + 去重", !!t && t.text === "流一歩二".replace("歩", "步") && t.ended === true, JSON.stringify(t && t.text));
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
