// 闪卡专区：热门闪卡、按游戏搜索、某个游戏的整套闪卡与合成成本
import { STATIC, ago, api, debounce, esc, itemHref, money } from "../core.js";
import { cardCell, cardTile, empty, star, tile } from "../ui.js";

const SORTS = [
  ["popular", "热度"],
  ["price", "成交价"],
  ["ask", "挂牌价"],
  ["change", "7 天涨幅"],
  ["listings", "在售数量"],
];

export async function mount(el, { match }) {
  return match[1] ? gamePage(el, Number(match[1])) : home(el);
}

function gameName(g) {
  if (g.name_cn && g.name && g.name_cn !== g.name) return `${g.name_cn}（${g.name}）`;
  return g.name_cn || g.name || `AppID ${g.appid}`;
}

function bindGameSearch(root) {
  const input = root.querySelector("input");
  const pop = root.querySelector(".pop");
  let results = [];
  let sel = -1;
  let seq = 0;

  const close = () => {
    pop.classList.add("hidden");
    sel = -1;
  };
  const go = (g) => {
    if (g) location.hash = `#/foil/${g.appid}`;
  };
  const paint = (warning) => {
    if (!results.length) {
      pop.innerHTML = `<div class="empty" style="padding:12px">${warning ? esc(warning) : "没有找到这个游戏。可以试试英文名或 AppID。"}</div>`;
    } else {
      pop.innerHTML = results
        .map(
          (g, i) => `<a class="opt${i === sel ? " sel" : ""}" data-i="${i}" href="#/foil/${g.appid}">
          <div class="grow"><div class="t">${esc(gameName(g))}</div>
          <div class="s">AppID ${g.appid}${g.foils ? ` · 已收录 ${g.foils} 张闪卡` : STATIC ? " · 还没有收录闪卡" : " · 点开后从 Steam 实时获取"}</div></div></a>`,
        )
        .join("");
    }
    pop.classList.remove("hidden");
  };
  const search = debounce(async () => {
    const q = input.value.trim();
    if (!q) return close();
    const my = ++seq;
    pop.innerHTML = '<div class="empty" style="padding:12px">搜索中…</div>';
    pop.classList.remove("hidden");
    try {
      const data = await api("/api/games", { params: { q } });
      if (my !== seq) return;
      results = data.games;
      sel = results.length ? 0 : -1;
      paint(data.warning);
    } catch (e) {
      results = [];
      paint(e.message);
    }
  }, 300);

  input.addEventListener("input", search);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!results.length) return;
      e.preventDefault();
      sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + results.length) % results.length;
      paint();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (/^\d+$/.test(input.value.trim())) return go({ appid: input.value.trim() });
      go(results[Math.max(sel, 0)]);
    } else if (e.key === "Escape") close();
  });
  document.addEventListener("click", (e) => {
    if (!root.contains(e.target)) close();
  });
}

async function home(el) {
  let sort = "popular";
  let offset = 0;
  el.innerHTML = `
    <div class="page-head"><div><h1>闪卡专区</h1>
      <p class="sub">闪亮集换式卡牌（Foil Trading Card）是普通卡的稀有版本：合成徽章时约有 1% 的几率掉落，集齐一套能合成闪亮徽章，所以价格通常是普通卡的几倍到几十倍。</p></div></div>
    <section class="panel">
      <div class="game-search"><input type="search" placeholder="按游戏搜索：中文名、英文名或 AppID，例如 传送门 2 / Portal 2 / 620" aria-label="按游戏搜索闪卡"><div class="pop hidden"></div></div>
      <div class="chips" id="top-games" style="margin-top:14px"></div>
    </section>
    <section class="panel">
      <div class="panel-head"><h2>热门闪卡</h2>
        <label class="muted small">排序 <select id="sort">${SORTS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></label></div>
      <div class="cards-grid" id="grid"></div>
      <div style="text-align:center;margin-top:16px"><button class="btn hidden" id="more">加载更多</button></div>
    </section>`;
  bindGameSearch(el.querySelector(".game-search"));
  const grid = el.querySelector("#grid");
  const more = el.querySelector("#more");

  async function load(reset) {
    if (reset) {
      offset = 0;
      grid.style.opacity = grid.innerHTML ? "0.5" : "1";
    }
    const data = await api("/api/cards", { params: { foil: 1, sort, limit: 48, offset } });
    grid.style.opacity = "1";
    const html = data.cards.map(cardTile).join("");
    if (reset) grid.innerHTML = html || empty("还没有收录闪卡", "后台正在扫描热门闪卡，几分钟后再来看看；也可以直接在上面搜索某个游戏。");
    else grid.insertAdjacentHTML("beforeend", html);
    offset += data.cards.length;
    more.classList.toggle("hidden", offset >= data.total);
  }

  el.querySelector("#sort").addEventListener("change", (e) => {
    sort = e.target.value;
    load(true);
  });
  more.addEventListener("click", () => load(false));

  api("/api/games", { params: { top: 1 } })
    .then((data) => {
      const box = el.querySelector("#top-games");
      if (!data.games.length) return;
      box.innerHTML =
        '<span class="muted small" style="align-self:center">收录闪卡最多的游戏：</span>' +
        data.games
          .map((g) => `<a class="chip" href="#/foil/${g.appid}">${esc(g.name_cn || g.name)}<span class="n">${g.foils}</span></a>`)
          .join("");
    })
    .catch(() => {});
  await load(true);
  return {};
}

