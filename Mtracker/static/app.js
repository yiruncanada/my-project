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
      <button class="account-del" data-id="${a.id}" title="删除账户">🗑</button>
    `;
    li.querySelector(".account-del").addEventListener("click", () => deleteAccount(a.id));
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

$("#btn-new-account").addEventListener("click", async () => {
  const name = prompt("请输入账户名称（如：支付宝 / 招商银行）");
  if (!name || !name.trim()) return;
  await api("/api/accounts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: name.trim() }),
  });
  await loadAll();
});

async function deleteAccount(id) {
  if (!confirm("确认删除该账户及其全部记录？")) return;
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
    chip.className = "candidate-chip";
    chip.textContent = fmtMoney(c);
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

function drawTrend(data) {
  const canvas = $("#trend-canvas");
  const empty = $("#trend-empty");
  if (!data || data.length < 2) {
    canvas.style.display = "none";
    empty.style.display = "block";
    empty.textContent = data && data.length === 1 ? "仅 1 条记录，再记录一次即可显示走势" : "暂无记录";
    return;
  }
  canvas.style.display = "block";
  empty.style.display = "none";

  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.parentElement.clientWidth - 36;
  const h = 220;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);

  const pad = { l: 50, r: 12, t: 12, b: 28 };
  const totals = data.map((d) => d.total);
  const max = Math.max(...totals);
  const min = Math.min(...totals);
  const range = max - min || 1;

  const px = (i) => pad.l + (i / (data.length - 1)) * (w - pad.l - pad.r);
  const py = (v) => pad.t + (1 - (v - min) / range) * (h - pad.t - pad.b);

  ctx.clearRect(0, 0, w, h);
  ctx.font = "11px sans-serif";
  ctx.textBaseline = "middle";

  // 网格 + Y 轴刻度
  ctx.strokeStyle = "#e6e8ee";
  ctx.fillStyle = "#8a919f";
  for (let g = 0; g <= 4; g++) {
    const v = min + (range * g) / 4;
    const y = py(v);
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
    ctx.fillText(fmtMoney(v).replace("¥ ", ""), 6, y);
  }

  // 折线
  ctx.strokeStyle = "#2f6fed";
  ctx.lineWidth = 2;
  ctx.beginPath();
  data.forEach((d, i) => {
    i === 0 ? ctx.moveTo(px(i), py(d.total)) : ctx.lineTo(px(i), py(d.total));
  });
  ctx.stroke();

  // 数据点
  data.forEach((d, i) => {
    ctx.fillStyle = "#2f6fed";
    ctx.beginPath();
    ctx.arc(px(i), py(d.total), 3, 0, Math.PI * 2);
    ctx.fill();
  });

  // X 轴首尾时间
  ctx.fillStyle = "#8a919f";
  const t0 = data[0].time.slice(5, 16);
  const t1 = data[data.length - 1].time.slice(5, 16);
  ctx.textAlign = "left";
  ctx.fillText(t0, pad.l, h - pad.b + 14);
  ctx.textAlign = "right";
  ctx.fillText(t1, w - pad.r, h - pad.b + 14);
  ctx.textAlign = "start";
}

window.addEventListener("resize", () => loadTrend());

// ---------------------------------------------------------------- 启动

loadAll();
