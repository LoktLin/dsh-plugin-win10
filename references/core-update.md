# DSH 本体更新 → 契约兼容工作流

> 本文件是 `dsh-plugin-win10` 技能的「本体升级」部分（原独立技能 `dsh-core-update`，2026-09-12 并入）。
> 入口在 SKILL.md §8；「我们依赖的官方 API 清单」另见 `references/used-apis.md`。
> 文内提到的探针/自测脚本都在本技能的 `scripts/` 下。

DSH 在快速演进（本机当前 `dsh 0.1.2-rc.1` / `cordis 4.0.2`）。**它一升级，我们所有插件依赖的官方 API 都可能变**——
改名、改签名、改语义、或者直接没有。而**大部分失效是静默的**：

| 变化 | 表面现象 | 为什么难发现 |
|---|---|---|
| 槽位名改了 | 插件照常加载，**UI 永远不出现** | 不报错、日志干净 |
| `patchReload` 语义变了 | 改了 patch **没生效** | 你会以为是自己写错了 |
| 装配清单换了 | 软链装了但**什么也没发生** | 没有任何错误输出 |
| `output.render` 契约变了 | 工具注册失败 | 只有一行 warn |
| 服务改名了 | 插件 `pending`，永不激活 | 看着"装了" |

所以不能靠"感觉哪里不对"。**把它变成可机械检查的断言。**

## 六步工作流

```
① 发现更新  →  ② 跑探针  →  ③ 读官方更新信息  →  ④ 定级与处置  →  ⑤ 复验 + 更新基线
```

### ① 发现更新

三种触发方式，任选（**记住：升级后第一件事就是跑探针，别先猜**）：

```powershell
# 最快：直接跑探针，它会拿当前状态和基线对比
node "$env:USERPROFILE\.dsh\skills\dsh-plugin-win10\scripts\probe-contracts.mjs"

# 想知道"是不是真升级了"：
Get-Content "$env:USERPROFILE\.dsh\profiles\web\package.json"    # 看 dsh / dsh-* 的版本
Get-Item (Join-Path (npm root -g) '@deepseek-ai\dsh\package.json') | Select-Object LastWriteTime   # ⚠️ 别照抄别人的路径
```
探针输出里的 **「与基线对比」** 段落就是答案：版本变没变、槽位增删了哪些、哪条检查状态翻转了。

### ② 跑探针（10 条检查 + 使用面扫描）

```powershell
$P = "$env:USERPROFILE\.dsh\skills\dsh-plugin-win10\scripts\probe-contracts.mjs"
node $P                              # 人类可读（不给参数 = 自动发现使用面）
node $P --json                       # 机器可读
node $P --no-scan                    # 明确不要使用面（只想知道"契约变没变"时）
node $P --scan "D:\你的插件目录" ...  # 显式指定使用面（可给多个）
```

检查项：`version` / `services`（我们用的 5 个 cordis 服务名）/ `tools`（注册契约 + schema 校验 + 保留名）/
`webserver`（路由五件套）/ `slots`（**槽位目录 + 关键槽位在不在**）/ `slot-kind`（关键槽位必须仍是 `list`）/
`client-boot`（`__ModuleLoader__` / `__DSH_BOOT__` / react 平台单例 / primitives / 运行期校验 / 主题令牌）/
`client-decl`（`dsh.client` 字段）/ `profile`（`bundles` + `patchReload`）/ `cli`（`--patch` / `--dump-config`）。

**使用面扫描**报出**我们哪里用了这些 API**——这样"契约变了"能直接对应到"哪个文件要改"。

| 参数 | 使用面来源 |
|---|---|
| 不给参数 | **自动发现**：从 `profiles/*/package.json` 的 `dsh.profile.bundles` 反查**软链到工作区**的开发中插件，加上带 `scripts/` 的技能目录 |
| `--scan <目录>...` | 你显式指定（覆盖自动发现） |
| `--no-scan` | 关闭 |

