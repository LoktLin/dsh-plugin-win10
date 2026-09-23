# 权威契约（从本机安装版本取证）

> **版本锚点**：本文所有具体值（槽位名、选择器、令牌、类名）取证自
> **`@deepseek-ai/dsh` 0.1.2-rc.1 · 复核于 2026-09-11**。
> ⚠️ **具体值会随版本漂移，且是老实话里最容易害人的东西**——实测就踩过两次：
> `[data-pane="sidebar"]` 在新版**已失效**、profile 的 `patchReload` 决定 patch 要不要重启。
> 所以**用之前按 §0 复核一遍**；写给别人用的文档里，凡具体值都应带上这种版本锚点。
>
> 本文件的每一条都来自**本机实际安装的 `*.d.ts` 与前端产物**，不是回忆、不是博客。

## 0. 取证方法（比读文档更可靠）

```powershell
# ⚠️ 用 `npm root -g` 现算，**别照抄别人的安装路径**（原作者机器上是 D:\Program Files\nodejs\node_global\node_modules）
$base = Join-Path (npm root -g) '@deepseek-ai\dsh\node_modules\@deepseek-ai'

# ① 谁声明了槽位？（SlotMap 是手写的空接口，靠 declare module 合并 → 每个提供方一个文件）
Get-ChildItem $base -Recurse -File -Include *.d.ts | Select-String -Pattern "interface SlotMap" -List

# ② 某个槽位的 kind / scope / owner props 精确契约
Get-Content "$base\dsh-client-ui-sidebar\lib\types\client\contract\slots.d.ts" -Raw

# ③ 服务与事件的契约
Get-Content "$base\dsh-host-webserver\lib\types\index.d.ts" -Raw
Get-Content "$base\dsh-client-ui-renderer\lib\types\client\registry.d.ts" -Raw
```

这些 `.d.ts` 的注释写得非常细——**为什么这么设计、什么情况会抛错**都在里面。读类型注释往往比读 README 更快拿到事实。

## 1. 槽位系统（`ctx.slots`）

### 1.1 四种 kind

| kind | 语义 | 注册时必须给 |
|---|---|---|
| `single` | 唯一占位：只允许一个占用者 | —（同 cell 同 `priority` 会抛错） |
| `list` | 有序列表：多个条目共存 | **`id`**（可选 `order`、`label`） |
| `keyed` | 按 key 分派：同 key 只渲染一个 | **`key`** |
| `chain` | 自我选举：按 `priority` 升序跑 `select`，第一个非 null 胜出 | **`select`** |

`priority` 还用于 **cell 隐藏**：同一 cell 内同 priority 重复注册会抛错。

### 1.2 四份 props 份额

每个注册进去的组件收到的 props 由四份合成：

1. **runtime 份额** —— 父级 `renderSlot` 调用点给的 `owner`，加上会话标准件与全局座位；
2. **child-render 份额** —— `renderSlot`，静态收窄到你声明的 children 键；
3. **store 份额** —— store handle 的 selector hook + 去掉草稿的动作集；
4. **business 份额** —— 由 `inject` 工厂的返回值推断。

组件引用 `ComposedProps`，**不要自己重述某一份额**。

### 1.3 声明即认领（最容易踩的红线）

- **声明一个槽位 = 独占它的渲染权**。往已声明槽位再注册→抛错；向**未声明**的槽位注册→抛错。
- 声明一个**已被声明**的 child → 抛错；同一个共享 handle 挂到两个 scope 下 → 抛错。
- **`chain` 没有 `select` → 加载期抛错**。
- 一个 entry 的 disposer 会**递归塌陷它声明的所有子槽位**（ledger 行、贡献、store 挂载一起走）。

所以：**别碰 `root`**。它是 shell 自己渲染的唯一槽位，`ui-layout` 的 AppFrame 占着它，并且声明了 `sidebar` / `conversation` / `details` / `shell.overlay`。
往 `root` 注册不会"并排显示"，而是**遮蔽整个 AppFrame**——页面只剩你的组件。要自己的全局浮层就注册 `shell.overlay`。

### 1.4 注册写法

