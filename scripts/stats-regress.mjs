// 底栏 token 口径回归（对齐 dsh-vscode v0.18.1 + 本体 GUI 实测口径）
// 用法：node scripts/stats-regress.mjs
// 原理：从 ../main.js 提取 STATS-PURE 块 eval 后直接调用。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "main.js"), "utf8");
const block = /\/\* ==== STATS-PURE-BEGIN[\s\S]*?STATS-PURE-END ==== \*\//.exec(src);
if (!block) {
    console.error("FAIL 找不到 STATS-PURE 块");
    process.exit(1);
}
const ns = new Function(`${block[0]}\nreturn { fmtTokenCount, tokenLineOf };`)();
const { fmtTokenCount, tokenLineOf } = ns;

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " -> " + detail : ""}`);
    ok ? pass++ : fail++;
};

// 真机 wire 数字（VSCode v0.18.1 changelog 校准过的同一组）
const WIRE = { uncachedInputTokens: 487647, cacheReadTokens: 3560960, outputTokens: 69909, cacheWriteTokens: 0 };
check("真机口径：命中率 + 总输入 + 输出",
    tokenLineOf(WIRE) === "缓存命中 88%  ·  输入 4.0M tok  ·  输出 69.9K tok",
    JSON.stringify(tokenLineOf(WIRE)));
// 旧实现只显示 uncached（487647 → 487.6K），量级差 ~8 倍——断言不会退回去
check("输入是总输入（不是只算 uncached）", !tokenLineOf(WIRE).includes("487.6K") && tokenLineOf(WIRE).includes("4.0M tok"));

check("全零 → 空串（不出现 NaN%）", tokenLineOf({ uncachedInputTokens: 0, cacheReadTokens: 0, outputTokens: 0 }) === "",
    JSON.stringify(tokenLineOf({ uncachedInputTokens: 0, cacheReadTokens: 0, outputTokens: 0 })));
check("空/缺失载荷 → 空串", tokenLineOf(undefined) === "" && tokenLineOf({}) === "" && tokenLineOf(null) === "");
check("零值字段不显示（新会话不出现 0 tok）", !tokenLineOf({ uncachedInputTokens: 0, cacheReadTokens: 0, outputTokens: 5 }).includes("输入"));

check("只有输出", tokenLineOf({ outputTokens: 500 }) === "输出 500 tok", JSON.stringify(tokenLineOf({ outputTokens: 500 })));
check("100% 命中（uncached=0）", tokenLineOf({ cacheReadTokens: 5000, uncachedInputTokens: 0, outputTokens: 0 }) === "缓存命中 100%  ·  输入 5.0K tok",
    JSON.stringify(tokenLineOf({ cacheReadTokens: 5000, uncachedInputTokens: 0, outputTokens: 0 })));
check("0% 命中（cacheRead=0）", tokenLineOf({ cacheReadTokens: 0, uncachedInputTokens: 2000 }) === "缓存命中 0%  ·  输入 2.0K tok",
    JSON.stringify(tokenLineOf({ cacheReadTokens: 0, uncachedInputTokens: 2000 })));
check("cacheWrite 不计入输入", tokenLineOf({ cacheReadTokens: 100, uncachedInputTokens: 100, cacheWriteTokens: 999999 }) === "缓存命中 50%  ·  输入 200 tok",
    JSON.stringify(tokenLineOf({ cacheReadTokens: 100, uncachedInputTokens: 100, cacheWriteTokens: 999999 })));

check("K/M 缩写边界", fmtTokenCount(999) === "999" && fmtTokenCount(1000) === "1.0K" && fmtTokenCount(999999) === "1000.0K"
    && fmtTokenCount(1000000) === "1.0M" && fmtTokenCount(0) === "0",
    [999, 1000, 999999, 1000000, 0].map(fmtTokenCount).join(","));
check("非数字字段按 0 处理（不抛 NaN）", tokenLineOf({ outputTokens: "abc", cacheReadTokens: null }) === "");

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);