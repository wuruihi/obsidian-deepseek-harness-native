// 实例选择回归（v0.7.9：桌面版端口运行时发现，对齐 dsh-vscode 0.21.4）
// 用法：node scripts/instance-regress.mjs
// 原理：从 ../main.js 提取 INSTANCE-PURE 块 eval 后直接调用（纯函数，无需宿主/网络）。
//
// 背景：2026-10-08 用户报「连不上」——插件原来只有「服务端口（默认 3080）」，那是旧 CLI 的端口；
// 2026-10-19 第三次同类故障：DSH 0.2.1 把桌面版端口改成系统分配（--port 0），写死 19387 又失效。
// 这里锁住契约：显式配置优先 → 否则「发现的桌面版端口（升序）→ 旧版自定义端口」→
// 都没发现时退回兼容端口 19387 并标 alive:false（上层据此提示"打开桌面版 App"）。
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
    return { instanceCandidates, pickInstance, desktopCandidates, LEGACY_DESKTOP_PORT, LEGACY_WEB_PORT, INSTANCE_MODES };
`)();
const { instanceCandidates, pickInstance, desktopCandidates, LEGACY_DESKTOP_PORT, LEGACY_WEB_PORT } = ns;

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " -> " + detail : ""}`);
    ok ? pass++ : fail++;
};
const kinds = (cands) => cands.map((c) => c.kind + ":" + c.port).join(",");

// 1) 常量
check("兼容桌面端口 = 19387、旧版默认 = 3080", LEGACY_DESKTOP_PORT === 19387 && LEGACY_WEB_PORT === 3080);

// 2) auto：没发现端口 → 兼容 19387 → 旧版 3080
check("auto（未发现）：19387 → 3080", kinds(instanceCandidates({ instance: "auto", port: 3080 }, [])) === "desktop:19387,legacy:3080",
    kinds(instanceCandidates({ instance: "auto", port: 3080 }, [])));

// 3) auto：发现到动态端口 → 未发现不出现，桌面版优先
check("auto（发现 59204）：桌面版 59204 → 旧版 3080",
    kinds(instanceCandidates({ instance: "auto", port: 3080 }, [59204])) === "desktop:59204,legacy:3080",
    kinds(instanceCandidates({ instance: "auto", port: 3080 }, [59204])));

// 4) 多个发现端口按升序（发现函数本身乱序也要稳住）
check("auto：多个发现端口按升序", kinds(instanceCandidates({ instance: "auto", port: 3080 }, [59211, 59204])) === "desktop:59204,desktop:59211,legacy:3080",
    kinds(instanceCandidates({ instance: "auto", port: 3080 }, [59211, 59204])));

// 5) 发现端口与旧版端口撞车：桌面版优先，不重复探测
check("auto：发现端口=旧版端口时去重（桌面版优先）",
    kinds(instanceCandidates({ instance: "auto", port: 3080 }, [3080])) === "desktop:3080",
    kinds(instanceCandidates({ instance: "auto", port: 3080 }, [3080])));

// 6) 非法发现端口被过滤（0/负数/超范围/非数字/重复）
check("非法/重复发现端口被过滤",
    kinds(instanceCandidates({ instance: "auto", port: 3080 }, [0, -1, 70000, "abc", 59204, 59204])) === "desktop:59204,legacy:3080");

// 7) auto + 发现端口活着 → 选它（2026-10-19 故障的修复点）
check("auto：发现的端口活着 → 选桌面版",
    pickInstance({ instance: "auto", port: 3080 }, { 59204: true, 3080: true }, [59204]).port === 59204 &&
    pickInstance({ instance: "auto", port: 3080 }, { 59204: true, 3080: true }, [59204]).kind === "desktop");

// 8) auto + 只有旧版活着 → 退旧版
check("auto：只有旧版活着 → 选旧版",
    pickInstance({ instance: "auto", port: 3080 }, { 59204: false, 3080: true }, [59204]).kind === "legacy");

// 9) auto + 都没起 → 首选发现的端口 + alive:false
const dead = pickInstance({ instance: "auto", port: 3080 }, {}, [59204, 59211]);
check("auto：都没起 → 首选发现端口 + alive:false", dead.kind === "desktop" && dead.port === 59204 && dead.alive === false);

// 10) auto + 没发现且都没起 → 兼容 19387 + alive:false（给"打开桌面版"指引）
const dead2 = pickInstance({ instance: "auto", port: 3080 }, {}, []);
check("auto（未发现）：都没起 → 19387 + alive:false", dead2.kind === "desktop" && dead2.port === 19387 && dead2.alive === false);

// 11) auto + 自定义旧版端口：仍桌面版优先
check("auto：自定义旧版端口时仍桌面版优先",
    kinds(instanceCandidates({ instance: "auto", port: 4000 }, [59204])) === "desktop:59204,legacy:4000" &&
    pickInstance({ instance: "auto", port: 4000 }, { 59204: true, 4000: true }, [59204]).port === 59204);

// 12) 显式 desktop 模式：只给发现的桌面版候选（不被旧版顶掉，也不退回 19387）
check("desktop 模式：只探发现的桌面版端口",
    kinds(instanceCandidates({ instance: "desktop", port: 3080 }, [59204])) === "desktop:59204");
check("desktop 模式（未发现）：退回兼容 19387",
    kinds(instanceCandidates({ instance: "desktop", port: 3080 }, [])) === "desktop:19387");
check("desktop 模式：选中发现的端口（哪怕旧版活着）",
    pickInstance({ instance: "desktop", port: 3080 }, { 59204: true, 3080: true }, [59204]).port === 59204);

// 13) 显式 legacy 模式：保持原样（发现结果不影响，也不被自动探测顶掉）
check("legacy 模式：只探自定义端口",
    kinds(instanceCandidates({ instance: "legacy", port: 4000 }, [59204])) === "legacy:4000");
check("legacy 模式：选中的就是它（哪怕桌面版活着）",
    pickInstance({ instance: "legacy", port: 4000 }, { 59204: true, 4000: true }, [59204]).kind === "legacy");

// 14) 宽松校验：非法/缺失/畸形配置一律按 auto
check("instance 非法值 → 按 auto", kinds(instanceCandidates({ instance: "nonsense", port: 3080 }, [])) === "desktop:19387,legacy:3080");
check("instance 缺失 → 按 auto", kinds(instanceCandidates({ port: 3080 }, [])) === "desktop:19387,legacy:3080");
check("settings 为 null/undefined → 按 auto 且不抛", kinds(instanceCandidates(null, [])) === "desktop:19387,legacy:3080");
check("port 非法（0/NaN/空）→ 回落 3080",
    kinds(instanceCandidates({ instance: "auto", port: 0 }, [])) === "desktop:19387,legacy:3080" &&
    kinds(instanceCandidates({ instance: "auto", port: "abc" }, [])) === "desktop:19387,legacy:3080");

// 15) 标签人话（设置/诊断里直接展示）
const discoveredCands = desktopCandidates([59204]);
const fallbackCands = desktopCandidates([]);
check("发现到端口时标签说明「自动发现」", discoveredCands[0].label.includes("自动发现") && discoveredCands[0].label.includes("59204"));
check("未发现时标签标明「兼容端口」", fallbackCands[0].label.includes("兼容端口") && fallbackCands[0].label.includes("19387"));

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
