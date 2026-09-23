# 我们依赖的官方 API 清单

> 用途：探针报出"某条契约变了"之后，**照这张表找到"谁在用、会怎么坏、改哪里"**，不要凭印象找。
> 本文件属于 `dsh-plugin-win10` 技能（原独立技能 `dsh-core-update`，2026-09-12 并入）。
> 「谁在用」来自探针的 `--scan`（可随时重跑刷新）：
> ```powershell
> node "$env:USERPROFILE\.dsh\skills\dsh-plugin-win10\scripts\probe-contracts.mjs" --scan `
>   "D:\lua_danzai\packages\dsh-eggy" "$env:USERPROFILE\.dsh\skills\dsh-plugin-win10"
> ```
> 版本锚点：`dsh 0.1.2-rc.1` / `cordis 4.0.2` @ 2026-09-11。

## 一、总表

| # | 官方契约 | 谁在用 | 失效后果（**注意有多少是静默的**） | feature-detect |
|---|---|---|---|---|
| 1 | `dsh.profile.bundles` 装配清单 | profile `package.json`；`dsh-plugin-win10` 的脚手架/文档 | **静默**：软链装了但 `apply()` 从不执行 | 无（这是配置，不是运行时）。用 `--dump-config` 验 |
| 2 | `dsh.profile.patchReload`（`live`/`startup`） | 同上 | **静默**：改了 patch 以为生效其实没生效（或反之白重启） | 读 profile `package.json` |
| 3 | `cordis.patch.yml` 顶层数组 + `insert`（带/不带 `id` 语义不同） | 所有插件的挂载 | **静默**：行没被插入，或插错位置 | `--dump-config` + 看 stderr 的 patch 警告 |
| 4 | `ctx.inject(['服务'])` / `ctx.get('服务')` | `dsh-eggy` ×5 | 插件 `pending`，**永不激活**（看着"装了"） | `typeof ctx.get === 'function'`，取不到就降级 |
| 5 | 服务名：`tools` `webServer` `systemPrompt` `sessions` `slots` | 两处都在用 | 同上 | `const t = ctx.get('tools'); if (t) …` |
| 6 | `ctx.tools.register({name,description,parameters,output:{schema,render},execute})` | `dsh-eggy` ×1 | **注册期抛错**，或工具静默不出现 | `typeof tools.register === 'function'` |
| 7 | 工具 `output.render` 必须返回 ContentBlock[]；`parameters` 走 schema 子集 | `dsh-eggy` + 所有生成的骨架 | 注册期抛错，严重时**连发消息都失败** | 跑 `selftest.mjs`（会真调 register） |
| 8 | `ctx.webServer.register({kind:'exact'\|'prefix',path,handler})` | `dsh-eggy` ×1 | 面板 404；**重复 (kind,path) 启动期抛错** | `typeof webServer.register === 'function'` |
| 9 | `ctx.slots.inject(key,cb)` + `ctx.slots.register(spec,Component)` | `dsh-plugin-win10`（脚手架槽位版 + 文档） | **静默**：注册失败/槽位没了 → **UI 永远不出现** | `if (ctx.slots && typeof ctx.slots.register === 'function')` → 否则退回 DOM 兜底 |
| 10 | 槽位目录（**本机 52 个**，见探针 `--json` 的 `slotKeys`） | `dsh-plugin-win10` 的 `sidebar.footer.action` ×17、`shell.overlay` ×17 | 用到的槽位被改名/移除 → 静默不显示 | `ctx.slots.spec(key)` 查得到才注册；查不到就走兜底 |
| 11 | 关键槽位 kind 必须仍是 `list` | 同上 | 变成 `single` 就**从"加性"变成"替换别人的 UI"** | 注册前 `ctx.slots.spec(key)?.kind === 'list'` |
| 12 | `window.__ModuleLoader__.load({id,factory})` + `id === 包名` | `dsh-eggy` ×1；生成的骨架 | **整个客户端半边不加载**（不报错） | 无法探测（壳的启动协议）。靠 `dsh.client` 声明 + 真机刷新验证 |
| 13 | `__DSH_BOOT__` 注入 | 壳自身的启动链 | 独立起 Vite/静态服务预览会失败（**这条是"别做什么"**） | — |
| 14 | 平台 require 白名单：`react` / `react/jsx-runtime` / `react-dom/client` / `@deepseek-ai/cordis` / `-dsh-client-ui-primitives` | 槽位路线的客户端 | 构建期纯度门或运行期 require 失败 | `try { require('react') } catch { 降级 }` |
| 15 | `<style data-plugin>` 样式归属约定 | 两处都在用 | 宿主无法追踪/回收你的样式（**不报错**） | 无法探测，照约定写 |
| 16 | `--dsw-alias-*` 主题令牌（**运行时注入，静态产物里查不到定义**） | `dsh-eggy` ×45 | 令牌没了 → 颜色变透明/纯黑（**不报错**） | **永远写 `var(--x, fallback)`**，这就是兼容 |
| 17 | `{ok:true,data}` 响应信封 | `dsh-eggy` ×93 | 面板解包失败（我们自己的约定，但要与官方风格一致） | 自己的约定，稳定 |
| 18 | `dsh.client.{platform,inject,immediately,external}` | 所有双面插件 | 声明坏了 → 启动期聚合抛错（FAILED fiber），**壳可能起不来** | `--dump-config` + 装前检查 `exports["./client"]` 指向真实文件 |
| 19 | CLI：`--patch` / `--dump-config` / `--dump-default-config` | `dsh-plugin-win10` 文档 ×7 | 文档里的命令失效，别人照着敲会报错 | `dsh --help` 看还在不在 |
| 20 | `defineTool` + value-schema DSL（`@deepseek-ai/dsh-tools`） | 官方推荐写法，我们目前用裸对象形状 | 两者都可用；官方 DSL 变了不影响我们裸写的那种 | 见官方文档；我们暂不强依赖 |

## 二、按"失效后果"排优先级（升级后先看这几条）

**🔴 静默且致命**（不报错但功能全没）：
`#1 bundles` · `#3 patch insert` · `#9 slots.register` · `#10 槽位目录` · `#12 __ModuleLoader__` · `#16 主题令牌`

