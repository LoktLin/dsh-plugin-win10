# 实测坑清单（每条都带"怎么提前发现"）

> 这些坑的共同特征：**不报语法错、不报异常，只是"没生效"**；或者反过来——**一处小错让整个 profile 起不来**。
> 所以每条都配了"提前发现"的办法。

## 0 类：装配期（症状出现时**最先查这里**）

### 0.1 把包放进 `node_modules` ≠ 插件被装配

**现象**：文件都在、软链也在，重启后**什么都没发生**，而且**不报任何错**、日志一行都没有。
**根因**：启动期**不会扫描 `node_modules` 去找插件**。真正的装配来源只有两条：
① 包名出现在 profile 的 **`dsh.profile.bundles`** 列表里（于是它自带的 `cordis.patch.yml` 作为一层被应用，把插件行 insert 进来）；
② profile / home 层的 `cordis.patch.yml` 里**显式 insert 一行**且 `name` 能解析到它。
只 mklink 而两者都没做 = 包在盘上、`apply()` 从未执行。
**本机实证对照**：`dsh-eggy` 在 `node_modules` 是软链，**同时**出现在 `bundles` 里；`dsh-better-sidebar` 只在 `node_modules`、不在 `bundles`。
**修法**：把包名加进 `~/.dsh/profiles/<名>/package.json` 的 `dsh.profile.bundles`（或走 `dsh plugin add`）。
**提前发现**：`dsh --profile web --dump-config | Select-String "<包名>"` —— **不启动就能查，装完立刻跑一次**。

### 0.2 `insert` 带 `id` 和不带 `id` 语义不同

**现象**：patch 写了但没生效，或者"看起来写对了"却什么都没加。
**根因**：`insert` **不带 `id`** 才是"新增一行插件"；**带 `id`** 是"往已有行/组里追加"，目标不存在时**只 warn 然后跳过**（不报错）。
同理 `name` 匹配不到会让整条 patch `skipping`。
**提前发现**：`--dump-config` 的 stderr 里会有 patch 匹配失败的 warn；别只看 stdout。

### 0.3 `dsh plugin add` 对没声明 `dsh.bundle` 的包只装成普通依赖

**现象**：pnpm 装成功了，但插件层根本没进配置树。
**根因**：只有在包**声明了 `dsh.bundle.patch`** 时，`dsh plugin add` 才会把它补进 `dsh.profile.bundles`；否则只打一行 warning。
**修法**：给包补上 `dsh.bundle.patch` 指向自己的 `cordis.patch.yml`。
**提前发现**：同 0.1 的 `--dump-config`。

### 0.4 工具注册的"抛错式"契约与可见性

**现象**：注册成功但模型看不到；或者启动期直接抛错。
**根因（本机 `dsh-tools/lib/types/index.d.ts` 取证）**：`ctx.tools.register()` 是**抛错式**的——
必须给完整的 `output: { schema, render }`；`parameters` 会被 `assertSupportedJsonSchema` 校验；
**同层重名**、或占用**保留的 PTC 传输名 `run_code`**（`RUN_CODE_NAME`）都会抛。
可见性另有两层：注册挂在**调用者的 scope**（host 级=全局可见，`agent.ctx` 级=只对该 agent 且遮蔽全局）；
再加 **`ToolRestriction`**（"per-scope filter over global tools"，按 agent 作用域过滤全局工具，**不影响** scoped 注册与保留的 PTC 传输）。
PTC 模式下模型**只看得到 `run_code`**。
**提前发现**：用 Cordis Host 的 `Tool.listTools` 直接问"当前 agent 真实可调用的工具"，这是**ground truth**——
比在源码里猜作用域快得多。（本机实测：profile 级软链插件 `dsh-eggy` 的 `eggy_*` 工具确实在列。）

## A 类：写错了会静默失效

### A1. 工具返回值不是 lossless JSON

**现象**：工具调用报 `returned invalid output: value is not lossless JSON`，或者工具"看着成功但结果没了"。
**根因**：`undefined`、`NaN`、`Infinity`、`-0` 都不是合法 JSON。实测三种都踩过：hub `/health` 缺字段得到 `undefined`；Lua 的 `p.z` 为 nil 得到 `NaN`；`-Math.round(0)` 得到 `-0`。
**修法**：所有出口统一过一层 `lossless()`（`undefined→null`、非有限数字`→null`、`-0→0`），骨架里已经写好。
**提前发现**：`selftest.mjs` 有专门一项递归遍历工具返回值找非法值。

### A2. `parameters` 的 JSON Schema 写错

