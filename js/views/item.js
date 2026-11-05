// 卡牌详情：价格走势（7/30/90 天）、流动性、订单簿、异常提示
import { PriceChart } from "../chart.js";
import { STATIC, ago, api, count, count1, duration, esc, imgUrl, money, pct, sellerGets, state, store } from "../core.js";
import { chg, empty, tile, toggleWatch } from "../ui.js";

const RANGES = [
  [7, "7 天"],
  [30, "30 天"],
  [90, "90 天"],
];
const GROUP_NAMES = { book: "订单簿", overview: "24 小时成交概览", history: "成交历史" };

const SUMMARY = {
  good: "成交活跃、买卖价差小，按市价买卖基本不吃亏。",
  fair: "每天都有成交，但买卖价差不小，急着卖要让一些价。",
  poor: "成交稀少，挂出去可能要等好几天才卖掉。",
  dead: "几乎没有成交，挂牌价只是卖家的要价，很难按这个价格卖出。",
  unknown: "成交数据暂时拿不到（Steam 限流中），先参考订单簿。",
};

function depthWithin(levels, ref, side) {
  if (!levels || !ref) return null;
  let n = 0;
  for (const [p, q] of levels) {
    if (side === "sell" ? p <= ref * 1.05 : p >= ref * 0.95) n += q;
    else break;
  }
  return n;
}

