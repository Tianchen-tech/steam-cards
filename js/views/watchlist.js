// 个人关注列表：涨跌、关注以来的变化、异常价格与目标价提醒
import { sparkline } from "../chart.js";
import { STATIC, api, esc, fromDisplay, itemHref, money, state, toDisplay } from "../core.js";
import { cardCell, chg, empty, flags, liq, tile, toast, toggleWatch } from "../ui.js";

const LEVEL = { alert: 3, warn: 2, info: 1 };
const COLS = [
  ["card", "卡牌", "l"],
  ["price", "成交价"],
  ["chg1", "24 小时"],
  ["chg7", "7 天"],
  ["spark", "近 7 天", "c hide-sm"],
  ["since", "关注以来"],
  ["ask", "最低挂牌", "hide-sm"],
  ["bid", "最高求购", "hide-sm"],
  ["liq", "流动性", "l hide-sm"],
  ["flags", "提醒", "l"],
  ["act", "", ""],
];
const SORTABLE = {
  price: (c) => c.price ?? c.ask ?? -1,
  chg1: (c) => c.chg["1d"] ?? -9,
  chg7: (c) => c.chg["7d"] ?? -9,
  since: (c) => c.watch.since_added ?? -9,
  ask: (c) => c.ask ?? -1,
  bid: (c) => c.bid ?? -1,
  flags: (c) => c.anomalies.reduce((s, a) => s + (LEVEL[a.level] || 0) * 10, 0) + c.anomalies.length,
};