```js
// 等声明出现再注册（owner 与贡献者的激活顺序不保证）
ctx.slots.inject('sidebar.footer.action', () => {
  const unregister = ctx.slots.register(
    { name: 'sidebar.footer.action', id: 'mytool', order: 110, locale: NS,
      inject: () => ({ /* 你的 business 份额 */ }) },
    MyFooterAction,          // 组件
  );
  return () => unregister();  // 别忘返回 disposer
});
```

- `ctx.slots.inject(key, cb)`：声明已存在时**同步**执行 cb；否则在声明提交后执行。塌陷时会 dispose 你的 effect，之后再声明会再跑一次。
- `ctx.slots.register(spec, Component)` 的返回是 disposer；**把它串进 `ctx.effect`**，否则插件卸载后条目会残留。

### 1.5 本机实测槽位目录

> kind/scope 标了 `✓` 的是我实际读过契约确认的；其余只确认了键名，用之前请查对应包的 `contract/slots.d.ts`。

**顶层布局（`ui-layout` 声明）**

| 槽位 | kind | scope | 说明 |
|---|---|---|---|
| `root` | single ✓ | root ✓ | **别注册**，会遮蔽 AppFrame |
| `sidebar` | single ✓ | root ✓ | 整个左栏；已被 `ui-sidebar` 占（注册=替换导航栏） |
| `conversation` | single ✓ | session-maybe ✓ | 整个中栏；已被 `ui-conversation` 占 |
| `details` | single ✓ | session ✓ | 右栏；已被 `ui-conversation` 的 DetailsPanel 占 |
| **`shell.overlay`** | **list** ✓ | root ✓ | **★ 全局浮层**，帧级、在所有栏之上、**默认点击穿透**（条目自己 opt-in pointer events）。要自己的浮层就放这 |

**侧边栏（`ui-sidebar` 声明，★ 加侧栏入口的正解）**

| 槽位 | kind | scope |
|---|---|---|
| `sidebar.brand.mark` | single ✓ | root ✓ |
| `sidebar.brand.name` | single ✓ | root ✓ |
| `sidebar.workspaces` | single ✓ | root ✓ | 已被 `ui-workspace` 占 |
| `sidebar.settings` | single ✓ | root ✓ | 已被 `ui-settings` 占 |
| **`sidebar.footer.action`** | **list** ✓ | root ✓ | **★ 侧栏底部「设置」旁的可选动作列表** —— 第三方入口的标准座位（owner 只给 `wide` 列状态） |

**会话区（`ui-conversation` / `ui-chat` 声明）**

`conversation.session` · `conversation.session.header` · `.header.lineage` · `.header.actions` · `.header.utilities` ·
`conversation.view` · `conversation.composer` · `conversation.composer.dock` · `conversation.composer.bar` ·
`conversation.hero.workspace` · `conversation.hero.brand.mark` · `conversation.hero.agentPreset` ·
`conversation.input.dock` · `conversation.input.overlay` · `conversation.input.left` · `conversation.input.right` ·
`conversation.input.attachments` · `conversation.input.plan` · `conversation.input.model` ·
`conversation.chat.node` · `conversation.chat.commandview` · `conversation.chat.turnTail` · `conversation.chat.assistant-actions` ·
`conversation.message.images` · `conversation.details.tool` · `conversation.trajectory.images` · `conversation.approval.detail`

**设置页（`ui-settings` / `ui-settings-*` 声明）**

`settings.trigger` · `settings.header` · `settings.action` · `settings.close` · `settings.section` ·
`settings.plugins.tab` · `settings.onboarding` · `settings.general.item` · `settings.plugin.item` ·
`settings.models.provider-card` · `settings.models.footer`

**工具调用视图**

`tool.call.toolview` · `tool.view.cordis`

**目录选择流的两个钩子**

`sidebar.workspaces.directoryFlow` · `conversation.hero.workspace.directoryFlow`

> **选接缝的经验**：要「加个入口」找 `*.footer.action` / `*.actions` 这类 **list**；要「加个浮层」用 `shell.overlay`；要「加个设置块」用 `settings.section` / `settings.plugins.tab`。
> **看到 `single` 就要警惕**：它几乎总是已经被正式插件占了，注册等于替换它。

### 1.6 直接抄官方先例（最省事的一条路）

**`dsh-client-ui-cordis` 就是 `sidebar.footer.action` 的真实占用者**，它的整个实现可以直接当模板抄：

