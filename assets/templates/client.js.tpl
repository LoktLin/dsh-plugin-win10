/**
 * {{NAME}} — DSH 插件 · Client half（浏览器侧）   （由技能 dsh-plugin-win10 的脚手架生成，{{DATE}}）
 *
 * ⚠️ 这个文件**不是**普通 ESM。客户端模块系统（`@deepseek-ai/dsh-client-modules`）是
 *    **懒加载 CJS 表**，bundle 必须向 `window.__ModuleLoader__` 注册一个 factory。
 *    所以这里手写注册壳、不经过任何打包器、**不依赖 React**（宿主不保证把 React 交给插件）。
 *
 * 四条纪律（都是实测踩出来的）：
 *   ① **绝不 throw**。Client half 的 apply 抛错会让**整个 Web 壳启动失败**——
 *      你写的只是一个面板，没资格让用户打不开界面。所有 DOM 操作都包 try/catch。
 *   ② **副作用必须可回收**。用 `ctx.effect(() => cleanup, 标签)`；否则热重载会留下幽灵入口/面板。
 *   ③ **DOM 是"别人的地盘"**。这个模板走的是 **A 路线（无构建）**，所以用 DOM 注入 + **MutationObserver 自愈**
 *      （React 重渲染会把它挤掉）。⚠️ **DOM 注入是兜底，不是首选**：
 *      官方槽位里 `sidebar.footer.action`（kind `list`）**就是**给侧栏入口留的加性座位，
 *      `shell.overlay`（kind `list`）是给浮层留的——它们都不需要你碰 DOM。
 *      要用槽位就升级到 B 路线（TS/JS + `require("react")` + `ctx.slots.register`），见 `references/standard-path.md`。
 *      （历史上 `sidebar.workspaces` / `sidebar.settings` 确实都是单占位且已被占用，但那**不等于**"没有可注册的槽位"。）
 *   ④ **主题用令牌，别写死颜色**。宿主皮肤通过 `--dsw-alias-*` 变量换肤；
 *      写死颜色会在用户的皮肤下变成一坨看不懂的东西。所有令牌都要带 fallback。
 */
