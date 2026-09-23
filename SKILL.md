---
name: dsh-plugin-win10
description: 开发、安装、调试与验收 DSH（DeepSeek Harness）Web GUI 插件包——Host 半边（工具/系统提示/HTTP 路由）+ Client 半边（侧边栏入口/面板/官方槽位）、cordis.patch.yml 挂载、profile 安装、快照与热更边界、以及"插件不生效"的排障；同时管 **DSH 本体升级后的契约兼容**——跑探针查我们依赖的官方 API 是否失效、按变化定级、决定要不要做新旧版本兼容、复验并更新契约基线。**只要用户提到 DSH 插件、dsh 插件、给 dsh 加面板/加工具/加侧边栏入口、cordis.patch、dsh.client、写个插件、插件不生效/工具没注册/面板不刷新、Slot/shell.overlay、或想照着蛋仔面板(dsh-eggy)做一个插件，就用这个技能**；**DSH 更新了/升级了/装了新版本、dsh web 重启后插件行为变了、要判断能不能升到新版、要给插件加版本兼容、提到 breaking change/契约/探针/基线/probe 时也用这个技能**，即使他没说"插件包"三个字。注意与相邻技能的分工：动态的、运行时用 cordis_define 挂的临时插件用 cordis-plugin-development；改 agent preset / cordis.yml 行用 editing-cordis-compositions；本技能管**落盘的 npm 插件包**及其与官方本体的契约兼容。**同时管「工具本身怎么设计才方便 AI 调」**——参数名不撞车 / `summaryOnly` 瘦身 / description 带可照抄的典型调用 / 回执自证 / 判据只有一份 / 一次调用胜过两次（`references/tool-design-for-ai.md`，全部是真机踩出来的）。**本技能以 Windows 10 + PowerShell 5.1 实测为准**（原名 `dsh-plugin-dev`，2026-09-23 更名并收敛为 Windows 专用，准备开源）。
---

# DSH 插件开发（Windows 10 实测版）

> 原名 `dsh-plugin-dev`，2026-09-23 更名为 `dsh-plugin-win10`：把「工具怎么设计才方便 AI 调」
> 与 Windows/PowerShell 5.1 的实测坑收进来，准备开源。

把「给 DSH 加一个自己的东西」做成**能装上、能验证、能被别人复用**的插件包。

## 0. 先想清楚：你要的到底是不是「插件包」

DSH 里「扩展」有好几种形态，选错会白干：

| 你想要 | 该用什么 | 落到哪 |
|---|---|---|
| 让 agent 多几个工具 / 加一段系统提示 / 加个 HTTP 接口 | **插件包 · Host 半边** | `index.js`（Node） |
| 给 Web GUI 加面板、入口、浮层、设置项 | **插件包 · Client 半边** | `lib/client.js`（浏览器） |
| 上面两样都要（面板读后端数据） | **双面插件包** | 两半 + `dsh.client` 声明 |
| 只是想现在、临时、一次性地给当前会话加个工具 | 动态 Cordis 插件（`cordis_define`/`cordis_run`） | 只在当前进程，重启即消失 |
| 想改某个会话的人格 / 装配 | agent preset（`cordis.yml` 行） | `${DSH_HOME}/.agent-presets/` |
| 想让 agent 学会一套做法 | Skill（`SKILL.md`） | `~/.dsh/skills/` |

**判断口诀：要"分发给别人 / 每次启动都在"→ 插件包；只是"这次会话临时用"→ 动态插件。**
另有两条省事的边界：**没有 Web 需求就不要声明 `dsh.client`**（少一半工作量和一半故障面）；**纯 client 的插件也要有个 Host 半边**——它是客户端拿数据的唯一同源通道（见 §3.4）。

## 1. 两条路线，先选一条