| 抄什么 | 在哪 |
|---|---|
| 注册同一个槽位 | `dsh-client-ui-cordis/lib/client.js` 里 `ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({...}, Component))` |
| **浮层怎么定位** | 同文件的 `CordisPanel`：用触发按钮的 `getBoundingClientRect()` 算锚点（如 `{ left, bottom: innerHeight - rect.top + 8 }` 向上展开），并在 resize 时重算 |
| **点外关闭** | 它用的是官方 `useDismissOnOutsidePointer(rootRef, open, setOpen)` ——**别自己写 document listener** |
| **面板挂在哪** | 面板是触发器 `rootRef` 的**子元素**（不是 body portal），配 `position:fixed` + inline style；容器 `pointer-events:none`、卡片 `auto` |
| 壳怎么渲染这个槽位 | `dsh-client-ui-sidebar/lib/client.js` 里 `renderSlot("sidebar.footer.action", { wide })`，宽态整行、轨道态 36×36 圆形居中 |

**结论：写之前先去 `node_modules/@deepseek-ai/` 里找"谁已经注册了这个槽位"，把它的实现读一遍。** 官方插件本身就是最好的文档，而且一定与你装的版本一致。

### 1.7 注册期会被运行期校验拦下的几件事

浏览器 bundle 里 `SlotCore.register` 的校验是**运行时**执行的（不是只靠类型），实测报错原文形如
`list slot "<name>" requires options.id`。`options` 只认这几个字段：**`{ key, id, order, label, priority }`**。
另外：往**未声明**的槽位注册、声明一个**已被声明**的 child、`chain` 少 `select`、同一 cell 同 `priority` —— 都在 **load 期抛错**（不是渲染期，所以会直接表现为插件起不来）。

### 1.8 客户端能 `require` 什么（平台 seed 白名单）

浏览器模块表只回答**平台单例**和**图里声明过的插件行**。本机实测出现在 seed 表里的有：

```
react · react/jsx-runtime · react-dom · react-dom/client · @deepseek-ai/cordis
@deepseek-ai/dsh-client-ui-primitives      ← 官方 UI 原语库（见下）
```

**`@deepseek-ai/dsh-client-ui-primitives` 值得单独记住**：它提供 `useDismissOnOutsidePointer`、`useAnchoredPosition`、`Modal`、`Button`、`Icon*` 等——
**这些正是"入口 + 浮层"所需要的**。手写 `document.addEventListener('pointerdown')` 和浮层定位之前，先看它有没有现成的。
⚠️ 注意它**不在 `node_modules/@deepseek-ai/` 下单独安装**（内联进了前端产物），所以类型不一定能直接 import，但**运行时 `require("…primitives")` 是通的**。

### 1.9 主题令牌必须带 fallback

实测：`--dsw-alias-label-primary` 在前端静态产物里**被使用 31 次、定义 0 次**——它们是**运行时注入**的。
所以：

- 任何时候都写 `var(--dsw-alias-label-primary, #e8e8ea)` —— **永远带 fallback**；
- 不要假设某个令牌一定存在；令牌缺失时页面不该变成一片透明或纯黑；
- 想拿当前真实值，去前端产物里搜 `--dsw-alias-` 的**注入点**，别猜。

## 2. HTTP 路由（`ctx.webServer`）

```ts
register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req, res) => void | Promise<void> }): () => void
```

- `kind: 'exact'` 逐字匹配；`'prefix'` 匹配 `p` 与 `p/<anything>`。**path 是绝对路径且不能带尾斜杠**。
- **重复的 `(kind, path)` 会抛错**——路由模式是组合期契约，冲突即配置错误。
- handler **拥有完整的响应生命周期**（要开 SSE 就自己持有 `res`）。它就是裸 Node `(req, res)`。
- 还有 `registerUpgrade`（WebSocket 升级）、`registerFallback`（兜住所有未匹配请求，**只有一个所有者**，SPA dist server 占着它）、`tapIndex`（index.html 的 html→html 变换）。
- `webserver/index-inject` 事件：每渲染一次 index 就 emit，监听者把自己的行推上去——这是往 `<head>` 注入脚本/数据的正规通道。

三条实践要求：

