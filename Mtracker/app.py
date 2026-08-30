# -*- coding: utf-8 -*-
"""
个人资产管理系统（极简单用户版）
后端：Flask + SQLite + RapidOCR
支持多币种账户，总资产/走势图统一换算为人民币
"""
import os
import re
import sqlite3

import cv2
import numpy as np
from flask import Flask, jsonify, render_template, request
from rapidocr_onnxruntime import RapidOCR

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("DB_PATH", os.path.join(BASE_DIR, "database.db"))

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024 * 1024  # 限制上传图片 16MB
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0  # 开发阶段禁用静态文件缓存，避免旧 JS 缓存

# ---------------------------------------------------------------- 币种与汇率

CURRENCIES = [
    {"code": "CNY", "name": "人民币", "symbol": "¥"},
    {"code": "USD", "name": "美元", "symbol": "$"},
    {"code": "CAD", "name": "加元", "symbol": "C$"},
    {"code": "EUR", "name": "欧元", "symbol": "€"},
    {"code": "GBP", "name": "英镑", "symbol": "£"},
    {"code": "JPY", "name": "日元", "symbol": "JP¥"},
    {"code": "HKD", "name": "港币", "symbol": "HK$"},
    {"code": "AUD", "name": "澳元", "symbol": "A$"},
]

