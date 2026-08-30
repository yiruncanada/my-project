// 资产管家 · 前端逻辑（原生 JS，无依赖）
"use strict";

const $ = (sel) => document.querySelector(sel);

// 全局状态
let accounts = [];
let selectedAccountId = null;
let pendingAmount = null; // OCR 识别结果待确认

// ---------------------------------------------------------------- 工具

function fmtMoney(n) {
  if (n === null || n === undefined) return "¥ --";
  return "¥ " + Number(n).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

async function api(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || "请求失败");
  }
  return data;
}

// ---------------------------------------------------------------- 渲染

function render() {
  renderSelect();
  renderSummary();
  renderAccountList();
}

function renderSelect() {
  const sel = $("#account-select");
  sel.innerHTML = '<option value="">请选择账户</option>';
  accounts.forEach((a) => {
    const opt = document.createElement("option");
    opt.value = a.id;
    opt.textContent = a.name;
    sel.appendChild(opt);
  });
  if (selectedAccountId && accounts.some((a) => a.id === selectedAccountId)) {
    sel.value = String(selectedAccountId);
  } else if (accounts.length) {
    sel.value = String(accounts[0].id);
    selectedAccountId = accounts[0].id;
  } else {
    selectedAccountId = null;
  }
  updateDropAccount();
}

function renderSummary() {
  const total = accounts.reduce((s, a) => s + (a.latest_amount || 0), 0);
  $(".summary-amount").textContent = accounts.length ? fmtMoney(total) : "¥ --";
  const latest = accounts
    .map((a) => a.updated_at)
    .filter(Boolean)
    .sort()
    .pop();
  $(".summary-updated").textContent = "最近更新：" + (latest || "--");
}

function renderAccountList() {
  const ul = $("#account-list");
  ul.innerHTML = "";
  if (!accounts.length) {
    const li = document.createElement("li");
    li.className = "account-item";
    li.innerHTML = '<span class="account-name hint">暂无账户，请先新增</span>';
    ul.appendChild(li);
    return;
  }
  accounts.forEach((a) => {
    const li = document.createElement("li");
    li.className = "account-item";
    li.innerHTML = `
      <span class="account-name">${escapeHtml(a.name)}</span>
      <span class="account-right">
        <span class="account-balance amount">${fmtMoney(a.latest_amount)}</span>
        <div class="account-time">${a.updated_at ? "更新于 " + a.updated_at : "暂无记录"}</div>
      </span>
      <button class="account-del" data-id="${a.id}" title="删除该账户及其记录">删除</button>
    `;
    li.querySelector(".account-del").addEventListener("click", (e) => deleteAccount(a.id, e.currentTarget));
    ul.appendChild(li);
  });
}

function updateDropAccount() {
  const acc = accounts.find((a) => a.id === selectedAccountId);
  $("#drop-account").textContent = acc ? acc.name : "未选择";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---------------------------------------------------------------- 数据加载

async function loadAll() {
  accounts = await api("/api/accounts");
  render();
  loadTrend();
}

async function loadTrend() {
  const data = await api("/api/trend");
  drawTrend(data);
}

// ---------------------------------------------------------------- 账户操作

// 新增账户弹窗
function openAccountModal() {
  $("#account-name-input").value = "";
  $("#account-modal-error").textContent = "";
  $("#account-modal").classList.remove("hidden");
  $("#account-name-input").focus();
}
function closeAccountModal() {
  $("#account-modal").classList.add("hidden");
}

$("#btn-new-account").addEventListener("click", openAccountModal);
$("#btn-account-cancel").addEventListener("click", closeAccountModal);
$("#account-modal").addEventListener("click", (e) => {
  if (e.target === $("#account-modal")) closeAccountModal();
});
$("#account-name-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("#btn-account-confirm").click();
});
$("#btn-account-confirm").addEventListener("click", async () => {
  const name = $("#account-name-input").value.trim();
  if (!name) {
    $("#account-modal-error").textContent = "请输入账户名称";
    return;
  }
  try {
    await api("/api/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name }),
    });
    closeAccountModal();
    await loadAll();
  } catch (err) {
    $("#account-modal-error").textContent = err.message;
  }
});

