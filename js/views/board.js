// 价格排行榜：涨幅榜 / 跌幅榜 / 成交价最高 / 挂牌价最高
import { sparkline } from "../chart.js";
import { STATIC, ago, api, count1, duration, esc, every, fromDisplay, itemHref, money, state, store } from "../core.js";
import { cardCell, chg, empty, liq, star } from "../ui.js";

const BOARDS = [
  ["gainers", "涨幅榜"],
  ["losers", "跌幅榜"],
  ["price", "成交价最高"],
  ["ask", "挂牌价最高"],
];
const PERIODS = [
  ["1d", "24 小时"],
  ["7d", "7 天"],
  ["30d", "30 天"],
];
const KINDS = [
  ["all", "全部"],
  ["normal", "普通卡"],
  ["foil", "闪卡"],
];
const BASES = [
  ["sale", "按成交价"],
  ["ask", "按挂牌价"],
];
const MIN_PRICE = { CNY: [0, 0.5, 1, 5, 20, 100], USD: [0, 0.1, 0.25, 1, 5, 20] };
const MIN_DAILY = [0, 1, 3, 10, 30];

function defaults() {
  return { board: "gainers", period: "7d", kind: "all", basis: "sale", min: "2", daily: "1" };
}

function seg(name, options, value) {
  return `<div class="seg" role="group" data-seg="${name}">${options
    .map(([v, label]) => `<button type="button" data-v="${v}" class="${v === value ? "on" : ""}" aria-pressed="${v === value}">${label}</button>`)
    .join("")}</div>`;
}

function explain(f) {
  const sym = state.display.symbol;
  const minList = MIN_PRICE[state.display.currency] || MIN_PRICE.USD;
  const min = minList[Number(f.min)] || 0;
  const period = PERIODS.find((p) => p[0] === f.period)[1];
  if (f.board === "price") return "按近 24 小时成交中位价排序，只看真实成交过的卡牌。想看卖家挂出的最高要价，切到「挂牌价最高」。";
  if (f.board === "ask") return "Steam 上挂牌价最高的卡牌。很多只是单张高价挂单、长期无人接手——对照成交价和流动性判断真实价值。";
  if (f.basis === "ask") return `按本地记录的最低挂牌价对比 ${period}前计算，只统计在售至少 5 件的卡。挂牌价是卖家要价，波动比成交价大，适合在成交数据缺失时参考。`;
  return `涨跌 = 近 24 小时成交中位价（按成交笔数加权）对比 ${period}前同一时段。${min ? `已过滤 ${sym}${min} 以下` : "未过滤低价卡"}${Number(f.daily) ? `、日均成交不足 ${MIN_DAILY[Number(f.daily)]} 笔` : ""}的卡牌——低价卡 1 分钱的波动就是几十个百分点。`;
}