> 自动发现让**零参数**就能回答"要改哪儿"。但它**只统计代码**（`.js/.mjs/.cjs/.ts/.tsx`）——
> 文档里*描述*某个 API 不算"在用"它，否则 SKILL.md / README 会凭空造出一大片假使用面。
> 探针自己（那张 token 表）也已排除，免得把"量尺"当成"被测物"。

退出码：`0` = 全 ok；`1` = 有 changed/missing（要人判断）；`2` = 探针自己跑不起来。

`--json` 除 `ok/checks/diff/usage` 外还带元数据：`generatedAt` / `elapsedMs` / `exitCode` /
`scanSource` / `scanDirs` / `warnings`——自动化消费（比如接任务看板）用得上。

> ⚠️ **`DSH_CORE_DIR` 指错路径会告警**：探针会回退到自动探测，但**必须**在 `warnings` 里出声。
> 曾经的版本静默回退——用户以为自己指定了被测本体，实际测的是另一个目录，报告看着正常其实完全无效。

### ②b 跑**插件自己的**契约测试（探针看不见的那些）

探针只检查"我们依赖的官方 API"，**它看不见插件自己对壳的耦合**。有些耦合比 API 更容易断，
而且断起来同样静默——最典型的是 **DOM 注入**：

> **实例**：`dsh-eggy` 的侧边栏入口为了保住「新会话」正下方这个位置，走的是 DOM 注入，
> 依赖壳的 CSS Modules **局部名**（`sidebarCol` / `logoRow` / `newSession` / `regionArea` / `footArea`）。
> 上游一改名，入口就**无声消失**。2026-09-11 实测：它依赖的锚点**已经掉了两个**
> （`[data-pane="sidebar"]`、`[data-dsh-frame]` 在整个客户端包里已不存在），只是各有 fallback 兜着。

```powershell
# 蛋仔插件的侧边栏锚点测试（7 条；A 组直接对照真实壳代码，是**升级预警**）
node "D:\lua_danzai\packages\dsh-eggy\scripts\test-entry-anchors.mjs"
```

**规律**：凡是我们**靠猜壳的内部结构**来定位的东西（类名子串、`data-*` 属性、DOM 层级），
都该有一份"拿去跟真实壳对照"的测试。**别靠人眼**——这种失配不会报错，只会让功能悄悄消失。

> 判断该不该加：问自己「**上游改了这个东西，我会不会得到任何提示？**」
> 答案是"不会"的，就该有测试。

### ③ 读官方更新信息

**探针只能告诉你"变了没有"；变的是什么、为什么变、该怎么改，得去读官方。**

> ⚠️ **这里没有 changelog**（2026-09-11 实测）：官方仓库根目录**没有 `CHANGELOG.md`**，
> 而且**默认分支是 `master` 不是 `main`**（用 `main` 一律 404）。写 URL 前先确认分支：
> `curl -s https://api.github.com/repos/deepseek-ai/deepseek-harness | findstr default_branch`
>
> **更重要的认知**：官方 changelog 里 99% 的内容与我们无关。
> **"变了没有 / 影响到我们哪一行"其实由探针的基线对比回答得更好**——
> 官方资料的价值在于"**为什么变、正确的写法是什么**"，不在于"我们有没有受影响"。

```powershell
# 官方仓库公开、MIT。raw.githubusercontent 抽风时换 api.github.com（返回 base64 的 JSON）
#   ★ 给 agent 的入口（仓库根，16KB，一次讲清仓库布局/命令/约定）
#     https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/AGENTS.md
#   开发文档
#     .../master/docs/user/develop/basic/index.zh.md        # 第一个插件、开发一个工具
#     .../master/docs/user/develop/practice/index.zh.md     # 能力的三种角色（Definition/Provider/Consumer）
#   关键包 README（比 README 更权威的是本机 .d.ts，见下）
#     .../master/packages/client/ui-slots/README.md
#     .../master/packages/client/ui-renderer/README.md
#     .../master/packages/host/webserver/README.md
#   版本动向（没有 CHANGELOG，看这两处）
#     https://api.github.com/repos/deepseek-ai/deepseek-harness/commits?per_page=20
#     https://github.com/deepseek-ai/deepseek-harness/releases
```