// 删除账户（两次点击确认，避免误删，也避免浏览器拦截原生确认框）
let deletePendingId = null;
async function deleteAccount(id, btn) {
  if (deletePendingId !== id) {
    deletePendingId = id;
    btn.textContent = "确认删除?";
    btn.classList.add("confirming");
    setTimeout(() => {
      if (deletePendingId === id) {
        deletePendingId = null;
        renderAccountList();
      }
    }, 5000);
    return;
  }
  deletePendingId = null;
  await api("/api/accounts/" + id, { method: "DELETE" });
  await loadAll();
}

$("#account-select").addEventListener("change", (e) => {
  selectedAccountId = e.target.value ? Number(e.target.value) : null;
  updateDropAccount();
});

// ---------------------------------------------------------------- 上传识别

const dropZone = $("#drop-zone");
const fileInput = $("#file-input");

dropZone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  if (fileInput.files.length) handleImage(fileInput.files[0]);
  fileInput.value = "";
});

dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("dragover");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("dragover");
  const file = e.dataTransfer.files[0];
  if (file) handleImage(file);
});

document.addEventListener("paste", (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const it of items) {
    if (it.type.startsWith("image/")) {
      handleImage(it.getAsFile());
      break;
    }
  }
});

async function handleImage(file) {
  if (!selectedAccountId) {
    alert("请先在下拉框中选择或新增一个账户");
    return;
  }
  const fd = new FormData();
  fd.append("image", file);
  const original = dropZone.innerHTML;
  dropZone.innerHTML = "<p>⏳ 正在识别中，首次需加载模型请稍候…</p>";
  try {
    const data = await api("/api/ocr", { method: "POST", body: fd });
    if (data.error) {
      alert(data.error);
      return;
    }
    if (!data.candidates.length) {
      alert("未识别到金额，请换一张更清晰的截图");
      return;
    }
    openModal(data);
  } catch (err) {
    alert("识别失败：" + err.message);
  } finally {
    dropZone.innerHTML = original;
  }
}

// ---------------------------------------------------------------- 确认弹窗

function openModal(ocrData) {
  pendingAmount = ocrData.best_guess;
  const acc = accounts.find((a) => a.id === selectedAccountId);
  $("#modal-account").textContent = acc ? acc.name : "";
  $("#modal-amount").value = ocrData.best_guess != null ? ocrData.best_guess : "";
  $("#modal-error").textContent = "";

  const box = $("#modal-candidates");
  box.innerHTML = "";
  ocrData.candidates.forEach((c) => {
    const chip = document.createElement("span");
    const isBest = Math.abs(c - ocrData.best_guess) < 0.005;
    chip.className = "candidate-chip" + (isBest ? " chip-best" : "");
    chip.textContent = (isBest ? "推荐 " : "") + fmtMoney(c);
    chip.addEventListener("click", () => {
      $("#modal-amount").value = c;
    });
    box.appendChild(chip);
  });

  $("#modal").classList.remove("hidden");
  $("#modal-amount").focus();
  $("#modal-amount").select();
}

function closeModal() {
  $("#modal").classList.add("hidden");
  pendingAmount = null;
}

$("#btn-cancel").addEventListener("click", closeModal);
$("#modal").addEventListener("click", (e) => {
  if (e.target === $("#modal")) closeModal();
});

$("#btn-confirm").addEventListener("click", async () => {
  const amount = parseFloat($("#modal-amount").value);
  if (!amount || amount <= 0) {
    $("#modal-error").textContent = "请输入有效金额";
    return;
  }
  try {
    await api("/api/logs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_id: selectedAccountId, amount: amount }),
    });
    closeModal();
    await loadAll();
  } catch (err) {
    $("#modal-error").textContent = err.message;
  }
});

