// 探针会话的磁盘清理 —— 收尾用
//
// 为什么需要它：DSH **没有删除会话的 API**，只有 `workspace/archiveSession`（= 侧栏隐藏，
// 文件照旧留在 ~/.dsh 下）。所以「跑完不留残留」必须做两件事：归档 + 删文件。
// 只归档不删文件 = 会话仍占着 ~/.dsh（用户看不见，但磁盘上一直在），本模块补上后半截。
//
// 用法：import { logDirOf, purgeSessionFiles } from "./session-purge.mjs";
//      await api.call("workspace.archiveSession", { sessionId: sid });  // 先归档，界面立刻不显示
//      purgeSessionFiles(sid);                                          // 再删文件
//
// 删除对象（按会话 id 定位，id 全局唯一）：
//   ~/.dsh/sessions/--<cwd slug>--/session-<id>/                 会话日志（zstd 多帧 jsonl）
//   ~/.dsh/storages/session_projcache/sessions/session-<id>.json 会话投影缓存
//   父目录若因此变空则一并删除
// 归档集（storages/workspace.json 的 archivedSessionIds）里的 id 会留下——无害：
//   DSH 本就容忍「有归档 id、盘上无文件」的历史条目，删不掉也无需删（写它要停宿主）。
//
// 纪律：best-effort，绝不抛错（收尾清理失败不该让回归红）；返回删了哪些路径，便于断言。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
const SESS_ROOT = path.join(HOME, ".dsh", "sessions");
const PROJ_CACHE = path.join(HOME, ".dsh", "storages", "session_projcache", "sessions");

/** 按会话 id 在 ~/.dsh/sessions 下找它的日志目录；找不到返回 null。 */
export function logDirOf(sessionId) {
    try {
        for (const d of fs.readdirSync(SESS_ROOT)) {
            const p = path.join(SESS_ROOT, d, sessionId);
            if (fs.existsSync(p)) return p;
        }
    } catch { /* 目录不存在等，视为没有 */ }
    return null;
}

/** 删掉该会话的日志目录 + 投影缓存（父目录空了也删）。返回删除路径列表。 */
export function purgeSessionFiles(sessionId) {
    const removed = [];
    const dir = logDirOf(sessionId);
    if (dir) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
            removed.push(dir);
            const parent = path.dirname(dir);
            if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) {
                fs.rmdirSync(parent);
                removed.push(parent);
            }
        } catch { /* 被占用等，尽力而为 */ }
    }
    for (const p of [path.join(PROJ_CACHE, sessionId + ".json"), path.join(path.dirname(PROJ_CACHE), sessionId + ".json")]) {
        try {
            if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); removed.push(p); }
        } catch { /* ignore */ }
    }
    return removed;
}
