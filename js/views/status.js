// 数据状态与设置：各接口健康度、采集进度、数据存放位置（本机 / 云盘）、网页版、偏好设置、数据口径说明
import { ago, api, applyStatus, count, duration, esc, every, state, store } from "../core.js";
import { setWatchCount, toast } from "../ui.js";

const GROUPS = [
  ["search", "卡牌搜索", "发现卡牌、最低挂牌价、在售数量"],
  ["book", "订单簿", "最高求购价、买卖单数量与深度"],
  ["overview", "24 小时成交概览", "近 24 小时成交量与中位价、汇率"],
  ["history", "成交历史", "7 / 30 / 90 天走势与涨跌（限流最严）"],
];

function epState(w) {
  const p = w.pacer;
  if (p.blocked_for > 0) return ["warn", `限流中，约 ${duration(p.blocked_for)}后重试`];
  if (p.last_error && (!p.last_ok_at || p.last_error_at > p.last_ok_at)) return ["bad", "最近一次请求失败"];
  if (p.ok) return ["good", "正常"];
  return ["", "尚未请求"];
}

const bytes = (n) => (n == null ? "" : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
// 路径的最后两级，例如「我的云端硬盘 / Steam卡牌行情」
const shortPath = (p) =>
  String(p || "").split(/[\\/]/).filter(Boolean).slice(-2).join(" / ").replace("com~apple~CloudDocs", "iCloud 云盘");
// 快照是谁存的：同一台电脑存的就说「这台电脑」
const who = (m) => (m.host && m.host === state.status?.cloud?.host ? "这台电脑 " : `「${esc(m.host || "另一台电脑")}」`);
const callout = (level, title, detail) =>
  `<div class="callout ${level}"><span class="ico">!</span><div><b>${title}</b><div class="detail">${detail}</div></div></div>`;

/** 「数据从哪来、怎么算」。网页版（publicSite）只有「覆盖范围」那一条说法不同。 */
export function aboutHtml(publicSite = false) {
  return `<div class="panel-head"><h2>数据从哪来、怎么算</h2></div>
    <div class="prose"><ul>
      <li><b>最低挂牌价</b>：市场上最便宜的那件在售卡牌的价格，也就是「立即买入价」。它是卖家的要价，不等于成交价。</li>
      <li><b>最高求购价</b>：买单里出价最高的那一档，也就是「立即卖出价」。卖给求购单要再扣约 15% 手续费。</li>
      <li><b>成交价</b>：近 24 小时实际成交的中位价（按笔数加权）。有 Steam 成交历史时用它，否则用本地每隔几小时采集的 24 小时成交概览。</li>
      <li><b>涨跌幅</b>：当前成交价对比 N 天前那 24 小时的成交价。成交接口被限流时，可以在排行榜切到「按挂牌价」口径——用本地记录的最低挂牌价计算，需要本地数据积累满一个周期。</li>
      <li><b>流动性</b>：主要看近 7 日日均成交笔数（能不能卖掉），买卖价差过大最多降一档（立刻卖给求购单要让价）；成交数据缺失时按订单簿（价差、挂单和求购数量）估计，并标注「按挂单估计」。</li>
      <li><b>异常提示</b>：24 小时涨跌超过 30%、挂牌价比成交价高 50% 以上或低 30% 以上、成交量放大到平时 3 倍、价差超过 40%、在售不超过 3 件、7 天无成交、触发目标价。</li>
      <li><b>覆盖范围</b>：Steam 上有十几万种卡牌，每页只能取 10 条，所以后台按「热门普通卡 / 热门闪卡 / 挂牌价最高」轮流扫描，${
        publicSite ? "站长搜索或关注过的卡牌也会被持续跟踪。网页版只能查到已经收录的卡牌" : "你搜索或关注过的卡牌也会被持续跟踪"
      }。</li>
    </ul></div>`;
}

export async function mount(el) {
  let timer = null;
  let alive = true;
  let storageHtml = "";
  el.innerHTML = `
    <div class="page-head"><div><h1>数据状态</h1>
      <p class="sub">所有数据都来自 Steam 社区市场的公开接口（不需要登录），在你的电脑上定时采集，可以只存在本机，也可以存进云盘。Steam 对请求频率限制很严，这里能看到每个接口现在是否可用。</p></div></div>
    <div class="endpoints" id="eps"></div>
    <div class="grid-2">
      <section class="panel" id="progress"></section>
      <section class="panel" id="fx"></section>
    </div>
    <section class="panel" style="margin-top:16px" id="storage">
      <div class="panel-head"><h2>数据存放位置</h2><span class="hint store-hint" id="st-hint"></span></div>
      <div class="store-now" id="st-now"></div>
      <div class="store-pick" id="st-pick"></div>
    </section>
    <section class="panel" id="site">
      <div class="panel-head"><h2>网页版</h2><span class="hint store-hint" id="site-hint"></span></div>
      <div id="site-body"><p class="muted">正在检查 GitHub 登录状态…</p></div>
    </section>
    <section class="panel" id="settings"></section>
    <section class="panel" id="about"></section>
    <dialog id="st-choice"><form method="dialog">
      <h2>云盘里已经有数据</h2>
      <div class="body"></div>
      <div class="actions"><button class="btn" value="cancel" type="submit">取消</button>
        <button class="btn" value="local" type="submit">用这台电脑的数据</button>
        <button class="btn primary" value="cloud" type="submit">载入云盘里的数据</button></div>
    </form></dialog>`;

  function renderEndpoints(s) {
    el.querySelector("#eps").innerHTML = GROUPS.map(([g, name, desc]) => {
      const w = s.workers[g];
      const [cls, label] = epState(w);
      const p = w.pacer;
      return `<div class="ep"><div class="h"><span class="dot ${cls}"></span>${name}</div>
        <div class="st">${label}</div>
        <div class="m">${desc}<br>近 1 分钟 ${p.per_min} 次 · 成功 ${count(p.ok)} · 被限流 ${count(p.limited)}<br>
        最小间隔 ${p.interval} 秒${w.queued ? ` · 插队 ${w.queued} 个` : ""}${w.current ? `<br>正在处理：${esc(w.current)}` : ""}</div>
        ${p.last_error && p.last_error_at ? `<div class="err">${esc(p.last_error)}（${ago(p.last_error_at)}）</div>` : ""}</div>`;
    }).join("");
  }

  function renderProgress(s) {
    const sw = s.workers.search;
    const done = sw.cycle_total ? sw.cycle_total - sw.cycle_left : 0;
    const pctDone = sw.cycle_total ? Math.round((done / sw.cycle_total) * 100) : 0;
    const next = sw.next_cycle_at ? Math.max(0, sw.next_cycle_at - Date.now() / 1000) : 0;
    const db = s.db;
    el.querySelector("#progress").innerHTML = `<div class="panel-head"><h2>采集进度</h2>
        <span class="hint">${s.offline ? "离线模式，不访问 Steam" : s.settings.collector_enabled ? "后台采集运行中" : "后台采集已暂停"}</span></div>
      <p style="margin-bottom:8px">本轮扫描：${done} / ${sw.cycle_total || 0} 页${sw.cycle_left ? "" : next ? `，下一轮约 ${duration(next)}后开始` : ""}</p>
      <div class="progress"><i style="width:${pctDone}%"></i></div>
      <dl class="kv" style="margin-top:16px">
        <dt>已收录卡牌</dt><dd>${count(db.items)} 张<span class="s">其中闪卡 ${count(db.foil)}</span></dd>
        <dt>涉及游戏</dt><dd>${count(db.games)} 款</dd>
        <dt>当前扫描范围</dt><dd>${count(db.tracked)} 张<span class="s">会被定时刷新</span></dd>
        <dt>有订单簿</dt><dd>${count(db.with_book)} 张</dd>
        <dt>有 Steam 成交历史</dt><dd>${count(db.with_history)} 张</dd>
        <dt>可计算涨跌</dt><dd>${count(db.with_stats)} 张</dd>
        <dt>本地快照</dt><dd>${count(db.snap_rows)} 条<span class="s">成交记录 ${count(db.sales_rows)} 条</span></dd>
      </dl>`;
  }

  function renderFx(s) {
    const d = s.display;
    const src = { steam: "由 Steam 同一物品的美元/人民币报价推算", manual: "手动设置", estimate: "估算值（Steam 报价接口限流，暂未自动更新）" };
    el.querySelector("#fx").innerHTML = `<div class="panel-head"><h2>货币与汇率</h2></div>
      <dl class="kv">
        <dt>Steam 报价货币</dt><dd>${esc(s.market_currency)}<span class="s">由出口 IP 所在地区决定</span></dd>
        <dt>页面显示货币</dt><dd>${esc(d.currency)}</dd>
        ${d.currency === "CNY" ? `<dt>汇率</dt><dd>1 USD = ¥${d.rate.toFixed(4)}<span class="s">${src[d.source] || ""}${d.fx_at && d.source === "steam" ? `，${ago(d.fx_at)}` : ""}</span></dd>` : ""}
        <dt>连接状态</dt><dd>${s.offline ? "离线模式" : s.market_ready ? "已连上 Steam" : "正在连接…"}</dd>
      </dl>
      <p class="note">数据库里统一按美元保存，显示时换算。人民币价格和 Steam 客户端里看到的可能差 1 分钱左右（四舍五入）。</p>`;
  }

  // ---------- 数据存放位置 ----------

  const conflictHtml = (m) =>
    callout(
      "warn",
      "云盘里有另一份更新的数据",
      `${who(m)}${ago(m.saved_at)}往云盘里存了一份数据（${count(m.cards)} 张卡，关注 ${count(m.watch)} 张），和这台电脑上的不是同一份。为免互相覆盖，这台电脑先暂停写入，请选择保留哪一边。如果两台电脑同时开着，它们会重复请求 Steam，更容易被限流，建议只开一台。
      <div class="row-actions"><button class="btn primary small" data-act="resolve" data-use="cloud">载入云盘里的数据</button>
      <button class="btn small" data-act="resolve" data-use="local">用这台电脑的数据覆盖</button></div>`,
    );

  function renderStorage(s) {
    const c = s.cloud || {};
    let hint = '<span class="dot"></span>只存在本机';
    let html;
    if (!c.folder) {
      html = `<p>现在只存在<b>这台电脑</b>上（程序目录下的 data 文件夹）。换电脑、重装或删掉程序文件夹，关注列表和积累的行情数据就都没了。</p>`;
    } else {
      const [cls, label] = c.conflict ? ["warn", "需要你选择"] : !c.available ? ["bad", "找不到云盘文件夹"]
        : c.error ? ["bad", "写入失败"] : c.busy ? ["warn", c.busy === "restore" ? "正在载入…" : "正在写入…"] : ["good", "已存到云盘"];
      hint = `<span class="dot ${cls}"></span>${label}`;
      const next = c.conflict ? "暂停" : c.dirty ? "有新改动，半分钟内写入"
        : c.next_upload ? `约 ${duration(Math.max(0, c.next_upload - Date.now() / 1000))}后` : "—";
      const recent = c.restored && Date.now() / 1000 - c.restored.at < 3600;
      html = `${c.conflict ? conflictHtml(c.conflict) : ""}
        ${!c.available ? callout("alert", "找不到云盘文件夹", `请确认${esc(c.label)}客户端正在运行并且已经登录。在那之前数据先存在这台电脑上，连上后会自动写入。<br>${esc(c.folder)}`)
          : c.error ? callout("alert", "写入云盘失败", `${esc(c.error)}（${ago(c.error_at)}），稍后会自动重试。`) : ""}
        ${recent ? `<div class="banner info">已载入${who(c.restored)}${ago(c.restored.saved_at)}存进云盘的数据。</div>` : ""}
        <dl class="kv">
          <dt>位置</dt><dd>${esc(c.label)}<span class="s" title="${esc(c.folder)}">${esc(shortPath(c.folder).replace(`${c.label} / `, ""))}</span></dd>
          <dt>云盘里的数据</dt><dd>${c.saved_at ? `${ago(c.saved_at)}保存<span class="s">${bytes(c.bytes)}</span>` : "还没有"}</dd>
          <dt>下次自动写入</dt><dd>${next}</dd>
        </dl>
        <p class="note">这台电脑上的 data 文件夹只是运行时的缓存，删掉后下次启动会从云盘恢复。除了定时写入，改了关注列表或设置后半分钟内、退出程序时也会写入一次；传到网上由云盘客户端在后台完成。</p>
        <div class="row-actions">
          <button class="btn" data-act="sync"${c.busy || c.conflict || !c.available ? " disabled" : ""}>立即写入云盘</button>
          <button class="btn" data-act="change">换个位置</button>
          <button class="btn ghost" data-act="local">改回只存本机</button>
        </div>`;
    }
    el.querySelector("#st-hint").innerHTML = hint;
    if (html !== storageHtml) {
      el.querySelector("#st-now").innerHTML = html;
      storageHtml = html;
    }
  }

  const pickRow = (f, checked) => {
    const m = f.meta;
    const has = m ? (m.error ? "里面的数据读不出来" : `${who(m)}${ago(m.saved_at)}存过数据`) : "";
    return `<label class="pick"><input type="radio" name="dest" value="${esc(f.path)}"${checked ? " checked" : ""}>
      <span class="grow"><b>${esc(f.label)}</b>${f.account ? `<span class="acct">${esc(f.account)}</span>` : ""}${m ? ' <span class="tag">已有数据</span>' : ""}
      <span class="s" title="${esc(f.target)}">${esc(shortPath(f.target))}${has ? ` · ${has}` : ""}</span></span></label>`;
  };

  async function renderPicker() {
    const box = el.querySelector("#st-pick");
    box.innerHTML = '<p class="muted">正在查找这台电脑上的云盘…</p>';
    let data;
    try {
      data = await api("/api/storage");
    } catch (e) {
      box.innerHTML = `<div class="banner">${esc(e.message)}</div>`;
      return;
    }
    if (!alive) return;
    const cur = data.current.folder;
    const opts = data.folders.filter((f) => f.target !== cur);
    box.innerHTML = `<h3>${cur ? "换到别的位置" : "改存到云盘"}</h3>
      <p class="muted" style="margin-top:4px">关注列表、设置和行情历史会放进云盘的同步文件夹，换电脑、重装程序都不会丢。程序还是在这台电脑上运行和采集。</p>
      ${data.folders.length ? "" : `<div class="banner info" style="margin:12px 0 0">这台电脑上没找到云盘。装好 <a href="https://www.google.com/drive/download/" target="_blank" rel="noopener">Google 云端硬盘桌面版</a>并登录后刷新本页，这里就会出现「Google 云端硬盘」；也可以在「系统设置 → Apple 账户 → iCloud」里打开 iCloud 云盘。</div>`}
      <div class="pick-list">
        ${opts.map((f, i) => pickRow(f, i === 0)).join("")}
        <label class="pick"><input type="radio" name="dest" value=""${opts.length ? "" : " checked"}>
          <span class="grow"><b>其他文件夹</b><span class="s">比如 Dropbox、OneDrive 或 NAS 的同步文件夹，会在里面新建「Steam卡牌行情」</span>
          <input type="text" id="st-path" placeholder="粘贴文件夹的完整路径" autocomplete="off" spellcheck="false" aria-label="文件夹路径"></span></label>
      </div>
      <div class="row-actions"><button class="btn primary" data-act="use">${cur ? "换到这里" : "改存到这里"}</button>
        ${cur ? '<button class="btn ghost" data-act="cancel-pick">取消</button>' : ""}</div>`;
    box.querySelector("#st-path").addEventListener("focus", (e) => {
      e.target.closest(".pick").querySelector('input[type="radio"]').checked = true;
    });
  }

  async function post(btn, body) {
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = body.action === "local" ? "正在切换…" : body.prefer === "cloud" || body.use === "cloud" ? "正在载入…" : "正在写入…";
    try {
      return await api("/api/storage", { method: "POST", body });
    } catch (err) {
      toast(err.message);
      return null;
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  async function done(res, message, loaded) {
    applyStatus(res.status);
    render(res.status, loaded);
    toast(message);
    if (loaded) {
      // 载入了云盘里的数据，关注列表可能变了
      const w = await api("/api/watchlist");
      state.watch = new Set(w.cards.map((c) => c.hash_name));
      setWatchCount();
    }
  }

  async function useFolder(btn, path, prefer) {
    const res = await post(btn, { action: "use", path, prefer });
    if (!res) return;
    if (res.need_choice) return askChoice(btn, path, res);
    el.querySelector("#st-pick").innerHTML = "";
    done(res, prefer === "cloud" ? "已载入云盘里的数据" : "数据已存到云盘", prefer === "cloud");
  }

  function askChoice(btn, path, res) {
    const d = el.querySelector("#st-choice");
    const m = res.meta;
    const where = esc(shortPath(res.folder));
    d.querySelector(".body").innerHTML = m.error
      ? `<p>「${where}」里已经有数据，但是读不出来：${esc(m.error)}</p>
         <p class="muted small">如果云盘客户端还在同步，等它同步完再试；也可以用这台电脑的数据覆盖，原来那份会另存为 tracker-backup.zip。</p>`
      : `<p>「${where}」里已经有${who(m)}${ago(m.saved_at)}存的数据：${count(m.cards)} 张卡，关注 ${count(m.watch)} 张。</p>
         <p class="muted small">这台电脑上现在有 ${count(res.local.cards)} 张卡，关注 ${count(res.local.watch)} 张。选「用这台电脑的数据」会先把云盘里那份另存为 tracker-backup.zip。</p>`;
    d.querySelector('[value="cloud"]').classList.toggle("hidden", !!m.error);
    d.returnValue = "";
    d.onclose = () => {
      if (d.returnValue === "cloud" || d.returnValue === "local") useFolder(btn, path, d.returnValue);
    };
    d.showModal();
  }

  el.querySelector("#storage").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === "change") return renderPicker();
    if (act === "cancel-pick") {
      el.querySelector("#st-pick").innerHTML = "";
      return;
    }
    if (act === "use") {
      const picked = el.querySelector('input[name="dest"]:checked');
      const path = picked?.value || el.querySelector("#st-path")?.value.trim();
      if (!path) return toast("请选择一个云盘，或者填写文件夹路径");
      return useFolder(btn, path);
    }
    const body = act === "resolve" ? { action: "resolve", use: btn.dataset.use } : { action: act };
    const res = await post(btn, body);
    if (!res) return;
    if (act === "resolve") {
      const cloud = btn.dataset.use === "cloud";
      done(res, cloud ? "已载入云盘里的数据" : "已用这台电脑的数据覆盖云盘，原来那份另存为 tracker-backup.zip", cloud);
    } else {
      done(res, act === "sync" ? "已写入云盘" : "已改回只存本机，云盘里的文件还留着", false);
      if (act === "local") renderPicker();
    }
  });

  // ---------- 网页版 ----------

  let site = null; // GET /api/site 的结果（带 GitHub 登录状态）；状态轮询只更新发布状态
  let siteHtml = "";
  let siteError = "";

  const siteUrl = (login, name) => {
    const [owner, repo] = name.includes("/") ? name.split("/") : [login, name];
    return `https://${owner.toLowerCase()}.github.io/${repo}/`;
  };

  async function loadSite(check) {
    try {
      site = await api("/api/site", { params: { check: check ? 1 : undefined } });
    } catch (e) {
      el.querySelector("#site-body").innerHTML = `<div class="banner">${esc(e.message)}</div>`;
      return;
    }
    if (alive) renderSite();
  }

  function renderSite(info) {
    if (!site) return;
    if (info) site = { ...site, ...info };
    const s = site;
    const a = s.account || {};
    let hint;
    let html;
    if (s.enabled) {
      const [cls, label] = s.busy ? ["warn", "正在发布…"] : s.error ? ["bad", "发布失败"] : ["good", "已发布"];
      hint = `<span class="dot ${cls}"></span>${label}`;
      const next = s.busy ? "正在发布…" : s.next_at ? `约 ${duration(Math.max(0, s.next_at - Date.now() / 1000))}后` : "—";
      html = `${s.error ? callout("alert", "发布失败", `${esc(s.error)}（${ago(s.error_at)}），稍后会自动重试。`) : ""}
        <dl class="kv">
          <dt>网址</dt><dd>${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url.replace(/^https?:\/\//, ""))} ↗</a>` : "第一次发布完成后显示"}</dd>
          <dt>上次发布</dt><dd>${s.last_at ? `${ago(s.last_at)}<span class="s">${count(s.cards)} 张卡 · ${bytes(s.bytes)}</span>` : "还没有"}</dd>
          <dt>下次发布</dt><dd>${next}</dd>
          <dt>GitHub 仓库</dt><dd><a href="https://github.com/${esc(s.repo)}" target="_blank" rel="noopener">${esc(s.repo)} ↗</a></dd>
        </dl>
        <p class="note">网页版只有公开的行情数据；你的关注列表、设置、电脑名和云盘位置都不会放上去，访客的关注列表存在他们自己的浏览器里。每次发布后，GitHub 要 1 分钟左右才会更新网页。停止自动发布后，网站会保留最后一次发布的数据；要彻底下线，到 GitHub 仓库的 Settings → Pages 里关掉，或者删除仓库。</p>
        <div class="row-actions">
          <button class="btn" data-act="publish"${s.busy ? " disabled" : ""}>立即发布</button>
          <button class="btn ghost" data-act="disable"${s.busy ? " disabled" : ""}>停止自动发布</button>
        </div>`;
    } else {
      hint = '<span class="dot"></span>未开启';
      const check = '<div class="row-actions"><button class="btn small" data-act="check">重新检查</button></div>';
      let body;
      if (!s.account) body = '<p class="muted">正在检查 GitHub 登录状态…</p>';
      else if (!a.installed)
        body = callout(
          "warn",
          "没有找到 GitHub 命令行工具 gh",
          `先安装 <a href="https://cli.github.com/" target="_blank" rel="noopener">GitHub CLI</a>，再在终端运行 <code>gh auth login</code> 登录。${check}`,
        );
      else if (!a.login)
        body = callout(
          "warn",
          "还没有登录 GitHub",
          `在终端运行 <code>gh auth login</code>，按提示用浏览器登录，然后点「重新检查」。${a.error ? `<br><span class="small">${esc(a.error)}</span>` : ""}${check}`,
        );
      else {
        const prev = s.repo && s.repo.split("/")[0].toLowerCase() === a.login.toLowerCase() ? s.repo.split("/")[1] : s.repo;
        const name = prev || s.default_repo;
        body = `${siteError ? callout("alert", "没有发布成功", esc(siteError)) : ""}
          <div class="field site-repo"><label for="site-repo">仓库名</label>
            <input type="text" id="site-repo" value="${esc(name)}" autocomplete="off" spellcheck="false">
            <div class="help">网址会是 <b id="site-preview">${esc(siteUrl(a.login, name))}</b></div></div>
          <p class="muted small">会在你的 GitHub 账号（${esc(a.login)}）下新建一个公开仓库（免费版 GitHub Pages 只能用公开仓库），里面只有网页文件和行情数据，不含程序代码。以前用这个程序发布过的仓库也可以填，会接着用。</p>
          <div class="row-actions"><button class="btn primary" data-act="setup">开始发布</button></div>`;
      }
      const interval = state.status?.settings?.site_interval_min;
      html = `<p>把排行榜、闪卡专区、走势图和流动性做成<b>只读网页</b>，免费发布到 GitHub Pages，别人打开网址就能查。数据还是这台电脑采集，${every(interval)}自动更新一次；访客再多也不会多请求一次 Steam。</p>${body}`;
    }
    el.querySelector("#site-hint").innerHTML = hint;
    if (html !== siteHtml) {
      el.querySelector("#site-body").innerHTML = html;
      siteHtml = html;
    }
  }

  el.querySelector("#site").addEventListener("input", (e) => {
    if (e.target.id !== "site-repo" || !site?.account?.login) return;
    el.querySelector("#site-preview").textContent = siteUrl(site.account.login, e.target.value.trim() || site.default_repo);
  });

  el.querySelector("#site").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    btn.disabled = true;
    if (act === "check") {
      btn.textContent = "检查中…";
      siteHtml = "";
      return loadSite(true);
    }
    const label = btn.textContent;
    btn.textContent = act === "disable" ? "正在停止…" : "正在发布…";
    const body = act === "setup" ? { action: "setup", repo: el.querySelector("#site-repo").value.trim() } : { action: act };
    try {
      const res = await api("/api/site", { method: "POST", body });
      siteError = "";
      siteHtml = "";
      renderSite(res.site);
      toast(act === "disable" ? "已停止自动发布，网站保留最后一次的数据" : "已发布，GitHub 1 分钟左右后更新网页");
    } catch (err) {
      if (act === "setup") {
        siteError = err.message;
        siteHtml = "";
        await loadSite(false);
      } else toast(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  });

  function renderSettings(s) {
    const v = s.settings;
    const theme = store("sct-theme") || "auto";
    el.querySelector("#settings").innerHTML = `<div class="panel-head"><h2>设置</h2><span class="hint">保存后立即生效</span></div>
      <form id="cfg" class="form-grid">
        <div class="field"><label for="s-cur">显示货币</label>
          <select id="s-cur" name="display_currency"><option value="CNY">人民币 CNY</option><option value="USD">美元 USD</option></select></div>
        <div class="field"><label for="s-up">涨跌颜色</label>
          <select id="s-up" name="up_color"><option value="red">红涨绿跌（国内习惯）</option><option value="green">绿涨红跌（国际习惯）</option></select></div>
        <div class="field"><label for="s-theme">外观</label>
          <select id="s-theme" data-local="theme"><option value="auto">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select>
          <div class="help">只保存在当前浏览器</div></div>
        <div class="field"><label for="s-proxy">HTTP 代理</label>
          <input type="text" id="s-proxy" name="proxy" placeholder="留空则使用系统代理，例如 http://127.0.0.1:7890">
          <div class="help">只有连不上 Steam 社区时才需要填写</div></div>
        <div class="field"><label class="switch"><input type="checkbox" name="collector_enabled"> 后台自动采集</label>
          <div class="help">关闭后只在你打开页面时按需获取</div></div>
        <div class="field"><label for="s-int">扫描间隔（分钟）</label><input type="number" id="s-int" name="scan_interval_min" min="10" max="1440"></div>
        <div class="field"><label for="s-p1">每轮扫描：热门普通卡（页）</label><input type="number" id="s-p1" name="scan_pages_popular" min="0" max="200">
          <div class="help">Steam 每页只返回 10 条</div></div>
        <div class="field"><label for="s-p2">每轮扫描：热门闪卡（页）</label><input type="number" id="s-p2" name="scan_pages_foil" min="0" max="200"></div>
        <div class="field"><label for="s-p3">每轮扫描：挂牌价最高（页）</label><input type="number" id="s-p3" name="scan_pages_price" min="0" max="100"></div>
        <div class="field"><label for="s-fx">手动汇率（1 USD = ? CNY）</label><input type="number" step="0.0001" id="s-fx" name="fx_manual" min="0">
          <div class="help">填 0 表示自动推算</div></div>
        <div class="field"><label for="s-h">成交历史请求间隔（秒）</label><input type="number" id="s-h" name="pace_history" min="5" max="600">
          <div class="help">太小容易被 Steam 封一段时间</div></div>
        <div class="field"><label for="s-b">订单簿请求间隔（秒）</label><input type="number" step="0.5" id="s-b" name="pace_book" min="1" max="120"></div>
        <div class="field"><label for="s-o">所有请求合计最小间隔（秒）</label><input type="number" step="0.5" id="s-o" name="pace_overall" min="1" max="60">
          <div class="help">不管哪个接口，两次请求之间至少隔这么久</div></div>
        <div class="field"><label for="s-cl">云盘定时写入间隔（分钟）</label><input type="number" id="s-cl" name="cloud_interval_min" min="10" max="1440">
          <div class="help">数据存在云盘时生效；每次写入整个数据文件</div></div>
        <div class="field"><label for="s-site">网页版发布间隔（分钟）</label><input type="number" id="s-site" name="site_interval_min" min="30" max="1440">
          <div class="help">开启网页版后生效；每次发布后 GitHub 要 1 分钟左右更新网页</div></div>
        <div class="field" style="grid-column:1/-1;display:flex;justify-content:flex-end"><button class="btn primary" type="submit">保存设置</button></div>
      </form>`;
    const form = el.querySelector("#cfg");
    for (const input of form.querySelectorAll("[name]")) {
      const val = v[input.name];
      if (input.type === "checkbox") input.checked = !!val;
      else input.value = val ?? "";
    }
    form.querySelector("#s-theme").value = theme;
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const body = {};
      for (const input of form.querySelectorAll("[name]")) body[input.name] = input.type === "checkbox" ? input.checked : input.value;
      const t = form.querySelector("#s-theme").value;
      store("sct-theme", t);
      if (t === "auto") delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = t;
      try {
        const st = await api("/api/settings", { method: "POST", body });
        applyStatus(st);
        toast("设置已保存");
        render(st, true);
      } catch (err) {
        toast(err.message);
      }
    });
  }

  function renderAbout() {
    el.querySelector("#about").innerHTML = aboutHtml();
  }

  function render(s, withSettings) {
    renderEndpoints(s);
    renderProgress(s);
    renderFx(s);
    renderStorage(s);
    renderSite(s.site);
    if (withSettings) renderSettings(s);
  }

  async function load(first) {
    clearTimeout(timer);
    try {
      const s = await api("/api/status");
      if (!alive) return;
      applyStatus(s);
      render(s, first);
      if (first && !s.cloud?.folder) renderPicker();
    } catch (e) {
      el.querySelector("#eps").innerHTML = `<div class="banner">无法连接本地服务：${esc(e.message)}</div>`;
    }
    timer = setTimeout(() => load(false), 5000);
  }

  renderAbout();
  loadSite(false);
  await load(true);
  return {
    destroy() {
      alive = false;
      clearTimeout(timer);
    },
  };
}