export async function mount(el, { match }) {
  const name = decodeURIComponent(match[1]);
  let d = null;
  let range = store("sct-range") || 30;
  let tableView = false;
  let timer = null;
  let alive = true;
  let polls = 0;
  let sig = "";

  el.innerHTML = '<div class="empty">加载中…</div>';

  function head() {
    const watched = state.watch.has(d.hash_name);
    const game = d.appid ? `<a href="#/foil/${d.appid}">${esc(d.game || `AppID ${d.appid}`)}</a>` : esc(d.game || "");
    return `<div class="crumbs"><a href="#/">价格排行</a> / ${d.appid ? `<a href="#/foil/${d.appid}">${esc(d.game || "游戏")}</a> / ` : ""}${esc(d.name)}</div>
      <section class="panel">
        <div class="item-head">
          <div class="item-art${d.foil ? " foil" : ""}">${d.icon ? `<img src="${esc(imgUrl(d.icon, "360fx360f"))}" alt="" data-fallback="1">` : ""}</div>
          <div class="item-title">
            <h1>${esc(d.name)}</h1>
            <div class="meta">${d.foil ? '<span class="tag foil">闪亮卡</span>' : '<span class="tag">普通卡</span>'}
              ${game}${d.appid ? `<span>AppID ${d.appid}</span>` : ""}</div>
            <div class="fresh" id="fresh"></div>
          </div>
          <div class="item-actions">
            <button class="btn${watched ? " primary" : ""}" id="watch-btn">${watched ? "★ 已关注" : "☆ 关注"}</button>
            <a class="btn" href="${esc(d.url)}" target="_blank" rel="noopener">在 Steam 市场查看 ↗</a>
            ${STATIC ? "" : '<button class="btn ghost" id="refresh-btn" title="立即重新获取订单簿、成交概览和成交历史">刷新</button>'}
          </div>
        </div>
        <div class="callouts" id="callouts"></div>
      </section>
      <div class="tiles" id="tiles" style="margin-top:16px"></div>
      <section class="panel" style="margin-top:16px">
        <div class="panel-head"><h2>价格走势</h2>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <div class="seg" id="range">${RANGES.map(([v, l]) => `<button type="button" data-v="${v}" class="${v === range ? "on" : ""}">${l}</button>`).join("")}</div>
            <button class="btn small ghost" id="table-btn">表格</button></div></div>
        <div class="chart-box" id="chart"></div>
        <div id="chart-table" class="hidden"></div>
        <p class="foot-note" id="chart-note"></p>
      </section>
      <div class="grid-2">
        <section class="panel" id="liq"></section>
        <section class="panel" id="book"></section>
      </div>`;
  }

  function freshness() {
    const parts = [
      ["book", d.book_at],
      ["overview", d.ov_at],
      ["history", d.hist_at],
    ].map(([g, at]) => {
      if (d.pending.includes(g)) {
        const blocked = d.limits[g];
        return `<span class="busy">${GROUP_NAMES[g]}：${blocked > 0 ? `Steam 限流中，约 ${duration(blocked)}后自动重试` : "正在获取…"}</span>`;
      }
      return `<span>${GROUP_NAMES[g]}：${at ? ago(at) : "暂无"}</span>`;
    });
    el.querySelector("#fresh").innerHTML = parts.join("");
  }

  function callouts() {
    const box = el.querySelector("#callouts");
    const list = d.anomalies || [];
    if (!list.length) {
      box.innerHTML = "";
      return;
    }
    const icon = { alert: "!", warn: "!", info: "i" };
    box.innerHTML = list
      .map((a) => {
        let extra = "";
        if (a.code === "ask_high" || a.code === "ask_low") extra = `（最低挂牌 ${money(d.ask)}，成交价 ${money(d.price)}，相差 ${pct(a.pct)}）`;
        else if (a.code === "swing") extra = `（${pct(a.pct)}）`;
        else if (a.code === "wide_spread") extra = `（价差 ${pct(a.pct, 0).replace("+", "")}）`;
        else if (a.code === "volume_spike") extra = `（约为平时的 ${a.ratio.toFixed(1)} 倍）`;
        else if (a.value) extra = `（目标价 ${money(a.value)}）`;
        return `<div class="callout ${esc(a.level)}"><span class="ico">${icon[a.level] || "i"}</span>
          <div><b>${esc(a.title)}</b> <span class="detail">${esc(a.detail)}${extra}</span></div></div>`;
      })
      .join("");
  }

  function tiles() {
    const busy = (g) => d.pending.includes(g);
    const daily = d.vol["7d"] != null ? d.vol["7d"] / 7 : null;
    const priceFoot =
      d.price != null
        ? `24h ${chg(d.chg["1d"])} · 7 天 ${chg(d.chg["7d"])}`
        : d.stats_src
          ? "暂无成交"
          : "等待成交数据";
    el.querySelector("#tiles").innerHTML = [
      tile("成交价 · 近 24 小时", money(d.price), priceFoot, busy("history") || busy("overview")),
      tile("最低挂牌价（立即买入）", money(d.ask), d.listings != null ? `在售 ${count(d.listings)} 件` : "", busy("book")),
      tile("最高求购价（立即卖出）", money(d.bid), d.buy_orders != null ? `求购 ${count(d.buy_orders)} 件` : "", busy("book")),
      tile(
        "近 24 小时成交",
        d.vol["1d"] != null ? `${count(d.vol["1d"])} 笔` : "—",
        daily != null ? `近 7 日日均 ${count1(daily)} 笔` : d.vol["1d"] == null ? "成交数据暂缺" : "",
        busy("history") || busy("overview"),
      ),
    ].join("");
  }

  const chartBox = () => el.querySelector("#chart");
  let chart = null;

  function renderChart() {
    if (!chart) chart = new PriceChart(chartBox());
    chart.range = range;
    chart.set({ sales: d.sales, med24: d.snaps.med24, asks: d.snaps.ask, bids: d.snaps.bid });
    const mode = chart.S ? chart.S.mode : "none";
    const notes = {
      steam: `成交价是 Steam 每${range <= 7 ? "小时" : "天"}的成交中位价，下方柱子是成交笔数；最低挂牌价和最高求购价来自本地定时采集，用来对比「要价」和「实际成交」。`,
      local: "Steam 成交历史暂时拿不到（限流中），图中是本地每隔几小时采集的 24 小时成交中位价，以及最低挂牌价/最高求购价。本地运行越久越完整。",
      ask: "Steam 的成交数据暂时拿不到（限流中），先显示本地采集的最低挂牌价和最高求购价——它们是买卖双方的报价，不是成交价。拿到成交数据后会自动补上。",
      none: "",
    };
    el.querySelector("#chart-note").textContent = notes[mode];
    if (tableView) el.querySelector("#chart-table").innerHTML = chart.tableHtml();
  }

  function liquidity() {
    const L = d.liquidity;
    const spread = L.spread;
    const sellNow = d.bid ? sellerGets(d.bid) : null;
    const listNet = d.ask ? sellerGets(d.ask) : null;
    const book = d.book;
    const dSell = book ? depthWithin(book.sells, d.ask, "sell") : null;
    const dBuy = book ? depthWithin(book.buys, d.bid, "buy") : null;
    const rows = [
      ["立即买入（最低挂牌价）", money(d.ask), d.listings != null ? `在售 ${count(d.listings)} 件` : ""],
      ["立即卖出（最高求购价）", money(d.bid), sellNow != null ? `扣手续费到手 ${money(sellNow)}` : ""],
      ["买卖价差", spread != null ? pct(spread).replace("+", "") : "—", spread != null ? "（最低挂牌 − 最高求购）÷ 最低挂牌" : ""],
      ["近 24 小时实际成交", d.vol["1d"] != null ? `${count(d.vol["1d"])} 笔` : "暂缺", d.med24 != null ? `Steam 统计中位价 ${money(d.med24)}` : ""],
      ["近 7 日日均成交", d.vol["7d"] != null ? `${count1(d.vol["7d"] / 7)} 笔` : "暂缺", ""],
      ["按最低价挂出到手", listNet != null ? money(listNet) : "—", listNet != null ? `手续费 ${money(d.ask - listNet)}` : ""],
      ["±5% 价位内的挂单", dSell != null || dBuy != null ? `卖 ${count(dSell)} · 买 ${count(dBuy)}` : "—", ""],
    ];
    el.querySelector("#liq").innerHTML = `<div class="panel-head"><h2>流动性</h2></div>
      <div class="liq-head"><span class="liq ${esc(L.grade)}"><span class="dot"></span>${esc(L.label)}</span></div>
      <p class="liq-summary">${SUMMARY[L.grade] || ""}${L.estimated && L.grade !== "unknown" ? "（成交数据缺失，按挂单情况估计）" : ""}</p>
      <dl class="kv">${rows.map(([k, v, s]) => `<dt>${k}</dt><dd>${v}${s ? `<span class="s">${s}</span>` : ""}</dd>`).join("")}</dl>
      <p class="note">挂牌价是卖家的要价，不等于成交价；想马上卖出只能按最高求购价成交。Steam 对卡牌收取约 15% 手续费（平台 5% + 游戏开发商 10%，各自最少 ${state.display.symbol}0.01），所以「到手价」会比售价低。</p>`;
  }

  function orderBook() {
    const box = el.querySelector("#book");
    const book = d.book;
    if (!book) {
      box.innerHTML = `<div class="panel-head"><h2>订单簿</h2></div>${empty(d.pending.includes("book") ? "正在获取订单簿…" : "暂无订单簿数据")}`;
      return;
    }
    const side = (levels, cls) => {
      const top = (levels || []).slice(0, 10);
      const max = Math.max(1, ...top.map((l) => l[1]));
      return `<table class="${cls}"><thead><tr><th>价格</th><th>数量</th></tr></thead><tbody>${
        top.length
          ? top
              .map(
                ([p, q]) => `<tr><td><span>${money(p)}</span></td><td><span class="bar" style="width:${Math.max(4, (q / max) * 100)}%"></span><span>${count(q)}</span></td></tr>`,
              )
              .join("")
          : '<tr><td colspan="2" class="muted">没有挂单</td></tr>'
      }</tbody></table>`;
    };
    box.innerHTML = `<div class="panel-head"><h2>订单簿</h2><span class="hint">${d.book_at ? `更新于 ${ago(d.book_at)}` : ""}</span></div>
      <div class="book">
        <div><h3><span>卖单（挂牌）</span><span class="muted">${count(d.listings)} 件</span></h3>${side(book.sells, "sell")}</div>
        <div><h3><span>买单（求购）</span><span class="muted">${count(d.buy_orders)} 件</span></h3>${side(book.buys, "buy")}</div>
      </div>
      <p class="note">卖单从低到高、买单从高到低，各显示最靠近成交的 10 档。两边差得越远，说明越难按理想价格成交。</p>`;
  }

  function renderAll() {
    const first = !el.querySelector("#tiles");
    if (first) {
      el.innerHTML = head();
      bind();
    } else {
      const btn = el.querySelector("#watch-btn");
      const watched = state.watch.has(d.hash_name);
      btn.textContent = watched ? "★ 已关注" : "☆ 关注";
      btn.classList.toggle("primary", watched);
    }
    freshness();
    callouts();
    tiles();
    renderChart();
    liquidity();
    orderBook();
  }

  function bind() {
    el.querySelector("#range").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      range = Number(b.dataset.v);
      store("sct-range", range);
      for (const x of el.querySelectorAll("#range button")) x.classList.toggle("on", x === b);
      chart.setRange(range);
      renderChart();
    });
    el.querySelector("#table-btn").addEventListener("click", (e) => {
      tableView = !tableView;
      e.target.textContent = tableView ? "图表" : "表格";
      chartBox().classList.toggle("hidden", tableView);
      el.querySelector("#chart-table").classList.toggle("hidden", !tableView);
      if (tableView) el.querySelector("#chart-table").innerHTML = chart.tableHtml();
    });
    el.querySelector("#refresh-btn")?.addEventListener("click", () => {
      polls = 0;
      load(true);
    });
    el.querySelector("#watch-btn").addEventListener("click", async (e) => {
      e.stopPropagation();
      e.preventDefault();
      await toggleWatch(d.hash_name);
      load(false);
    });
  }

  async function load(refresh) {
    clearTimeout(timer);
    try {
      const data = await api("/api/item", { params: { name, refresh: refresh ? 1 : undefined } });
      if (!alive) return;
      const next = JSON.stringify([data.book_at, data.ov_at, data.hist_at, data.ask_at, data.pending, data.limits, data.watched]);
      d = data;
      if (data.watched) state.watch.add(data.hash_name);
      if (next !== sig || refresh) renderAll();
      else freshness();
      sig = next;
    } catch (e) {
      if (!d) el.innerHTML = empty("打不开这张卡牌", esc(e.message), '<a class="btn" href="#/">返回排行榜</a>');
      return;
    }
    // 后台还在刷新时轮询：前 2 分钟每 2.5 秒，之后每 15 秒
    if (d.pending.length) {
      polls += 1;
      timer = setTimeout(() => load(false), polls > 48 ? 15000 : 2500);
    }
  }

  await load(false);
  return {
    destroy() {
      alive = false;
      clearTimeout(timer);
      chart?.destroy();
    },
  };
}