| | **A · 轻量路线（无构建）** | **B · 标准路线（官方形态）** |
|---|---|---|
| 代码 | 手写 JS，直接跑 | TypeScript，`tsdown` 构建 |
| 客户端 | 纯 DOM + `MutationObserver` | React（由壳提供）+ `ctx.slots` |
| 挂 UI | DOM 注入侧边栏（官方槽位被占时的兜底） | 注册到官方槽位（`shell.overlay` / `sidebar.*` …） |
| 依赖 | 零 | `@deepseek-ai/dsh-client-runtime`、react |
| 上手 | 十几分钟能跑起来 | 需要一套构建配置 |
| 合适 | 内部工具、单机面板、快速验证想法 | 要发布、要长在正式接缝上、要多插件共存 |
| 范例 | **`dsh-eggy`（蛋仔面板）** | `@linxin666/dsh-client-ui-task-board` |

**默认建议走 A 起步、确有必要再升 B。** 理由：A 没有构建链，改完刷新页面就能看到结果，反馈循环最短；等你要发布、或者发现绕不开某个官方接缝（比如必须出现在设置页、必须进对话区），再迁 B —— 那时你已经明确知道需要哪个槽位了。

- A 路线逐层解剖 → `references/lightweight-path.md`（**拿蛋仔面板当完整范例**）
- B 路线完整写法 → `references/standard-path.md`
- 官方契约（槽位目录、路由、工具、声明字段）→ `references/contracts.md`
- 实测坑清单 → `references/pitfalls.md`
- 官方包地图与社区插件 → `references/ecosystem.md`
- **DSH 本体升级后**的契约兼容工作流（探针 → 定级 → 兼容决策 → 复验+更新基线）→ `references/core-update.md`
- 我们依赖的官方 API 清单（谁在用、失效后果、怎么 feature-detect）→ `references/used-apis.md`

## 2. 五步流程

### 第 1 步：取证，别猜

DSH 在快速演进，**契约以你本机安装的版本为准**，不要照抄博客或旧文档。取证顺序：

1. **本机类型定义是最好的文档**（比 README 准，且一定与运行版本一致）：
   ```powershell
   # ⚠️ 用 `npm root -g` 现算，**别照抄别人的安装路径**（若 dsh 不是 npm 全局装的，用 `Get-Command dsh` 反推）
   $base = Join-Path (npm root -g) '@deepseek-ai\dsh\node_modules\@deepseek-ai'
   Get-ChildItem $base -Recurse -File -Include *.d.ts |
     Select-String -Pattern "interface SlotMap" -List        # 谁声明了槽位
   Get-ChildItem $base\dsh-host-webserver\lib\types -Recurse -Include *.d.ts
   ```
   `*.d.ts` 里的注释写得非常细（为什么这么设计、什么会抛错），读它就是读官方意图。
2. 官方仓库 `github.com/deepseek-ai/deepseek-harness`（MIT，公开）：`packages/client/ui-slots`、`packages/host/webserver`、`packages/bundle/*` 是模板来源，根 `AGENTS.md` 是给 agent 的入口。
   ⚠️ 但**默认分支 ≠ 你装的版本**——先确认 npm 包版本，再决定参考哪个 tag。
3. 社区插件源码（本机就有）：见 `references/ecosystem.md`。
4. 仍然不确定 → **选一个"失败得最安全"的最小实现**，并显式标注假设，别硬凑。

> 为什么强调取证：DSH 里有一批"写错了不报错、只是静默不生效"的地方（补丁 id 对不上、`exports` 路径不存在、槽位名拼错），也有几处"写错了让整个 profile 起不来"的地方。查一次的成本远低于盲改。

### 第 2 步：生成骨架

⚠️ **先判断路线，再决定用不用脚手架。** 脚手架生成的是 **A 路线（DOM 注入）的客户端**——
如果你的需求是「侧栏入口 / 浮层 / 设置块」这类**官方已经留好座位**的事，
**先读 `references/contracts.md` §1.6（官方先例，可直接抄）**，把客户端写成**槽位路线**；
脚手架这时可以只用来生成 Host 半边与声明文件，客户端你自己写（或生成后整体替换掉）。

（这是个真实教训：实测里 agent 拿到脚手架后，即使问题明确在问"该注册哪个槽位"，
也倾向于先生成一整套 DOM 注入骨架——**工具的默认值会悄悄替你做决定**。）