async function gamePage(el, appid) {
  el.innerHTML = `<div class="crumbs"><a href="#/foil">闪卡专区</a> / <span id="crumb">AppID ${appid}</span></div>
    <div class="page-head"><div><h1 id="g-title">加载中…</h1><p class="sub" id="g-sub"></p></div>
      ${STATIC ? "" : '<div><button class="btn" id="refresh">刷新价格</button></div>'}</div>
    <div id="warn"></div>
    <div class="tiles" id="set-tiles"></div>
    <section class="panel" style="margin-top:16px"><div class="panel-head"><h2 id="foil-h">闪卡</h2><span class="hint" id="foil-hint"></span></div>
      <div class="cards-grid" id="foil-grid"><div class="empty">${STATIC ? "加载中…" : "正在从 Steam 获取这款游戏的闪卡…"}</div></div></section>
    <section class="panel"><div class="panel-head"><h2 id="normal-h">普通卡</h2><span class="hint" id="normal-hint"></span></div>
      <div id="normal-list"><div class="empty">稍后加载…</div></div></section>`;

  let foil = null;
  let normal = null;
  const warnings = new Set();

  function renderHead() {
    const g = foil || normal || {};
    const title = g.name_cn || g.name || `AppID ${appid}`;
    el.querySelector("#g-title").textContent = title;
    el.querySelector("#crumb").textContent = title;
    el.querySelector("#g-sub").innerHTML = `${g.name_cn && g.name && g.name !== g.name_cn ? `${esc(g.name)} · ` : ""}AppID ${appid} ·
      <a href="https://store.steampowered.com/app/${appid}" target="_blank" rel="noopener">Steam 商店页 ↗</a> ·
      <a href="https://steamcommunity.com/market/search?appid=753&category_753_Game%5B%5D=tag_app_${appid}" target="_blank" rel="noopener">Steam 市场 ↗</a>`;
    el.querySelector("#warn").innerHTML = [...warnings].map((w) => `<div class="banner">${esc(w)}</div>`).join("");
  }

  function renderTiles() {
    const t = [];
    const fc = foil ? foil.cards.length : null;
    const nc = normal ? normal.cards.length : null;
    const missing = (part) => part.cards.filter((c) => !c.ask).length;
    const none = STATIC ? "网页版还没有收录" : "没有找到";
    // 网页版只有采集到的卡：这套卡在本地版里没完整拉取过，就不能叫「全套」
    const partial = (part) => part?.complete === false;
    t.push(
      tile(
        `${partial(foil) ? "已收录的闪卡" : "闪卡全套"}${fc ? `（${fc} 张）` : ""}`,
        foil && fc ? money(foil.set_cost) : "—",
        foil && fc
          ? partial(foil)
            ? "按最低挂牌价合计，这套卡可能没收录全"
            : foil.set_complete
              ? "按最低挂牌价，合成闪亮徽章的成本"
              : `有 ${missing(foil)} 张暂无在售，未计入`
          : foil
            ? none
            : "获取中…",
        !foil,
      ),
    );
    t.push(
      tile(
        `${partial(normal) ? "已收录的普通卡" : "普通卡全套"}${nc ? `（${nc} 张）` : ""}`,
        normal && nc ? money(normal.set_cost) : "—",
        normal && nc
          ? partial(normal)
            ? "按最低挂牌价合计，这套卡可能没收录全"
            : normal.set_complete
              ? "合成 1 级普通徽章的成本"
              : `有 ${missing(normal)} 张暂无在售`
          : normal
            ? none
            : "获取中…",
        !normal,
      ),
    );
    const whole = !partial(foil) && !partial(normal);
    const ratio = whole && foil && normal && foil.set_cost && normal.set_cost ? foil.set_cost / normal.set_cost : null;
    t.push(tile("闪卡溢价", ratio ? `×${ratio.toFixed(ratio >= 10 ? 0 : 1)}` : "—", whole ? "闪卡全套 ÷ 普通卡全套" : "两套卡都收录全才能算"));
    const top = foil && fc ? [...foil.cards].sort((a, b) => (b.ask || 0) - (a.ask || 0))[0] : null;
    t.push(tile("最贵的闪卡", top ? money(top.ask) : "—", top ? esc(top.name) : ""));
    el.querySelector("#set-tiles").innerHTML = t.join("");
  }

  function renderFoil() {
    const grid = el.querySelector("#foil-grid");
    el.querySelector("#foil-h").textContent = `闪卡（${foil.cards.length} 张）`;
    el.querySelector("#foil-hint").textContent = foil.fetched_at && !STATIC ? `价格更新于 ${ago(foil.fetched_at)}` : "";
    grid.innerHTML = foil.cards.length
      ? foil.cards.map(cardTile).join("")
      : STATIC
        ? empty("网页版还没有收录这款游戏的闪卡", "网页版只有站长的电脑采集到的卡牌。")
        : empty("这款游戏没有闪卡", "可能没有集换式卡牌，或者 AppID 不对。");
  }

  function renderNormal() {
    const box = el.querySelector("#normal-list");
    el.querySelector("#normal-h").textContent = `普通卡（${normal.cards.length} 张）`;
    el.querySelector("#normal-hint").textContent = normal.fetched_at && !STATIC ? `价格更新于 ${ago(normal.fetched_at)}` : "";
    if (!normal.cards.length) {
      box.innerHTML = empty(STATIC ? "网页版还没有收录这款游戏的普通卡" : "没有普通卡数据");
      return;
    }
    box.innerHTML = `<div class="table-wrap"><table class="data"><thead><tr><th class="l">卡牌</th><th>最低挂牌价</th><th>成交价</th><th>在售</th><th></th></tr></thead><tbody>
      ${normal.cards
        .map(
          (c) => `<tr data-href="${itemHref(c.hash_name)}"><td class="l">${cardCell(c)}</td><td><b>${money(c.ask)}</b></td>
        <td class="${c.price ? "" : "muted"}">${money(c.price, "—")}</td><td>${c.listings ?? "—"}</td><td>${star(c)}</td></tr>`,
        )
        .join("")}</tbody></table></div>`;
  }

  async function load(refresh) {
    warnings.clear();
    try {
      foil = await api("/api/game", { params: { appid, part: "foil", refresh: refresh ? 1 : undefined } });
      if (foil.warning) warnings.add(foil.warning);
      renderHead();
      renderFoil();
      renderTiles();
    } catch (e) {
      el.querySelector("#foil-grid").innerHTML = empty("获取失败", esc(e.message));
    }
    try {
      normal = await api("/api/game", { params: { appid, part: "normal", refresh: refresh ? 1 : undefined } });
      if (normal.warning) warnings.add(normal.warning);
      renderHead();
      renderNormal();
      renderTiles();
    } catch (e) {
      el.querySelector("#normal-list").innerHTML = empty("获取失败", esc(e.message));
    }
  }

  el.querySelector("#refresh")?.addEventListener("click", async (e) => {
    e.target.disabled = true;
    e.target.textContent = "刷新中…";
    await load(true);
    e.target.disabled = false;
    e.target.textContent = "刷新价格";
  });
  renderTiles();
  await load(false);
  return {};
}

