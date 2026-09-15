// 模型解析回归（对齐 dsh-vscode scripts/model-regress.cjs 的用例面）
// 用法：node scripts/model-regress.mjs
// 原理：从 ../main.js 提取 MODEL-PURE 块 eval 后直接调用（纯函数，无需宿主）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "main.js"), "utf8");
const block = /\/\* ==== MODEL-PURE-BEGIN[\s\S]*?MODEL-PURE-END ==== \*\//.exec(src);
if (!block) {
    console.error("FAIL 找不到 MODEL-PURE 块");
    process.exit(1);
}
const ns = new Function(`
    ${block[0]}
    return { modelChoiceOf, realModelOf, modelEchoOf, modelMemoryWorthy, modelSelectionOf };
`)();
const { modelChoiceOf, realModelOf, modelEchoOf, modelMemoryWorthy, modelSelectionOf } = ns;

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " -> " + detail : ""}`);
    ok ? pass++ : fail++;
};

// 真机载荷（会话 session-7c9fa9c4 实测：会话真实模型与 catalog default 不同）
const REAL_MS = {
    lastUsed: { provider: "deepseek-official", model: "deepseek-flash", reasoningEffort: "high" },
    next: { provider: "deepseek-official", model: "deepseek-flash", reasoningEffort: "high" },
};
const CATALOG = {
    default: { provider: "comleader", model: "deepseek-v4.1-flash" },
    routableProviders: ["comleader"],
    groups: [{ id: "comleader", name: "Comleader", models: [{ id: "deepseek-v4.1-flash" }] }],
    failures: [],
};

// 1) next 优先（待生效切换立刻可见）
check("next 优先于 lastUsed",
    realModelOf({ lastUsed: { provider: "a", model: "old" }, next: { provider: "a", model: "new" } })?.model === "new",
    JSON.stringify(realModelOf({ lastUsed: { provider: "a", model: "old" }, next: { provider: "a", model: "new" } })));

// 2) next 缺失/为空 → 回落 lastUsed
check("next 为 null → lastUsed",
    realModelOf({ lastUsed: { provider: "a", model: "old" }, next: null })?.model === "old");
check("只有 lastUsed",
    realModelOf(REAL_MS)?.provider === "deepseek-official" && realModelOf(REAL_MS)?.reasoningEffort === "high",
    JSON.stringify(realModelOf(REAL_MS)));

// 3) 缺字段/畸形 → undefined（不能抛、不能编）
check("空投影 → undefined", realModelOf({ lastUsed: null, next: null }) === undefined);
check("非对象 → undefined", realModelOf(undefined) === undefined && realModelOf("glm-5.3") === undefined);
check("畸形（缺 model）→ undefined", realModelOf({ next: { provider: "a" } }) === undefined);

// 4) catalog 形状永不冒充会话模型（本轮 bug 的核心断言）
check("catalog 形状 → undefined（不冒充会话模型）", realModelOf(CATALOG) === undefined, JSON.stringify(realModelOf(CATALOG)));
check("catalog.default 也不是会话模型", realModelOf({ default: CATALOG.default }) === undefined);

// 5) selectModel 回执归一化
check("回执 selected 优先",
    modelEchoOf({ selected: { provider: "comleader", model: "glm-5.3" } }, { provider: "x", model: "y" })?.model === "glm-5.3");
check("回执缺失 → 退回请求值",
    modelEchoOf(null, { provider: "comleader", model: "glm-5.3" })?.model === "glm-5.3"
    && modelEchoOf({}, { provider: "comleader", model: "glm-5.3" })?.model === "glm-5.3");
check("回执畸形 → 退回请求值",
    modelEchoOf({ selected: { provider: "comleader" } }, { provider: "comleader", model: "glm-5.3" })?.model === "glm-5.3");
check("两侧都空 → undefined", modelEchoOf(null, null) === undefined);

// 6) 投影载荷两种形状（历史快照 {values} / 投影帧 {key,value}）
check("modelSelectionOf: {values:{modelSelection}}",
    modelSelectionOf({ values: { modelSelection: REAL_MS } }) === REAL_MS);
check("modelSelectionOf: {modelSelection}", modelSelectionOf({ modelSelection: REAL_MS }) === REAL_MS);
check("modelSelectionOf: 空 → undefined", modelSelectionOf(null) === undefined && modelSelectionOf({ values: {} }) === undefined);

// 7) 项目记忆资格：空白 / 子代理 / 非本工作区 都不能当「本项目最近使用模型」
check("普通真实会话 → 可记", modelMemoryWorthy({ sessionId: "s1", blank: false }, true) === true);
check("空白会话 → 不记", modelMemoryWorthy({ blank: true }, true) === false);
check("子代理会话 → 不记", modelMemoryWorthy({ blank: false, origin: "subagent" }, true) === false);
check("非本工作区 → 不记", modelMemoryWorthy({ blank: false }, false) === false);
check("无行 → 不记", modelMemoryWorthy(undefined, true) === false);

// 8) modelChoiceOf 形状校验
check("modelChoiceOf 需要 provider+model",
    modelChoiceOf({ provider: "a", model: "b" })?.model === "b" && modelChoiceOf({ provider: "a" }) === undefined
    && modelChoiceOf({ model: "b" }) === undefined && modelChoiceOf(null) === undefined);
check("空字符串 effort 不进对象", Object.keys(modelChoiceOf({ provider: "a", model: "b", reasoningEffort: "" }) || {}).sort().join(",") === "model,provider");

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);