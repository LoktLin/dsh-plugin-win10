# A 路线范例：蛋仔控制面板（`dsh-eggy`）逐层解剖

> 这是本机**真实在跑**的一个无构建插件（29 个工具 + 一个面板），也是 A 路线（纯 JS、零依赖、不打包）的完整样本。
> 下面每一段都来自实际源码，注释里的"为什么"是踩过之后补的。

## 0. 为什么它选了无构建路线

它要解决的问题是「让 agent 别再拼 shell 命令调脚本」，顺带一个操作面板。特点：

- **单人/单机**：不需要发布、不需要别人 `npm i`；
- **内核已经在技能里**：`~/.dsh/skills/lua-eggy/scripts/lib/*.mjs` 是一整套现成实现，插件只是把它们挂到 `tools` 上；
- **迭代频繁**：Host 改完重启一次 `dsh web` 就能验证，客户端改完刷新页面就行——没有构建步骤反而更快。

代价也说清楚：**没有类型检查、没有 JSX、面板是全手写 DOM**。等它要发布或要长进官方接缝时，就该升 B 路线。

## 1. 文件布局

```
dsh-eggy/
├── package.json          # exports 两半 + dsh.bundle.patch + dsh.client
├── cordis.patch.yml      # 4 行：- insert: [{id: dsh-eggy, name: dsh-eggy}]
├── index.js              # Host 半边（1328 行）
├── lib/
│   ├── client.js         # Client 半边（1366 行，手写 CJS factory）
│   ├── backend.mjs       # 内核调度：hub 在跑走 hub，否则进程内兜底
│   ├── rpc.mjs policy.mjs ledger.mjs cdp.mjs …   # 与技能侧同一份实现
│   └── batch.mjs skill.mjs eui.mjs trigger.mjs …
└── scripts/              # 自检与回归（check-schemas / check-client / regression / selftest）
```

**值得抄的一点**：它有一整套 `scripts/check-*.mjs` + `scripts/regression.mjs`，把"契约检查"和"现场能力回归"分开跑。
插件的复杂度一旦上去，**没有自检就只能靠人肉点面板**，而人对面板的耐心是有限的。

## 2. Host 半边

### 2.1 入口与降级声明

```js
export const name = 'dsh-eggy';
/** 不硬依赖任何服务：tools / webServer 缺了就降级并打警告，绝不让插件加载失败。 */
export const inject = [];
export function apply(ctx) { /* ... */ }
```

`inject: []` 是**刻意的**。它不需要任何服务就能加载，然后逐个 `ctx.inject([...])` 惰性挂载。
好处：即便某个服务在当前部署里不存在，插件仍然装得上，面板也还能用。

### 2.2 四个惰性挂载点

```js
apply(ctx) {
  // ① 会话工作区：从 sessions 服务拿会话 cwd，给"按名定位工程目录"用
  ctx.inject(['sessions'], (c) => {
    const sessions = c.get('sessions');
    sessionCwdOf = (agent) => String(sessions.get(agent?.id)?.header?.cwd || '');
  });

  // ② 原生工具
  ctx.inject(['tools'], (c) => {
    const tools = c.get('tools');
    for (const def of TOOLS) {
      const guarded = { ...def, async execute(a, e) { return lossless(await def.execute(a, e)); } };
      c.effect(() => tools.register(guarded), `dsh-eggy: tool ${def.name}`);
    }
  });

  // ③ 系统提示补充（order 120）
  ctx.inject(['systemPrompt'], (c) => {
    c.effect(() => c.get('systemPrompt').section({ name: 'plugin:dsh-eggy', order: 120, text: EGGY_GUIDANCE }), '…');
  });

  // ④ 面板路由
  ctx.inject(['webServer'], (c) => {
    c.effect(() => c.get('webServer').register({ kind: 'prefix', path: '/eggy', handler: makeHandler() }), '…');
  });
}
```

**每个注册都包在 `c.effect(() => …, label)` 里** —— label 是排障时的唯一线索（`[dsh-eggy] 已注册 29/29 个原生工具` 这类日志也来自这里）。

### 2.3 lossless JSON 出口（必须抄）

```js
function lossless(value) {
  if (value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return Object.is(value, -0) ? 0 : value;   // -0 也不是合法 JSON
  }
  if (Array.isArray(value)) return value.map(lossless);
  if (value !== null && typeof value === 'object') {
    const out = {}; for (const k of Object.keys(value)) out[k] = lossless(value[k]); return out;
  }
  return value;
}
```

