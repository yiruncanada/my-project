# -*- coding: utf-8 -*-
"""
个人资产管理系统（极简单用户版）
后端：Flask + SQLite + RapidOCR
"""
import os
import re
import sqlite3

import cv2
import numpy as np
from flask import Flask, jsonify, render_template, request
from rapidocr_onnxruntime import RapidOCR

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "database.db")

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024 * 1024  # 限制上传图片 16MB
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0  # 开发阶段禁用静态文件缓存，避免旧 JS 缓存

# ---------------------------------------------------------------- 数据库

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with get_db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
            );
            CREATE TABLE IF NOT EXISTS asset_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                account_id INTEGER NOT NULL,
                amount REAL NOT NULL,
                recorded_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
                FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
            );
            """
        )


# ---------------------------------------------------------------- OCR

_ocr = None


def get_ocr():
    """懒加载 OCR 引擎（首次调用时加载模型，约 1~3 秒）"""
    global _ocr
    if _ocr is None:
        _ocr = RapidOCR()
    return _ocr


# 金额正则：可选货币符号 + 数字（可带千分位逗号）+ 可选小数
AMOUNT_RE = re.compile(r"(?:[¥￥$€£])?\s*\d[\d,]*(?:\.\d{1,2})?")
# 余额/总额等关键词，命中关键词的数字优先作为推荐值
KEYWORDS = ["余额", "总额", "合计", "总资产", "可用余额", "结余", "balance", "total", "available"]


def extract_amounts(ocr_result):
    """从 RapidOCR 结果中提取所有金额候选，返回候选列表与推荐值"""
    candidates = []
    lines = []
    for item in ocr_result:
        box, text, score = item
        text = (text or "").strip()
        if not text:
            continue
        lines.append(text)
        has_keyword = any(k in text.lower() for k in KEYWORDS)
        for m in AMOUNT_RE.finditer(text):
            raw = m.group(0)
            # 过滤百分比（数字后紧跟 %，如 4.5%）
            if m.end() < len(text) and text[m.end()] == "%":
                continue
            # 过滤时间（数字前后是冒号，如 14:43）
            prev = text[m.start() - 1] if m.start() > 0 else ""
            nxt = text[m.end()] if m.end() < len(text) else ""
            if prev == ":" or nxt == ":":
                continue
            clean = re.sub(r"[^\d.\-]", "", raw)
            if not clean:
                continue
            try:
                val = float(clean)
            except ValueError:
                continue
            if val <= 0:
                continue
            # 过滤年份（1900-2100 且无小数点）
            if "." not in clean and 1900 <= val <= 2100:
                continue
            candidates.append({"amount": val, "line": text, "keyword": has_keyword})

    # 去重（关键词命中的优先保留）
    seen = {}
    for c in candidates:
        key = round(c["amount"], 2)
        if key not in seen or (c["keyword"] and not seen[key]["keyword"]):
            seen[key] = c
    unique = list(seen.values())

    # 关键词命中优先，其次金额从大到小
    unique.sort(key=lambda c: (not c["keyword"], -c["amount"]))

    # 最多返回 6 个候选，减少噪音
    amount_list = [c["amount"] for c in unique][:6]
    best_guess = amount_list[0] if amount_list else None
    return {"candidates": amount_list, "best_guess": best_guess, "lines": lines}


# ---------------------------------------------------------------- 页面

@app.route("/")
def index():
    return render_template("index.html")


# ---------------------------------------------------------------- 账户

@app.route("/api/accounts", methods=["GET"])
def list_accounts():
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT a.id, a.name,
                   (SELECT l.amount FROM asset_logs l
                     WHERE l.account_id = a.id
                     ORDER BY l.recorded_at DESC, l.id DESC LIMIT 1) AS latest_amount,
                   (SELECT l.recorded_at FROM asset_logs l
                     WHERE l.account_id = a.id
                     ORDER BY l.recorded_at DESC, l.id DESC LIMIT 1) AS updated_at,
                   (SELECT COUNT(*) FROM asset_logs l WHERE l.account_id = a.id) AS logs_count
            FROM accounts a
            ORDER BY a.id
            """
        ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/accounts", methods=["POST"])
def create_account():
    name = (request.json or {}).get("name", "").strip()
    if not name:
        return jsonify({"error": "账户名称不能为空"}), 400
    with get_db() as conn:
        cur = conn.execute("INSERT INTO accounts (name) VALUES (?)", (name,))
        aid = cur.lastrowid
    return jsonify({"id": aid, "name": name}), 201


@app.route("/api/accounts/<int:aid>", methods=["DELETE"])
def delete_account(aid):
    with get_db() as conn:
        conn.execute("DELETE FROM accounts WHERE id = ?", (aid,))
    return jsonify({"ok": True})


# ---------------------------------------------------------------- 记录

@app.route("/api/logs", methods=["POST"])
def add_log():
    body = request.json or {}
    try:
        account_id = int(body.get("account_id"))
        amount = float(body.get("amount"))
    except (TypeError, ValueError):
        return jsonify({"error": "参数无效"}), 400
    if amount <= 0:
        return jsonify({"error": "金额需大于 0"}), 400
    with get_db() as conn:
        exists = conn.execute("SELECT 1 FROM accounts WHERE id = ?", (account_id,)).fetchone()
        if not exists:
            return jsonify({"error": "账户不存在"}), 404
        conn.execute(
            "INSERT INTO asset_logs (account_id, amount) VALUES (?, ?)", (account_id, amount)
        )
    return jsonify({"ok": True}), 201


@app.route("/api/trend")
def trend():
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT l.account_id, l.amount, l.recorded_at
            FROM asset_logs l
            JOIN accounts a ON a.id = l.account_id
            ORDER BY l.recorded_at ASC, l.id ASC
            """
        ).fetchall()
    latest = {}
    timeline = []
    for r in rows:
        latest[r["account_id"]] = r["amount"]
        total = round(sum(latest.values()), 2)
        timeline.append({"time": r["recorded_at"], "total": total})
    return jsonify(timeline)


# ---------------------------------------------------------------- OCR 识别

@app.route("/api/ocr", methods=["POST"])
def api_ocr():
    f = request.files.get("image")
    if f is None:
        return jsonify({"error": "未收到图片"}), 400
    nparr = np.frombuffer(f.read(), np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img is None:
        return jsonify({"error": "无法解析图片，请上传 PNG/JPG 截图"}), 400
    result, _ = get_ocr()(img)
    if not result:
        return jsonify({"error": "", "candidates": [], "best_guess": None, "lines": []})
    out = extract_amounts(result)
    out["error"] = ""
    return jsonify(out)


if __name__ == "__main__":
    init_db()
    app.run(host="127.0.0.1", port=5000, debug=True)
