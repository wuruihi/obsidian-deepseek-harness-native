// 用户提问应答编码回归（DSH AskUserQuestionAnswer 契约）
// 用法：node scripts/question-regress.mjs
// 原理：从 ../main.js 提取 QUESTION-PURE 标记块整段 eval 后直接断言编码结果。
// 背景：0.1.5 之前插件把答案拼成字符串，服务端 `[...answer.selected]` 抛
//       "Error: answer.selected is not iterable"（用户在 Obsidian 里看到的就是这个）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "main.js"), "utf8");
const block = /\/\* ==== QUESTION-PURE-BEGIN[\s\S]*?QUESTION-PURE-END ==== \*\//.exec(src);
if (!block) {
    console.error("FAIL 找不到 QUESTION-PURE 标记块");
    process.exit(1);
}
const ns = new Function(`
    ${block[0]}
    return { questionAnswer, questionAnswerItem };
`)();

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " -> " + detail : ""}`);
    ok ? pass++ : fail++;
};

const Q = (extra = {}) => ({ id: "q1", question: "选哪个？", options: [{ label: "甲" }, { label: "乙" }], ...extra });

// 1. 单选：selected 必须是数组且只含 label（不是拼接字符串）
{
    const a = ns.questionAnswer([Q()], [{ selected: ["甲"], custom: "" }]);
    check("单选 → selected 为数组", Array.isArray(a.answers[0].selected) && a.answers[0].selected.length === 1 && a.answers[0].selected[0] === "甲",
        JSON.stringify(a.answers[0]));
    check("id 回显提问方的 id", a.answers[0].id === "q1", a.answers[0].id);
    check("单选无自定义时不带 custom 字段", !("custom" in a.answers[0]), JSON.stringify(a.answers[0]));
}

// 2. 单选 + 自定义非空 → 清空 selected，只留 custom（对齐 QuestionComposer）
{
    const a = ns.questionAnswer([Q()], [{ selected: ["甲"], custom: "  我自己说  " }]);
    check("单选+自定义 → selected 清空、custom 去空格", a.answers[0].selected.length === 0 && a.answers[0].custom === "我自己说",
        JSON.stringify(a.answers[0]));
}

// 3. 多选（服务端字段 multiSelect）→ selected 与 custom 并存
{
    const a = ns.questionAnswer([Q({ multiSelect: true })], [{ selected: ["甲", "乙"], custom: "补充" }]);
    check("多选 multiSelect → selected 保留且与 custom 并存",
        a.answers[0].selected.join(",") === "甲,乙" && a.answers[0].custom === "补充", JSON.stringify(a.answers[0]));
}

// 4. legacy 客户端叫法 multi 也认
{
    const a = ns.questionAnswer([Q({ multi: true })], [{ selected: ["甲"], custom: "补充" }]);
    check("legacy multi 同样按多选处理", a.answers[0].selected.join(",") === "甲" && a.answers[0].custom === "补充", JSON.stringify(a.answers[0]));
}

// 5. 未作答 → selected 为空数组（服务端可迭代，不报错）
{
    const a = ns.questionAnswer([Q()], [{ selected: [], custom: "" }]);
    check("空答 → selected=[] 仍可迭代", Array.isArray(a.answers[0].selected) && a.answers[0].selected.length === 0, JSON.stringify(a.answers[0]));
}

// 6. 多题：逐一回显各自 id，与 drafts 顺序对齐
{
    const a = ns.questionAnswer([Q(), Q({ id: "q2", question: "再选一个？" })], [{ selected: ["乙"], custom: "" }, { selected: [], custom: "随便" }]);
    check("多题 id 各自回显", a.answers.length === 2 && a.answers[0].id === "q1" && a.answers[1].id === "q2", JSON.stringify(a.answers));
    check("多题答案与题目顺序对齐", a.answers[0].selected[0] === "乙" && a.answers[1].custom === "随便", JSON.stringify(a.answers));
}

// 7. 脏值防御：selected 只保留题面 label
{
    const a = ns.questionAnswer([Q()], [{ selected: ["甲", "丙（不在题面）"], custom: "" }]);
    check("题面外的值被剔除", a.answers[0].selected.join(",") === "甲", JSON.stringify(a.answers[0]));
}

// 8. 缺 id / 无 options 的退化不崩
{
    const a = ns.questionAnswer([{ question: "无 id 无选项" }], [{ selected: [], custom: "自述答案" }]);
    check("缺 id 退化且不崩", a.answers[0].id === "0" && a.answers[0].custom === "自述答案", JSON.stringify(a.answers[0]));
    const b = ns.questionAnswer(["字符串问题"], [{ selected: [], custom: "x" }]);
    check("字符串问题也编码", b.answers[0].id === "0" && b.answers[0].custom === "x", JSON.stringify(b.answers[0]));
}

// 9. drafts 缺项（题多于草稿）不崩
{
    const a = ns.questionAnswer([Q(), Q({ id: "q2" })], [{ selected: ["甲"], custom: "" }]);
    check("drafts 缺项 → 该题空答不崩", a.answers.length === 2 && a.answers[1].selected.length === 0, JSON.stringify(a.answers));
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);