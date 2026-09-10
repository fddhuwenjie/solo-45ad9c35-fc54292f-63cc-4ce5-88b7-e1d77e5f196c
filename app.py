#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""无障碍影视解说编排 —— 本地 Flask 后端。

所有数据保存在本机 SQLite (data.db)，不访问任何外部服务。
启动: python3 app.py  (默认 http://127.0.0.1:5000)
"""
import io
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone

# 允许在没有全局安装 Flask 的环境下使用随项目携带的 .pylibs
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PYLIBS = os.path.join(BASE_DIR, ".pylibs")
if os.path.isdir(PYLIBS) and PYLIBS not in sys.path:
    sys.path.insert(0, PYLIBS)

from flask import Flask, g, jsonify, request, send_file, send_from_directory

DB_PATH = os.path.join(BASE_DIR, "data.db")
STATIC_DIR = os.path.join(BASE_DIR, "static")

app = Flask(__name__, static_folder=STATIC_DIR, static_url_path="/static")

SNAPSHOT_COALESCE_SEC = 5  # 连续调整类快照的合并窗口（秒）
# 这些离散操作每次都独立留快照（新增、删除、导入等不做合并）
COALESCE_LABELS = {"拖拽调整解说", "编辑解说文本", "调整解说时间", "精确调整时间"}
HISTORY_LIMIT = 60
DEFAULT_MIN_GAP = 1.0
DEFAULT_RATE = 240.0  # 朗读单位（汉字/英文词）每分钟

CJK_RE = re.compile(
    r"[一-鿿㐀-䶿぀-ヿ]"
)
WORD_RE = re.compile(r"[A-Za-z0-9’']+")
TIMECODE_RE = re.compile(
    r"(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})"
)

# ---------------------------------------------------------------------------
# 示例 SRT（首次使用的“载入示例”）
# ---------------------------------------------------------------------------
SAMPLE_SRT = """1
00:00:00,500 --> 00:00:03,000
夜晚的城市，灯火通明。

2
00:00:04,200 --> 00:00:07,800
"The city never sleeps," she whispered.

3
00:00:09,000 --> 00:00:12,500
他穿过街道，走向那座旧桥。

4
00:00:14,000 --> 00:00:17,500
"Tomorrow," he said, "everything changes."

5
00:00:19,500 --> 00:00:23,000
风吹过河面，带起一阵涟漪。

6
00:00:24,500 --> 00:00:28,000
She watched him leave, and said nothing.

7
00:00:30,000 --> 00:00:34,000
故事，才刚刚开始。
"""


# ---------------------------------------------------------------------------
# 数据库
# ---------------------------------------------------------------------------
def get_db():
    if "db" not in g:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        g.db = conn
    return g.db


@app.teardown_appcontext
def close_db(exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS projects (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL,
            min_gap     REAL NOT NULL DEFAULT %g,
            speech_rate REAL NOT NULL DEFAULT %g,
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS subtitles (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            idx        INTEGER NOT NULL,
            start_ms   INTEGER NOT NULL,
            end_ms     INTEGER NOT NULL,
            text       TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_sub_project ON subtitles(project_id, start_ms);
        CREATE TABLE IF NOT EXISTS cards (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            start_ms      INTEGER NOT NULL,
            end_ms        INTEGER NOT NULL,
            text          TEXT NOT NULL DEFAULT '',
            duration_ms   INTEGER NOT NULL DEFAULT 0,
            duration_mode TEXT NOT NULL DEFAULT 'auto',   -- auto | manual
            locked        INTEGER NOT NULL DEFAULT 0,
            color         TEXT NOT NULL DEFAULT '#4f86e8'
        );
        CREATE INDEX IF NOT EXISTS idx_cards_project ON cards(project_id, start_ms);
        CREATE TABLE IF NOT EXISTS history (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            label      TEXT NOT NULL DEFAULT '',
            state_json TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_history_project ON history(project_id, id);
        CREATE TABLE IF NOT EXISTS versions (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            name       TEXT NOT NULL,
            note       TEXT NOT NULL DEFAULT '',
            state_json TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        """
        % (DEFAULT_MIN_GAP, DEFAULT_RATE)
    )
    conn.commit()
    conn.close()


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# 时间 / 文本工具
# ---------------------------------------------------------------------------
def parse_timecode(tc):
    m = TIMECODE_RE.search(tc.strip())
    if not m:
        raise ValueError("无法识别的时间码: %r" % tc)
    h, mm, ss, ms = m.groups()
    return int(h) * 3600 + int(mm) * 60 + int(ss) + int(ms.ljust(3, "0")) / 1000.0


