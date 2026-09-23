/**
 * {{NAME}} — DSH 插件 · Client half（**槽位路线 / 官方接缝**）
 *   （由技能 dsh-plugin-win10 的脚手架生成，{{DATE}}；`--route slot`）
 *
 * ⚠️ 这个文件**不是**普通 ESM。客户端模块系统是**懒加载 CJS 表**，
 *    bundle 只做一件事：向 `window.__ModuleLoader__.load` 注册一个 factory。
 *
 * 与 `--route dom` 的区别：**完全不碰 DOM 结构**——不找侧边栏、不插节点、不用 MutationObserver。
 * 而是把组件注册进官方槽位，由壳自己的渲染器（React）决定它渲染在哪。
 *
 * 五条纪律：
 *   ① **绝不 throw**：Client 的 apply 抛错会让整个 Web 壳起不来。
 *   ② **副作用必须可回收**：`ctx.effect` / `slots.register` 返回的 disposer 都要交回去。
 *   ③ **注册进未声明的槽位会在 load 期抛错**；所以先 `ctx.slots.inject(key, cb)` 等声明。
 *   ④ **list 型槽位必须带 `id`**（全新 id = 加在别人旁边；复用别人的 id = 替换那一格）。
 *   ⑤ **主题令牌一律带 fallback**：`var(--dsw-alias-x, #fallback)`（令牌是运行时注入的，静态产物里查不到定义）。
 *
 * 想换接缝：改下面 `ENTRY_SLOT` 即可。可用座位与选法见技能 `references/contracts.md` §1.5；
 * **官方可抄的完整先例**见 §1.6（`dsh-client-ui-cordis` 就注册在 `sidebar.footer.action`）。
 */