它的注释记录了这个坑的代价：**缺字段导致 `undefined`、Lua 返回 nil 导致 `NaN`、`-Math.round(0)` 得到 `-0`——三种都实测踩过**。
所有工具出口统一过它，一处漏掉就是"工具报错但看不出为什么"。

### 2.4 错误翻译

```js
function fail(prefix, error) {
  const msg = error instanceof EggyError ? error.message : String(error?.message || error);
  const extra = error instanceof EggyError && error.extra ? ` 附加信息：${JSON.stringify(error.extra).slice(0, 400)}` : '';
  const err = new Error(`[${prefix}] ${msg}${extra}`);
  err.name = 'EggyToolError';
  return err;
}
```

**给模型的错误信息要能据此自救**：带上工具名前缀、原始信息、以及一段可读的结构化附加信息。

### 2.5 路由表与信封

```js
function makeHandler() {
  return async (req, res) => {
    if (!isLocalRequest(req)) { sendJson(res, 403, { ok: false, error: '仅允许本机访问' }); return; }
    const url = new URL(req.url || '/eggy', 'http://127.0.0.1');
    const route = url.pathname.replace(/\/+$/, '') || '/eggy';
    try {
      if (route === '/eggy' || route === '/eggy/status') { sendJson(res, 200, { ok: true, data: await getHealth() }); return; }
      if (route === '/eggy/tool' && req.method === 'POST') {
        const body = await readBody(req);
        sendJson(res, 200, { ok: true, data: await runToolByName(body.name, body.args) });
        return;
      }
      // …/eggy/shot 直接回 PNG（面板做预览用）；/eggy/scene、/eggy/ledger、/eggy/lua、/eggy/rollback …
      sendJson(res, 404, { ok: false, error: '未知路由：' + route });
    } catch (e) { sendJson(res, e.status || 500, { ok: false, error: e.message }); }
  };
}
```

三个可复用的决定：

1. **统一信封 `{ok, data}` / `{ok, error}`**，客户端 `api()` 直接认——面板代码因此只有一行解包。
2. **`/eggy/tool` 复用同一份 `execute`**：面板和模型调用同一个实现，绝不会出现"面板能用、工具不能用"。
   而且工具内部抛错**不回 500**，而是回 `{ok:false,error}`，面板能把原话显示出来。
3. **本机守卫在最前面**：GUI 是 `127.0.0.1`，外部 Host 一律 403。

## 3. Client 半边

### 3.1 CJS factory 壳（照抄这一段）

```js
window.__ModuleLoader__.load({
  id: "dsh-eggy",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    /* …整个 bundle 在这里，CSS 注入也在里面（materialize 时才跑）… */
    exports.name = "dsh-eggy";
    exports.inject = [];
    exports.apply = apply;
    return module.exports;
  },
});
```

文件头注释把三条纪律写死了：**不是普通 ESM**（客户端模块系统是懒加载 CJS 表）、**不用 React**（纯 DOM）、
**失败只打日志绝不 throw**（客户端 apply 抛错会让整个 Web 壳启动失败）。

### 3.2 侧边栏入口：DOM 注入 + 双层自愈

```js
/** 侧边栏 UI 根节点。 */
// ⚠️ 选择器会随壳版本漂移（2026-09-11 复核）：当前版本的侧栏类是**哈希类名**
//    （形如 .pI_x6G_sidebarCol > .hHd-Xa_root > logoRow / newSession / regionArea / footArea），
//    `[data-pane="sidebar"]` **在当前版本已经不存在了**——这里还能跑，是因为第二个候选
//    `[class*="sidebarCol"]` 兜住了。所以 DOM 注入必须写多重候选，并且**永远留一个控制台兜底入口**
//    （如 `window.__某面板.open()`），否则壳一改结构就彻底失联且不报错。
//    想确认当前版本的真实结构：去 dsh-web-frontend 的 dist 产物或 dsh-client-ui-sidebar 的
//    客户端 bundle 里搜类名，别信旧笔记。
function sidebarRoot() {
  var column = document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]');
  if (column === null) return undefined;
  var logoRow = column.querySelector('[class*="logoRow"]');
  var logoOwner = logoRow === null ? null : logoRow.parentElement;
  return logoOwner || column.firstElementChild || undefined;
}

/** 把入口插到「新会话」下方的入口块末尾。 */
function placeEntry(root, entry) {
  var button = newSessionButton(root);                 // button[class*="newSession"] 或第一个 BUTTON 子节点
  if (button === undefined) return false;
  if (entry.parentElement === root) return true;
  var anchor = button.nextElementSibling;
  while (anchor !== null && anchor.tagName === "BUTTON") anchor = anchor.nextElementSibling;   // 走完所有插件入口
  if (anchor === null) {
    anchor = root.querySelector('[class*="regionArea"], [class*="footArea"]');
    if (anchor === null || anchor.parentElement !== root) return false;
  }
  root.insertBefore(entry, anchor);
  return true;
}
```

