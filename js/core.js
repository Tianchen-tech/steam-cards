// 公共：接口请求、全局状态、格式化、手续费计算

export const state = {
  status: null,
  display: { currency: "CNY", symbol: "¥", rate: 1, source: "fallback" },
  watch: new Set(),
};

// 网页版：发布到 GitHub Pages 的只读版本，没有本地服务，数据来自定时导出的文件（见 static.js）
export const STATIC = document.documentElement.dataset.mode === "static";

export async function api(path, { method = "GET", params, body } = {}) {
  if (STATIC) return (await import("./static.js")).request(path, { method, params, body });
  const url = new URL(path, location.origin);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* 非 JSON */
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || `请求失败（HTTP ${res.status}）`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export function applyStatus(s) {
  state.status = s;
  state.display = s.display;
  const updown = s.settings.up_color === "green" ? "green" : "red";
  if (updown === "green") document.documentElement.dataset.updown = "green";
  else delete document.documentElement.dataset.updown;
  try {
    localStorage.setItem("sct-updown", updown);
  } catch {
    /* 隐私模式 */
  }
}

// ---------- 格式化 ----------

const nf2 = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });
const compact = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 });

export const toDisplay = (usd) => (usd == null ? null : usd * state.display.rate);
export const fromDisplay = (v) => (v == null || v === "" ? null : Number(v) / state.display.rate);

export function money(usd, dash = "—") {
  if (usd == null || Number.isNaN(usd)) return dash;
  return state.display.symbol + nf2.format(toDisplay(usd));
}

export function moneyShort(usd) {
  const v = toDisplay(usd);
  if (v == null) return "";
  if (Math.abs(v) >= 10000) return state.display.symbol + compact.format(v);
  if (Math.abs(v) >= 100) return state.display.symbol + nf0.format(v);
  return state.display.symbol + nf2.format(v);
}

export function pct(x, digits = 1) {
  if (x == null || Number.isNaN(x)) return "—";
  const v = x * 100;
  const abs = Math.abs(v);
  const body = abs >= 1000 ? nf0.format(abs) : abs.toFixed(digits);
  return (v > 0.05 ? "+" : v < -0.05 ? "−" : "") + body + "%";
}

export const chgClass = (x) => (x == null ? "flat" : x > 0.0005 ? "rise" : x < -0.0005 ? "fall" : "flat");

export function count(n) {
  if (n == null) return "—";
  return n >= 100000 ? compact.format(n) : nf0.format(n);
}

export function count1(n) {
  if (n == null) return "—";
  return n >= 100 ? nf0.format(n) : nf1.format(n);
}

export function ago(ts) {
  if (!ts) return "从未";
  const s = Date.now() / 1000 - ts;
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

/** 「每小时」「每 30 分钟」「每 2 小时」 */
export function every(min) {
  const m = Number(min) || 60;
  if (m === 60) return "每小时";
  return m % 60 ? `每 ${m} 分钟` : `每 ${m / 60} 小时`;
}

export function duration(sec) {
  if (sec < 60) return `${Math.ceil(sec)} 秒`;
  if (sec < 3600) return `${Math.ceil(sec / 60)} 分钟`;
  return `${(sec / 3600).toFixed(1)} 小时`;
}

export function dateLabel(ts, withHour = false) {
  const d = new Date(ts * 1000);
  const base = `${d.getMonth() + 1}月${d.getDate()}日`;
  return withHour ? `${base} ${String(d.getHours()).padStart(2, "0")}:00` : base;
}

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

// ---------- Steam 手续费 ----------
// 卡牌交易：Steam 平台费 5% + 游戏开发商费 10%，每项最少 0.01。按显示货币的「分」计算。

function buyerPays(receive) {
  return receive + Math.max(Math.floor(receive * 0.05), 1) + Math.max(Math.floor(receive * 0.1), 1);
}

/** 买家支付 usd 时卖家实际到手多少（返回 USD，便于统一格式化）。 */
export function sellerGets(usd) {
  if (!usd) return null;
  const total = Math.round(toDisplay(usd) * 100);
  let r = Math.floor(total / 1.15);
  while (r > 0 && buyerPays(r) > total) r -= 1;
  while (buyerPays(r + 1) <= total) r += 1;
  return Math.max(r, 0) / 100 / state.display.rate;
}

// ---------- 链接 ----------

export const itemHref = (hash) => `#/item/${encodeURIComponent(hash)}`;
export const imgUrl = (icon, size = "96fx96f") =>
  icon ? `https://community.fastly.steamstatic.com/economy/image/${icon}/${size}` : null;
export const steamUrl = (hash) => `https://steamcommunity.com/market/listings/753/${encodeURIComponent(hash)}`;

export function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function store(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(key) || "null");
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    return null;
  }
  return value;
}