**取值纪律（非常重要）**：
- **默认分支 ≠ 你装的版本**。先确认本机 `dsh` 的版本，再决定参考哪个 tag/commit；
- **能读本机 `.d.ts` 就别读 README**——`.d.ts` 一定与你装的版本一致，而且注释里写了"为什么这么设计、什么会抛错"；
- **别人的笔记（博客/社区技能）只能当索引**，具体签名回本机验。本会话就吃过这个亏：某份资料说前端产物里有 `PLATFORM_MODULES`，实测**两个产物里都是 0 次命中**。

### ④ 定级与处置

把探针报出来的变化分四类，**处置方式完全不同**：

| 级别 | 变化性质 | 处置 |
|---|---|---|
| **A 新增** | 多了槽位 / 多了 API / 多了字段 | **什么都不用改**。可选：评估是否值得采纳（新槽位可能比你现在用的更合适） |
| **B 签名变更** | 参数改名/改形状（如 `owner` props、`options` 字段） | **改代码**。有类型就是编译期报错，没类型就是运行期静默失效 |
| **C 移除** | 槽位没了 / 服务没了 / 旗标没了 | **致命，必须改**。先看有没有替代品；没有就退回兜底路线（见下面的兼容策略） |
| **D 语义变更** | 同名同签名但行为变了（`patchReload`、快照时机、`kind` 从 list 变 single） | **最难**，类型检查发现不了。只能靠**探针把语义也断言成检查项**（如 `slot-kind` 就是在断言"必须还是 list"）+ 在真机上验 |

**处置顺序永远是**：先看**使用面扫描**里谁在用 → 判断能不能 feature-detect → 能就改代码，不能就走兼容策略或锁版本。

### ⑤ 复验 + 更新基线

```powershell
node $P                       # 先跑到全绿
node $P --save-baseline       # **确认一切正常之后**才存
```

⚠️ **基线代表"已知良好"**。在插件还没跑通的时候存基线，等于把"坏状态"固化下来，下次升级就比不出东西了——

而且是**静默**失效：探针照样全绿，你以为一切正常。所以探针**自带守卫**：

| 情况 | 行为 |
|---|---|
| 全绿时 `--save-baseline` | 正常写入 |
| 有非 ok 项时 `--save-baseline` | **拒绝**，退出码 `3`，并列出是哪几项；**基线文件一个字节都不动** |
| 明知它坏、只想记录现状 | `--save-baseline --force`，会写入但**发出告警**（这些项以后查不出变化） |

> 退出码补齐：`0` 全 ok / `1` 有 changed·missing / `2` 探针跑不起来 / `3` **拒绝保存基线**。

### ⑥ 改了探针/文档之后：跑技能自测

```powershell
node "$env:USERPROFILE\.dsh\skills\dsh-plugin-win10\scripts\test-skill.mjs"          # 人类可读
node "$env:USERPROFILE\.dsh\skills\dsh-plugin-win10\scripts\test-skill.mjs" --json   # 机器可读
```

**技能自己也会腐化，所以探针自带测试。** 22+ 条用例分三组：

| 组 | 盯什么 |
|---|---|
| `T1` CLI 契约 | 参数 / 退出码 / JSON schema / 幂等 / **无副作用** / 无效 `DSH_CORE_DIR` 必须告警 / 自动发现使用面 / **使用面只算代码**（夹具护栏） |
| `T2` 断言正确性 | **故障注入**：删槽位、改状态、改版本、损坏基线 → 探针**必须如实报警**；再恢复并复验回到全绿 |
| `T3` 文档一致性 | 文档声称的检查条数 == 实现；URL 分支名/文件真实存在；附录数值与实测一致；提到的脚本真实存在；提到的参数**行为上**可用 |