```powershell
node "$env:USERPROFILE\.dsh\skills\dsh-plugin-win10\scripts\scaffold.mjs" dsh-mytool --dir D:\myplugins
node "$env:USERPROFILE\.dsh\skills\dsh-plugin-win10\scripts\selftest.mjs" --plugin D:\myplugins\dsh-mytool
```
骨架已经内建了下面这些"不写就出事"的东西，别删：lossless JSON 出口、`inject` 降级、本机访问守卫、`{ok,data}` 信封、客户端绝不 throw、effect 回收、DOM 自愈。
`selftest` 会在**不碰真实 dsh web** 的前提下用桩上下文把两半边跑一遍，**两条路线都认**（DOM 注入 或 `ctx.slots.register` 命中任一条即通过，并报出注册进了哪个槽位），改完随时重跑。

### 第 3 步：写 Host 半边

契约（`index.js`）：

```js
export const name = 'dsh-mytool';        // 一般等于包名
export const inject = [];                // 必需 service；缺了 fiber 会 pending。可选服务用 ctx.inject
export function apply(ctx) { /* ... */ } // 副作用全部挂到 ctx.effect 上
```

四件事，按需取用：

```js
// ① 工具：给 agent 用
ctx.inject(['tools'], (sub) => {
  const tools = sub.get('tools');
  sub.effect(() => tools.register({ name, description, parameters, output, execute }), 'label');
});

// ② 系统提示：让 agent 知道"有这么个插件、什么时候用"
ctx.inject(['systemPrompt'], (sub) => {
  sub.effect(() => sub.get('systemPrompt').section({ name: 'plugin:mytool', order: 150, text: '...' }), 'label');
});

// ③ HTTP 路由：给客户端半边取数据（唯一的同源通道）
ctx.inject(['webServer'], (sub) => {
  sub.effect(() => sub.get('webServer').register({ kind: 'prefix', path: '/mytool', handler }), 'label');
});

// ④ 会话信息：需要 cwd / agent 时
ctx.inject(['sessions'], (sub) => { /* sessions.get(agent.id).header.cwd */ });
```

三条硬约束，违反不会报语法错但会出事：

- **工具返回值必须是 lossless JSON**。`undefined` / `NaN` / `Infinity` / `-0` 都不是合法 JSON，宿主会拒收**整个结果**并报 `returned invalid output: value is not lossless JSON`。骨架里的 `lossless()` 就是干这个的，所有出口都要过它。
- **`parameters` 必须是合法 JSON Schema**。把 `description` 误写成 `properties` 之类的笔误会让宿主在**注册期**抛错，严重时**连发消息都失败**——所以骨架带了自检。
- **别硬依赖**。`inject` 只写"没有它我就没法工作"的服务；其余一律 `ctx.inject([...], sub => ...)` 惰性挂载，缺了就 `console.warn` 降级。插件加载失败会牵连整个 profile，代价远大于少一个功能。

用 `@deepseek-ai/schemastery` 的 `z` 做配置 schema（**不是 zod**），配置值放 schema 默认值，不要散在源码常量里。

### 第 3.5 步：让工具**方便 AI 调**（写 Host 半边时就要想）

插件的消费者有两类：**人**看面板，**AI** 看 `description` + `parameters` + 回执。
所以「调用体验」本身就是功能。判据不是「能不能调」，而是：

1. 读一遍描述，能不能**照着把参数填对**？
2. **一次调用**，能不能拿到我想要的东西？
3. 这个返回，**值不值它占的那点上下文**？

**四条不变量**（建议在 smoke/单测里**断言**它们，否则下一个加 op 的人会顺手破坏，而且**不会有任何报错**，只是变回难用）：

| 不变量 | 怎么做 | 反例 |
|---|---|---|
| **参数名不撞车** | 同一领域里「同一个词指两个东西」时，**造两个不同的词**，并在两处描述里互相点名 | `level`（地图关卡 ID）与 `which`（玩法第几关）撞车 → 改名 `stage` |
| **大返回能瘦身** | 给 `summaryOnly:true`（**默认行为一字节不改**），且**只去体积、不去结论** | `op=levels` 18 917 B → 3 126 B；`metrics` 去分箱但留 `core`/`hotBin` |
| **描述里能照抄** | 每个工具 description 末尾给一条 **`典型调用`** 的 JSON | 只讲「为什么」→ AI 还得自己拼参数 |
| **提示段不漏工具** | 系统提示段**从数据生成** + 断言「不在豁免表里的工具必须有一条『什么时候用』」 | 手写一段提示 → **漏了 4 个版本**，两个工具在 AI 开场提示里根本没指路 |

