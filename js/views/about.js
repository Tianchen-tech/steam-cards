// 网页版的「关于本站」：数据更新时间与收录范围、访客自己的显示偏好（存在浏览器里）、数据口径
import { ago, api, applyStatus, count, every, state, store } from "../core.js";
import { tile, toast } from "../ui.js";
import { aboutHtml } from "./status.js";

function when(ts) {
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export async function mount(el) {
  const s = state.status;
  const db = s.db || {};
  const def = s.defaults;
  el.innerHTML = `
    <div class="page-head"><div><h1>关于本站</h1>
      <p class="sub">这是「Steam 卡牌行情」的只读网页版：站长的电脑定时从 Steam 社区市场的公开接口采集卡牌价格，约${every(s.interval_min)}发布一次到这里。价格仅供参考，买卖以 Steam 市场为准。</p></div></div>
    <div class="tiles">
      ${tile("数据更新于", when(s.generated_at), ago(s.generated_at))}
      ${tile("收录卡牌", `${count(db.items)} 张`, `其中闪卡 ${count(db.foil)} 张`)}
      ${tile("涉及游戏", `${count(db.games)} 款`, "")}
      ${tile("有 Steam 成交历史", `${count(db.with_history)} 张`, "可以看 7 / 30 / 90 天走势")}
    </div>
    <section class="panel" style="margin-top:16px">
      <div class="panel-head"><h2>显示偏好</h2><span class="hint">只保存在这个浏览器里</span></div>
      <form id="pref" class="form-grid">
        <div class="field"><label for="p-cur">显示货币</label>
          <select id="p-cur" name="currency"><option value="CNY">人民币 CNY</option><option value="USD">美元 USD</option></select>
          <div class="help">人民币按 Steam 自己的汇率换算</div></div>
        <div class="field"><label for="p-up">涨跌颜色</label>
          <select id="p-up" name="up_color"><option value="red">红涨绿跌（国内习惯）</option><option value="green">绿涨红跌（国际习惯）</option></select></div>
        <div class="field"><label for="p-theme">外观</label>
          <select id="p-theme" name="theme"><option value="auto">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></div>
      </form>
      <p class="note">关注列表和目标价提醒也只保存在这个浏览器里：换浏览器、用无痕模式或清除网站数据后就没了。</p>
    </section>
    <section class="panel">${aboutHtml(true)}</section>
    <p class="foot-note">本站与 Valve、Steam 没有关系，只展示 Steam 社区市场公开的价格数据，不登录账号、不进行任何交易。</p>`;

  const form = el.querySelector("#pref");
  form.currency.value = s.display.currency;
  form.up_color.value = s.settings.up_color;
  form.theme.value = store("sct-theme") || "auto";
  form.addEventListener("change", async (e) => {
    const field = e.target.name;
    if (field === "theme") {
      const t = e.target.value;
      store("sct-theme", t);
      if (t === "auto") delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = t;
    } else {
      // 和站长的默认设置一样就不单独记，站长以后改了默认值也能跟着变
      const pref = store("sct-pref") || {};
      const value = e.target.value;
      if (value === (field === "currency" ? def.currency : def.up_color)) delete pref[field];
      else pref[field] = value;
      store("sct-pref", pref);
      applyStatus(await api("/api/status"));
    }
    toast("已保存");
  });
  return {};
}
