// 页面组件（返回 HTML 字符串；所有来自 Steam 的文本都经过 esc 转义）
import { STATIC, api, chgClass, esc, imgUrl, itemHref, money, pct, state } from "./core.js";

const STAR =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 3.2l2.6 5.6 6.1.7-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6L3.3 9.5l6.1-.7z"/></svg>';
const STAR_OFF =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" d="M12 3.2l2.6 5.6 6.1.7-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6L3.3 9.5l6.1-.7z"/></svg>';

export function art(card, size = "96fx96f", cls = "thumb") {
  const src = imgUrl(card.icon, size);
  const inner = src
    ? `<img src="${esc(src)}" alt="" loading="lazy" data-fallback="1">`
    : '<span class="ph">无图</span>';
  return `<span class="${cls}${card.foil ? " foil" : ""}">${inner}</span>`;
}

export function cardCell(card) {
  return `<div class="cardcell">${art(card, "62fx62f")}
    <div class="meta"><div class="title" title="${esc(card.name)}">${esc(card.name)}</div>
    <div class="game">${card.foil ? '<span class="tag foil">闪</span> ' : ""}${esc(card.game || "未知游戏")}</div></div></div>`;
}

export function chg(x, digits = 1) {
  const cls = chgClass(x);
  const arrow = cls === "rise" ? "▲ " : cls === "fall" ? "▼ " : "";
  return `<span class="chg ${cls}">${x == null ? "—" : arrow + pct(x, digits).replace(/^[+−]/, "")}</span>`;
}

export function liq(l) {
  if (!l) return '<span class="liq unknown"><span class="dot"></span>—</span>';
  return `<span class="liq ${esc(l.grade)}" title="${esc(l.label)}"><span class="dot"></span>${esc(l.label.replace("（按挂单估计）", "*"))}</span>`;
}

export function star(card) {
  const on = state.watch.has(card.hash_name);
  return `<button class="star${on ? " on" : ""}" data-star="${esc(card.hash_name)}" aria-pressed="${on}"
    title="${on ? "取消关注" : "加入关注"}">${on ? STAR : STAR_OFF}</button>`;
}

export function flags(list, max = 3) {
  if (!list || !list.length) return "";
  const shown = list.slice(0, max).map((f) => `<span class="flag ${esc(f.level)}" title="${esc(f.detail)}">${esc(f.title)}</span>`);
  if (list.length > max) shown.push(`<span class="flag">+${list.length - max}</span>`);
  return `<div class="flags">${shown.join("")}</div>`;
}

export function empty(title, body = "", action = "") {
  return `<div class="empty"><h3>${esc(title)}</h3>${body ? `<p>${body}</p>` : ""}${action}</div>`;
}

export function tile(label, value, foot = "", busy = false) {
  return `<div class="tile${busy ? " busy" : ""}"><div class="label">${label}</div>
    <div class="value">${value}</div><div class="foot">${foot || "&nbsp;"}</div></div>`;
}

export function cardTile(card) {
  const price = card.price ?? card.ask;
  const basis = card.price != null ? "成交" : "挂牌";
  const change = card.chg["7d"] ?? card.achg?.["7d"];
  return `<div class="ctile-wrap"><a class="ctile${card.foil ? " foil" : ""}" href="${itemHref(card.hash_name)}">
      <span class="art">${imgUrl(card.icon) ? `<img src="${esc(imgUrl(card.icon, "360fx360f"))}" alt="" loading="lazy" data-fallback="1">` : '<span class="ph">无图</span>'}</span>
      <span class="name" title="${esc(card.name)}">${esc(card.name)}</span>
      <span class="game">${esc(card.game || "")}</span>
      <span class="row first"><span class="price">${money(price)}</span>${change != null ? `<span><span class="per">7天</span>${chg(change)}</span>` : ""}</span>
      <span class="row small muted"><span>${basis}价</span><span>在售 ${card.listings ?? "—"}</span></span>
    </a>${star(card)}</div>`;
}

let toastTimer = null;
export function toast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 2600);
}

export function setWatchCount() {
  const n = state.watch.size;
  document.getElementById("watch-count").textContent = n ? String(n) : "";
}

export async function toggleWatch(name) {
  const on = state.watch.has(name);
  if (on) {
    await api("/api/watchlist", { method: "DELETE", params: { name } });
    state.watch.delete(name);
    toast("已取消关注");
  } else {
    await api("/api/watchlist", { method: "POST", body: { name } });
    state.watch.add(name);
    toast(STATIC ? "已加入关注列表（保存在这个浏览器里）" : "已加入关注列表，后台会优先刷新它");
  }
  for (const btn of document.querySelectorAll("[data-star]")) {
    if (btn.dataset.star !== name) continue;
    btn.classList.toggle("on", !on);
    btn.setAttribute("aria-pressed", String(!on));
    btn.title = on ? "加入关注" : "取消关注";
    if (btn.classList.contains("star")) btn.innerHTML = on ? STAR_OFF : STAR;
    else btn.textContent = on ? "☆ 关注" : "★ 已关注";
  }
  setWatchCount();
  document.dispatchEvent(new CustomEvent("watch-changed", { detail: { name, on: !on } }));
  return !on;
}