1. **显式缓存策略**：实时/敏感快照用 `Cache-Control: no-store`；可重验证的用 `no-cache`。
2. **明确的 4xx/5xx**：path 解码、body 解析、handler 里的 rejection 都要转成状态码，别让它变成未处理 rejection。
3. **最小暴露**：涉及本机能力时收敛到回环地址（检查 `req.headers.host` 只允许 `127.0.0.1` / `localhost` / `::1`），并对方法做白名单。骨架里的 `isLocalRequest()` 就是这件事。

## 3. 工具（`ctx.tools.register`）

```js
ctx.tools.register({
  name, description,
  parameters,                     // JSON Schema（隐式开放对象根；必填用属性内联 required: true）
  output: { schema, render },     // schema 在注册期被校验；render 给模型稳定紧凑的文本
  async execute(args, exec) { },  // exec.agent 拿当前会话/工作区；exec.signal 要转发/观察
})
```

- 返回 disposer；用 `ctx.effect(() => tools.register(def), 'label')` 串起来。
- **返回值必须 lossless JSON**：`undefined` / `NaN` / `Infinity` / `-0` 宿主直接拒收整条结果，报
  `returned invalid output: value is not lossless JSON`。所有出口过一层 `lossless()`。
- **schema 写坏会在注册期炸**，严重时连"发消息"都失败（曾把 `description` 误写成 `properties` 字段，
  宿主 `assertObjectJsonSchema` 抛错）。改完跑自检。
- `description` 要写清**何时调用、前置条件、失败语义、副作用**——这是模型唯一能看到的说明书。

## 4. 客户端声明与生命周期

`package.json`：

```jsonc
{
  "type": "module",
  "main": "./index.js",
  "exports": {
    ".":        { "default": "./index.js" },
    "./client": { "default": "./lib/client.js" },   // 客户端半边入口，必须有真实文件
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },     // 挂在哪个 patch 层
    "client": {
      "platform": "web",
      "inject": [],                                  // 随图下发的信息性元数据（预检/HMR diff 用）
      "immediately": false                           // 仅启动关键入口才开；普通插件别开
    }
  }
}
```

要点：

- **client 包必须同时有** `dsh.client.platform: "web"` **和真实存在的** `exports["./client"]`。缺一个 → 启动期聚合抛错（FAILED fiber）。
- `dsh.client.inject` **不决定** client fiber 的激活顺序——真正的依赖等待来自客户端 bundle 导出的 `export const inject`。两者不互相替代。
- `inject` 里写的是**官方包名**（如 `@deepseek-ai/dsh-client-ui-renderer`），与本插件的 npm 依赖同一套名字。
- **没有 Web 需求就不要声明 `dsh.client`**，也别构建 client bundle。
- 客户端 bundle 在**激活时被读进内存**（`initialBundleSnapshot`）；只有 bundle 内容变化能走 HMR，
  `package.json` / `exports` / 插件集合 / host 代码变化都要重启。

## 5. Patch 与 profile

`cordis.patch.yml`（插件自带，随包发布）：

```yaml
- insert:
    - id: dsh-mytool          # 配置树里稳定的行身份（覆盖/禁用都按它）
      name: dsh-mytool        # 可解析的包名或导出路径
      config: {}              # 可选；被上层按 id 覆盖时是整段替换，不是深合并
```

- 必须是**顶层数组**。后层按 `id` 覆盖前层。
- 生效顺序：**profile bundles → profile `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch`**（最后者胜）。
- 包没有 `dsh.bundle` 时只会成为普通依赖，**不会自动成为 profile 层**。
- 用户层的文件是 `~/.dsh/profiles/<name>/cordis.patch.yml`。

## 6. 与相邻机制的分工

| 机制 | 本体 | 生命周期 |
|---|---|---|
| **本技能管的插件包** | npm 包 + `cordis.patch.yml` | 持久，随 profile 启动 |
| `dsh-cordis-host-runner` / `dsh-cordis-client-runner` | 动态双半插件（模型当场写、当场挂） | 只在当前进程，重启即消失 |
| `dsh-agent-presets` | agent preset（`${DSH_HOME}/.agent-presets/<id>/`） | 单会话装配 |
| `dsh-skill-filesystem` | Skill（`~/.dsh/skills/<name>/SKILL.md`） | 按需加载的知识 |
