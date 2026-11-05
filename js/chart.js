// 价格走势图（成交价折线 + 下方独立的成交量柱，不用双坐标轴）和迷你走势线
import { count, dateLabel, esc, money, state } from "./core.js";

const HOUR = 3600;
const DAY = 86400;

export function sparkline(values, { w = 88, h = 26 } = {}) {
  const pts = [];
  (values || []).forEach((v, i) => v != null && pts.push([i, v]));
  if (pts.length < 2) {
    return `<svg class="spark" width="${w}" height="${h}" aria-hidden="true"><line x1="2" x2="${w - 2}" y1="${h / 2}" y2="${h / 2}" stroke="var(--grid)" stroke-width="1"/></svg>`;
  }
  const ys = pts.map((p) => p[1]);
  let lo = Math.min(...ys);
  let hi = Math.max(...ys);
  if (hi - lo < 1e-9) {
    lo -= 1;
    hi += 1;
  }
  const n = Math.max(values.length - 1, 1);
  const x = (i) => 2 + (i / n) * (w - 7);
  const y = (v) => h - 3 - ((v - lo) / (hi - lo)) * (h - 6);
  const d = pts.map((p, k) => `${k ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join("");
  const first = pts[0][1];
  const last = pts[pts.length - 1];
  const color = last[1] > first * 1.0005 ? "var(--rise)" : last[1] < first * 0.9995 ? "var(--fall)" : "var(--muted)";
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
    <path d="${d}" fill="none" stroke="var(--ink-3)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" opacity="0.7"/>
    <circle cx="${x(last[0]).toFixed(1)}" cy="${y(last[1]).toFixed(1)}" r="2.6" fill="${color}"/></svg>`;
}

/** 把成交历史和本地快照按时间桶整理：7 天按小时、30/90 天按天。 */
export function buildRows(data, days) {
  const now = Date.now() / 1000;
  const start = now - days * DAY;
  const sales = (data.sales || []).filter((p) => p[0] > start && p[2] > 0);
  const med = (data.med24 || []).filter((p) => p[0] > start);
  const asks = (data.asks || []).filter((p) => p[0] > start);
  const bids = (data.bids || []).filter((p) => p[0] > start);
  const mode = sales.length ? "steam" : med.length ? "local" : asks.length ? "ask" : "none";
  const step = days <= 7 ? (mode === "steam" ? HOUR : 4 * HOUR) : DAY;

  const rows = [];
  if (step === DAY) {
    const d = new Date(start * 1000);
    d.setHours(0, 0, 0, 0);
    while (d.getTime() / 1000 <= now) {
      rows.push(d.getTime() / 1000);
      d.setDate(d.getDate() + 1);
    }
  } else {
    for (let t = Math.floor(start / step) * step; t <= now; t += step) rows.push(t);
  }
  const out = rows.map((t) => ({ t, price: null, vol: mode === "steam" ? 0 : null, ask: null, bid: null, pv: 0 }));
  const idxOf = (t) => {
    if (!out.length || t < out[0].t) return -1;
    let lo = 0;
    let hi = out.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (out[mid].t <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  if (mode === "steam") {
    for (const [t, p, n] of sales) {
      const r = out[idxOf(t)];
      if (r) {
        r.vol += n;
        r.pv += p * n;
      }
    }
    for (const r of out) if (r.vol > 0) r.price = r.pv / r.vol;
  } else {
    for (const [t, m] of med) {
      const r = out[idxOf(t)];
      if (r && m != null) r.price = m;
    }
  }
  for (const [t, a] of asks) {
    const r = out[idxOf(t)];
    if (r && a != null) r.ask = a;
  }
  for (const [t, b] of bids) {
    const r = out[idxOf(t)];
    if (r && b != null) r.bid = b;
  }
  return {
    mode,
    step,
    rows: out,
    hasVol: mode === "steam",
    hasPrice: out.some((r) => r.price != null),
    hasAsk: out.some((r) => r.ask != null),
    hasBid: out.some((r) => r.bid != null),
  };
}

function niceStep(raw) {
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * pow;
}

function topRounded(x, y, w, h, r) {
  if (h <= 0) return "";
  r = Math.min(r, w / 2, h);
  if (r < 0.5) return `M${x},${y + h}V${y}H${x + w}V${y + h}Z`;
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

export class PriceChart {
  constructor(host) {
    this.host = host;
    this.range = 30;
    this.data = null;
    this.idx = null;
    this.width = 0;
    this.host.tabIndex = 0;
    this.host.setAttribute("role", "img");
    this.ro = new ResizeObserver(() => {
      if (this.host.clientWidth !== this.width) this.render();
    });
    this.ro.observe(host);
    this.host.addEventListener("keydown", (e) => this.onKey(e));
  }

  destroy() {
    this.ro.disconnect();
  }

  set(data) {
    this.data = data;
    this.render();
  }

  setRange(days) {
    this.range = days;
    this.idx = null;
    this.render();
  }

  labels() {
    const local = this.S && this.S.mode === "local";
    return {
      price: local ? "成交中位价（近 24 小时，本地采集）" : "成交价（中位）",
      ask: "最低挂牌价",
      bid: "最高求购价",
      vol: "成交量",
    };
  }

  render() {
    if (!this.data) return;
    const host = this.host;
    this.width = host.clientWidth;
    const S = buildRows(this.data, this.range);
    this.S = S;
    if (S.mode === "none" || (!S.hasPrice && !S.hasAsk && !S.hasBid)) {
      host.innerHTML = `<div class="chart-empty">这段时间还没有价格数据。<br>后台在持续采集，关注这张卡会让它被优先刷新。</div>`;
      host.setAttribute("aria-label", "暂无价格数据");
      return;
    }
    const W = Math.max(this.width, 300);
    const M = { l: 60, r: 14, t: 10 };
    const PH = W < 520 ? 180 : 220;
    const GAP = S.hasVol ? 16 : 0;
    const VH = S.hasVol ? 56 : 0;
    const XB = 24;
    const H = M.t + PH + GAP + VH + XB;
    const x0 = M.l;
    const x1 = W - M.r;
    const n = S.rows.length;
    const bw = (x1 - x0) / n;
    const xi = (i) => x0 + (i + 0.5) * bw;
    this.geom = { x0, x1, bw, n, top: M.t, bottom: M.t + PH + GAP + VH, W, PH };

    // 价格轴（显示货币）
    const rate = state.display.rate;
    const vals = [];
    for (const r of S.rows) {
      if (r.price != null) vals.push(r.price * rate);
      if (r.ask != null) vals.push(r.ask * rate);
      if (r.bid != null) vals.push(r.bid * rate);
    }
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    if (hi - lo < hi * 0.02) {
      lo = hi * 0.95;
      hi = hi * 1.05 || 1;
    }
    const step = niceStep((hi - lo) / 4);
    const yMin = Math.max(0, Math.floor(lo / step) * step);
    const yMax = Math.ceil(hi / step) * step;
    const py = (v) => M.t + PH - ((v * rate - yMin) / (yMax - yMin || 1)) * PH;
    this.py = py;
    const decimals = Math.min(2, Math.max(0, -Math.floor(Math.log10(step))));
    const sym = state.display.symbol;

    let svg = `<svg viewBox="0 0 ${W} ${H}" height="${H}" aria-hidden="true">`;
    svg += '<g class="axis">';
    for (let v = yMin; v <= yMax + step / 2; v += step) {
      const y = M.t + PH - ((v - yMin) / (yMax - yMin || 1)) * PH;
      svg += `<line class="${v === yMin ? "baseline" : "gridline"}" x1="${x0}" x2="${x1}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/>`;
      svg += `<text x="${x0 - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end">${sym}${v.toFixed(decimals)}</text>`;
    }
    // 时间刻度
    const every = S.step === HOUR ? 24 : S.step === 4 * HOUR ? 6 : Math.ceil(n / 6);
    const labelY = M.t + PH + GAP + VH + 17;
    for (let i = n - 1; i >= 0; i -= 1) {
      const d = new Date(S.rows[i].t * 1000);
      const show = S.step === DAY ? (n - 1 - i) % every === 0 : d.getHours() === 0;
      if (!show) continue;
      const x = xi(i);
      if (x < x0 + 14 || x > x1 - 14) continue;
      svg += `<text x="${x.toFixed(1)}" y="${labelY}" text-anchor="middle">${d.getMonth() + 1}/${d.getDate()}</text>`;
    }
    svg += "</g>";

    // 成交价：面积淡色 + 2px 折线
    const pricePts = S.rows.map((r, i) => (r.price != null ? [xi(i), py(r.price)] : null)).filter(Boolean);
    if (pricePts.length) {
      const line = pricePts.map((p, k) => `${k ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");
      const base = M.t + PH;
      if (pricePts.length > 1) {
        svg += `<path d="${line}L${pricePts[pricePts.length - 1][0].toFixed(1)},${base}L${pricePts[0][0].toFixed(1)},${base}Z" fill="var(--series-1)" opacity="0.10"/>`;
      }
      svg += `<path d="${line}" fill="none" stroke="var(--series-1)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
      if (pricePts.length === 1) svg += `<circle cx="${pricePts[0][0]}" cy="${pricePts[0][1]}" r="4" fill="var(--series-1)" stroke="var(--surface)" stroke-width="2"/>`;
    }
    for (const [key, color] of [["ask", "var(--series-2)"], ["bid", "var(--series-3)"]]) {
      const pts = S.rows.map((r, i) => (r[key] != null ? [xi(i), py(r[key])] : null)).filter(Boolean);
      if (pts.length === 1) {
        svg += `<circle cx="${pts[0][0].toFixed(1)}" cy="${pts[0][1].toFixed(1)}" r="4" fill="${color}" stroke="var(--surface)" stroke-width="2"/>`;
        continue;
      }
      if (!pts.length) continue;
      const line = pts.map((p, k) => `${k ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");
      svg += `<path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    }
    // 末端点
    const lastP = pricePts[pricePts.length - 1];
    if (lastP && pricePts.length > 1) svg += `<circle cx="${lastP[0].toFixed(1)}" cy="${lastP[1].toFixed(1)}" r="4" fill="var(--series-1)" stroke="var(--surface)" stroke-width="2"/>`;

    // 成交量柱（独立面板，自己的刻度）
    if (S.hasVol) {
      const vTop = M.t + PH + GAP;
      const vMax = Math.max(1, ...S.rows.map((r) => r.vol || 0));
      const barW = Math.min(24, Math.max(1, bw - 2));
      svg += '<g class="axis">';
      svg += `<line class="baseline" x1="${x0}" x2="${x1}" y1="${vTop + VH}" y2="${vTop + VH}"/>`;
      svg += `<text x="${x0 - 8}" y="${vTop + 8}" text-anchor="end">${count(vMax)}</text>`;
      svg += `<text x="${x0 - 8}" y="${vTop + VH}" text-anchor="end">0</text>`;
      svg += "</g>";
      let bars = "";
      S.rows.forEach((r, i) => {
        if (!r.vol) return;
        const h = Math.max(1, (r.vol / vMax) * VH);
        bars += topRounded(xi(i) - barW / 2, vTop + VH - h, barW, h, 3);
      });
      svg += `<path d="${bars}" fill="var(--vol)"/>`;
    }

    // 悬停层
    svg += `<line class="xh" x1="0" x2="0" y1="${M.t}" y2="${M.t + PH + GAP + VH}" stroke="var(--ink-3)" stroke-width="1" visibility="hidden"/>`;
    svg += `<circle class="xp" r="4" fill="var(--series-1)" stroke="var(--surface)" stroke-width="2" visibility="hidden"/>`;
    svg += `<circle class="xa" r="4" fill="var(--series-2)" stroke="var(--surface)" stroke-width="2" visibility="hidden"/>`;
    svg += `<circle class="xb" r="4" fill="var(--series-3)" stroke="var(--surface)" stroke-width="2" visibility="hidden"/>`;
    svg += `<rect class="hit" x="${x0}" y="${M.t}" width="${x1 - x0}" height="${PH + GAP + VH}" fill="transparent"/>`;
    svg += "</svg>";

    const lab = this.labels();
    const keys = [];
    if (S.hasPrice) keys.push(`<span class="k"><i style="background:var(--series-1)"></i>${lab.price}</span>`);
    if (S.hasAsk) keys.push(`<span class="k"><i style="background:var(--series-2)"></i>${lab.ask}</span>`);
    if (S.hasBid) keys.push(`<span class="k"><i style="background:var(--series-3)"></i>${lab.bid}</span>`);
    if (S.hasVol) keys.push(`<span class="k"><i class="bar" style="background:var(--vol)"></i>${lab.vol}（下方）</span>`);
    const legend = keys.length > 1 ? `<div class="legend">${keys.join("")}</div>` : "";
    host.innerHTML = `${legend}<div style="position:relative">${svg}<div class="tip hidden"></div></div>`;
    host.setAttribute("aria-label", `价格走势图，最近 ${this.range} 天。可用左右方向键查看每个时间点。`);

    const hit = host.querySelector(".hit");
    hit.addEventListener("pointermove", (e) => {
      const rect = host.querySelector("svg").getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * W;
      this.show(Math.max(0, Math.min(n - 1, Math.floor((px - x0) / bw))));
    });
    hit.addEventListener("pointerleave", () => this.hide());
    if (this.idx != null) this.show(Math.min(this.idx, n - 1));
  }

  show(i) {
    const S = this.S;
    if (!S || !S.rows[i]) return;
    this.idx = i;
    const { x0, bw, W } = this.geom;
    const x = x0 + (i + 0.5) * bw;
    const r = S.rows[i];
    const svg = this.host.querySelector("svg");
    const xh = svg.querySelector(".xh");
    xh.setAttribute("x1", x);
    xh.setAttribute("x2", x);
    xh.setAttribute("visibility", "visible");
    for (const [cls, v] of [[".xp", r.price], [".xa", r.ask], [".xb", r.bid]]) {
      const c = svg.querySelector(cls);
      if (v != null) {
        c.setAttribute("cx", x);
        c.setAttribute("cy", this.py(v));
        c.setAttribute("visibility", "visible");
      } else c.setAttribute("visibility", "hidden");
    }
    const lab = this.labels();
    const rows = [];
    if (S.hasPrice || S.mode !== "ask") {
      rows.push(`<div class="r"><span class="n"><i style="background:var(--series-1)"></i>${S.mode === "local" ? "成交中位价" : "成交价"}</span><b>${r.price != null ? money(r.price) : "无成交"}</b></div>`);
    }
    if (S.hasVol) rows.push(`<div class="r"><span class="n"><i style="background:var(--vol);height:8px;width:8px;border-radius:2px"></i>${lab.vol}</span><b>${count(r.vol)} 笔</b></div>`);
    if (S.hasAsk) rows.push(`<div class="r"><span class="n"><i style="background:var(--series-2)"></i>${lab.ask}</span><b>${r.ask != null ? money(r.ask) : "—"}</b></div>`);
    if (S.hasBid) rows.push(`<div class="r"><span class="n"><i style="background:var(--series-3)"></i>${lab.bid}</span><b>${r.bid != null ? money(r.bid) : "—"}</b></div>`);
    const tip = this.host.querySelector(".tip");
    tip.innerHTML = `<div class="d">${esc(this.when(r.t))}</div>${rows.join("")}`;
    tip.classList.remove("hidden");
    const scale = svg.getBoundingClientRect().width / W;
    const px = x * scale;
    const tw = tip.offsetWidth;
    const left = px + 14 + tw > svg.clientWidth ? px - 14 - tw : px + 14;
    tip.style.left = `${Math.max(0, left)}px`;
    tip.style.top = "8px";
  }

  hide() {
    const svg = this.host.querySelector("svg");
    if (!svg) return;
    this.idx = null;
    for (const c of svg.querySelectorAll(".xh,.xp,.xa,.xb")) c.setAttribute("visibility", "hidden");
    this.host.querySelector(".tip")?.classList.add("hidden");
  }

  when(t) {
    const S = this.S;
    if (S.step === DAY) return dateLabel(t);
    if (S.step === HOUR) return dateLabel(t, true);
    const end = new Date((t + S.step) * 1000);
    return `${dateLabel(t, true)}–${String(end.getHours()).padStart(2, "0")}:00`;
  }

  onKey(e) {
    if (!this.S || !this.S.rows.length) return;
    const n = this.S.rows.length;
    let i = this.idx ?? n - 1;
    if (e.key === "ArrowLeft") i -= 1;
    else if (e.key === "ArrowRight") i += 1;
    else if (e.key === "Home") i = 0;
    else if (e.key === "End") i = n - 1;
    else if (e.key === "Escape") return this.hide();
    else return;
    e.preventDefault();
    this.show(Math.max(0, Math.min(n - 1, i)));
  }

  tableHtml() {
    const S = this.S || buildRows(this.data || {}, this.range);
    const rows = S.rows.filter((r) => r.price != null || r.ask != null || r.bid != null || r.vol).reverse();
    if (!rows.length) return '<div class="chart-empty">没有数据</div>';
    const lab = this.labels();
    return `<div class="table-wrap"><table class="data"><thead><tr><th class="l">时间</th>
      ${S.hasPrice || S.mode !== "ask" ? `<th>${S.mode === "local" ? "成交中位价" : "成交价"}</th>` : ""}
      ${S.hasVol ? "<th>成交量</th>" : ""}${S.hasAsk ? `<th>${lab.ask}</th>` : ""}${S.hasBid ? `<th>${lab.bid}</th>` : ""}</tr></thead><tbody>
      ${rows
        .map(
          (r) => `<tr style="cursor:default"><td class="l">${esc(this.when(r.t))}</td>
        ${S.hasPrice || S.mode !== "ask" ? `<td>${money(r.price)}</td>` : ""}
        ${S.hasVol ? `<td>${count(r.vol)}</td>` : ""}${S.hasAsk ? `<td>${money(r.ask)}</td>` : ""}${S.hasBid ? `<td>${money(r.bid)}</td>` : ""}</tr>`,
        )
        .join("")}</tbody></table></div>`;
  }
}
