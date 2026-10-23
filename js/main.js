// 入口：路由、顶栏搜索、连接状态、全局事件委托
import { STATIC, ago, api, applyStatus, debounce, esc, imgUrl, itemHref, money, state } from "./core.js";
import { setWatchCount, toast, toggleWatch } from "./ui.js";
import * as about from "./views/about.js";
import * as board from "./views/board.js";
import * as foil from "./views/foil.js";
import * as item from "./views/item.js";
import * as status from "./views/status.js";
import * as watchlist from "./views/watchlist.js";

const ROUTES = [
  [/^\/?$/, board, "board"],
  [/^\/foil\/?$/, foil, "foil"],
  [/^\/foil\/(\d+)\/?$/, foil, "foil"],
  [/^\/item\/(.+)$/, item, ""],
  [/^\/watchlist\/?$/, watchlist, "watch"],
  // 网页版没有采集和设置，这一页换成「关于本站」
  [/^\/status\/?$/, STATIC ? about : status, "status"],
];

const view = document.getElementById("view");
let current = null;
let navSeq = 0;

async function navigate() {
  const raw = location.hash.replace(/^#/, "") || "/";
  const [path, query] = raw.split("?");
  const found = ROUTES.find(([re]) => re.test(path));
  if (!found) {
    location.hash = "#/";
    return;
  }
  const [re, mod, nav] = found;
  const seq = ++navSeq;
  current?.destroy?.();
  current = null;
  for (const a of document.querySelectorAll("[data-nav]")) a.classList.toggle("active", a.dataset.nav === nav);
  view.innerHTML = "";
  window.scrollTo(0, 0);
  try {
    const ctx = await mod.mount(view, { match: path.match(re), params: new URLSearchParams(query || "") });
    if (seq === navSeq) current = ctx;
    else ctx?.destroy?.();
  } catch (e) {
    console.error(e);
    view.innerHTML = `<div class="empty"><h3>页面出错了</h3><p>${esc(e.message)}</p></div>`;
  }
}

// ---------- 连接状态 ----------

// 网页版：显示数据是多久前发布的；超过 3 个发布周期没更新就标黄
function renderAge(s) {
  const el = document.getElementById("health");
  const age = Date.now() / 1000 - s.generated_at;
  const stale = age > Math.max(3, 3 * (s.interval_min || 60) / 60) * 3600;
  el.innerHTML = `<span class="dot ${stale ? "warn" : "good"}"></span><span>${ago(s.generated_at)}更新</span>`;
  el.title = stale ? "数据有一段时间没有更新了，价格可能已经变化" : "行情数据的发布时间";
}

function renderHealth(s) {
  if (s.static) return renderAge(s);
  const el = document.getElementById("health");
  const w = s.workers;
  const blocked = ["search", "book", "overview", "history"].filter((g) => w[g].pacer.blocked_for > 0);
  let cls = "good";
  let text = s.settings.collector_enabled ? "采集中" : "已暂停";
  if (s.offline) {
    cls = "";
    text = "离线模式";
  } else if (!s.market_ready) {
    const err = w.book.last_error;
    cls = err ? "bad" : "warn";
    text = err ? "连不上 Steam" : "连接中";
  } else if (blocked.includes("search") && blocked.includes("book")) {
    cls = "bad";
    text = "Steam 限流中";
  } else if (blocked.length) {
    cls = "warn";
    text = `部分接口限流`;
  }
  let title = blocked.length ? `被限流的接口：${blocked.join("、")}，会自动退避重试` : "Steam 连接状态";
  // Steam 一切正常时，再看数据存放的云盘和网页版有没有问题
  const c = s.cloud || {};
  if (cls === "good" && c.folder && (c.conflict || !c.available || c.error)) {
    cls = "warn";
    text = c.conflict ? "云盘数据待处理" : !c.available ? "云盘未连接" : "云盘写入失败";
    title = "数据存放位置有问题，点开「数据状态」查看";
  } else if (cls === "good" && s.site?.enabled && s.site.error) {
    cls = "warn";
    text = "网页版发布失败";
    title = "点开「数据状态」查看原因";
  }
  el.innerHTML = `<span class="dot ${cls}"></span><span>${text}</span>`;
  el.title = title;
}

async function pollStatus() {
  try {
    const s = await api("/api/status");
    applyStatus(s);
    renderHealth(s);
  } catch {
    const el = document.getElementById("health");
    el.innerHTML = `<span class="dot bad"></span><span>${STATIC ? "数据加载失败" : "本地服务未响应"}</span>`;
  }
  setTimeout(pollStatus, STATIC ? 60000 : 15000);
}

// ---------- 顶栏搜索 ----------

function bindSearch() {
  const input = document.getElementById("global-search");
  const pop = document.getElementById("global-pop");
  let items = [];
  let sel = -1;
  let seq = 0;

  const close = () => pop.classList.add("hidden");
  const none = STATIC ? "没有找到。网页版只能搜已经收录的卡牌。" : "没有找到。按回车到 Steam 实时搜索。";
  const paint = (note) => {
    if (!items.length) {
      pop.innerHTML = `<div class="empty" style="padding:12px">${note ? esc(note) : none}</div>`;
    } else {
      pop.innerHTML =
        items
          .map(
            (c, i) => `<a class="opt${i === sel ? " sel" : ""}" href="${itemHref(c.hash_name)}">
          <span class="thumb${c.foil ? " foil" : ""}" style="width:30px;height:35px">${c.icon ? `<img src="${esc(imgUrl(c.icon, "62fx62f"))}" alt="" data-fallback="1">` : ""}</span>
          <div class="grow"><div class="t">${esc(c.name)}</div><div class="s">${esc(c.game || "")}${c.foil ? " · 闪卡" : ""}</div></div>
          <span class="num">${money(c.price ?? c.ask)}</span></a>`,
          )
          .join("") + (note ? `<div class="empty" style="padding:8px 10px;text-align:left">${esc(note)}</div>` : "");
    }
    pop.classList.remove("hidden");
  };
  const run = async (live) => {
    const q = input.value.trim();
    if (!q) return close();
    const my = ++seq;
    if (live) {
      pop.innerHTML = '<div class="empty" style="padding:12px">正在 Steam 上搜索…</div>';
      pop.classList.remove("hidden");
    }
    try {
      const data = await api("/api/search", { params: { q, live: live ? 1 : undefined } });
      if (my !== seq) return;
      items = data.cards;
      sel = -1;
      paint(data.warning);
    } catch (e) {
      items = [];
      paint(e.message);
    }
  };
  const searchLater = debounce(() => run(false), 250);
  input.addEventListener("input", searchLater);
  input.addEventListener("focus", () => input.value.trim() && pop.innerHTML && pop.classList.remove("hidden"));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!items.length) return;
      e.preventDefault();
      sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      paint();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (sel >= 0 && items[sel]) {
        location.hash = itemHref(items[sel].hash_name);
        close();
        input.blur();
      } else run(!STATIC);
    } else if (e.key === "Escape") {
      close();
      input.blur();
    }
  });
  pop.addEventListener("click", () => close());
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".topbar .search")) close();
  });
}