**现象**：注册期抛错，**严重时连"发消息"都失败**（不是只有这个工具不能用）。
**根因**：宿主在注册期校验 schema。实测过一次把 `description` 写成了 `properties` 字段，宿主 `assertObjectJsonSchema` 直接抛。
**修法**：`parameters` 用合法 JSON Schema；`description` 是字符串、`properties` 是对象。
**提前发现**：`selftest.mjs` 的"工具形状合法"一项会检查这两个字段的类型；也可以 `JSON.stringify(def.parameters)` 加一次独立解析。

### A3. patch 的 `id` 对不上 → 插件"装上了但没进配置树"

**现象**：`node_modules` 里有这个包，但什么效果都没有。
**根因**：`cordis.patch.yml` 里 `- insert:` 的 `id` 与 profile 层引用的 `id` 不一致；或者包没有 `dsh.bundle`（那就只是普通依赖，**不会自动成为 profile 层**）。
**提前发现**：`dsh --profile web --dump-config | Select-String "<包名>"` —— **不启动就能查，养成装完先跑这个的习惯**。

### A4. 以为 `config` 是深合并

**现象**：按 `id` 覆盖某行配置后，原来那些键全没了。
**根因**：**`config` 是整段替换，不是深合并**。
**修法**：覆盖时把需要的键全部重述一遍。

### A5. 路由 path 带尾斜杠 / 重复注册

**现象**：客户端 404，或者启动期抛错。
**根因**：`path` 必须是**绝对路径且无尾斜杠**；`(kind, path)` 重复会抛错（路由模式是组合期契约）。
**提前发现**：`curl.exe http://127.0.0.1:3080/<path>/status` 直接打一遍。

### A6. 忘记 dispose 槽位注册 → 幽灵条目

**现象**：反复加载插件后，同一个入口出现好几个。
**根因**：`ctx.slots.register()` 的返回值没被回收。
**修法**：串进 `ctx.effect(() => unregister, label)`，或直接用 `ctx.slots.inject` 回调的返回值（它随声明塌陷自动回收）。
**提前发现**：写一个"dispose 之后 registry / DOM / style 全部清空"的断言（`selftest.mjs` 里客户端那三项就是照这个写的）。

## B 类：写错了会让整个壳起不来

### B1. 客户端 `apply` 抛错

**现象**：整个 Web GUI 起不来，或页面白屏。
**根因**：Client 半边的 `apply` 在壳的启动路径上，抛错会**拖垮整个 Web 壳**。
**修法**：所有 DOM 操作包 `try/catch`，失败只 `console.warn` 并 `return`。**绝不 throw**。
**提前发现**：`selftest.mjs` 会断言 `apply(ctx)` 不抛错、且返回 cleanup 函数。

### B2. `dsh.client` 声明坏 / `exports["./client"]` 指向不存在的文件

**现象**：启动期**聚合抛错**（FAILED fiber），shell 可能完全起不来。
**根因**：客户端 bundle 扫描是**激活期同步**跑的，一个坏声明会把整批聚合错误抛出。
**修法**：`dsh.client.platform: "web"` 与真实存在的 `exports["./client"]` **两个都要有**。
**提前发现**：装之前先 `node -e "JSON.parse(require('fs').readFileSync('package.json'))"` 确认 exports 指向的文件存在。

### B3. 往 `root` 槽位注册

**现象**：页面只剩你的组件，侧边栏/对话区/浮层**全没了**。
**根因**：`root` 是 `kind: 'single'`，`ui-layout` 的 AppFrame 占着它并声明了其它所有座位。往它注册 = **遮蔽整个框架**（而且动态注册的条目优先级更低反而会赢）。
**修法**：要全局浮层用 `shell.overlay`；要改导航栏先想清楚是不是真的要**替换**它。

### B4. 注册到未声明的槽位 / 声明已被声明的子槽

**现象**：加载期抛错。
**根因**：**声明即认领**。往未声明槽位注册、声明已声明的 child、同一个 store handle 挂两个 scope、`chain` 少了 `select` —— 都会在 load 时抛。
**修法**：先用 `ctx.slots.inject(key, cb)` 等声明；`chain` 别忘 `select`。

## C 类：改了不生效（不是 bug，是边界）

### C1. Host 改了没重启

**现象**：工具行为没变。
**根因**：Host 代码是 `dsh web` **启动时**加载的快照。
**修法**：重启。**这条占了"改了没反应"的一大半。**

### C2. Client 改了没刷新 / 只 build 没 watcher

**现象**：面板没变。
**根因**：客户端 bundle 在**激活时**被读进内存（`initialBundleSnapshot`）。只有 bundle **内容**变化能走 HMR，而且需要构建 watcher 持续重写 `lib/client.js`。
**修法**：没 watcher 就刷新页面；改了 `package.json` / `exports` / 插件集合 / host 代码 → 必须重启（HMR 管不到组合期的东西）。