> ⚠️ **T2 是这组测试里最值钱的部分**。它不证明"探针能跑"，它证明"**契约真变时探针会喊**"。
> 一个不会报警的探针等于没有——而"能不能报警"只能靠故意改坏来证明。
>
> ⚠️ 跑手会**临时改写契约基线**并在 `finally` 里还原（`T2.5` 复验）。中途 Ctrl-C 可能留下
> `dsh-contract-baseline.json.test-backup`，删掉即可。

## 兼容策略：做还是不做

**先问第一个问题：这个插件是给自己用，还是给别人用？**

- **只给自己用** → 跟新版就行，**不做兼容**。兼容代码是长期成本，换来的只是"能多跑几个旧版本"，而旧版本你根本不会再装。
- **要给别人用 / 已经有别人在用** → 才考虑下面这些。

四个手法，**按推荐顺序**：

| 手法 | 怎么做 | 什么时候用 |
|---|---|---|
| **1. 能力探测（首选）** | 探测**能力**而不是版本号：`if (ctx.slots && typeof ctx.slots.register === 'function') { 槽位路线 } else { DOM 兜底 }` | 大多数情况。⚠️ **别信版本号**——rc 版本号不保证语义 |
| **2. 适配层收口** | 把官方 API 的调用**集中到一个薄封装**（如 `lib/platform.mjs`）里，别散落在各处 | **任何超过一个文件的插件都该这么做**。升级时只改一处，改动面可控 |
| **3. 锁版本** | `package.json` 的 `engines.dsh` 写范围，README 标注"验证过的版本" | 变化是语义级、无法探测时。诚实地说"只支持 X"比假装兼容好 |
| **4. 双写** | 同时注册槽位与 DOM 兜底 | ⚠️ **慎用**：会产生**两条入口**（本机 `dsh-eggy` 的教训就是"只有一条路时还没事，两条路同时生效就出双入口"）。真要用必须加互斥幂等键 |

**什么时候不该兼容**：旧行为已经拿不到了（如服务被移除）；兼容分支比功能本身还复杂；或者你根本不知道有几个旧版本在外面——**这种情况下锁版本 + 明确声明支持范围更负责**。

## 我们依赖的官方 API 清单

→ `references/used-apis.md`：逐条列**我们用了什么、谁在用、失效后果、怎么 feature-detect**。
**升级后要改代码时，照那张表走**，不要凭印象找。

## 两条自我约束（写探针时踩出来的，对"做检查"这件事都适用）

1. **每条检查 token 必须先自己命中一次再留下**。我第一版照着别人的笔记加了 `PLATFORM_MODULES` 检查，
   实测本版本**两个产物里都是 0 次命中** → 它会变成"永远在报警"的噪音，而**噪音会让人忽略真问题**。
2. **解析源码别用「缩进 + 换行 + 大括号」这种正则**。真实代码缩进不统一，写死了就报**假警报**
   （第一版探针因此误报"5 个服务缺 4 个""3 个关键槽位缺失"）。用**花括号配平**切块。

> 一句话：**假警报比没有警报更糟**。一个会乱叫的探针，最后一定会被忽略。

## 附：本机当前状态（供快速对照）

| 项 | 值 |
|---|---|
| dsh / cordis | `0.1.2-rc.1` / `4.0.2` |
| 官方包数量 | 222 |
| 槽位总数 | **52**（来自 13 个文件） |
| 关键槽位 | `sidebar.footer.action`(list) · `shell.overlay`(list) · `root`(single, **禁注册**) |
| profile | `bundles` 7 项 · `patchReload: live` |
| 基线文件 | `~/.dsh/dsh-contract-baseline.json` |

（这些值会随版本变——**探针每次都会重新取**，这张表只是让你一眼看出"是不是变了"。）