def format_srt_time(seconds):
    if seconds < 0:
        seconds = 0.0
    ms = int(round(seconds * 1000.0))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return "%02d:%02d:%02d,%03d" % (h, m, s, ms)


def parse_srt(content):
    """解析 SRT，返回 [{idx,start,end,text}] (秒)。容忍 BOM、空行、点号毫秒。"""
    content = content.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n")
    blocks = re.split(r"\n[ \t]*\n", content.strip())
    entries = []
    for bi, block in enumerate(blocks, 1):
        lines = [ln for ln in block.split("\n") if ln.strip() != ""]
        if not lines:
            continue
        pos = 0
        idx = bi
        if not TIMECODE_RE.search(lines[0]) and len(lines) >= 2:
            try:
                idx = int(lines[0].strip())
                pos = 1
            except ValueError:
                idx = bi
        arrow = None
        for j in range(pos, len(lines)):
            if "-->" in lines[j]:
                arrow = j
                break
        if arrow is None:
            raise ValueError("第 %d 个字幕块缺少时间轴（-->）" % bi)
        parts = lines[arrow].split("-->")
        try:
            start = parse_timecode(parts[0])
            end = parse_timecode(parts[1])
        except ValueError as exc:
            raise ValueError("第 %d 个字幕块时间码错误: %s" % (bi, exc))
        if end < start:
            raise ValueError("第 %d 个字幕块结束时间早于开始时间" % bi)
        text = "\n".join(lines[arrow + 1:]).strip()
        entries.append({"idx": idx, "start": start, "end": end, "text": text})
    if not entries:
        raise ValueError("没有解析到任何字幕条目")
    entries.sort(key=lambda e: (e["start"], e["end"]))
    return entries


def count_units(text):
    """朗读单位：每个汉字/假名 1 个，每个连续英数词 1 个。"""
    cjk = len(CJK_RE.findall(text or ""))
    stripped = CJK_RE.sub(" ", text or "")
    words = len(WORD_RE.findall(stripped))
    return cjk, words


def estimate_seconds(text, rate):
    cjk, words = count_units(text)
    return (cjk + words) * 60.0 / float(rate or DEFAULT_RATE)


# ---------------------------------------------------------------------------
# 序列化
# ---------------------------------------------------------------------------
def card_row_to_dict(row):
    return {
        "id": row["id"],
        "start": row["start_ms"] / 1000.0,
        "end": row["end_ms"] / 1000.0,
        "text": row["text"],
        "duration": row["duration_ms"] / 1000.0,
        "duration_mode": row["duration_mode"],
        "locked": bool(row["locked"]),
        "color": row["color"],
        "cjk_chars": count_units(row["text"])[0],
        "word_count": count_units(row["text"])[1],
    }