### C3. 用独立 Vite/静态服务"预览"插件

**现象**：页面起不来，或者起来了但什么都没有。
**根因**：Web 壳依赖 Host 注入的 `window.__DSH_BOOT__`；独立服务没有这个，客户端模块系统压根不存在。
**修法**：**别这么干**。插件只能在 DSH GUI 里验证。

### C4. 把「重启」当调试手段（patch 文件其实是热加载的）

**现象**：出问题就重启 `dsh web`，重启完没好，就以为"不是重启的事"，然后卡住。
**根因**：**patch 文件（`cordis.patch.yml`）是否热加载取决于 profile 的 `patchReload`**：
`live` → 监听 profile 与 home 级 patch 文件，**改完不用重启**；`startup` → 只应用一次。
本机是 **`live`**（`~/.dsh/profiles/web/package.json` 的 `dsh.profile.patchReload`）。
而 `dsh.profile.bundles` / `package.json` / `exports` 这些是**启动时快照**，改了才必须重启。
**修法**：先分清你改的是哪一类。**「我重启了还是没工具」在 `live` 机器上什么也证明不了**——
patch 改动本来就不需要重启。先查装配（0.1），再谈重启。
**提前发现**：`Get-Content ~/.dsh/profiles/web/package.json`，看 `dsh.profile.patchReload`。

### C5. 手搓软链会被下一次 `dsh plugin install` 清掉

**现象**：开发态用 mklink 装的插件，某次 `dsh plugin add/install` 之后突然消失了。
**根因**：本机 pnpm 是 `nodeLinker: hoisted`，手搓的软链**不在 profile 的 `dependencies` 里**，
下一次 install 会把它当"多余的目录"清掉。
**修法**：把软链当**开发态手段**，别当交付方式；要长期存在就走 `dsh plugin add` 或写进 `bundles`。
**提前发现**：`Get-Content ~/.dsh/profiles/web/pnpm-workspace.yaml` 看 `nodeLinker`；import 失败时先确认软链还在。

## D 类：DOM 注入路线特有的坑（A 路线）

### D1. 侧边栏选择器随壳版本失效

**现象**：侧边栏里看不到入口，控制台也没有报错。
**根因**：壳的结构会变（当前是 `column > wrapper > 根`，旧壳是 `column` 第一个子元素）。
**修法**：选择器写**多重兼容**（`[data-pane="sidebar"], [class*="sidebarCol"]`），并且**先试官方槽位**（`sidebar.footer.action`）；同时留一个控制台兜底入口（如 `window.__mytoolPanel.open()`），万一选择器全失效还能用。

### D2. React 重渲染把注入的节点挤掉

**现象**：入口出现一下又消失，或者切换会话后就没了。
**根因**：DOM 是别人的地盘。
**修法**：双层 `MutationObserver`（等出现 + 被改动时当帧插回），配合幂等属性 + `isConnected` 检查。代码见 `lightweight-path.md` §3.2。

### D3. 写死颜色，用户换皮肤后看不清

**现象**：某些皮肤下面板对比度崩了。
**根因**：皮肤令牌常常是**半透明**的（`bg-overlay` 实测 55%~92% 不透明），直接当底色会透出壁纸。
**修法**：能用 `--dsw-alias-*` 就用；需要实底时**自己从主题色合成不透明实色**，并跟着主题变化重算。

## E 类：开发流程里的坑（我踩过，值得单独说）

### E1. 用"看着对"代替"跑一遍"

**现象**：脚手架生成的客户端代码里 `window.__<插件名>Panel` 拼出了 `window.__dsh-selftest-probePanel` —— **不是合法 JS 标识符**，一挂载就死。
**根因**：插件名里的连字符被直接拼进了标识符。**肉眼扫不出来。**
**修法**：**任何生成代码都要跑一次真验证**。这条是被 `selftest.mjs` 当场抓到的——它值得你为每个新插件跑一次。

### E2. 测试桩不忠实，测了个寂寞

**现象**：客户端挂载测试一直失败，查半天发现是**桩的问题**：真实的 `document.querySelector` 找不到时返回 **`null`**，桩返回了 `undefined`，于是插件里 `el !== null` 的幂等守卫被误触发。
**根因**：桩与真实环境语义不一致时，测试只会制造假信号。
**修法**：写桩时**逐条对齐真实语义**（`querySelector` 返回 `null`、`removeChild` 存在、`parentNode` 能从 `parentElement` 取…)；桩一旦发现不一致，**改桩而不是改被测代码**。