另外六条同样重要（详见 `references/tool-design-for-ai.md`）：

- **判据只能有一份**：两个入口做同一个判断 → 抽函数 + 跑回归。**漂移过的判据比没有判据更坏**。
- **时间敏感的链条做成一次调用**：拆开时调用方自身往返延迟（1~3 秒）会毁掉时间精度。
- **回执要自证**；**参数名骗人时回执必须当场纠正**（给**实测值**，并说明差额来源）。
- **危险操作默认安全**：`dryRun` 先给计划、真删双钥匙、不需要动就一个字节都不动。
- **按「谁错了」区分静默与报错**：调用方输入非法 → 大声报错；数据里混无关内容 → **静默忽略并如实报 `ignored`**。
- **只报数字，不下判决**：阈值属于业务方；用测试断言输出里没有 `pass`/`reachable`/`verdict`。

> ⚠️ 本机（Windows 10 / PowerShell 5.1）另有 8 条实测坑：**没有 heredoc**、**`node -e` 的引号会被吃掉**、
> **管道会骗 exit code**、`Get-Content` 默认 GBK、子进程 stdout 走 936 代码页、`$pid` 只读、
> **改名/改技能前必须逐文件 SHA 备份**、**改名要扫全机引用**。→ `references/tool-design-for-ai.md` 附录。

### 第 4 步：写 Client 半边

客户端是**懒加载 CJS 表**，不是普通 ESM——每个插件 bundle 只做一件事：注册一个 factory。

```js
window.__ModuleLoader__.load({
  id: "dsh-mytool",                                    // 必须等于包名
  factory: (require) => {
    var module = { exports: {} }; var exports = module.exports;
    // …整个 bundle 在这里，CSS 注入也在 factory 内（materialize 时才跑）
    exports.name = "dsh-mytool";
    exports.inject = [];
    exports.apply = function (ctx) { /* 副作用挂 ctx.effect */ };
    return module.exports;
  },
});
```

- **`require` 能拿到平台单例**：`require("react")`、`react/jsx-runtime`、`react-dom/client` 都是壳提供的。B 路线就靠它。**但是**跨插件的值 import 是被禁止的（会被构建期纯度门或运行时 require 拒绝）——协作要走 service / slot。
- **CSS 用 `<style data-plugin="<包名>">`**：宿主按这个属性追踪"哪个模块拥有这套样式"并在卸载时回收。
- **绝不 throw**。Client 半边的 `apply` 抛错会让**整个 Web 壳启动失败**。你写的是一个面板，没资格让用户打不开界面——所以所有 DOM 操作包 `try/catch`，失败只 `console.warn`。
- **副作用必须可回收**：`ctx.effect(() => cleanup, label)`。否则热重载/反复加载会留下幽灵入口和幽灵面板。
- **主题用令牌**：颜色走 `--dsw-alias-*`（`label-primary/secondary`、`interactive-bg-hover`、`border-l1/l2`、`brand-primary`…），每个令牌配 fallback。写死颜色会在用户的皮肤下变成看不清的色块。

A 路线（纯 DOM）还要处理一件事：**DOM 是别人的地盘**。React 每次重渲染都可能把你的节点挤掉，所以要用 `MutationObserver` 双层自愈（等侧边栏出现 + 被改动时当帧插回），并且**幂等**——已经注入过就跳过。蛋仔面板用的是这套（`references/lightweight-path.md` 有完整代码讲解）。

### 第 5 步：装上并挂载

**先搞清"装配"是怎么发生的**——这里有个坑，症状是「文件都在、什么也没发生、**且完全静默**」：