window.__ModuleLoader__.load({
  id: "{{NAME}}",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    /** 平台单例：由壳提供，**不要**把 React 打进 bundle。 */
    var React = require("react");
    var h = React.createElement;

    /** 侧栏底部「设置」旁的可选动作列表（list 型，加性）。别的常用座位见 contracts §1.5。 */
    var ENTRY_SLOT = "{{SLOT}}";
    var STYLE_ID = "{{ATTR}}-style";
    var PREFIX = "{{PREFIX}}";
    var TITLE = "{{TITLE}}";
    var VERSION = "{{VERSION}}";

    var CSS = [
      ".{{ATTR}}-entry{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:12px;padding:4px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));background:transparent;color:var(--dsw-alias-label-secondary,#9aa0a6);cursor:pointer}",
      ".{{ATTR}}-entry:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,#e8e8ea)}",
      ".{{ATTR}}-entry:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f7cff);outline-offset:2px}",
      // 浮层容器不吃指针事件，卡片自己吃 —— 这样"贴着入口"的小面板不会挡住底下的界面
      ".{{ATTR}}-layer{position:fixed;z-index:2147483000;pointer-events:none}",
      ".{{ATTR}}-card{pointer-events:auto;box-sizing:border-box;padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-1,#17171a);color:var(--dsw-alias-label-primary,#e8e8ea);border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));box-shadow:0 12px 32px rgba(0,0,0,.45);font-size:12.5px;line-height:1.5}",
      ".{{ATTR}}-card h4{margin:0 0 6px;font-size:13px}",
      ".{{ATTR}}-grid{display:grid;grid-template-columns:auto 1fr;gap:2px 10px}",
      ".{{ATTR}}-k{color:var(--dsw-alias-label-secondary,#9aa0a6)}",
      ".{{ATTR}}-v{word-break:break-all}",
      ".{{ATTR}}-err{color:#e07a6a}",
    ].join("\n");

    function installStyle() {
      var old = document.getElementById(STYLE_ID);
      if (old) old.remove();
      var style = document.createElement("style");
      style.id = STYLE_ID;
      // 官方约定：客户端插件注入的 <style> 要带 data-plugin，宿主据此追踪归属并在卸载时回收
      style.setAttribute("data-plugin", "{{NAME}}");
      style.setAttribute("data-plugin-css", STYLE_ID);
      style.textContent = CSS;
      document.head.appendChild(style);
      return style;
    }

    /** 同源取数：Host 半边就是这个 {ok,data} 约定。 */
    async function api(path, init) {
      var res = await fetch(path, init);
      var json;
      try { json = await res.json(); } catch (e) { throw new Error("HTTP " + res.status + " 返回非 JSON"); }
      if (!json.ok) throw new Error(json.error || ("HTTP " + res.status));
      return json.data;
    }

    /** 浮层：贴着触发按钮定位（官方 CordisPanel 同款思路：向上展开 + 夹取到视口内）。 */
    function Panel(props) {
      var state = React.useState({ loading: true });
      var d = state[0], set = state[1];
      React.useEffect(function () {
        var alive = true;
        api(PREFIX + "/status").then(
          function (v) { if (alive) set({ loading: false, data: v }); },
          function (e) { if (alive) set({ loading: false, error: String(e.message || e) }); },
        );
        return function () { alive = false; };            // 卸载后不再 setState
      }, []);
      if (d.loading) return h("div", { className: "{{ATTR}}-card", style: props.style }, "读取中…");
      if (d.error) return h("div", { className: "{{ATTR}}-card", style: props.style },
        h("div", { className: "{{ATTR}}-err" }, "读不到 " + PREFIX + "/status：" + d.error));
      var rows = Object.keys(d.data || {}).slice(0, 8);
      return h("div", { className: "{{ATTR}}-card", style: props.style, role: "dialog", "aria-label": TITLE },
        h("h4", null, TITLE + " · v" + VERSION),
        h("div", { className: "{{ATTR}}-grid" },
          rows.map(function (k) {
            return h(React.Fragment, { key: k },
              h("div", { className: "{{ATTR}}-k" }, k),
              h("div", { className: "{{ATTR}}-v" }, String(d.data[k])));
          })));
    }

    /**
     * 入口条目。owner 只给 `wide`（侧栏是否展开）——**不要假设别的 props**。
     * 面板跟着条目自己定位，所以不需要 `shell.overlay`；要帧级浮层再单独注册那个槽位。
     */
    function ToolEntry(props) {
      var ref = React.useRef(null);
      var s = React.useState(false); var open = s[0]; var setOpen = s[1];
      var a = React.useState(null); var anchor = a[0]; var setAnchor = a[1];

      React.useEffect(function () {
        if (!open) { setAnchor(null); return undefined; }
        function place() {
          var el = ref.current;
          if (!el || typeof el.getBoundingClientRect !== "function") return;
          var r = el.getBoundingClientRect();
          var w = Math.min(380, (window.innerWidth || 1024) - 16);
          setAnchor({
            width: w,
            left: Math.max(8, Math.min(r.left, (window.innerWidth || 1024) - w - 8)),
            bottom: Math.max(8, (window.innerHeight || 768) - r.top + 8),
          });
        }
        place();
        window.addEventListener("resize", place);
        return function () { window.removeEventListener("resize", place); };
      }, [open]);

      React.useEffect(function () {
        if (!open) return undefined;
        function onKey(e) { if (e.key === "Escape") setOpen(false); }
        function onDown(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
        document.addEventListener("keydown", onKey, true);
        document.addEventListener("pointerdown", onDown, true);
        return function () {
          document.removeEventListener("keydown", onKey, true);
          document.removeEventListener("pointerdown", onDown, true);
        };
      }, [open]);

      return h(React.Fragment, null,
        h("button", {
          ref: ref, type: "button", className: "{{ATTR}}-entry", title: TITLE,
          "aria-label": TITLE, "aria-expanded": open ? "true" : "false",
          onClick: function () { setOpen(!open); },
        }, props && props.wide ? "{{LABEL}}" : "●"),
        open && anchor
          ? h("div", { className: "{{ATTR}}-layer", style: anchor }, h(Panel, { style: { width: anchor.width } }))
          : null);
    }

    /**
     * 客户端插件入口。`ctx` 是客户端 cordis 上下文。
     * `inject = ['slots']` 让框架**等服务就绪再激活**——这才是不撑爆壳的正规姿势。
     */
    function apply(ctx) {
      if (!ctx || !ctx.slots) { console.warn("[{{NAME}}] 客户端没有 slots 服务，跳过注册（Host 半边不受影响）"); return undefined; }
      var styleEl = installStyle();
      var disposers = [];

      try {
        // 等声明出现再注册：owner 与贡献者的激活顺序不保证，
        // 直接往未声明的槽位 register 会在 load 期抛错。
        ctx.slots.inject(ENTRY_SLOT, function () {
          var unregister = ctx.slots.register(
            { name: ENTRY_SLOT, id: "{{ATTR}}", order: 120 },
            ToolEntry,
          );
          disposers.push(unregister);
          return function () { unregister(); };      // 声明塌陷时自动回收
        });
      } catch (e) {
        console.warn("[{{NAME}}] 注册槽位 " + ENTRY_SLOT + " 失败：" + (e && e.message ? e.message : e));
      }

      function cleanup() {
        for (var i = 0; i < disposers.length; i += 1) { try { disposers[i](); } catch (e) { /* 忽略 */ } }
        disposers.length = 0;
        try { if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl); } catch (e) { /* 忽略 */ }
      }
      if (ctx && typeof ctx.effect === "function") ctx.effect(function () { return cleanup; }, "{{NAME}}: slot entry");
      return cleanup;
    }

    exports.name = "{{NAME}}";
    exports.inject = ["slots"];
    exports.apply = apply;
    return module.exports;
  },
});
