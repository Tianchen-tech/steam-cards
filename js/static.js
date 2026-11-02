// 网页版（发布到 GitHub Pages 的只读版本）的数据接口：没有本地服务，按本地服务 /api/... 的返回格式，
// 从定时导出的 data/*.json 里算出结果。排行榜的筛选条件和 sct/api.py 里的 SQL 一一对应。
// 关注列表保存在访客自己的浏览器里（localStorage）。
import { store } from "./core.js";

const DATA = new URL("../data/", import.meta.url);
const META_TTL = 5 * 60 * 1000; // 每 5 分钟检查一次有没有发布新数据
const WATCH_KEY = "sct-watch";

let meta = null;
let metaAt = 0;
let cards = [];
let byName = new Map();
let games = new Map();
let foilCount = new Map();
let loading = null;

function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function getJson(path, init) {
  const res = await fetch(new URL(path, DATA), init);
  if (!res.ok) throw fail(res.status, res.status === 404 ? "没有找到这份数据" : `加载数据失败（HTTP ${res.status}）`);
  return res.json();
}

async function refresh() {
  const m = await getJson("meta.json", { cache: "no-cache" });
  if (!meta || m.version !== meta.version) {
    // 文件名带上版本号：GitHub Pages 会缓存 10 分钟，换了版本就绕过旧缓存
    const [c, g] = await Promise.all([getJson(`cards.json?v=${m.version}`), getJson(`games.json?v=${m.version}`)]);
    cards = c.cards;
    byName = new Map(cards.map((x) => [x.hash_name, x]));
    games = new Map(g.games.map((x) => [x.appid, x]));
    foilCount = new Map();
    for (const x of cards) if (x.foil && x.appid != null) foilCount.set(x.appid, (foilCount.get(x.appid) || 0) + 1);
  }
  meta = m;
  metaAt = Date.now();
}

async function load() {
  if (meta && Date.now() - metaAt < META_TTL) return;
  loading ??= refresh().finally(() => {
    loading = null;
  });
  try {
    await loading;
  } catch (e) {
    if (!meta) throw e;
    metaAt = Date.now() - META_TTL + 30000; // 已经有数据就先用着，半分钟后再检查
  }
}

// ---------- 关注列表（访客自己的浏览器） ----------

const watches = () => store(WATCH_KEY) || {};

/** 和 sct/api.py 的 card_json 一样：加上关注信息，以及触发目标价的提醒（排在最前面）。 */
function withWatch(c, w) {
  if (!w) return { ...c, watched: false };
  const basis = c.price || c.ask;
  const targets = [];
  if (basis && w.target_high && basis >= w.target_high)
    targets.push({ level: "alert", code: "target_high", title: "已达到目标高价", detail: "当前成交价已高于你设置的目标价", value: w.target_high });
  if (basis && w.target_low && basis <= w.target_low)
    targets.push({ level: "alert", code: "target_low", title: "已跌到目标低价", detail: "当前成交价已低于你设置的目标价", value: w.target_low });
  return {
    ...c,
    watched: true,
    anomalies: [...targets, ...(c.anomalies || [])],
    watch: {
      added_at: w.added_at,
      added_price: w.added_price,
      note: w.note ?? null,
      target_high: w.target_high ?? null,
      target_low: w.target_low ?? null,
      since_added: basis && w.added_price ? basis / w.added_price - 1 : null,
    },
  };
}

function present(list) {
  const w = watches();
  return list.map((c) => withWatch(c, w[c.hash_name]));
}

// ---------- 排序（和 SQL 的 ORDER BY 一致：NULL 排最后） ----------

const desc = (get) => (a, b) => {
  const x = get(a);
  const y = get(b);
  if (x == null || y == null) return (x == null) - (y == null);
  return y - x;
};
const asc = (get) => (a, b) => {
  const x = get(a);
  const y = get(b);
  if (x == null || y == null) return (x == null) - (y == null);
  return x - y;
};
// rank IS NULL, rank, listings DESC
const byRank = (a, b) => asc((c) => c.rank)(a, b) || desc((c) => c.listings)(a, b);
const SORTS = {
  popular: byRank,
  price: desc((c) => c.price),
  ask: desc((c) => c.ask),
  change: desc((c) => c.chg["7d"]),
  listings: desc((c) => c.listings),
};