// ---------------------------------------------------------------- 一键隐数

$("#toggle-hide").addEventListener("click", () => {
  document.body.classList.toggle("hide-numbers");
});

// ---------------------------------------------------------------- 趋势图（原生 canvas）

// 账户颜色盘
const PALETTE = ["#2f6fed", "#f5a623", "#34c759", "#ff3b30", "#af52de", "#00c7be", "#ff9500", "#5856d6"];

function niceCeil(v) {
  if (v <= 0) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = Math.pow(10, exp);
  const frac = v / base;
  const nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  return nice * base;
}

function fmtAxis(v) {
  if (v >= 10000) {
    const w = v / 10000;
    return (w >= 100 ? Math.round(w) : Math.round(w * 10) / 10) + "万";
  }
  return String(Math.round(v));
}

function drawTrend(data) {
  const canvas = $("#trend-canvas");
  const empty = $("#trend-empty");
  const legendBox = $("#trend-legend");
  const days = data.days || [];
  const series = data.series || [];
  if (!days.length || !series.length) {
    canvas.style.display = "none";
    legendBox.style.display = "none";
    empty.style.display = "block";
    empty.textContent = "暂无记录";
    return;
  }
  canvas.style.display = "block";
  legendBox.style.display = "flex";
  empty.style.display = "none";

  // 每个账户分配颜色
  series.forEach((s, i) => { s.color = PALETTE[i % PALETTE.length]; });

  const n = days.length;
  const dayTotals = days.map((_, i) => series.reduce((sum, s) => sum + (s.values[i] || 0), 0));
  const yMax = niceCeil(Math.max(...dayTotals));

  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.parentElement.clientWidth - 36;
  const h = 240;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const pad = { l: 56, r: 12, t: 14, b: 30 };
  const plotW = w - pad.l - pad.r;
  const plotH = h - pad.t - pad.b;
  const slot = plotW / n;
  const barW = Math.min(slot * 0.6, 46);
  const py = (v) => pad.t + plotH * (1 - v / yMax);

  // Y 轴网格 + 刻度
  ctx.font = "11px sans-serif";
  ctx.textBaseline = "middle";
  ctx.strokeStyle = "#e6e8ee";
  ctx.fillStyle = "#8a919f";
  for (let g = 0; g <= 4; g++) {
    const v = (yMax * g) / 4;
    const y = py(v);
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    ctx.textAlign = "right";
    ctx.fillText(fmtAxis(v), pad.l - 6, y);
  }

  // 堆叠柱状图（累加求和，各账户自下而上堆叠）
  for (let i = 0; i < n; i++) {
    const x = pad.l + slot * i + (slot - barW) / 2;
    let cum = 0;
    for (const s of series) {
      const v = s.values[i] || 0;
      if (v <= 0) continue;
      const prev = cum;
      cum += v;
      const yTop = py(cum);
      const yBottom = py(prev);
      ctx.fillStyle = s.color;
      ctx.fillRect(x, yTop, barW, yBottom - yTop);
    }
  }

  // X 轴日期标签（过多时抽稀）
  ctx.fillStyle = "#8a919f";
  ctx.textAlign = "center";
  const step = Math.max(1, Math.ceil(n / 8));
  for (let i = 0; i < n; i += step) {
    ctx.fillText(days[i].slice(5), pad.l + slot * i + slot / 2, h - pad.b + 14);
  }
  ctx.textAlign = "start";

  // 图例
  legendBox.innerHTML = "";
  series.forEach((s) => {
    const item = document.createElement("span");
    item.className = "legend-item";
    item.innerHTML = `<span class="legend-dot" style="background:${s.color}"></span>${escapeHtml(s.name)}`;
    legendBox.appendChild(item);
  });
}

window.addEventListener("resize", () => loadTrend());

// ---------------------------------------------------------------- 启动

loadAll();