# 默认汇率：1 单位外币 = X 人民币（可在线编辑）
DEFAULT_RATES = [
    ("CNY", 1.0),
    ("USD", 6.72),
    ("CAD", 4.85),
    ("EUR", 7.35),
    ("GBP", 8.55),
    ("JPY", 0.045),
    ("HKD", 0.86),
    ("AUD", 4.45),
]


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
                currency TEXT NOT NULL DEFAULT 'CNY',
                created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
            );
            CREATE TABLE IF NOT EXISTS asset_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                account_id INTEGER NOT NULL,
                amount REAL NOT NULL,
                recorded_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
                FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS exchange_rates (
                currency TEXT PRIMARY KEY,
                rate REAL NOT NULL
            );
            """
        )
        # 迁移：旧版 accounts 表补 currency 列
        cols = [r[1] for r in conn.execute("PRAGMA table_info(accounts)")]
        if "currency" not in cols:
            conn.execute("ALTER TABLE accounts ADD COLUMN currency TEXT NOT NULL DEFAULT 'CNY'")
        # 种子汇率
        conn.executemany(
            "INSERT OR IGNORE INTO exchange_rates (currency, rate) VALUES (?, ?)",
            DEFAULT_RATES,
        )


init_db()  # 导入时初始化数据库（幂等；gunicorn/Docker 部署也需要）


def get_rates():
    with get_db() as conn:
        rows = conn.execute("SELECT currency, rate FROM exchange_rates").fetchall()
    return {r["currency"]: r["rate"] for r in rows}


def to_cny(amount, currency, rates=None):
    if amount is None:
        return None
    rates = rates or get_rates()
    return round(amount * rates.get(currency, 1.0), 2)


# ---------------------------------------------------------------- OCR

_ocr = None


def get_ocr():
    """懒加载 OCR 引擎（首次调用时加载模型，约 1~3 秒）"""
    global _ocr
    if _ocr is None:
        _ocr = RapidOCR()
    return _ocr


# 金额正则：可选货币符号 + 可选正负号 + 数字（含空格/逗号/点分隔符）
AMOUNT_RE = re.compile(r"(?:[¥￥$€£])?\s*[-+]?\d[\d\s.,]*")
# 余额/总额等关键词，命中关键词的数字优先作为推荐值
KEYWORDS = ["余额", "总额", "合计", "总资产", "可用余额", "结余", "balance", "total",
            "available", "solde", "disponible"]


def parse_money_number(s):
    """解析金额字符串，兼容 1,234.56 / 1.234,56 / 3 278,95 / 3278.95 等格式"""
    s = s.strip().rstrip(".,")
    sign = 1.0
    if s.startswith("-"):
        sign = -1.0
        s = s[1:]
    elif s.startswith("+"):
        s = s[1:]
    s = s.replace(" ", "")
    if not s or not any(ch.isdigit() for ch in s):
        return None
    if not any(c in s for c in ",."):
        return sign * float(s) if re.fullmatch(r"\d+", s) else None

    has_comma = "," in s
    has_dot = "." in s
    if has_comma and has_dot:
        # 同时有两种分隔符：最后一个出现的是小数分隔符
        pos = max(s.rfind(","), s.rfind("."))
        dec = s[pos + 1:]
        intp = s[:pos].replace(",", "").replace(".", "")
    else:
        sep = "," if has_comma else "."
        parts = s.split(sep)
        if all(len(p) == 3 for p in parts[1:]):
            # 每个分组都是 3 位 → 全是千分位（如 1,234,567）
            intp = "".join(parts)
            dec = ""
        else:
            # 最后一个分隔符是小数分隔符
            intp = "".join(parts[:-1])
            dec = parts[-1]
    if not intp:
        intp = "0"
    if not intp.isdigit():
        return None
    val = float(intp)
    if dec:
        if not dec.isdigit():
            return None
        val += int(dec.ljust(2, "0")[:2]) / 100.0
    return sign * val


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
            raw = m.group(0).strip().rstrip(".,")
            if not raw:
                continue
            # 过滤百分比（数字后紧跟 %，如 4.5%）
            if m.end() < len(text) and text[m.end()] == "%":
                continue
            # 过滤时间（数字前后是冒号，如 14:43）
            prev = text[m.start() - 1] if m.start() > 0 else ""
            nxt = text[m.end()] if m.end() < len(text) else ""
            if prev == ":" or nxt == ":":
                continue
            body = raw.lstrip("+-").replace(" ", "")
            # 过滤以 0 开头的纯整数（账户号，如 08081）
            if re.fullmatch(r"0\d+", body):
                continue
            # 过滤 7 位以上纯整数（账户号/ID，如 5532718）
            if re.fullmatch(r"\d{7,}", body):
                continue
            val = parse_money_number(raw)
            if val is None or val <= 0:
                continue
            # 过滤年份（1900-2100 且无小数点）
            if "." not in body and "," not in body and 1900 <= val <= 2100:
                continue
            # 是否有小数部分（带小数更像真实金额，纯整数更像流水号/ID）
            clean_raw = raw.replace(" ", "")
            pos = max(clean_raw.rfind("."), clean_raw.rfind(","))
            has_decimal = bool(pos >= 0 and 1 <= len(clean_raw[pos + 1:]) <= 2 and clean_raw[pos + 1:].isdigit())
            candidates.append({"amount": round(val, 2), "line": text, "keyword": has_keyword, "decimal": has_decimal})

    # 去重（关键词命中、带小数的优先保留）
    seen = {}
    for c in candidates:
        key = c["amount"]
        if key not in seen or (c["keyword"], c["decimal"]) > (seen[key]["keyword"], seen[key]["decimal"]):
            seen[key] = c
    unique = list(seen.values())

    # 排序：关键词命中 > 带小数 > 金额从大到小
    unique.sort(key=lambda c: (not c["keyword"], not c["decimal"], -c["amount"]))

    amount_list = [c["amount"] for c in unique][:6]
    best_guess = amount_list[0] if amount_list else None
    return {"candidates": amount_list, "best_guess": best_guess, "lines": lines}


# ---------------------------------------------------------------- 页面

@app.route("/")
def index():
    return render_template("index.html")


# ---------------------------------------------------------------- 币种 / 汇率

@app.route("/api/currencies")
def currencies():
    rates = get_rates()
    return jsonify([{**c, "rate": rates.get(c["code"], 1.0)} for c in CURRENCIES])


@app.route("/api/rates", methods=["POST"])
def update_rate():
    body = request.json or {}
    currency = body.get("currency", "").strip().upper()
    try:
        rate = float(body.get("rate"))
    except (TypeError, ValueError):
        return jsonify({"error": "汇率无效"}), 400
    if rate <= 0:
        return jsonify({"error": "汇率需大于 0"}), 400
    valid = {c["code"] for c in CURRENCIES}
    if currency not in valid:
        return jsonify({"error": "不支持的币种"}), 400
    with get_db() as conn:
        conn.execute(
            "INSERT INTO exchange_rates (currency, rate) VALUES (?, ?) "
            "ON CONFLICT(currency) DO UPDATE SET rate = excluded.rate",
            (currency, rate),
        )
    return jsonify({"ok": True})


# ---------------------------------------------------------------- 账户

@app.route("/api/accounts", methods=["GET"])
def list_accounts():
    rates = get_rates()
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT a.id, a.name, a.currency,
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
    result = []
    for r in rows:
        d = dict(r)
        d["amount_cny"] = to_cny(d["latest_amount"], d["currency"], rates)
        result.append(d)
    return jsonify(result)


@app.route("/api/accounts", methods=["POST"])
def create_account():
    body = request.json or {}
    name = body.get("name", "").strip()
    currency = body.get("currency", "CNY").strip().upper()
    if not name:
        return jsonify({"error": "账户名称不能为空"}), 400
    if currency not in {c["code"] for c in CURRENCIES}:
        return jsonify({"error": "不支持的币种"}), 400
    with get_db() as conn:
        cur = conn.execute(
            "INSERT INTO accounts (name, currency) VALUES (?, ?)", (name, currency)
        )
        aid = cur.lastrowid
    return jsonify({"id": aid, "name": name, "currency": currency}), 201


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
    rates = get_rates()
    with get_db() as conn:
        accounts = conn.execute("SELECT id, name, currency FROM accounts ORDER BY id").fetchall()
        logs = conn.execute(
            "SELECT account_id, amount, recorded_at FROM asset_logs ORDER BY recorded_at ASC, id ASC"
        ).fetchall()

    if not logs:
        return jsonify({"days": [], "series": []})

    # 按天分组（保持时间顺序）
    days = []
    logs_by_day = {}
    for log in logs:
        d = log["recorded_at"][:10]  # YYYY-MM-DD
        if d not in logs_by_day:
            days.append(d)
            logs_by_day[d] = []
        logs_by_day[d].append(log)

    # 逐天向前填充：当天某账户未更新则沿用最近一次值
    latest = {}
    day_values = {}
    for day in days:
        for log in logs_by_day[day]:
            latest[log["account_id"]] = log["amount"]
        day_values[day] = dict(latest)

    # 换算为人民币后输出
    series = []
    for acc in accounts:
        rate = rates.get(acc["currency"], 1.0)
        values = [round(day_values[d].get(acc["id"], 0.0) * rate, 2) for d in days]
        if any(v != 0 for v in values):
            series.append({"account_id": acc["id"], "name": acc["name"], "values": values})

    return jsonify({"days": days, "series": series})


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
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", 5000))
    debug = os.environ.get("DEBUG", "1") != "0"
    app.run(host=host, port=port, debug=debug)