const has = (s, term) => s != null && String(s).toLowerCase().includes(term);
// 和 sct/api.py 的 NOISE 一样：涨跌幅绝对值比它小当作没变
const NOISE = 5e-7;
// COALESCE(vol7 / 7.0, vol1, vol24, 0)
const daily = (c) => (c.vol["7d"] != null ? c.vol["7d"] / 7 : c.vol["1d"] ?? c.vol24 ?? 0);
const ofKind = (kind) => (c) => (kind === "foil" ? c.foil : kind === "normal" ? !c.foil : true);

// ---------- 各个接口 ----------

function status() {
  const pref = store("sct-pref") || {};
  const d = meta.display;
  const currency = pref.currency || d.currency;
  const cny = currency === "CNY";
  return {
    static: true,
    now: Math.floor(Date.now() / 1000),
    generated_at: meta.generated_at,
    interval_min: meta.interval_min,
    display: { currency, symbol: cny ? "¥" : "$", rate: cny ? d.cny : 1, source: d.source, fx_at: d.fx_at },
    defaults: { currency: d.currency, up_color: meta.up_color },
    settings: { display_currency: currency, up_color: pref.up_color || meta.up_color },
    db: meta.counts,
  };
}

function leaderboard(q) {
  const board = q.board || "gainers";
  const period = q.period || "7d";
  const kind = q.kind || "all";
  const basis = q.basis || "sale";
  const minPrice = Number(q.min_price) || 0;
  const minDaily = Number(q.min_daily) || 0;
  const limit = Math.min(Number(q.limit) || 50, 200);
  const field = basis === "ask" ? "achg" : "chg";
  if (!["gainers", "losers", "price", "ask"].includes(board) || !["1d", "7d", "30d"].includes(period)) throw fail(400, "未知的榜单参数");
  const col = (c) => c[field][period];
  const pool = cards.filter(ofKind(kind));
  let keep;
  let order;
  if (board === "gainers" || board === "losers") {
    const up = board === "gainers";
    const sign = (c) => (up ? col(c) > NOISE : col(c) < -NOISE);
    keep =
      basis === "ask"
        ? // 挂牌价口径：至少 5 件在售
          (c) => col(c) != null && c.ask != null && c.ask >= minPrice && (c.listings ?? 0) >= 5 && (!minDaily || daily(c) >= minDaily) && sign(c)
        : (c) => col(c) != null && c.price != null && c.price >= minPrice && daily(c) >= minDaily && sign(c);
    order = up ? desc(col) : asc(col);
  } else {
    const key = board === "price" ? (c) => c.price : (c) => c.ask;
    keep = (c) => key(c) != null && key(c) >= minPrice && daily(c) >= minDaily;
    order = desc(key);
  }
  const found = pool.filter(keep).sort(order);
  const days = period === "30d" ? 30 : 7;
  const w = watches();
  return {
    cards: found.slice(0, limit).map((c) => ({ ...withWatch(c, w[c.hash_name]), spark: days === 30 ? c.s30 : c.s7, flags: (c.anomalies || []).length })),
    total: found.length,
    coverage: {
      items: pool.length,
      with_change: pool.filter((c) => col(c) != null).length,
      with_price: pool.filter((c) => c.price != null).length,
    },
    spark_days: days,
  };
}

function cardList(q) {
  let list = cards;
  if (q.foil === "0" || q.foil === "1") list = list.filter((c) => c.foil === (q.foil === "1"));
  if (q.appid) list = list.filter((c) => c.appid === Number(q.appid));
  if (q.q) {
    const term = q.q.trim().toLowerCase();
    list = list.filter((c) => has(c.name, term) || has(c.game, term) || has(c.hash_name, term));
  }
  list = [...list].sort(SORTS[q.sort] || SORTS.popular);
  const limit = Math.min(Number(q.limit) || 60, 200);
  const offset = Math.max(Number(q.offset) || 0, 0);
  return { cards: present(list.slice(offset, offset + limit)), total: list.length };
}

function gameRow(g) {
  return { appid: g.appid, name: g.name, name_cn: g.name_cn, foils: foilCount.get(g.appid) || 0 };
}

