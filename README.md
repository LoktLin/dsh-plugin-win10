# dsh-plugin-win10

> DSH（DeepSeek Harness）**Web GUI 插件包的开发技能**：把「给 DSH 加个自己的东西」做成
> **能装上、能验证、能被别人复用**的插件包；另含一页**工具本身怎么设计才方便 AI 调**。

这是一个 DSH **Skill**（`SKILL.md` + `references/` + `scripts/`）。**装法 = 放进技能目录**（不是 npm 包）。

- **平台**：Windows 10 + PowerShell 5.1（`win10` 后缀即此意）。
- **契约基线**：`dsh 0.1.2-rc.1` 真机取证 —— **DSH 升级后先跑 `node scripts/probe-contracts.mjs --scan <你的插件>` 对比基线**，别靠"看着还在"下结论；未实测的项文档里会明说「未验证」。

## 它解决什么

| 你会遇到 | 这里有什么 |
|---|---|
| 给 DSH 加几个工具 / 加段系统提示 / 加个 HTTP 路由 | Host 半边写法 + 三条硬约束（lossless JSON / JSON Schema / 别硬依赖） |
| 给 Web GUI 加面板、入口、浮层 | Client 半边（槽位路线 与 DOM 注入路线怎么选）+ 主题令牌 + 副作用回收 |
| **「文件都在，但什么也没发生」** | 装配机制（`dsh.profile.bundles` / `cordis.patch.yml`）+ 生效边界表 + 五分钟排障 |
| **工具写完了，但 AI 老调错、一次调用拿不全** | `references/tool-design-for-ai.md`：13 条实测经验 + 四条可用测试钉住的不变量 |
| Windows 上被 PowerShell 咬 | `references/pitfalls.md` 的 W 类：**9 条**实测坑（heredoc、`node -e` 引号、管道骗 exit code…） |
| DSH 升级后插件行为变了 | 契约探针 + 兼容工作流（跑探针 → 读官方信息 → 定级处置 → 复验更新基线） |

## 里面有什么

| 路径 | 内容 |
|---|---|
| `SKILL.md` | 主入口：选形态 → 选路线 → 五步流程 → 生效边界 → 验证矩阵 → 排障 |
| `references/tool-design-for-ai.md` | 让 AI 调得顺的 13 条实测经验（含系统提示段这第二条通道） |
| `references/contracts.md` | 官方精确契约：槽位全目录 / 路由 / 工具 / `dsh.client` |
| `references/lightweight-path.md` · `standard-path.md` | A 路线（无构建、DOM 注入）/ B 路线（TS + tsdown + React + 槽位） |
| `references/pitfalls.md` | 实测坑清单：装配 / 静默失效 / 起不来 / 不生效 / DOM / Windows |
| `references/core-update.md` | DSH 本体升级后的契约兼容工作流与兼容策略 |
| `references/used-apis.md` | 依赖的官方 API 清单：失效后果 + 怎么 feature-detect |
| `references/ecosystem.md` | 官方包地图与可参考的社区插件 |
| `references/release-doc-review.md` | 发版前的发布文档内检流程（README / release notes / CHANGELOG） |
| `scripts/` | `scaffold.mjs` 生成骨架 · `selftest.mjs` 桩自检 · `probe-contracts.mjs` 契约探针 · `test-skill.mjs` 本技能自测 |
| `assets/templates/` | 脚手架模板：Host / Client 两半边 + `package.json` + `cordis.patch.yml` |

## 装上

```powershell
$dest = Join-Path $env:USERPROFILE '.dsh\skills\dsh-plugin-win10'
git clone git@github.com:LoktLin/dsh-plugin-win10.git $dest
```

目录名保持 `dsh-plugin-win10`（DSH 实时 watch `~/.dsh/skills`）。

## 用

```powershell
# ① 生成骨架
node scripts/scaffold.mjs dsh-mytool --dir D:\myplugins
# ② 桩自检（不碰真实 dsh web，秒级）
node scripts/selftest.mjs --plugin D:\myplugins\dsh-mytool
# ③ 契约探针（要兼容性结论时）
node scripts/probe-contracts.mjs --scan D:\myplugins\dsh-mytool
# ④ 本技能自身自测
node scripts/test-skill.mjs
```

Agent 侧直接说需求即可（「给 dsh 加个面板」「插件不生效」「DSH 升级后插件还能用吗」），技能按触发词自动加载。

## 两条硬边界

- **工具只报数字，不下判决**：给「重叠 20px」而不是「这关有问题」—— 阈值属于业务方。
- **失败走回执，不抛异常**：Host 工具里同步函数不 `await`，用 `.catch()` 接成 `{ok:false,error}`。

## 许可

[Apache-2.0](LICENSE)。
