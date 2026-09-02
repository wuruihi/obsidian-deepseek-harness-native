// 临时调试脚本：验证 FENCE-PURE 块的解析行为
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "main.js"), "utf8");
const m = /\/\* ==== FENCE-PURE-BEGIN[\s\S]*?FENCE-PURE-END ==== \*\//.exec(src);
const ns = new Function(m[0] + "; return { cheapRepairs, balanceClose, scanJsonValue, repairSpec, parseSpec };")();

const t2 = '{"type":"button","label":"A"}\n{"type":"button","label":"B"}';
console.log("t2 chars:", JSON.stringify(t2));
const first = ns.scanJsonValue(t2, 0);
console.log("scan first:", JSON.stringify(first));
console.log("repairSpec:", JSON.stringify(ns.repairSpec(t2)));
console.log("parseSpec:", JSON.stringify(ns.parseSpec(t2)));

const t1 = '{"items":[{"type":"text","content":"x"}]},{"type":"badge","label":"b"}';
console.log("\nt1 parseSpec:", JSON.stringify(ns.parseSpec(t1)));

const t3 = '{"title":"t","items":[{"type":"text","content":"a"}]} 这是正文尾巴';
console.log("\nt3 scan:", JSON.stringify(ns.scanJsonValue(t3, 0)));
console.log("t3 repairSpec:", JSON.stringify(ns.repairSpec(t3)));
console.log("t3 parseSpec:", JSON.stringify(ns.parseSpec(t3)));

const bare = '[{"type":"text","content":"a"},{"type":"badge","label":"b"}]';
console.log("\nbare array parseSpec:", JSON.stringify(ns.parseSpec(bare)));

console.log("\n===== repairSpec.toString() =====");
// 手动插桩 t3
{
    const text = '{"title":"t","items":[{"type":"text","content":"a"}]} 这是正文尾巴'.trim();
    const first = ns.scanJsonValue(text, 0);
    console.log("t3 first:", JSON.stringify(first));
    const [end1, v1] = first;
    console.log("end1:", end1, "char at end1:", JSON.stringify(text[end1]), "v1.items:", Array.isArray(v1.items));
    let pos = end1;
    while (pos < text.length && /[\s,]/.test(text[pos])) pos++;
    console.log("pos after skip:", pos, "total:", text.length, "char:", JSON.stringify(text[pos]));
}
