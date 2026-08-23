// dsh-ui 围栏切分 + 容错解析 回归测试（对齐 dsh-vscode scripts/fence-regress.cjs 的 8 个用例）
// 用法：node scripts/fence-regress.mjs
// 原理：从 ../main.js 提取 FENCE-PURE-BEGIN..END 纯函数区整段 eval 后直接调用。
//       动渲染器（切分/修复管线）必跑本脚本。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "main.js"), "utf8");
const m = /\/\* ==== FENCE-PURE-BEGIN[\s\S]*?FENCE-PURE-END ==== \*\//.exec(src);
if (!m) {
    console.error("FAIL 找不到 FENCE-PURE 标记块——main.js 的纯函数区被挪动了？");
    process.exit(1);
}
const ns = new Function(`
    ${m[0]}
    return { cheapRepairs, balanceClose, scanJsonValue, repairSpec, parseSpec, specStart, balancedEnd, splitDshUiSegments };
`)();
const { parseSpec, splitDshUiSegments } = ns;

// 每个用例：[名称, 输入文本, 断言(segs, parsedFirstFence)]
const cases = [
    ["glued opener 开栏符粘句尾",
        '前文。一句话主线。```dsh-ui\n{"items": [{"type": "text", "content": "a"}]}\n```\n后文正文。',
        (segs) => segs.filter(x => x.kind === "fence").length === 1
            && segs.some(t => t.kind === "text" && t.text.includes("前文"))
            && segs.some(t => t.kind === "text" && t.text.includes("后文正文"))],
    ["missing closer + prose 漏闭合栏吞正文",
        '按消化规则。```dsh-ui\n{"items": [{"type": "callout", "content": "x"}], "gap": 14}\n\n补充说明自由组合。\n\n以上',
        (segs) => segs.filter(x => x.kind === "fence").length === 1
            && segs.some(t => t.kind === "text" && t.text.includes("补充说明"))],
    ["bare components 裸组件序列",
        '```dsh-ui\n{"type": "button", "label": "A"}\n{"type": "button", "label": "B"}\n```',
        (segs) => segs.filter(x => x.kind === "fence").length === 1],
    ["early-close + orphans root提前闭合+孤儿",
        '```dsh-ui\n{"items": [{"type": "text", "content": "x"}]}},{"type": "text", "content": "y"}\n```',
        (segs) => segs.filter(x => x.kind === "fence").length === 1],
    ["plain fence hides literal 普通围栏里的字面标记不误触",
        '```js\nvar s = "```dsh-ui";\n```\nreal prose',
        (segs) => segs.filter(x => x.kind === "fence").length === 0
            && segs.some(t => t.kind === "text" && t.text.includes("real prose"))],
    ["streaming partial 流式半截",
        '正文\n```dsh-ui\n{"items": [{"type": "text", "content": "半截',
        (segs) => segs.filter(x => x.kind === "fence").length === 1 && segs.filter(x => x.kind === "text").length === 1],
    ["two clean fences 两个干净围栏",
        'a\n\n```dsh-ui\n{"items": [{"type": "text", "content": "1"}]}\n```\n\nb\n\n```dsh-ui\n{"items": [{"type": "text", "content": "2"}]}\n```\n\nc',
        (segs) => segs.filter(x => x.kind === "fence").length === 2],
    ["user exact badcase 真实坏例(3.3)",
        '3.3 拆给你听。\n\n一句话主线：时机完全不同。```dsh-ui\n{"title": "3.3 到底在说什么", "gap": 14, "items": [{"type": "text", "size": "h3", "content": "第一件"}, {"type": "timeline", "items": [{"time": "2025-01", "title": "常住人口登记", "desc": "张三"}]}]}\n\n\n剩下两条小规则补一句就通：\n\n- **时间打平**：标待核实\n\n以上',
        (segs) => segs.filter(x => x.kind === "fence").length === 1
            && segs.some(t => t.kind === "text" && t.text.includes("剩下两条小规则"))],
];

let pass = 0;
for (const [name, input, check] of cases) {
    try {
        const segs = splitDshUiSegments(input);
        const ok = check(segs);
        console.log(`${ok ? "PASS" : "FAIL"} ${name} -> ${segs.map(s => s.kind + "(" + s.text.length + "ch)").join(", ")}`);
        if (ok) pass++;
    } catch (e) {
        console.log(`ERROR ${name}: ${e.message}`);
    }
}

// ---- 解析层专项（parseSpec 四级链）----
const parseCases = [
    ["plain valid 合法 JSON", '{"title":"t","items":[{"type":"text","content":"a"}]}', (r) => r && r.items.length === 1 && r.title === "t"],
    ["smart quotes + trailing comma 结构引号是智能引号/尾逗号", '{“items”:[{“type”:“text”,“content”:“a”}],}', (r) => r && r.items.length === 1],
    ["bracket-balance }顶未关数组", '{"items":[{"type":"text","content":"x"}]},{\"type\":\"badge\",\"label\":\"b\"}', (r) => r && Array.isArray(r.items)],
    ["bare array 裸数组包壳", '[{"type":"text","content":"a"},{"type":"badge","label":"b"}]', (r) => r && !r.type && !r.title && r.items.length === 2],
    ["bare sequence 裸序列包壳", '{"type":"button","label":"A"}\n{"type":"button","label":"B"}', (r) => r && r.items.length === 2],
    ["truncation tail 截断自动闭合", '{"items":[{"type":"text","content":"半截"', (r) => r && Array.isArray(r.items)],
    ["prose tail tolerance 正文尾巴容忍", '{"title":"t","items":[{"type":"text","content":"a"}]} 这是栏内混进的正文，应当被忽略而不是整体报废', (r) => r && r.title === "t"],
];
for (const [name, input, check] of parseCases) {
    try {
        const r = parseSpec(input);
        const ok = check(r);
        console.log(`${ok ? "PASS" : "FAIL"} [parse] ${name}${ok ? "" : " -> " + JSON.stringify(r)}`);
        if (ok) pass++;
    } catch (e) {
        console.log(`ERROR [parse] ${name}: ${e.message}`);
    }
}

const total = cases.length + parseCases.length;
console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