function gameList(q) {
  const term = (q.q || "").trim();
  if (!term) {
    if (q.top !== "1") return { games: [], warning: null };
    const top = new Map();
    for (const c of cards) {
      if (!c.foil || c.appid == null) continue;
      const t = top.get(c.appid) || { appid: c.appid, foils: 0, rank: Infinity, game: null };
      t.foils += 1;
      t.rank = Math.min(t.rank, c.rank ?? 1e9);
      if (c.game && (t.game == null || c.game > t.game)) t.game = c.game;
      top.set(c.appid, t);
    }
    const list = [...top.values()].sort((a, b) => b.foils - a.foils || a.rank - b.rank).slice(0, 16);
    return {
      games: list.map((t) => ({ appid: t.appid, name: games.get(t.appid)?.name || t.game, name_cn: games.get(t.appid)?.name_cn || null, foils: t.foils })),
      warning: null,
    };
  }
  if (/^\d+$/.test(term)) {
    const g = games.get(Number(term));
    return { games: [g ? gameRow(g) : { appid: Number(term), name: null, name_cn: null, foils: 0 }], warning: null };
  }
  const t = term.toLowerCase();
  const found = [...games.values()]
    .filter((g) => has(g.name, t) || has(g.name_cn, t))
    .map(gameRow)
    .sort((a, b) => b.foils - a.foils || (a.name || "").length - (b.name || "").length)
    .slice(0, 12);
  return { games: found, warning: null };
}

function game(q) {
  const appid = Number(q.appid);
  if (!appid) throw fail(400, "缺少 appid");
  const part = (q.part || "foil") === "normal" ? "normal" : "foil";
  const list = cards
    .filter((c) => c.appid === appid && c.foil === (part === "foil"))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const g = games.get(appid);
  const asks = list.map((c) => c.ask);
  const fetched = g?.sets?.[part] || null;
  return {
    appid,
    name: g?.name || list[0]?.game || null,
    name_cn: g?.name_cn || null,
    part,
    cards: present(list),
    set_cost: asks.length ? asks.filter(Boolean).reduce((s, a) => s + a, 0) : null,
    set_complete: asks.length > 0 && asks.every(Boolean),
    // 网页版只有采集到的卡：整套卡牌在本地版里完整拉取过，才算得出合成成本
    complete: !!fetched,
    fetched_at: fetched,
    warning: null,
  };
}

async function item(q) {
  const c = byName.get((q.name || "").trim());
  if (!c) throw fail(404, "网页版还没有收录这张卡牌");
  const d = await getJson(`item/${c.f}.json?v=${meta.version}`);
  return withWatch(d, watches()[c.hash_name]);
}

function search(q) {
  const term = (q.q || "").trim().toLowerCase();
  if (!term) return { cards: [], warning: null };
  const found = cards.filter((c) => has(c.name, term) || has(c.game, term) || has(c.hash_name, term)).sort(byRank);
  return { cards: present(found.slice(0, 20)), warning: null };
}

function watchlist() {
  const w = watches();
  const list = Object.keys(w)
    .filter((name) => byName.has(name))
    .sort((a, b) => (w[b].added_at || 0) - (w[a].added_at || 0))
    .map((name) => ({ ...withWatch(byName.get(name), w[name]), spark: byName.get(name).s7 }));
  return { cards: list };
}

function price(v) {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function watchAdd(q, body) {
  const name = (body.name || "").trim();
  const c = byName.get(name);
  if (!c) throw fail(404, "没有找到这张卡牌");
  const w = watches();
  const entry = w[name] || { added_at: Math.floor(Date.now() / 1000), added_price: c.price || c.ask || null };
  if ("note" in body) entry.note = body.note || null;
  for (const k of ["target_high", "target_low"]) {
    const v = price(body[k]);
    if (v !== undefined) entry[k] = v;
  }
  w[name] = entry;
  if (store(WATCH_KEY, w) === null) throw fail(500, "浏览器不允许保存数据（可能是无痕模式），关注列表存不下来");
  return { ok: true, card: withWatch(c, entry) };
}

function watchRemove(q) {
  const w = watches();
  delete w[(q.name || "").trim()];
  store(WATCH_KEY, w);
  return { ok: true };
}

const ROUTES = {
  "GET /api/status": status,
  "GET /api/leaderboard": leaderboard,
  "GET /api/cards": cardList,
  "GET /api/games": gameList,
  "GET /api/game": game,
  "GET /api/item": item,
  "GET /api/search": search,
  "GET /api/watchlist": watchlist,
  "POST /api/watchlist": watchAdd,
  "DELETE /api/watchlist": watchRemove,
};

export async function request(path, { method = "GET", params, body } = {}) {
  const fn = ROUTES[`${method} ${path}`];
  if (!fn) throw fail(404, "网页版不支持这个操作");
  await load();
  const q = {};
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== "") q[k] = String(v);
  return fn(q, body || {});
}