def fetch_state(db, project_id):
    project = db.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
    if project is None:
        return None
    subs = [
        {"id": r["id"], "idx": r["idx"], "start": r["start_ms"] / 1000.0,
         "end": r["end_ms"] / 1000.0, "text": r["text"]}
        for r in db.execute(
            "SELECT * FROM subtitles WHERE project_id=? ORDER BY start_ms, idx",
            (project_id,)).fetchall()
    ]
    cards = [
        card_row_to_dict(r) for r in db.execute(
            "SELECT * FROM cards WHERE project_id=? ORDER BY start_ms, id",
            (project_id,)).fetchall()
    ]
    history = [
        {"id": r["id"], "label": r["label"], "created_at": r["created_at"]}
        for r in db.execute(
            "SELECT * FROM history WHERE project_id=? ORDER BY id DESC LIMIT ?",
            (project_id, HISTORY_LIMIT)).fetchall()
    ]
    versions = [
        {"id": r["id"], "name": r["name"], "note": r["note"],
         "created_at": r["created_at"]}
        for r in db.execute(
            "SELECT * FROM versions WHERE project_id=? ORDER BY id DESC",
            (project_id,)).fetchall()
    ]
    return {
        "project": {
            "id": project["id"], "name": project["name"],
            "min_gap": project["min_gap"], "speech_rate": project["speech_rate"],
            "created_at": project["created_at"], "updated_at": project["updated_at"],
        },
        "subtitles": subs,
        "cards": cards,
        "history": history,
        "versions": versions,
    }


def touch(db, project_id):
    db.execute("UPDATE projects SET updated_at=? WHERE id=?", (now_iso(), project_id))


def snapshot_state(db, project_id, label, coalesce=None):
    """保存当前状态快照。

    coalesce=True 时，相同标签在合并窗口内只保留一次（用于拖拽/输入等高频操作）。
    默认仅对 COALESCE_LABELS 中的调整类标签启用合并。
    """
    if coalesce is None:
        coalesce = label in COALESCE_LABELS
    if coalesce:
        last = db.execute(
            "SELECT id, label, created_at FROM history WHERE project_id=? ORDER BY id DESC LIMIT 1",
            (project_id,)).fetchone()
        if last is not None and last["label"] == label:
            try:
                age = (datetime.now(timezone.utc)
                       - datetime.fromisoformat(last["created_at"])).total_seconds()
                if age < SNAPSHOT_COALESCE_SEC:
                    return last["id"]
            except ValueError:
                pass
    state = dump_state(db, project_id)
    cur = db.execute(
        "INSERT INTO history(project_id, label, state_json, created_at) VALUES(?,?,?,?)",
        (project_id, label, state, now_iso()))
    # 仅保留最近 HISTORY_LIMIT 条
    db.execute(
        """DELETE FROM history WHERE project_id=? AND id NOT IN
           (SELECT id FROM history WHERE project_id=? ORDER BY id DESC LIMIT ?)""",
        (project_id, project_id, HISTORY_LIMIT))
    return cur.lastrowid


def dump_state(db, project_id):
    p = db.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
    subs = [dict(r) for r in db.execute(
        "SELECT idx,start_ms,end_ms,text FROM subtitles WHERE project_id=? ORDER BY start_ms, idx",
        (project_id,)).fetchall()]
    cards = [dict(r) for r in db.execute(
        "SELECT start_ms,end_ms,text,duration_ms,duration_mode,locked,color FROM cards WHERE project_id=?",
        (project_id,)).fetchall()]
    import json
    return json.dumps({"min_gap": p["min_gap"], "speech_rate": p["speech_rate"],
                       "subtitles": subs, "cards": cards}, ensure_ascii=False)


def restore_state(db, project_id, state_json):
    """在事务内用快照整体替换字幕/卡片/设置。"""
    import json
    state = json.loads(state_json)
    db.execute("DELETE FROM subtitles WHERE project_id=?", (project_id,))
    db.execute("DELETE FROM cards WHERE project_id=?", (project_id,))
    for s in state["subtitles"]:
        db.execute(
            "INSERT INTO subtitles(project_id,idx,start_ms,end_ms,text) VALUES(?,?,?,?,?)",
            (project_id, s["idx"], s["start_ms"], s["end_ms"], s["text"]))
    for c in state["cards"]:
        db.execute(
            """INSERT INTO cards(project_id,start_ms,end_ms,text,duration_ms,
               duration_mode,locked,color) VALUES(?,?,?,?,?,?,?,?)""",
            (project_id, c["start_ms"], c["end_ms"], c["text"], c["duration_ms"],
             c.get("duration_mode", "auto"), c.get("locked", 0), c.get("color", "#4f86e8")))
    db.execute("UPDATE projects SET min_gap=?, speech_rate=? WHERE id=?",
               (state.get("min_gap", DEFAULT_MIN_GAP),
                state.get("speech_rate", DEFAULT_RATE), project_id))