### E3. 把"通过"当成"验证过"

**现象**：`selftest` 绿了，但真装上去还是不生效。
**根因**：桩测试覆盖的是**契约**（形状、回收、守卫），不覆盖**组合**（profile 挂载、真实槽位存在、真实 DOM 结构）。
**修法**：按 `SKILL.md` §4 的矩阵走完——桩测试 + `--dump-config` + 路由 curl + GUI 实际看一眼，**缺一项就把结论标成"未验证"，别写"完成"**。

---

## W 类：Windows 10 / PowerShell 5.1 实测坑（2026-09-23 真撞的）

> 这一节是技能改名成 `dsh-plugin-win10` 的原因。每条都是在这台机器上真踩的，不是理论。
> 完整版（含「工具怎么设计才方便 AI 调」12 条）在 `references/tool-design-for-ai.md`。

### W1. PowerShell 没有 heredoc

**现象**：`git commit -F - <<'MSG' … MSG` → `Missing file specification after redirection operator`，
而且多行正文里的 `-` 会被当表达式解析，一次报一屏错。
**修法**：提交信息**写文件**再 `git commit -q -F <文件>`（放 `$env:TEMP`，用完删）。
**注意**：文件要 **UTF-8 无 BOM**，否则中文提交信息会坏。

### W2. `node -e` 里的引号与正则会被 PowerShell 吃掉

**现象**：`node -e "…const hasWhich=/" which\/.test(j);…"` →
`SyntaxError: Invalid regular expression: missing /`（PowerShell 先把引号配平打乱了，Node 收到碎片）。
**根因**：PowerShell 的引号规则与 sh 不同，`\"` 与 `/` 的转义在两层解析器之间来回丢。
**修法**：**要检查什么，就把它写成测试文件** —— 顺带变成永久回归。
（同类还有：`-e` 里带反引号、带 `$`、带中文都会翻车。）

### W3. 管道会骗 exit code

**现象**：`node tests\x.mjs 2>&1 | Select-Object -Last 3` 结束时报告 `[exit code: 1]`，
而 node 其实是 **0**（脚本明明打印了「通过 N 项，失败 0」）。
**修法**：**单独跑一次**看 `$LASTEXITCODE`：`node tests\x.mjs > $null 2>&1; "exit=$LASTEXITCODE"`。
**教训**：别把「管道报的 exit code」当成被测程序的结论 —— 会白查半小时。

### W4. `Get-Content` 默认按 ANSI/GBK 解码

**现象**：UTF-8 的中文文件读出来是乱码，误判成「文件是 GBK」，进而去转码 —— **越修越坏**。
**修法**：显式 `-Encoding UTF8`，或用 `read` 工具 / node 读；**拷贝一律二进制**（`Copy-Item -LiteralPath`）。

### W5. 子进程 stdout 走控制台代码页（本机 936）

**现象**：`.ps1` 把窗口标题「原神」输出给 Node，Node 收到 `d4ad c9f1`（GBK 字节）→ mojibake。
**修法**：子进程侧把**非 ASCII 转义成 `\uXXXX`**（或让脚本纯 ASCII，并断言 0 个 >127 字节）。
**推广**：**任何「Node → PowerShell → Node」的数据通道**都按这个处理。

### W6. `$pid` 是只读自动变量

**现象**：`$pid = 0` → `Cannot overwrite variable PID because it is read-only or constant`。
**修法**：换名（`$procId`）。同类还有 `$host` / `$input` / `$error`。

### W7. 改名 / 改技能前必须逐文件 SHA 备份，且**备份不能放回 `skills\`**

**为什么**：技能目录常**不在 git 里**，就是唯一副本。
**怎么备**：拷到 `~/.dsh/_skill-backups/<旧名>_<时间戳>/`，**逐文件比对 SHA-256** 才算备好。
⚠️ **绝不能把备份放回 `~/.dsh/skills/`**：备份里带 `SKILL.md`，会被技能系统当成**第二个技能**加载出来。

### W8. 改名要扫全机引用，改完要复查残留

**现象**：技能目录内改完了，但 `skills/README.md`、工作区 `AGENTS.md`、插件源码注释、CHANGELOG 里
写死的名字/路径还指着旧名 → 别人照着跑就失败。
**做法**：**写脚本**做替换（保留 UTF-8 无 BOM、原子写、逐文件报改了几处），跑完**再扫一遍残留**；
`.dsh/storages/` 下的**会话缓存不要动**（历史数据）。
**本机实证**：一次改名 = 技能内 **7 个文件 31 处** + 外部 **4 个文件 9 处**。
