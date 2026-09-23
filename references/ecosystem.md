# 生态地图：官方包、社区插件、以及去哪儿抄

## 0. 官方：`deepseek-ai/deepseek-harness`（公开、MIT）

仓库地址：https://github.com/deepseek-ai/deepseek-harness

**取证纪律（重要）**：默认分支 **不等于** 你本机装的版本。拷代码/对齐契约之前先确认 npm 包版本，再决定参考哪个 tag；
`dsh` 自己的 README 也提醒「GitHub 有 tag ≠ npm 已发布」。

**取证顺序**：① 本机 `node_modules/@deepseek-ai/*/lib/types/*.d.ts`（**最准，一定与运行版本一致**）→ ② 官方仓库对应路径 → ③ 社区插件。

**注意**：本机 `@deepseek-ai/dsh` 安装目录里的 README 里的相对链接（`docs/user/develop/practice/index.zh.md`）**指向仓库内的文档**，安装产物里没有——要看那些文档得去仓库。

### 与本技能直接相关的官方包（本机实测存在的）

| 包 | 作用 | 为什么你要看它 |
|---|---|---|
| `dsh-host-webserver` | HTTP 路由注册、index 注入、静态 fallback | **路由契约的唯一权威**（`register` / `registerUpgrade` / `registerFallback` / `tapIndex`） |
| `dsh-client-modules` | 客户端模块系统（宿主半边：扫描 `dsh.client`、组 `window.__DSH_BOOT__`、发 bundle） | 搞清楚**客户端 bundle 怎么被发现、快照、热更** |
| `dsh-client-ui-renderer` | Slot registry 的 cordis 服务层（`ctx.slots`）+ `ctx.uiRenderer` | **槽位系统的入口**，注册/声明/回收语义都在这 |
| `dsh-client-ui-slots` | 槽位纯核（`SlotMap`、`register`、四种 kind、store seat） | ⚠️ 本机**未作为独立包安装**（内联了）；契约从各提供方的 `contract/slots.d.ts` 反推 |
| `dsh-client-ui-layout` | 三栏 AppFrame + `ctx.layout`（导航与面板状态） | `root` / `sidebar` / `conversation` / `details` / **`shell.overlay`** 的声明者 |
| `dsh-client-ui-sidebar` | 侧边栏（会话树、搜索、分组） | **`sidebar.footer.action`（list）加侧栏入口的正解**；`sidebar.workspaces`/`settings` 已被占 |
| `dsh-client-ui-theme` | 主题：`--dsw-*` 令牌、light/dark/system | 你的面板要跟着换肤，令牌清单在这 |
| `dsh-client-ui-settings` / `-general` / `-plugins` / `-models` | 设置域与各设置分区 | 要加"设置页/设置项"就看它们的 slot 契约 |
| `dsh-client-ui-conversation` / `-chat` | 会话栏与对话节点 | 要进对话区（发消息、命令视图、turnTail）看这两个 |
| `dsh-client-ui-tool` | 工具调用的渲染树 + 每工具展示位 | 想让自己的工具结果有专属渲染，注册 `tool.call.toolview` |
| `dsh-api-gateway` / `dsh-api-remotes` / `dsh-api-*-controller` | Remote 层：Host↔Client 的结构化 RPC | 要读会话/工作区等 Host 状态时，这是正规通道（比自己开 HTTP 路由更贴框架） |
| `dsh-tool-cordis` / `dsh-cordis-*-runner` | 动态双半插件（运行时定义、挂载、卸载） | 区分"临时插件"与"插件包"（见 `contracts.md` §6） |

## 1. 本机已装的社区插件（可直接读源码抄）

```powershell
$nm = "$env:USERPROFILE\.dsh\profiles\web\node_modules"
Get-ChildItem $nm -Directory | Where-Object { $_.Name -like '@*' } |
  ForEach-Object { Get-ChildItem $_.FullName -Directory } | Select-Object -ExpandProperty FullName
```

### `@linxin666/*` v0.3.19 —— 同一作者的一整支（共 20 个包）