def recompute_card(db, card_id, rate):
    row = db.execute("SELECT text,duration_mode FROM cards WHERE id=?", (card_id,)).fetchone()
    dur_ms = int(round(estimate_seconds(row["text"], rate) * 1000)) if row["duration_mode"] == "auto" \
        else db.execute("SELECT end_ms-start_ms FROM cards WHERE id=?", (card_id,)).fetchone()[0]
    db.execute("UPDATE cards SET duration_ms=? WHERE id=?", (dur_ms, card_id))


def require_project(project_id):
    db = get_db()
    row = db.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
    if row is None:
        return None, (jsonify({"error": "项目不存在"}), 404)
    return row, None


def bad_request(msg):
    return jsonify({"error": msg}), 400


# ---------------------------------------------------------------------------
# 页面
# ---------------------------------------------------------------------------
@app.get("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


# ---------------------------------------------------------------------------
# 项目 API
# ---------------------------------------------------------------------------
@app.get("/api/projects")
def list_projects():
    db = get_db()
    rows = db.execute("SELECT * FROM projects ORDER BY updated_at DESC, id DESC").fetchall()
    return jsonify([{"id": r["id"], "name": r["name"],
                     "updated_at": r["updated_at"],
                     "card_count": db.execute(
                         "SELECT COUNT(*) c FROM cards WHERE project_id=?", (r["id"],)).fetchone()["c"],
                     "sub_count": db.execute(
                         "SELECT COUNT(*) c FROM subtitles WHERE project_id=?", (r["id"],)).fetchone()["c"]}
                    for r in rows])


@app.post("/api/projects")
def create_project():
    data = request.get_json(force=True, silent=True) or {}
    name = (data.get("name") or "").strip() or "未命名项目"
    db = get_db()
    ts = now_iso()
    cur = db.execute(
        "INSERT INTO projects(name,created_at,updated_at) VALUES(?,?,?)",
        (name, ts, ts))
    db.commit()
    return jsonify({"id": cur.lastrowid, "name": name}), 201


@app.get("/api/projects/<int:pid>")
def get_project(pid):
    db = get_db()
    state = fetch_state(db, pid)
    if state is None:
        return jsonify({"error": "项目不存在"}), 404
    return jsonify(state)


@app.patch("/api/projects/<int:pid>")
def rename_project(pid):
    _, err = require_project(pid)
    if err:
        return err
    data = request.get_json(force=True, silent=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return bad_request("项目名称不能为空")
    db = get_db()
    db.execute("UPDATE projects SET name=? WHERE id=?", (name, pid))
    touch(db, pid)
    db.commit()
    return jsonify({"ok": True})


@app.delete("/api/projects/<int:pid>")
def delete_project(pid):
    _, err = require_project(pid)
    if err:
        return err
    db = get_db()
    db.execute("DELETE FROM projects WHERE id=?", (pid,))
    db.commit()
    return jsonify({"ok": True})


@app.get("/api/sample-srt")
def sample_srt():
    return jsonify({"content": SAMPLE_SRT})


# ---------------------------------------------------------------------------
# 字幕导入
# ---------------------------------------------------------------------------
@app.post("/api/projects/<int:pid>/subtitles/import")
def import_subtitles(pid):
    _, err = require_project(pid)
    if err:
        return err
    data = request.get_json(force=True, silent=True) or {}
    content = data.get("content") or ""
    mode = data.get("mode", "replace")
    try:
        entries = parse_srt(content)
    except ValueError as exc:
        return bad_request(str(exc))
    db = get_db()
    snapshot_state(db, pid, "导入字幕" if mode == "append" else "导入字幕（替换）")
    if mode != "append":
        db.execute("DELETE FROM subtitles WHERE project_id=?", (pid,))
        db.execute("DELETE FROM cards WHERE project_id=?", (pid,))
    base = db.execute("SELECT COALESCE(MAX(idx),0) m FROM subtitles WHERE project_id=?",
                      (pid,)).fetchone()["m"]
    for k, e in enumerate(entries):
        db.execute(
            "INSERT INTO subtitles(project_id,idx,start_ms,end_ms,text) VALUES(?,?,?,?,?)",
            (pid, base + k + 1, int(round(e["start"] * 1000)),
             int(round(e["end"] * 1000)), e["text"]))
    touch(db, pid)
    db.commit()
    return jsonify({"imported": len(entries), "state": fetch_state(db, pid)})


# ---------------------------------------------------------------------------
# 解说卡片 API
# ---------------------------------------------------------------------------
@app.post("/api/projects/<int:pid>/cards")
def create_card(pid):
    project, err = require_project(pid)
    if err:
        return err
    data = request.get_json(force=True, silent=True) or {}
    try:
        start = float(data.get("start", 0.0))
        end = float(data.get("end", start + 2.0))
    except (TypeError, ValueError):
        return bad_request("时间格式不正确")
    if end < start:
        return bad_request("结束时间不能早于开始时间")
    text = data.get("text", "") or ""
    mode = "manual" if data.get("duration_mode") == "manual" else "auto"
    db = get_db()
    snapshot_state(db, pid, "新增解说")
    duration_ms = int(round(estimate_seconds(text, project["speech_rate"]) * 1000)) if mode == "auto" \
        else int(round((end - start) * 1000))
    cur = db.execute(
        """INSERT INTO cards(project_id,start_ms,end_ms,text,duration_ms,duration_mode,
           locked,color) VALUES(?,?,?,?,?,?,?,?)""",
        (pid, int(round(start * 1000)), int(round(end * 1000)), text, duration_ms,
         mode, 1 if data.get("locked") else 0, data.get("color", "#4f86e8")))
    touch(db, pid)
    db.commit()
    row = db.execute("SELECT * FROM cards WHERE id=?", (cur.lastrowid,)).fetchone()
    return jsonify(card_row_to_dict(row)), 201


@app.patch("/api/projects/<int:pid>/cards/<int:cid>")
def update_card(pid, cid):
    project, err = require_project(pid)
    if err:
        return err
    db = get_db()
    row = db.execute("SELECT * FROM cards WHERE id=? AND project_id=?", (cid, pid)).fetchone()
    if row is None:
        return jsonify({"error": "解说卡片不存在"}), 404
    data = request.get_json(force=True, silent=True) or {}
    fields = {"start", "end", "text", "locked", "color", "duration_mode", "duration"}
    changes = {k: v for k, v in data.items() if k in fields}
    if not changes:
        return bad_request("没有要更新的字段")
    # 已锁定卡片：只允许解锁
    if row["locked"] and not (set(changes.keys()) <= {"locked"} and changes.get("locked") is False):
        return jsonify({"error": "该片段已锁定，请先解锁再修改"}), 409

    start_ms = row["start_ms"]
    end_ms = row["end_ms"]
    text = row["text"]
    mode = row["duration_mode"]
    if "start" in changes:
        try:
            start_ms = int(round(float(changes["start"]) * 1000))
        except (TypeError, ValueError):
            return bad_request("开始时间格式不正确")
    if "end" in changes:
        try:
            end_ms = int(round(float(changes["end"]) * 1000))
        except (TypeError, ValueError):
            return bad_request("结束时间格式不正确")
    if start_ms < 0 or end_ms < start_ms:
        return bad_request("时间区间无效")
    if "text" in changes:
        text = changes["text"] or ""
    if "duration_mode" in changes and changes["duration_mode"] in ("auto", "manual"):
        mode = changes["duration_mode"]
    if mode == "manual" and "duration" in changes:
        try:
            end_ms = start_ms + max(0, int(round(float(changes["duration"]) * 1000)))
        except (TypeError, ValueError):
            return bad_request("时长格式不正确")

    label = data.get("_label")
    if not label:
        if "text" in changes:
            label = "编辑解说文本"
        elif "start" in changes or "end" in changes or "duration" in changes:
            label = "调整解说时间"
        elif "locked" in changes:
            label = "锁定/解锁解说"
        else:
            label = "修改解说"
    snapshot_state(db, pid, label)

    duration_ms = row["duration_ms"]
    if mode == "auto" and ("text" in changes or "duration_mode" in changes):
        duration_ms = int(round(estimate_seconds(text, project["speech_rate"]) * 1000))
    elif mode == "manual":
        duration_ms = end_ms - start_ms

    db.execute(
        """UPDATE cards SET start_ms=?,end_ms=?,text=?,duration_ms=?,duration_mode=?,
           locked=?,color=? WHERE id=?""",
        (start_ms, end_ms, text, duration_ms, mode,
         1 if changes.get("locked", bool(row["locked"])) else 0,
         changes.get("color", row["color"]), cid))
    touch(db, pid)
    db.commit()
    return jsonify(card_row_to_dict(db.execute("SELECT * FROM cards WHERE id=?", (cid,)).fetchone()))


@app.delete("/api/projects/<int:pid>/cards/<int:cid>")
def delete_card(pid, cid):
    _, err = require_project(pid)
    if err:
        return err
    db = get_db()
    row = db.execute("SELECT * FROM cards WHERE id=? AND project_id=?", (cid, pid)).fetchone()
    if row is None:
        return jsonify({"error": "解说卡片不存在"}), 404
    snapshot_state(db, pid, "删除解说")
    db.execute("DELETE FROM cards WHERE id=?", (cid,))
    touch(db, pid)
    db.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# 设置
# ---------------------------------------------------------------------------
@app.patch("/api/projects/<int:pid>/settings")
def update_settings(pid):
    project, err = require_project(pid)
    if err:
        return err
    data = request.get_json(force=True, silent=True) or {}
    min_gap = project["min_gap"]
    rate = project["speech_rate"]
    if "min_gap" in data:
        try:
            min_gap = max(0.0, float(data["min_gap"]))
        except (TypeError, ValueError):
            return bad_request("最小间隔格式不正确")
    if "speech_rate" in data:
        try:
            rate = max(1.0, float(data["speech_rate"]))
        except (TypeError, ValueError):
            return bad_request("语速格式不正确")
    db = get_db()
    snapshot_state(db, pid, "修改编排设置")
    db.execute("UPDATE projects SET min_gap=?, speech_rate=? WHERE id=?",
               (min_gap, rate, pid))
    # 语速变化后重算所有自动卡片的预估时长
    if rate != project["speech_rate"]:
        for r in db.execute("SELECT id FROM cards WHERE project_id=? AND duration_mode='auto'",
                            (pid,)).fetchall():
            recompute_card(db, r["id"], rate)
    touch(db, pid)
    db.commit()
    return jsonify(fetch_state(db, pid))


# ---------------------------------------------------------------------------
# 撤销 / 历史
# ---------------------------------------------------------------------------
@app.post("/api/projects/<int:pid>/history")
def push_history(pid):
    _, err = require_project(pid)
    if err:
        return err
    label = (request.get_json(force=True, silent=True) or {}).get("label", "") or "手动保存"
    db = get_db()
    hid = snapshot_state(db, pid, str(label)[:80])
    touch(db, pid)
    db.commit()
    return jsonify({"id": hid})


@app.post("/api/projects/<int:pid>/undo")
@app.post("/api/projects/<int:pid>/history/<int:hid>/restore")
def undo(pid, hid=None):
    _, err = require_project(pid)
    if err:
        return err
    data = request.get_json(force=True, silent=True) or {}
    if hid is None:
        hid = data.get("history_id")
    db = get_db()
    row = db.execute("SELECT * FROM history WHERE id=? AND project_id=?", (hid, pid)).fetchone()
    if row is None:
        return jsonify({"error": "历史快照不存在"}), 404
    restore_state(db, pid, row["state_json"])
    # 恢复后移除该快照，使“撤销”可以继续向前回退
    db.execute("DELETE FROM history WHERE id=?", (hid,))
    touch(db, pid)
    db.commit()
    return jsonify(fetch_state(db, pid))


# ---------------------------------------------------------------------------
# 工作版本
# ---------------------------------------------------------------------------
@app.post("/api/projects/<int:pid>/versions")
def create_version(pid):
    project, err = require_project(pid)
    if err:
        return err
    data = request.get_json(force=True, silent=True) or {}
    name = (data.get("name") or "").strip() or ("版本 " + now_iso()[5:16].replace("T", " "))
    db = get_db()
    cur = db.execute(
        "INSERT INTO versions(project_id,name,note,state_json,created_at) VALUES(?,?,?,?,?)",
        (pid, name, (data.get("note") or "")[:500], dump_state(db, pid), now_iso()))
    touch(db, pid)
    db.commit()
    return jsonify({"id": cur.lastrowid, "name": name}), 201


@app.post("/api/projects/<int:pid>/versions/<int:vid>/restore")
def restore_version(pid, vid):
    _, err = require_project(pid)
    if err:
        return err
    db = get_db()
    row = db.execute("SELECT * FROM versions WHERE id=? AND project_id=?", (vid, pid)).fetchone()
    if row is None:
        return jsonify({"error": "版本不存在"}), 404
    # 恢复前自动留快照，可通过撤销找回当前状态
    snapshot_state(db, pid, "恢复版本「%s」前" % row["name"])
    restore_state(db, pid, row["state_json"])
    touch(db, pid)
    db.commit()
    return jsonify(fetch_state(db, pid))


@app.delete("/api/projects/<int:pid>/versions/<int:vid>")
def delete_version(pid, vid):
    _, err = require_project(pid)
    if err:
        return err
    db = get_db()
    db.execute("DELETE FROM versions WHERE id=? AND project_id=?", (vid, pid))
    db.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# 导出 SRT
# ---------------------------------------------------------------------------
def build_srt(items):
    """items: [(start_sec,end_sec,text)]，按开始时间排序并重新编号。"""
    items = sorted(items, key=lambda it: (it[0], it[1]))
    out = []
    for i, (start, end, text) in enumerate(items, 1):
        out.append("%d\n%s --> %s\n%s\n" % (i, format_srt_time(start),
                                            format_srt_time(end), text.strip()))
    return "\n".join(out).strip() + "\n"


@app.get("/api/projects/<int:pid>/export")
def export_srt(pid):
    project, err = require_project(pid)
    if err:
        return err
    mode = request.args.get("mode", "narration")
    db = get_db()
    items = []
    if mode == "merged":
        for r in db.execute("SELECT start_ms,end_ms,text FROM subtitles WHERE project_id=? ORDER BY start_ms",
                            (pid,)).fetchall():
            items.append((r["start_ms"] / 1000.0, r["end_ms"] / 1000.0, r["text"]))
        for r in db.execute("SELECT start_ms,end_ms,text FROM cards WHERE project_id=? ORDER BY start_ms",
                            (pid,)).fetchall():
            tag = "【解说】"
            items.append((r["start_ms"] / 1000.0, r["end_ms"] / 1000.0,
                          tag + (r["text"] or "").strip()))
    else:
        for r in db.execute("SELECT start_ms,end_ms,text FROM cards WHERE project_id=? ORDER BY start_ms",
                            (pid,)).fetchall():
            items.append((r["start_ms"] / 1000.0, r["end_ms"] / 1000.0, r["text"]))
    content = build_srt(items)
    suffix = "解说" if mode != "merged" else "合并"
    filename = "%s-%s.srt" % (project["name"], suffix)
    return send_file(io.BytesIO(content.encode("utf-8-sig")),
                     as_attachment=True, download_name=filename, mimetype="text/plain")


# ---------------------------------------------------------------------------
if __name__ == "__main__":
    init_db()
    app.run(host="127.0.0.1", port=5000, debug=False)
