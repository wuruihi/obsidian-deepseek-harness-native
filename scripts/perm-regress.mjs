// 会话级权限现值归一化回归（对齐 dsh-vscode 0.21.1 的同类修正）
// 用法：node scripts/perm-regress.mjs
// 原理：从 ../main.js 提取 PERM-PURE 块 eval 后直接调用（纯函数，无需宿主）。
//
// 为什么要有它：`settings/describe` 的 permission.defaultPreset 是**服务器全局默认**
// （只影响未来会话），会话当前用的预设只在该会话的 `permissions` 投影里。旧实现拿
// 全局默认当"当前会话值"显示 ⇒ 用户看到的值不是这个会话的值。这里锁住"只认会话值、
// 认不出就返回 null（不许编）"的契约。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "main.js"), "utf8");
const block = /\/\* ==== PERM-PURE-BEGIN[\s\S]*?PERM-PURE-END ==== \*\//.exec(src);
if (!block) {
    console.error("FAIL 找不到 PERM-PURE 块");
    process.exit(1);
}
const ns = new Function(`
    ${block[0]}
    return { permissionValueOf, permissionIdOf };
`)();
const { permissionValueOf, permissionIdOf } = ns;

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " -> " + detail : ""}`);
    ok ? pass++ : fail++;
};

// 1) 历史快照形态：{values:{permissions:{currentValue}}}
check("历史快照 values.permissions.currentValue",
    permissionValueOf({ values: { permissions: { currentValue: "workspace-write", revision: 3 } } }) === "workspace-write");

// 2) 投影帧形态：{permissions:...}
check("投影帧 permissions 顶层",
    permissionValueOf({ permissions: { currentValue: "danger-full-access" } }) === "danger-full-access");

// 3) 裸字符串（部分版本直接给 id）
check("裸字符串", permissionValueOf({ permissions: "read-only" }) === "read-only");

// 4) 其它字段名（currentPreset / preset / value / name）逐个认
check("currentPreset", permissionIdOf({ currentPreset: "auto" }) === "auto");
check("preset", permissionIdOf({ preset: "read-only" }) === "read-only");
check("value", permissionIdOf({ value: "workspace-write" }) === "workspace-write");
check("name", permissionIdOf({ name: "danger-full-access" }) === "danger-full-access");

// 5) 认不出 → null（**不许**回落到服务器默认值/编值）
check("空投影 → null", permissionValueOf(null) === null && permissionValueOf(undefined) === null);
check("非对象 → null", permissionValueOf("read-only") === null);
check("空对象 → null", permissionValueOf({}) === null && permissionValueOf({ values: {} }) === null);
check("permissions 为 null → null", permissionValueOf({ values: { permissions: null } }) === null);
check("字段类型不对（数字）→ null", permissionIdOf({ currentValue: 42 }) === null);
check("空字符串 → null", permissionIdOf("") === null);

// 6) values 与顶层同时存在时以 values 为准（历史快照优先）
check("values 优先于顶层",
    permissionValueOf({ values: { permissions: "read-only" }, permissions: "workspace-write" }) === "read-only");

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);