> **把包放进 `node_modules` ≠ 插件被装配。**
> 启动期**不会**扫描 `node_modules` 去找插件。真正的装配来源只有两条：
> ① 包的**名字出现在 profile 的 `dsh.profile.bundles` 列表里**（于是它自带的 `cordis.patch.yml` 作为一层被应用，把插件行 insert 进来）；
> ② 或者 profile / home 层的 `cordis.patch.yml` 里**显式 insert 一行**，且 `name` 能解析到它。
>
> 只 mklink 而这两件事都没做 = 包在盘上、`apply()` 从未执行、**不报任何错**。
> 本机实证对照：`dsh-eggy` 在 `node_modules` 里是软链，**同时**出现在 `bundles` 列表里；
> `dsh-better-sidebar` 只在 `node_modules`、不在 `bundles`。

**三种方式，从"最不侵入"到"最正式"：**

**① `--patch`——验证阶段的首选（零侵入）。** 官方支持用临时 patch 层启动 GUI，不碰用户的 profile、不 publish、不改任何现有文件：

```powershell
# scratch/cordis.yml
# - insert:
#     - id: mytool
#     name: 'D:\myplugins\dsh-mytool\index.js'     # name 可以是**文件绝对路径**（源码直跑）
npm dsh web --patch .\scratch\cordis.yml
```
**为什么放第一位**：装进 profile 要改用户环境还要重启他正在用的 GUI，而 `--patch` 只影响这一次启动。
帮别人写插件时尤其重要——**别拿别人的环境做试验**。

**② `dsh plugin --profile web add <pkg>@<ver>`——正式安装。**
它把包装进 profile 的 `node_modules`，并在**包声明了 `dsh.bundle.patch` 时**把包补进 `dsh.profile.bundles`。
⚠️ **没声明 `dsh.bundle` 的包只会装成"普通依赖"，不会成为 profile 层** —— 表现为"装成功了但没有工具"，而且只有一行 warning。

**③ 手搓软链——只在需要频繁改代码时用。** 必须**两件都做**：

```powershell
cmd /c mklink /J "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-mytool" "D:\myplugins\dsh-mytool"
# 再把 "dsh-mytool" 加进 profile package.json 的 dsh.profile.bundles（或往 cordis.patch.yml 加一行），然后重启
```
⚠️ 本机 pnpm 是 `nodeLinker: hoisted`，手搓的软链不在 profile 的 `dependencies` 里，**下一次 `dsh plugin add/install` 会把它清掉**——它是开发态手段，不是交付方式。

