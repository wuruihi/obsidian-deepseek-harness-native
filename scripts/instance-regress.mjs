// 实例选择回归（v0.7.7，对齐 dsh-vscode §3.5 的实例优先级）
// 用法：node scripts/instance-regress.mjs
// 原理：从 ../main.js 提取 INSTANCE-PURE 块 eval 后直接调用（纯函数，无需宿主/网络）。
//
// 为什么要有它：2026-10-08 用户报「连不上」——插件原来只有「服务端口（默认 3080）」，那是
// **旧 CLI** 的端口，而旧 CLI 已于 2026-09-30 删除、桌面版 App（19387）一直活着。
// 这里锁住"显式配置优先 → 否则桌面版优先 → 都没有时给桌面版指引"的契约。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "main.js"), "utf8");
const block = /\/\* ==== INSTANCE-PURE-BEGIN[\s\S]*?INSTANCE-PURE-END ==== \*\//.exec(src);
if (!block) {
    console.error("FAIL 找不到 INSTANCE-PURE 块");
    process.exit(1);
}
const ns = new Function(`
    ${block[0]}
    return { instanceCandidates, pickInstance, DESKTOP_APP_PORT, LEGACY_WEB_PORT, INSTANCE_MODES };
`)();
const { instanceCandidates, pickInstance, DESKTOP_APP_PORT, LEGACY_WEB_PORT } = ns;

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " -> " + detail : ""}`);
    ok ? pass++ : fail++;
};
const kinds = (cands) => cands.map((c) => c.kind + ":" + c.port).join(",");

// 1) 常量与基调
check("桌面版端口 = 19387、旧版默认 = 3080", DESKTOP_APP_PORT === 19387 && LEGACY_WEB_PORT === 3080);

// 2) auto 模式：候选顺序 = 桌面版 → 旧版
check("auto：候选顺序 桌面版→旧版", kinds(instanceCandidates({ instance: "auto", port: 3080 })) === "desktop:19387,legacy:3080",
    kinds(instanceCandidates({ instance: "auto", port: 3080 })));

// 3) auto + 桌面版活着 → 连桌面版（这就是本次故障的修复点）
check("auto：桌面版活着 → 选桌面版",
    pickInstance({ instance: "auto", port: 3080 }, { 19387: true, 3080: true }).port === 19387 &&
    pickInstance({ instance: "auto", port: 3080 }, { 19387: true, 3080: true }).kind === "desktop");

// 4) auto + 只有旧版活着 → 退旧版
check("auto：只有旧版活着 → 选旧版",
    pickInstance({ instance: "auto", port: 3080 }, { 19387: false, 3080: true }).kind === "legacy");

// 5) auto + 都没起 → 给桌面版并标 alive:false（上层据此提示"打开桌面版 App"，而不是跑旧版启动命令）
const dead = pickInstance({ instance: "auto", port: 3080 }, {});
check("auto：都没起 → 首选桌面版 + alive:false", dead.kind === "desktop" && dead.port === 19387 && dead.alive === false);

// 6) auto + 自定义端口：尊重自定义端口（仍桌面版优先）
check("auto：自定义端口候选 = 桌面版→自定义",
    kinds(instanceCandidates({ instance: "auto", port: 4000 })) === "desktop:19387,legacy:4000");
check("auto：自定义端口活着 + 桌面版活着 → 仍桌面版优先",
    pickInstance({ instance: "auto", port: 4000 }, { 19387: true, 4000: true }).port === 19387);

// 7) 自定义端口恰好等于桌面版端口 → 不重复探测
check("auto：端口=19387 时不重复候选", kinds(instanceCandidates({ instance: "auto", port: 19387 })) === "desktop:19387");

// 8) 显式模式：只给一个候选（不被自动探测顶掉）
check("desktop 模式：只探桌面版", kinds(instanceCandidates({ instance: "desktop", port: 3080 })) === "desktop:19387");
check("legacy 模式：只探自定义端口", kinds(instanceCandidates({ instance: "legacy", port: 4000 })) === "legacy:4000");
check("legacy 模式：选中的就是它（哪怕桌面版活着）",
    pickInstance({ instance: "legacy", port: 4000 }, { 19387: true, 4000: true }).kind === "legacy");

// 9) 宽松校验：非法/缺失/畸形配置一律按 auto
check("instance 非法值 → 按 auto", kinds(instanceCandidates({ instance: "nonsense", port: 3080 })) === "desktop:19387,legacy:3080");
check("instance 缺失 → 按 auto", kinds(instanceCandidates({ port: 3080 })) === "desktop:19387,legacy:3080");
check("settings 为 null/undefined → 按 auto 且不抛", kinds(instanceCandidates(null)) === "desktop:19387,legacy:3080");
check("port 非法（0/NaN/空）→ 回落 3080", kinds(instanceCandidates({ instance: "auto", port: 0 })) === "desktop:19387,legacy:3080"
    && kinds(instanceCandidates({ instance: "auto", port: "abc" })) === "desktop:19387,legacy:3080");

// 10) 标签人话（设置/诊断里直接展示）
check("候选带人话标签", instanceCandidates({ instance: "auto", port: 3080 })[0].label.includes("桌面版 App")
    && instanceCandidates({ instance: "auto", port: 3080 })[1].label.includes("旧版 dsh web"));

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);