export async function mount(el, { params }) {
  const saved = store("sct-board") || {};
  const f = { ...defaults(), ...saved };
  for (const k of Object.keys(defaults())) if (params.get(k)) f[k] = params.get(k);
  let timer = null;
  let alive = true;

  el.innerHTML = `
    <div class="page-head"><div><h1>价格排行</h1>
      <p class="sub">追踪 Steam 社区市场的集换式卡牌，看哪些卡在涨、在跌、最值钱——并且分清「挂牌价」和「真实成交价」。</p></div></div>
    <div class="filters" id="f-row"></div>
    <section class="panel"><p class="muted small" id="explain" style="margin-bottom:10px"></p><div id="board-body"></div></section>
    <p class="foot-note" id="coverage"></p>`;

  const row = el.querySelector("#f-row");
  const body = el.querySelector("#board-body");

  function renderFilters() {
    const priceOpts = MIN_PRICE[state.display.currency] || MIN_PRICE.USD;
    const moving = f.board === "gainers" || f.board === "losers";
    row.innerHTML = `${seg("board", BOARDS, f.board)}
      ${moving ? seg("period", PERIODS, f.period) : ""}
      ${seg("kind", KINDS, f.kind)}
      ${moving ? seg("basis", BASES, f.basis) : ""}
      <label>最低价 <select data-sel="min">${priceOpts
        .map((v, i) => `<option value="${i}" ${String(i) === f.min ? "selected" : ""}>${v ? `≥ ${state.display.symbol}${v}` : "不限"}</option>`)
        .join("")}</select></label>
      <label>日均成交 <select data-sel="daily">${MIN_DAILY.map(
        (v, i) => `<option value="${i}" ${String(i) === f.daily ? "selected" : ""}>${v ? `≥ ${v} 笔` : "不限"}</option>`,
      ).join("")}</select></label>`;
    el.querySelector("#explain").textContent = explain(f);
  }

  function sync() {
    store("sct-board", f);
    const qs = new URLSearchParams(f).toString();
    history.replaceState(null, "", `#/?${qs}`);
  }

  async function load() {
    clearTimeout(timer);
    body.style.opacity = body.innerHTML ? "0.5" : "1";
    const priceOpts = MIN_PRICE[state.display.currency] || MIN_PRICE.USD;
    let data;
    try {
      data = await api("/api/leaderboard", {
        params: {
          board: f.board,
          period: f.period,
          kind: f.kind,
          basis: f.basis,
          min_price: fromDisplay(priceOpts[Number(f.min)] || 0),
          min_daily: MIN_DAILY[Number(f.daily)] || 0,
          limit: 50,
        },
      });
    } catch (e) {
      body.innerHTML = empty("加载失败", esc(e.message));
      body.style.opacity = "1";
      return;
    }
    if (!alive) return;
    body.style.opacity = "1";
    renderTable(data);
    const cov = data.coverage;
    const basisName = f.basis === "ask" && (f.board === "gainers" || f.board === "losers") ? "挂牌价" : "成交价";
    const counts = cov.items
      ? `共收录 ${cov.items.toLocaleString()} 张卡牌，其中 ${cov.with_price.toLocaleString()} 张有成交价、${cov.with_change.toLocaleString()} 张有该周期的${basisName}涨跌数据。`
      : "";
    el.querySelector("#coverage").innerHTML = !counts
      ? ""
      : STATIC
        ? `${counts}数据${ago(state.status.generated_at)}更新，约${every(state.status.interval_min)}更新一次。<a href="#/status">关于本站</a>`
        : `本地${counts}后台每轮会扫描热门卡和高价卡，覆盖面会随运行时间增加。<a href="#/status">查看采集进度</a>`;
    // 冷启动时每 20 秒刷新一次，直到有数据
    if (!data.cards.length && !STATIC) timer = setTimeout(load, 20000);
  }

  function renderTable(data) {
    const moving = f.board === "gainers" || f.board === "losers";
    const askBasis = moving && f.basis === "ask";
    if (!data.cards.length) {
      const sw = state.status?.workers?.search;
      const progress = sw && sw.cycle_total ? Math.round(((sw.cycle_total - sw.cycle_left) / sw.cycle_total) * 100) : 0;
      if (!data.coverage.items && STATIC) {
        body.innerHTML = empty("还没有数据", "站长的电脑还没有发布行情数据，过一会儿再来看看。");
        return;
      }
      if (!data.coverage.items) {
        const blocked = sw ? sw.pacer.blocked_for : 0;
        body.innerHTML = empty(
          blocked > 0 ? "Steam 暂时拒绝了卡牌搜索请求" : "正在从 Steam 采集数据…",
          blocked > 0
            ? `搜索接口返回 429（请求太频繁），程序会自动等待，约 ${duration(blocked)}后重试，不需要手动操作。<br>如果长时间都这样，可以在「数据状态」里调大请求间隔或减少每轮扫描页数。`
            : `首次启动需要几分钟：先扫描热门卡牌（当前进度 ${progress}%），再逐张拉取订单簿和成交记录。<br>页面会自动刷新。`,
          '<a class="btn" href="#/status">查看采集进度</a>',
        );
        return;
      }
      const tips = [];
      if (moving && f.basis === "sale") tips.push('<button class="btn" data-act="basis-ask">改用挂牌价口径</button>');
      tips.push('<button class="btn" data-act="loosen">放宽筛选条件</button>');
      body.innerHTML = empty(
        "暂时没有满足条件的卡牌",
        moving
          ? "涨跌需要有足够的历史：Steam 成交历史拿到后马上就能算；如果成交接口被限流，本地快照要积累满一个周期（比如 24 小时）才会出现。"
          : "成交价需要 Steam 的成交数据，后台正在陆续获取。",
        `<div style="display:flex;gap:8px;justify-content:center">${tips.join("")}</div>`,
      );
      return;
    }
    const periodLabel = PERIODS.find((p) => p[0] === f.period)[1];
    const head =
      f.board === "ask"
        ? '<th class="rank hide-sm">#</th><th class="l">卡牌</th><th>最低挂牌价</th><th>成交价</th><th class="hide-sm">在售</th><th class="hide-sm">日均成交</th><th class="l hide-sm">流动性</th><th></th>'
        : `<th class="rank hide-sm">#</th><th class="l">卡牌</th><th>${askBasis ? "最低挂牌价" : "成交价"}</th><th>${moving ? periodLabel : "7 天"}涨跌</th>
           <th class="c hide-sm">近 ${data.spark_days} 天</th><th class="hide-sm">日均成交</th><th class="hide-sm">在售</th><th class="l hide-sm">流动性</th><th></th>`;
    const rows = data.cards
      .map((c, i) => {
        const daily = c.liquidity.daily_volume;
        const change = moving ? (askBasis ? c.achg : c.chg)[f.period] : c.chg["7d"];
        if (f.board === "ask") {
          return `<tr data-href="${itemHref(c.hash_name)}"><td class="rank hide-sm">${i + 1}</td><td class="l">${cardCell(c)}</td>
            <td><b>${money(c.ask)}</b></td><td class="${c.price ? "" : "muted"}">${money(c.price, "无成交")}</td>
            <td class="hide-sm">${c.listings ?? "—"}</td><td class="hide-sm">${count1(daily)}</td><td class="l hide-sm">${liq(c.liquidity)}</td><td>${star(c)}</td></tr>`;
        }
        return `<tr data-href="${itemHref(c.hash_name)}"><td class="rank hide-sm">${i + 1}</td><td class="l">${cardCell(c)}</td>
          <td><b>${money(askBasis ? c.ask : c.price)}</b></td><td>${chg(change)}</td>
          <td class="c hide-sm">${sparkline(c.spark)}</td><td class="hide-sm">${count1(daily)}</td><td class="hide-sm">${c.listings ?? "—"}</td>
          <td class="l hide-sm">${liq(c.liquidity)}</td><td>${star(c)}</td></tr>`;
      })
      .join("");
    body.innerHTML = `<div class="table-wrap"><table class="data"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>
      <p class="foot-note">流动性带 * 的是按订单簿估计（成交数据暂缺）。点击任意一行查看走势和买卖盘。</p>`;
  }

  row.addEventListener("click", (e) => {
    const btn = e.target.closest(".seg button");
    if (!btn) return;
    const key = btn.parentElement.dataset.seg;
    const wasMoving = f.board === "gainers" || f.board === "losers";
    f[key] = btn.dataset.v;
    if (key === "basis") f.daily = f.basis === "ask" ? "0" : "1";
    if (key === "board") {
      const moving = f.board === "gainers" || f.board === "losers";
      if (!moving) {
        f.min = "0";
        f.daily = f.board === "price" ? "1" : "0";
      } else if (!wasMoving) {
        f.min = "2";
        f.daily = f.basis === "ask" ? "0" : "1";
      }
    }
    renderFilters();
    sync();
    load();
  });
  row.addEventListener("change", (e) => {
    const sel = e.target.closest("[data-sel]");
    if (!sel) return;
    f[sel.dataset.sel] = sel.value;
    renderFilters();
    sync();
    load();
  });
  body.addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]");
    if (!act) return;
    if (act.dataset.act === "basis-ask") {
      f.basis = "ask";
      f.daily = "0";
    } else {
      f.min = "0";
      f.daily = "0";
    }
    renderFilters();
    sync();
    load();
  });

  renderFilters();
  sync();
  await load();
  return {
    destroy() {
      alive = false;
      clearTimeout(timer);
    },
    onStatus() {},
  };
}