| 包 | 能学什么 |
|---|---|
| `dsh-client-ui-task-board` | **最值得读的一个**：Host 权威账本 + client 面板 + 设置页槽位注册 + cron 调度 + 权限门。契约文档（中英 README）写得非常清楚 |
| `dsh-ssh` | Host 半边 128KB / client 半边 808KB —— 大插件的组织方式；看它的 `lib/types/http.d.ts` 学路由分层 |
| `dsh-doctor` | 环境诊断类插件的形态（Host + CLI + client） |
| `dsh-client-ui-settings` 系 / `-web-ui-settings` | 往设置域里长内容 |
| `dsh-client-ui-skin-center` | 皮肤/主题类插件怎么用 `--dsw-*` 令牌 |
| `dsh-client-ui-skill-explorer` / `-preset-center` / `-model-capabilities` | 各类只读视图的槽位用法 |
| `dsh-client-ui-git-graph` / `-market` / `-plugin-manager` / `-community-plugins` | 带列表/卡片/搜索的复杂面板 |
| `dsh-pet` / `dsh-usage` / `dsh-session-archive` / `dsh-i18n` / `dsh-liangshen` / `dsh-tool-describe-image` / `dsh-remote-web-ui` | 各自小而专的样本 |
| `dsh-web-all` | **聚合包**：一键装全套，`cordis.patch.yml` 与 `exports` 的多入口写法值得参考 |

仓库：https://github.com/zhu1090093659/dsh-web

### 其它本机插件

- `dsh-better-sidebar` v0.18.0 —— 侧边栏增强
- `dsh-eggy` —— **本技能的 A 路线范例**（蛋仔控制面板，自研）
- `dsh-at-file` / `dsh-skill-manager` / `dsh-wechat` —— 本地自研/第三方小插件

> 抄代码之前先看它的 `package.json` 的 `dsh` 段与 `cordis.patch.yml`——**这两处决定了它能不能被装上**，比源码本身更值得先看。

## 2. 社区已有的知识与技能（存在，但要按版本校验）

| 资源 | 内容 | 怎么用 |
|---|---|---|
| [NanmiCoder/dsh-agent-teams · `dsh-plugin-win10elopment`](https://github.com/NanmiCoder/dsh-agent-teams) | 一份**相当完整**的 DSH 插件开发 Skill（v3.1.1）：bundle/profile 契约、Service、工具、HTTP、持久化、slot 四步契约、Conversation Node、双 tsconfig、纯度门、分发与验证矩阵 | 最值得通读的外部资料。⚠️ **它自己在开头声明「主体保留 2026-08-13 的历史模板，不代表当前 Harness 的 API」**——所以把它当**索引和思路**，具体签名回本机 `.d.ts` 校验 |
| [sandbaseai/deepseek-harness-handbook](https://github.com/sandbaseai/deepseek-harness-handbook) | 手册，含 `docs/en/plugin-development/first-plugin.md` | 入门读物 |
| [Pasumao/dsh-plugin-win10-kb](https://github.com/Pasumao/dsh-plugin-win10-kb) | 「官方文档完整镜像 + 主题导航与检索」知识库 | 想快速检索官方文档时用 |
| [liangdabiao/dsh-plugin-win10eloper-skill](https://github.com/liangdabiao/dsh-plugin-win10eloper-skill) | 含 `references/browser-side.md`（Slots Toolview、沙箱与安全，基于 dsh 0.1.1-rc.2） | 浏览器侧专题；**注意版本号比本机旧** |

**对本技能的使用建议**：上面这些是"别人的笔记"。**本技能与它们的差异是**：本技能定位在
「**用本机真实契约**做**可验证**的插件开发」，所以每个契约都给了取证命令，每个结论都尽量标了来源与验证方式；
而它们的价值是**覆盖面**和**行文组织**。两者互补——拿它们的结构，回本机取事实。

## 3. 去哪儿找"这个功能该注册哪个槽位"

1. `Get-ChildItem $base -Recurse -Include *.d.ts | Select-String "interface SlotMap" -List` → 得到**提供方清单**；
2. 按你的功能关键词找对应包（侧栏 → `ui-sidebar`；会话 → `ui-conversation`；设置 → `ui-settings*`；工具视图 → `ui-tool`）；
3. 读它的 `contract/slots.d.ts` —— 注释会写**这个座位是谁的、被谁占了、注册上去是"加"还是"替换"**；
4. **优先选 `kind: 'list'`**（加性）；看到 `single` 基本可以认为已经被正式插件占了。

## 4. 抄代码的正确姿势

- **先看 `package.json` 的 `dsh` 段**（能不能被装上），再看 `cordis.patch.yml`（挂在哪一层），最后才看源码。
- 社区包的 `lib/client.js` 是**构建产物**（可能 800KB+ 且带 sourcemap）——想读源码就顺着 `.map` 找回 `src/`，
  或者直接在 GitHub 上读源码仓库，别硬啃产物。
- **不要照抄 API 名字**。同一件事在不同版本里可能改过名（本机 `shell.overlay`、`sidebar.footer.action` 都是我从
  `.d.ts` 现场查出来的）。**抄结构，不抄符号。**