window.__ModuleLoader__.load({
  id: "{{NAME}}",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    /** 幂等键 + 样式表 id：热重载时靠它们判断「已经注入过了」。 */
    var ENTRY_ATTR = "data-{{ATTR}}-entry";
    var PANEL_ATTR = "data-{{ATTR}}-panel";
    var STYLE_ID = "{{ATTR}}-style";

    /** Host 半边挂的路由前缀（必须与 index.js 里的 PREFIX 一致）。 */
    var PREFIX = "{{PREFIX}}";
    var TITLE = "{{TITLE}}";
    var VERSION = "{{VERSION}}";

    var ICON =
      '<svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" ' +
      'stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<rect x="2.2" y="3.2" width="11.6" height="9.6" rx="1.6"/>' +
      '<path d="M2.2 6.4h11.6M5.4 9.6h5.2"/></svg>';

    /* 样式全部挂在 {{ATTR}}- 前缀下，并用宿主令牌兜底：
       换皮肤时颜色跟着变，令牌缺失时也有合理默认值。 */
    var CSS = [
      "[" + ENTRY_ATTR + "]{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;height:36px;padding:0 10px;background:transparent;border:none;border-radius:8px;color:var(--dsw-alias-label-secondary,#9aa0a6);cursor:pointer;font:inherit;font-size:13px;white-space:nowrap;text-align:left}",
      "[" + ENTRY_ATTR + "]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,#e8e8ea)}",
      "[" + ENTRY_ATTR + "][data-active]{background:var(--dsw-alias-interactive-bg-active,rgba(127,127,127,.2));color:var(--dsw-alias-label-primary,#e8e8ea);font-weight:600}",
      "[" + ENTRY_ATTR + "]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f7cff);outline-offset:2px}",
      ".{{ATTR}}-icon{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;flex:none}",
      ".{{ATTR}}-icon svg{display:block;width:18px;height:18px}",
      ".{{ATTR}}-label{overflow:hidden;text-overflow:ellipsis}",
      "[data-sidebar-collapsed] [" + ENTRY_ATTR + "]{justify-content:center;padding:0;width:36px;height:36px;margin:0 auto 12px;border-radius:50%}",
      "[data-sidebar-collapsed] .{{ATTR}}-label{display:none}",

      "[" + PANEL_ATTR + "]{position:fixed;z-index:2147483000;left:50%;transform:translateX(-50%);top:52px;width:min(720px,94vw);height:min(72vh,720px);display:flex;flex-direction:column;box-sizing:border-box;background:var(--dsw-alias-bg-layer-1,#17171a);color:var(--dsw-alias-label-primary,#e8e8ea);border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:12px;box-shadow:0 18px 48px rgba(0,0,0,.55);font-size:13px;line-height:1.5;overflow:hidden}",
      "[" + PANEL_ATTR + "][hidden]{display:none!important}",
      ".{{ATTR}}-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22));flex:none}",
      ".{{ATTR}}-title{font-weight:700}",
      ".{{ATTR}}-spacer{flex:1}",
      ".{{ATTR}}-badge{font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));color:var(--dsw-alias-label-secondary,#9aa0a6)}",
      ".{{ATTR}}-btn{font:inherit;font-size:12px;padding:4px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));background:transparent;color:inherit;cursor:pointer}",
      ".{{ATTR}}-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}",
      ".{{ATTR}}-btn:disabled{opacity:.45;cursor:default}",
      ".{{ATTR}}-btn.{{ATTR}}-primary{background:var(--dsw-alias-brand-primary,#4f7cff);border-color:transparent;color:#fff;font-weight:600}",
      ".{{ATTR}}-body{flex:1;min-height:0;overflow:auto;padding:10px 12px;display:flex;flex-direction:column;gap:10px}",
      ".{{ATTR}}-sec{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22));background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.07))}",
      ".{{ATTR}}-sec-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#9aa0a6)}",
      ".{{ATTR}}-grid{display:grid;grid-template-columns:auto 1fr;gap:3px 10px;font-size:12px}",
      ".{{ATTR}}-k{color:var(--dsw-alias-label-secondary,#9aa0a6)}",
      ".{{ATTR}}-v{word-break:break-all}",
      ".{{ATTR}}-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px;vertical-align:middle;background:var(--dsw-alias-label-secondary,#9aa0a6)}",
      ".{{ATTR}}-dot.ok{background:#7fd18a}",
      ".{{ATTR}}-dot.err{background:#e07a6a}",
      ".{{ATTR}}-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}",
      ".{{ATTR}}-ta,.{{ATTR}}-sel{box-sizing:border-box;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;padding:6px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));background:var(--dsw-alias-bg-layer-1,transparent);color:inherit;width:100%}",
      ".{{ATTR}}-ta{min-height:76px;resize:vertical}",
      ".{{ATTR}}-out{margin:0;padding:8px;max-height:240px;overflow:auto;white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));border-radius:6px}",
      ".{{ATTR}}-out:empty{display:none}",
      ".{{ATTR}}-hint{font-size:11px;color:var(--dsw-alias-label-secondary,#9aa0a6)}",
    ].join("\n");

    /** 侧边栏 UI 根节点（当前壳：column > wrapper > 根；旧壳：column 第一个子元素）。 */
    function sidebarRoot() {
      var column = document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]');
      if (column === null) return undefined;
      var logoRow = column.querySelector('[class*="logoRow"]');
      var logoOwner = logoRow === null ? null : logoRow.parentElement;
      return logoOwner || column.firstElementChild || undefined;
    }

    /** 「新会话」按钮：当前壳在根下直接作为按钮兄弟，旧壳在 logo 行里。 */
    function newSessionButton(root) {
      var nested = root.querySelector('button[class*="newSession"]');
      if (nested !== null) return nested;
      for (var i = 0; i < root.children.length; i++) {
        if (root.children[i].tagName === "BUTTON") return root.children[i];
      }
      return root.querySelector("button") || undefined;
    }

    /**
     * 把入口行插到「新会话」下方的插件入口块**末尾**。
     * 不依赖别的插件用了什么属性名：从「新会话」往后走完所有按钮兄弟，
     * 插在第一个非按钮兄弟之前 —— 因此永远落在入口块最后一行，别的插件自愈重排也不会让顺序乱跳。
     */
    function placeEntry(root, entry) {
      var button = newSessionButton(root);
      if (button === undefined) return false;
      if (entry.parentElement === root) return true;
      var anchor = button.nextElementSibling;
      while (anchor !== null && anchor.tagName === "BUTTON") anchor = anchor.nextElementSibling;
      if (anchor === null) {
        anchor = root.querySelector('[class*="regionArea"], [class*="footArea"]');
        if (anchor === null || anchor.parentElement !== root) return false;
      }
      root.insertBefore(entry, anchor);
      return true;
    }

    /** 入口行 + 自愈。返回 { syncActive, dispose }。 */
    function mountEntry(onToggle, isOpen) {
      var noop = { syncActive: function () {}, dispose: function () {} };
      if (document.querySelector("[" + ENTRY_ATTR + "]") !== null) return noop;

      var entry = document.createElement("button");
      entry.type = "button";
      entry.setAttribute(ENTRY_ATTR, "");
      // L2 语义属性：与任务看板 / SSH 等入口行保持一致，皮肤与兼容适配器据此识别
      entry.setAttribute("data-dsh-plugin", "{{ATTR}}");
      entry.setAttribute("data-dsh-part", "sidebar-entry");
      entry.setAttribute("aria-label", TITLE);
      entry.setAttribute("title", TITLE);
      var iconSpan = document.createElement("span");
      iconSpan.className = "{{ATTR}}-icon";
      iconSpan.innerHTML = ICON;
      var labelSpan = document.createElement("span");
      labelSpan.className = "{{ATTR}}-label";
      labelSpan.textContent = "{{LABEL}}";
      entry.append(iconSpan, labelSpan);
      entry.addEventListener("click", onToggle);

      var root;
      var placed = false;
      var rootObserver = { disconnect: function () {}, observe: function () {} };

      function tryPlace() {
        if (root !== undefined && !root.isConnected) {
          rootObserver.disconnect();
          root = undefined;
          placed = false;
        }
        if (root !== undefined && placed) {
          if (document.body.contains(entry)) return;
          rootObserver.disconnect();
          root = undefined;
          placed = false;
        }
        if (root === undefined) root = sidebarRoot();
        if (root === undefined) return;
        try {
          placed = placeEntry(root, entry);
          if (placed && typeof MutationObserver === "function") {
            rootObserver.observe(root, { childList: true, subtree: true });
          }
        } catch (error) {
          console.warn("[{{NAME}}] 入口插入失败：", error);
        }
      }

      // React 每次重渲染都可能把我们的 DOM 挤掉 —— 两层的自愈：
      // waitObserver 等侧边栏出现；rootObserver 在它被改动时立刻插回（同一帧，无闪烁）。
      var waitObserver = null;
      if (typeof MutationObserver === "function") {
        waitObserver = new MutationObserver(function () { tryPlace(); });
        waitObserver.observe(document.body, { childList: true, subtree: true });
        rootObserver = new MutationObserver(function () {
          if (root === undefined || !root.isConnected) { placed = false; tryPlace(); return; }
          if (!root.contains(entry)) {
            try { placed = placeEntry(root, entry); } catch (error) { console.warn("[{{NAME}}] 入口重插失败：", error); }
          }
        });
      }

      function syncActive() {
        if (isOpen()) entry.setAttribute("data-active", "true");
        else entry.removeAttribute("data-active");
      }

      tryPlace();
      syncActive();

      return {
        syncActive: syncActive,
        dispose: function () {
          if (waitObserver !== null) waitObserver.disconnect();
          rootObserver.disconnect();
          entry.removeEventListener("click", onToggle);
          entry.remove();
        },
      };
    }

    /** 统一的面板请求：同源 fetch + 解 `{ok,data}` 信封。Host 半边就是这个约定。 */
    async function api(path, init) {
      var res = await fetch(path, init);
      var json;
      try { json = await res.json(); } catch (error) { throw new Error("HTTP " + res.status + " 返回非 JSON"); }
      if (!json.ok) throw new Error(json.error || ("HTTP " + res.status));
      return json.data;
    }

    function el(tag, cls, text) {
      var node = document.createElement(tag);
      if (cls) node.className = cls;
      if (text !== undefined) node.textContent = text;
      return node;
    }

    /** 面板：一行状态 + 一个「试跑工具」区（面板与工具共用同一份 Host 实现）。 */
    function createPanel() {
      var existing = document.querySelector("[" + PANEL_ATTR + "]");
      if (existing !== null) existing.remove();

      var panel = el("div");
      panel.setAttribute(PANEL_ATTR, "");
      panel.hidden = true;
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-label", TITLE);

      // ---- header ----
      var head = el("div", "{{ATTR}}-head");
      var title = el("span", "{{ATTR}}-title", TITLE);
      var badge = el("span", "{{ATTR}}-badge", "v" + VERSION);
      var spacer = el("div", "{{ATTR}}-spacer");
      var refreshBtn = el("button", "{{ATTR}}-btn", "刷新");
      refreshBtn.type = "button";
      var closeBtn = el("button", "{{ATTR}}-btn", "关闭");
      closeBtn.type = "button";
      head.append(title, badge, spacer, refreshBtn, closeBtn);

      // ---- body ----
      var body = el("div", "{{ATTR}}-body");

      var statusSec = el("div", "{{ATTR}}-sec");
      statusSec.append(el("div", "{{ATTR}}-sec-title", "状态"));
      var grid = el("div", "{{ATTR}}-grid");
      statusSec.append(grid);

      var toolSec = el("div", "{{ATTR}}-sec");
      toolSec.append(el("div", "{{ATTR}}-sec-title", "试跑工具"));
      var sel = el("select", "{{ATTR}}-sel");
      var ta = el("textarea", "{{ATTR}}-ta");
      ta.placeholder = '{"text":"hello"}';
      var runRow = el("div", "{{ATTR}}-row");
      var runBtn = el("button", "{{ATTR}}-btn {{ATTR}}-primary", "运行");
      runBtn.type = "button";
      var out = el("pre", "{{ATTR}}-out");
      runRow.append(runBtn);
      var hint = el("div", "{{ATTR}}-hint", "参数是 JSON 对象；面板走 Host 的 " + PREFIX + "/tool，与模型调用同一份 execute。");
      toolSec.append(sel, ta, runRow, out, hint);

      body.append(statusSec, toolSec);
      panel.append(head, body);

      var refs = {
        grid: grid, sel: sel, ta: ta, out: out,
        refresh: refreshBtn, run: runBtn, close: closeBtn, hint: hint,
      };
      var onStateChange = null;
      var state = { open: false, loadedTools: false };

      function renderStatus(d) {
        grid.textContent = "";
        var rows = [
          ["插件", d.plugin || "{{NAME}}"],
          ["版本", d.version || VERSION],
          ["进程", d.pid === undefined ? "-" : String(d.pid)],
          ["已运行", (d.uptimeSec === undefined ? "-" : d.uptimeSec + "s")],
          ["工具", (d.tools || []).join(", ") || "-"],
        ];
        rows.forEach(function (pair) {
          grid.append(el("div", "{{ATTR}}-k", pair[0]), el("div", "{{ATTR}}-v", pair[1]));
        });
      }

      async function refresh() {
        refs.refresh.disabled = true;
        refs.hint.textContent = "读取中…";
        try {
          var d = await api(PREFIX + "/status");
          renderStatus(d);
          refs.hint.textContent = "已连接（" + PREFIX + "/status）";
          if (!state.loadedTools) {
            try {
              var t = await api(PREFIX + "/tools");
              (t.tools || []).forEach(function (tool) {
                var opt = el("option", null, tool.name);
                opt.value = tool.name;
                refs.sel.append(opt);
              });
              state.loadedTools = true;
            } catch (error) { /* 工具列表拿不到不影响状态显示 */ }
          }
        } catch (error) {
          refs.grid.textContent = "";
          refs.grid.append(
            el("div", "{{ATTR}}-k", "连接"),
            el("div", "{{ATTR}}-v", "读不到 " + PREFIX + "/status —— 若刚改过插件代码，host 侧是启动时快照，需要重启 dsh web；只改 client.js 也要刷新页面。"),
          );
          refs.hint.textContent = String(error.message || error);
        } finally {
          refs.refresh.disabled = false;
        }
      }

      async function runTool() {
        refs.run.disabled = true;
        refs.out.textContent = "运行中…";
        var args = {};
        var raw = String(refs.ta.value || "").trim();
        if (raw) {
          try { args = JSON.parse(raw); } catch (error) { refs.out.textContent = "参数不是合法 JSON：" + error.message; refs.run.disabled = false; return; }
        }
        try {
          var d = await api(PREFIX + "/tool", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: refs.sel.value, args: args }),
          });
          refs.out.textContent = d.ok ? JSON.stringify(d.data, null, 1) : ("工具返回错误：" + d.error);
        } catch (error) {
          refs.out.textContent = "请求失败：" + String(error.message || error);
        } finally {
          refs.run.disabled = false;
        }
      }

      function onRefreshClick() { void refresh(); }
      function onRunClick() { void runTool(); }
      function onCloseClick() { close(); }
      refreshBtn.addEventListener("click", onRefreshClick);
      runBtn.addEventListener("click", onRunClick);
      closeBtn.addEventListener("click", onCloseClick);

      return {
        element: panel,
        set onStateChange(fn) { onStateChange = fn; },
        isOpen: function () { return state.open; },
        open: function () {
          state.open = true;
          panel.hidden = false;
          if (onStateChange) onStateChange();
          void refresh();
        },
        close: function () {
          state.open = false;
          panel.hidden = true;
          if (onStateChange) onStateChange();
        },
        toggle: function () { if (state.open) this.close(); else this.open(); },
        destroy: function () {
          refreshBtn.removeEventListener("click", onRefreshClick);
          runBtn.removeEventListener("click", onRunClick);
          closeBtn.removeEventListener("click", onCloseClick);
          panel.remove();
        },
      };
    }

    function installStyle() {
      var old = document.getElementById(STYLE_ID);
      if (old !== null) old.remove();
      var style = document.createElement("style");
      style.id = STYLE_ID;
      // 官方约定：客户端插件注入的 <style> 带 `data-plugin` 标记（dsh-client-modules 按它追踪
      // 「这个模块拥有的样式」并在卸载时回收）。不加也不报错，但加了才能被宿主正确纳管。
      style.setAttribute("data-plugin", "{{NAME}}");
      style.setAttribute("data-plugin-css", STYLE_ID);
      style.textContent = CSS;
      document.head.appendChild(style);
      return style;
    }

    /**
     * 客户端插件入口。`ctx` 是客户端 cordis 上下文（至少要有 effect()）。
     * 全程 try/catch：这里抛错会拖垮整个 Web 壳。
     */
    function apply(ctx) {
      if (typeof document === "undefined") return;
      if (document.querySelector("[" + PANEL_ATTR + "]") !== null || document.querySelector("[" + ENTRY_ATTR + "]") !== null) {
        console.warn("[{{NAME}}] 客户端 UI 已存在，跳过重复注入");
        return;
      }

      var styleEl, panel, entryHandle, onKey;
      var disposed = false;

      try {
        styleEl = installStyle();
        panel = createPanel();
        document.body.appendChild(panel.element);
        entryHandle = mountEntry(function () { panel.toggle(); }, function () { return panel.isOpen(); });
        panel.onStateChange = entryHandle.syncActive;

        onKey = function (event) {
          if (event.key === "Escape" && panel.isOpen()) panel.close();
        };
        document.addEventListener("keydown", onKey, true);

        // 兜底入口：侧边栏选择器若在未来壳版本上失效，控制台仍可 window.{{GLOBAL}}.open()
        // （对象名必须是**合法 JS 标识符** —— 插件名里的连字符不能直接拼进去）
        window.{{GLOBAL}} = {
          open: function () { panel.open(); },
          close: function () { panel.close(); },
          toggle: function () { panel.toggle(); },
          version: VERSION,
        };
      } catch (error) {
        console.error("[{{NAME}}] 客户端 UI 挂载失败：", error);
        return;
      }

      function cleanup() {
        if (disposed) return;
        disposed = true;
        try { document.removeEventListener("keydown", onKey, true); } catch (error) { /* 忽略 */ }
        try { if (entryHandle) entryHandle.dispose(); } catch (error) { /* 忽略 */ }
        try { if (panel) panel.destroy(); } catch (error) { /* 忽略 */ }
        try { if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl); } catch (error) { /* 忽略 */ }
        try { delete window.{{GLOBAL}}; } catch (error) { window.{{GLOBAL}} = undefined; }
      }

      if (ctx && typeof ctx.effect === "function") {
        ctx.effect(function () { return cleanup; }, "{{NAME}}: sidebar entry + panel");
      }
      return cleanup;
    }

    exports.name = "{{NAME}}";
    exports.inject = [];
    exports.apply = apply;
    return module.exports;
  },
});