自愈用**两个 MutationObserver**：

```js
var waitObserver = new MutationObserver(tryPlace);            // 等侧边栏出现
waitObserver.observe(document.body, { childList: true, subtree: true });
var rootObserver = new MutationObserver(function () {          // 被 React 挤掉时当帧插回
  if (root === undefined || !root.isConnected) { placed = false; tryPlace(); return; }
  if (!root.contains(entry)) placeEntry(root, entry);
});
```

配合幂等键（`data-dsh-eggy-entry`）和 `aria-label`，并挂 `data-dsh-plugin` / `data-dsh-part="sidebar-entry"` 语义属性——
**后者是与任务看板 / SSH 等其它入口行共享的事实约定**，皮肤和兼容适配器据此识别。

> ⚠️ **但这不是最优解**。官方给了 `sidebar.footer.action`（`kind: 'list'`，加性）就是干这个的，见 `contracts.md` §1.5。
> DOM 注入是**槽位被占或不想引入 React 时的兜底**，代价是：选择器可能随壳版本失效、需要 MutationObserver、和 React 抢 DOM。

### 3.3 主题：把半透明令牌合成不透明实色

皮肤的令牌常常是半透明（`bg-overlay` 实测 ≈92% 不透明；有背景艺术时降到 ≈55%），直接当面板底色会**透出壁纸**。
它的做法是**用 JS 从主题色合成一个不透明实色**写进 `--eggy-surface`：

```js
/* 面板底色不再直接吃 --dsw-alias-bg-overlay：皮肤把它定义成半透明，
   直接当底会让面板"透"出壁纸。改成由 JS 合成不透明实色，皮肤换色相我们跟着变，但保证对比度。 */
"[" + PANEL_ATTR + "]{background-color:var(--eggy-surface,#0b0b0d);color:var(--eggy-text,#efe9dc);…}"
```

同时 `applyThemeSurfaces(root)` 跟着主题变化重算（`themeObserver` 观察 `document.documentElement`）。
**可复用的原则**：能用令牌就用令牌；令牌是半透明而你又需要实底时，**自己合成**，别把对比度交给运气。

### 3.4 面板与回收

```js
function apply(ctx) {
  if (typeof document === "undefined") return;
  if (document.querySelector("[" + PANEL_ATTR + "]") !== null || document.querySelector("[" + ENTRY_ATTR + "]") !== null) {
    console.warn("[dsh-eggy] 客户端 UI 已存在，跳过重复注入");   // 幂等
    return;
  }
  try {
    styleEl = installStyle();  panel = createPanel();
    entryHandle = mountEntry(...);  document.addEventListener("keydown", onKey, true);  // ESC 关闭
    window.__dshEggy = { open, close, toggle, version };        // 选择器失效时的兜底入口
  } catch (error) { console.error("[dsh-eggy] 客户端 UI 挂载失败：", error); return; }   // 绝不 throw

  function cleanup() { /* 逐个 try 回收：keydown、entry、panel、style、window 全局 */ }
  if (ctx && typeof ctx.effect === "function") ctx.effect(() => cleanup, "dsh-eggy: sidebar entry + panel");
  return cleanup;
}
```

`cleanup` 里每一步都单独 `try {} catch {}` —— **回收路径上不能因为一个失败就漏掉后面几个**，否则热重载一次就多一个幽灵。

## 4. 从它身上学到的三件事

1. **无构建路线的上限在哪**：面板是手写 DOM + 手写 CSS 字符串数组，1366 行里大半是样式。
   需求一旦复杂（多视图、表格、状态管理），手写 DOM 的边际成本会陡增——那时就该升 B 路线。
2. **它绕过的官方接缝，B 路线能直接拿到**：`sidebar.footer.action`（侧栏入口）、`shell.overlay`（全局浮层）。
   如果你现在新建插件，**先试槽位**，槽位不行再 DOM。
3. **它的自检体系是最大资产**：`check-schemas` / `check-client` / `regression` / `selftest` 四件套，
   把"契约有没有坏"和"现场能力还在不在"分开断言。A 路线没有类型系统兜底，**自检就是你的类型系统**。