export async function mount(el) {
  let cards = [];
  let sortKey = "flags";
  let dir = -1;
  let timer = null;
  let alive = true;

  el.innerHTML = `
    <div class="page-head"><div><h1>关注列表</h1>
      <p class="sub">${
        STATIC
          ? "关注列表只保存在你这个浏览器里，换浏览器或清除网站数据就没了。"
          : "关注的卡牌会被后台优先刷新（订单簿约 15 分钟、成交概览约 30 分钟一次）。"
      }出现暴涨暴跌、挂牌价偏离成交价、成交量异常或触发你设的目标价时，会在「提醒」里标出来。</p></div></div>
    <div class="tiles" id="sum"></div>
    <section class="panel" style="margin-top:16px"><div id="list"></div></section>
    <dialog id="edit"><form method="dialog" id="edit-form">
      <h2>提醒设置</h2>
      <p class="muted small" id="edit-name" style="margin:-8px 0 14px"></p>
      <div class="field"><label for="f-high">涨到以上提醒（${esc(state.display.symbol)}）</label><input type="number" step="0.01" min="0" id="f-high" placeholder="不设置"></div>
      <div class="field"><label for="f-low">跌到以下提醒（${esc(state.display.symbol)}）</label><input type="number" step="0.01" min="0" id="f-low" placeholder="不设置"></div>
      <div class="field"><label for="f-note">备注</label><input type="text" id="f-note" maxlength="200" placeholder="例如：凑套装、等跌到 3 块再买"></div>
      <p class="help muted small" style="margin-top:10px">按成交价判断；没有成交数据时按最低挂牌价。</p>
      <div class="actions"><button class="btn" value="cancel" type="submit">取消</button><button class="btn primary" value="save" type="submit">保存</button></div>
    </form></dialog>`;

  const list = el.querySelector("#list");
  const dialog = el.querySelector("#edit");
  let editing = null;

  function summary() {
    const alerts = cards.filter((c) => c.anomalies.some((a) => a.level === "alert" || a.level === "warn")).length;
    const up = cards.filter((c) => (c.chg["1d"] ?? 0) > 0.0005).length;
    const down = cards.filter((c) => (c.chg["1d"] ?? 0) < -0.0005).length;
    const total = cards.reduce((s, c) => s + (c.price ?? c.ask ?? 0), 0);
    el.querySelector("#sum").innerHTML = [
      tile("关注卡牌", `${cards.length} 张`, STATIC ? "保存在这个浏览器里" : "后台优先刷新"),
      tile("需要留意", `${alerts} 张`, alerts ? "见下方「提醒」列" : "暂无异常"),
      tile("24 小时涨 / 跌", `<span class="rise">${up}</span> / <span class="fall">${down}</span>`, "按成交价"),
      tile("参考总价", money(total), "每张按成交价（缺失时按挂牌价）"),
    ].join("");
  }

  function table() {
    if (!cards.length) {
      list.innerHTML = empty(
        "还没有关注的卡牌",
        "在排行榜、闪卡专区或卡牌详情页点 ☆ 就能加入关注，之后在这里统一看涨跌和异常提醒。",
        '<a class="btn primary" href="#/">去排行榜看看</a>',
      );
      return;
    }
    const sorted = [...cards];
    if (SORTABLE[sortKey]) sorted.sort((a, b) => (SORTABLE[sortKey](a) - SORTABLE[sortKey](b)) * dir);
    const head = COLS.map(([k, label, cls]) => {
      const can = SORTABLE[k];
      const on = k === sortKey;
      return `<th class="${cls ?? ""}${can ? " sortable" : ""}${on ? " sorted" : ""}" ${can ? `data-sort="${k}"` : ""}>${label}${on ? (dir < 0 ? " ↓" : " ↑") : ""}</th>`;
    }).join("");
    const rows = sorted
      .map((c) => {
        const w = c.watch;
        const targets = [w.target_high ? `≥${money(w.target_high)}` : "", w.target_low ? `≤${money(w.target_low)}` : ""].filter(Boolean).join(" ");
        return `<tr data-href="${itemHref(c.hash_name)}">
          <td class="l">${cardCell(c)}${w.note ? `<div class="muted small" style="margin:4px 0 0 50px;white-space:normal">${esc(w.note)}</div>` : ""}</td>
          <td><b>${money(c.price)}</b></td><td>${chg(c.chg["1d"])}</td><td>${chg(c.chg["7d"])}</td>
          <td class="c hide-sm">${sparkline(c.spark)}</td>
          <td title="关注时 ${money(w.added_price)}">${chg(w.since_added)}</td>
          <td class="hide-sm">${money(c.ask)}</td><td class="hide-sm">${money(c.bid)}</td>
          <td class="l hide-sm">${liq(c.liquidity)}</td>
          <td class="l">${flags(c.anomalies, 2) || '<span class="muted small">—</span>'}${targets ? `<div class="muted small" style="margin-top:4px">目标 ${targets}</div>` : ""}</td>
          <td><div style="display:flex;gap:4px;justify-content:flex-end">
            <button class="btn small ghost" data-edit="${esc(c.hash_name)}">提醒</button>
            <button class="btn small ghost" data-remove="${esc(c.hash_name)}">移除</button></div></td></tr>`;
      })
      .join("");
    list.innerHTML = `<div class="table-wrap"><table class="data"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  async function load() {
    clearTimeout(timer);
    try {
      const data = await api("/api/watchlist");
      if (!alive) return;
      cards = data.cards;
      state.watch = new Set(cards.map((c) => c.hash_name));
      summary();
      table();
    } catch (e) {
      list.innerHTML = empty("加载失败", esc(e.message));
    }
    timer = setTimeout(load, 30000);
  }

  list.addEventListener("click", async (e) => {
    const th = e.target.closest("[data-sort]");
    if (th) {
      const k = th.dataset.sort;
      dir = k === sortKey ? -dir : -1;
      sortKey = k;
      table();
      return;
    }
    const rm = e.target.closest("[data-remove]");
    if (rm) {
      e.stopPropagation();
      await toggleWatch(rm.dataset.remove);
      load();
      return;
    }
    const ed = e.target.closest("[data-edit]");
    if (ed) {
      e.stopPropagation();
      editing = cards.find((c) => c.hash_name === ed.dataset.edit);
      if (!editing) return;
      const round = (v) => (v ? toDisplay(v).toFixed(2) : "");
      el.querySelector("#edit-name").textContent = `${editing.name} · 当前成交价 ${money(editing.price)}，最低挂牌 ${money(editing.ask)}`;
      el.querySelector("#f-high").value = round(editing.watch.target_high);
      el.querySelector("#f-low").value = round(editing.watch.target_low);
      el.querySelector("#f-note").value = editing.watch.note || "";
      dialog.showModal();
    }
  });

  dialog.addEventListener("close", async () => {
    if (dialog.returnValue !== "save" || !editing) return;
    const num = (id) => {
      const v = el.querySelector(id).value.trim();
      return v ? fromDisplay(v) : 0;
    };
    try {
      await api("/api/watchlist", {
        method: "POST",
        body: { name: editing.hash_name, target_high: num("#f-high"), target_low: num("#f-low"), note: el.querySelector("#f-note").value.trim() },
      });
      toast("提醒设置已保存");
      load();
    } catch (err) {
      toast(err.message);
    }
  });

  await load();
  return {
    destroy() {
      alive = false;
      clearTimeout(timer);
    },
  };
}