**🟠 会报错但有噪音**（容易误判成自己的 bug）：
`#6 tools.register` · `#7 output.render` · `#8 webServer.register` · `#18 dsh.client`

**🟡 语义型**（同名同签名，行为变了，类型检查发现不了）：
`#2 patchReload` · `#11 slot kind` · 快照时机（客户端 bundle 激活时快照）

**⇒ 所以探针把 `#11 slot-kind` 也做成了断言**：这类"语义契约"必须**主动断言**，否则永远发现不了。

## 三、降低升级成本的一条架构纪律（强烈建议）

**把官方 API 的调用收口到一个薄适配层**，别散落在各处：

```
dsh-eggy/
├── lib/platform.mjs     ← 只有这个文件 import/触碰官方 API
│     export function getSlots(ctx) { … }        // 探到就用，探不到返回 null
│     export function registerTool(ctx, def) { … }
│     export function registerRoute(ctx, cfg) { … }
│     export const THEME_FALLBACK = '#0b0b0d'
└── index.js / lib/*.mjs  ← 只调 platform.mjs，不直接碰 ctx.tools / ctx.slots / ctx.webServer
```

**收益**：官方 API 变了，**只改一个文件**；而且天然有一个地方集中做 feature-detect。
**现状**：`dsh-eggy` 的官方调用目前分散在 `index.js`（`ctx.inject` ×5、`tools.register`、`webServer.register`）——
**数据已经在探针的使用面里了，改造时照着它搬**。

## 四、新旧版本兼容：针对本清单的具体建议

| 契约 | 建议策略 | 理由 |
|---|---|---|
| `#9/#10/#11` 槽位 | **能力探测 + DOM 兜底**（唯一值得做双路的地方） | 槽位是"锦上添花"，客户端的核心功能不该因为壳没有槽位就全没 |
| `#1 装配清单` | **不做兼容**，改文档和脚手架 | 这是用户环境的配置，不是我们能兼容的 |
| `#2 patchReload` | **不做兼容**，改文档（写成"取决于 profile 设置"） | 语义由用户的 profile 决定 |
| `#6/#7 tools` | **不做兼容**，锁 `engines.dsh` 范围 | 核心能力，签名变了只能跟 |
| `#16 主题令牌` | **fallback 就是兼容**，永远带上 | 成本为零，收益稳定 |
| `#12 __ModuleLoader__` | 无法兼容 | 壳的启动协议，只能跟版本 |

**一句话原则**：
> **能用能力探测解决的，就别用版本判断；能用 fallback 吸收的，就别写分支；
> 剩下的老老实实锁版本并在 README 写清"验证过的版本"。**

## 五、这次工作流本身的迭代记录

| 版本 | 变化 |
|---|---|
| 2026-09-11 首版 | 探针 9 条检查 + 使用面扫描 + 基线对比。修掉探针自己的 3 处假警报：① 服务名解析正则过严（漏报 4/5）② 槽位块解析写死缩进（漏报 3 个关键槽位）③ 前端产物只扫了"最大的那个文件"（含 `__ModuleLoader__` 的是另一个）。并删掉一条**照搬别人笔记、本版本 0 命中**的 `PLATFORM_MODULES` 检查——**假警报会训练人忽略探针**。 |
| 2026-09-12 并入 dsh-plugin-win10 | 原 `dsh-core-update` 技能整体并入：触发词与「插件不生效」排障正面重叠、契约知识两处各一份必然漂移。探针/自测脚本迁至 `dsh-plugin-win10/scripts/`，工作流正文迁至 `references/core-update.md`。探针按 `process.argv[1]` 排除自身、基线文件独立于技能目录，搬家零行为变化。 |