配置层级顺序（后者覆盖前者）：**profile bundles → profile `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → 命令行 `--patch`**。
`id` 是配置树里稳定的**行身份**：`insert` **不带 `id`** 才是"新增一行插件"，**带 `id`** 是"往已有行/组里追加"（目标不存在时只 warn 然后跳过）。
按 `id` 覆盖时 `config` 是**整段替换**，不是深合并。

## 3. 生效边界：什么改了要做什么

这是最容易浪费时间的部分，一次记住——**先查 profile 的 `patchReload` 是 `live` 还是 `startup`，它决定了下面几行**：

| 改了什么 | 怎么生效 |
|---|---|
| Host 半边（`index.js` / `lib/*.mjs`） | **必须重启 `dsh web`**——Host 代码是启动时加载的快照 |
| Client 半边（`lib/client.js`） | **刷新浏览器**。bundle 在激活时快照；若同时在跑 `pnpm run dev:web` / `tsdown --watch`，客户端插件可热重载 |
| `cordis.patch.yml`（patch 文件） | **取决于 `patchReload`**：`live` → **热加载，不用重启**；`startup` → 只应用一次，要重启。本机是 `live` |
| `dsh.profile.bundles` / `package.json` / `exports` / 插件集合 | **重启**。bundle 列表在启动时快照，热载只重读 patch 文件 |
| 只跑了 `build` 没留 watcher | 刷新页面即可 |

⚠️ **推论（反直觉但很关键）**：在 `patchReload: live` 的机器上，**「我重启了还是没工具」什么也证明不了**——
patch 改动本来就不需要重启，重启也没改变 patch 的加载结果。
**别拿"重启"当调试手段**：先确认包进没进 `bundles`、行有没有被 insert，再谈重启。

**另一个必须知道的事实**：客户端 bundle 在**激活时**被读进内存（`initialBundleSnapshot`）。所以"我改了 `lib/client.js` 但页面没变"通常是没刷新；而"我改了 `exports` 但没变"通常是没重启。
**还有**：`dsh.client` 声明写坏、或声明了 `exports["./client"]` 但文件不存在 → 启动期**聚合抛错**（FAILED fiber），整个 shell 可能起不来。改这里之前先跑 §4 的验证。

## 4. 验证矩阵（按顺序，别跳）

```powershell
# ① 骨架自检：不碰真实 dsh web，验证两半边契约
node "$env:USERPROFILE\.dsh\skills\dsh-plugin-win10\scripts\selftest.mjs" --plugin <插件目录>

# ② 组合期：确认插件真的进了配置树（不启动也能查）
dsh --profile web --dump-config | Select-String "dsh-mytool"

# ③ 路由通不通（Host 半边活着）
curl.exe "http://127.0.0.1:3080/mytool/status"

# ④ 工具注册（Host 半边的 tools）
#    问 agent 调 mytool_ping；或看 dsh web 控制台有没有 "[dsh-mytool] 已注册 N/N 个工具"

# ⑤ GUI（Client 半边）：刷新页面 → 看入口/面板是否出现、能否收起、控制台有无报错
```

**在临时 profile 里试装**比在 `web` 上试更安全（搞坏了不影响你正在用的 GUI）：
`dsh plugin --profile scratch add <包名>` 然后 `dsh --profile scratch --dump-config`。

### 验证的三层阶梯（越往下越接近真实，代价也越大）

桩测试能证明**契约**，但证明不了**装配**和**渲染**。按需往下走：

| 层 | 做什么 | 能证明什么 | 代价 |
|---|---|---|---|
| **L1 桩契约** | `scripts/selftest.mjs`（桩 ctx/req/res/document/slots） | 工具注册形状、路由信封与守卫、lossless、客户端挂载与回收、**两条路线** | 秒级 |
| **L2 真实 cordis 装配** | 用本机真装的 `@deepseek-ai/cordis` 跑 `ctx.plugin(plugin)`，断言工具/路由/提示段真的注册了；再 `fiber.dispose()` 断言 **disposer 全被调用**（无幽灵） | 插件在**真实 fiber 生命周期**下的行为。⚠️ 直接 `plugin.apply(root)` 是**什么都不注册**的（没有 fiber），必须走 `ctx.plugin` | 十秒级 |
| **L3 真实渲染** | 客户端组件用真实 React（`react` + `react-dom/server` 的 `renderToStaticMarkup`）渲染一遍，断言关键字段与**样式里没有裸色值**（所有 `var()` 都带 fallback） | 组件真能渲染、不崩、不依赖未提供的上下文 | 十秒级 |
| **L4 真机** | 装进 profile / `--patch` 启动，刷新页面**看一眼** | 槽位真被渲染、观感、真实 webServer 路由 | 需要重启 GUI——**先问用户** |

**做不到 L4 时，必须在交付物里写明"未验证"**（这比假装通过有价值得多）。
点名几个容易漏的边界：**真实 GUI 渲染**、**真实 webServer 上的路由注册**、**折叠态的观感**。

## 5. 环境降级

这个技能依赖「本机有 DSH 安装 + 文件系统」，但不是每个环境都齐：

| 环境 | 能做到 | 做不到时怎么办 |
|---|---|---|
| 有 shell + 文件系统（本机 / Cowork / Claude Code） | 全流程 | —— |
| 无文件系统（Claude.ai 网页） | 读契约、设计、**把两半边代码作为文本产出**给用户自己落盘 | 明确告诉用户：需要 `package.json` / `cordis.patch.yml` / `index.js` / `lib/client.js` 四个文件，并给出每个文件的作用与最小内容 |
| 无 shell | 同上 | 给出等价的手工命令（`mklink` / `dsh plugin add`）让用户自己跑 |
| 无浏览器 | 不能验证 GUI | 至少跑完 ①②④；把"面板是否出现"明确标为**未验证**，别假装通过 |

**任何环境下都不要做的两件事**：不要为了验证去启动一个独立的 Vite/静态服务器（Web 壳依赖 Host 注入的 `window.__DSH_BOOT__`，独立服务起不来，还会误导）；不要擅自重启用户正在用的 `dsh web`——问一下，或者让用户重启。

## 6. 五分钟排障

| 症状 | 先查这里 |
|---|---|
| 插件「像没装上」 | ① 软链是否存在且指向对；② `cordis.patch.yml` 里是否有该行且 `disabled: false`；③ `--dump-config` 里有没有；④ **重启过 `dsh web` 吗** |
| 工具没出现 | Host 半边注册是否抛错（看控制台 `[包名]` 日志）；`inject: ['tools']` 是否写对；schema 是否合法 |
| 面板不出现 | 刷新浏览器了吗；侧边栏选择器是否与真实壳一致；Client `apply` 是否被前面的 throw 中断（看控制台） |
| 面板出现了但不更新数据 | Client 是否在跑 watcher（不是则刷新）；Host 路由路径是否带多余尾斜杠；`{ok,data}` 信封是否一致 |
| 整个 GUI 起不来 | `dsh.client` 声明或 `exports["./client"]` 指向不存在的文件；先删 profile 里那一行救回来，再修 |
| 改了没反应 | 对照 §3 的表——九成是 Host 改了没重启，或者 Client 改了没刷新 |
| DSH 升级后插件行为变了/升级前想评估 | **先跑契约探针对比基线**（§8）——大量失效是静默的，别靠"看着还在"下结论 |

更多实测坑（含每条的具体现象与修法）见 `references/pitfalls.md`。

## 7. 参考文件

| 文件 | 何时读 |
|---|---|
| `references/tool-design-for-ai.md` | **写工具时先读这个**：13 条「让 AI 调得顺」的实测经验（参数名 / 瘦身 / 典型调用 / **系统提示段这第二条通道** / 判据唯一 / 一次调用 / 回执自证 / 静默 vs 报错 / 不下判决 / 测试纪律）+ **Windows 与 PowerShell 5.1 的 8 条坑** |
| `references/contracts.md` | 要 `ctx.slots` / `webServer` / 工具 / `dsh.client` 的**精确契约**时；含**本机实测的槽位全目录** |
| `references/lightweight-path.md` | 走 A 路线时；**蛋仔面板（dsh-eggy）逐层解剖**，含 DOM 注入自愈、主题合成、面板结构 |
| `references/standard-path.md` | 走 B 路线时；TS + tsdown + React + 槽位注册的完整写法 |
| `references/pitfalls.md` | 踩到坑 / 提交前自检 |
| `references/ecosystem.md` | 想知道官方有哪些包、社区有哪些插件可以抄、怎么从官方仓库取证 |
| `references/core-update.md` | DSH 本体升级后：六步契约兼容工作流（发现更新 → 跑探针 → 读官方信息 → 定级处置 → 复验+更新基线 → 跑自测）与兼容策略 |
| `references/used-apis.md` | 要看"我们依赖哪些官方 API、失效了会怎么坏、谁在用、怎么 feature-detect"时 |

## 8. DSH 本体升级了怎么办

**别猜，跑探针。** 本技能里的契约全部取证自 `dsh 0.1.2-rc.1`——**本体会升级，这些具体值会过期**。
升级后第一件事：

```powershell
node "$env:USERPROFILE\.dsh\skills\dsh-plugin-win10\scripts\probe-contracts.mjs" --scan "<你的插件目录>"
```

它会拿当前状态和**已知良好的基线**对比，报出：版本变没变、**槽位增删了哪些**、哪条契约状态翻转了，
以及**我们的代码里哪里用了这个 API**。

- 六步工作流与兼容策略 → `references/core-update.md`
- 我们依赖的官方 API 清单 → `references/used-apis.md`

> 这部分原是独立技能 `dsh-core-update`，2026-09-12 并入本技能：它声称的触发词（"插件突然不生效/工具没注册"）
> 与本技能 §6 的排障正面重叠，且同一批契约知识在两处各写一份、必然漂移。探针与自测脚本都在本技能 `scripts/` 下，
> 改完探针/文档后跑 `node "$env:USERPROFILE\.dsh\skills\dsh-plugin-win10\scripts\test-skill.mjs"` 自检。