// ---------- 全局委托 ----------

document.addEventListener("click", async (e) => {
  const starBtn = e.target.closest("[data-star]");
  if (starBtn) {
    e.preventDefault();
    e.stopPropagation();
    try {
      await toggleWatch(starBtn.dataset.star);
    } catch (err) {
      toast(err.message);
    }
    return;
  }
  const row = e.target.closest("tr[data-href]");
  if (row && !e.target.closest("a, button, input, select")) {
    if (e.metaKey || e.ctrlKey) window.open(row.dataset.href, "_blank");
    else location.hash = row.dataset.href;
  }
});

// 卡牌图片加载失败时换成占位
document.addEventListener(
  "error",
  (e) => {
    const img = e.target;
    if (img.tagName !== "IMG" || !img.dataset.fallback) return;
    const ph = document.createElement("span");
    ph.className = "ph";
    ph.textContent = "无图";
    img.replaceWith(ph);
  },
  true,
);

window.addEventListener("hashchange", navigate);

async function start() {
  if (STATIC) {
    document.querySelector('[data-nav="status"]').textContent = "关于本站";
    document.getElementById("health").title = "行情数据的发布时间";
  }
  try {
    const [s, w] = await Promise.all([api("/api/status"), api("/api/watchlist")]);
    applyStatus(s);
    renderHealth(s);
    state.watch = new Set(w.cards.map((c) => c.hash_name));
    setWatchCount();
  } catch (e) {
    view.innerHTML = STATIC
      ? `<div class="empty"><h3>数据加载失败</h3><p>请稍后刷新页面再试。${esc(e.message)}</p></div>`
      : `<div class="empty"><h3>连不上本地服务</h3><p>请确认 server.py 正在运行。${esc(e.message)}</p></div>`;
    return;
  }
  document.addEventListener("watch-changed", setWatchCount);
  bindSearch();
  setTimeout(pollStatus, STATIC ? 60000 : 15000);
  navigate();
}

start();
