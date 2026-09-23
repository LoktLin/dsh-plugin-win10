# dsh-plugin-win10

> DSH（DeepSeek Harness）**Web GUI 插件包**的开发技能：怎么把「给 DSH 加个自己的东西」做成
> **能装上、能验证、能被别人复用**的插件包 —— 外加一页别人很少写、但 AI 时代最要紧的东西：
> **工具本身怎么设计，才方便 AI 调**。

这是一个 [DSH](https://github.com/deepseek-ai/deepseek-harness) **Skill**（`SKILL.md` + `references/` + `scripts/`），
不是 npm 包。装上即可被 agent 按需加载。

- 原名 `dsh-plugin-dev`，2026-09-23 更名为 `dsh-plugin-win10`：
  把**工具设计经验**与 **Windows / PowerShell 5.1 实测坑**收进来（这正是 `win10` 后缀的由来）。
- 所有契约取证自**真机**（`dsh 0.1.2-rc.1`，Windows 10 + PowerShell 5.1），
  每条都标了证据来源；**没实测过的会明说「未验证」**。

## 它解决什么

| 你会遇到 | 这里有什么 |
|---|---|
| 给 DSH 加几个工具 / 加段系统提示 / 加个 HTTP 路由 | Host 半边写法 + 三条硬约束（lossless JSON / JSON Schema / 别硬依赖） |
| 给 Web GUI 加面板、入口、浮层 | Client 半边（槽位路线 与 DOM 注入路线怎么选）+ 主题令牌 + 副作用回收 |
| **「文件都在，但什么也没发生」** | 装配机制（`dsh.profile.bundles` / `cordis.patch.yml`）+ 生效边界表 + 五分钟排障 |
| **工具写完了，但 AI 老调错、一次调用拿不全** | **`references/tool-design-for-ai.md`**：13 条实测经验 + 四条可用测试钉住的不变量 |
| Windows 上被 PowerShell 各种咬 | **`pitfalls.md` 的 W 类**：8 条真撞过的坑（heredoc、`node -e` 引号、管道骗 exit code…） |
| DSH 升级后插件行为变了 | 契约探针 + 六步兼容工作流（发现更新 → 跑探针 → 读官方信息 → 定级处置 → 复验更新基线） |

## 目录

```
dsh-plugin-win10/
├─ SKILL.md                          ← 主入口（0 选形态 → 1 选路线 → 2 五步流程 → 3 生效边界 → 4 验证矩阵 → 排障）
├─ references/
│  ├─ tool-design-for-ai.md          ← ★ 「让 AI 调得顺」的 13 条实测经验 + Windows 8 条坑
│  ├─ contracts.md                   ← 官方精确契约（槽位全目录 / 路由 / 工具 / dsh.client）
│  ├─ lightweight-path.md            ← A 路线（无构建、DOM 注入）逐层解剖
│  ├─ standard-path.md               ← B 路线（TS + tsdown + React + 槽位）
│  ├─ pitfalls.md                    ← 实测坑清单（装配/静默失效/起不来/不生效/DOM/W 类 Windows）
│  ├─ core-update.md                 ← DSH 本体升级后的六步契约兼容工作流
│  ├─ used-apis.md                   ← 我们依赖的官方 API 清单（失效后果 + 怎么 feature-detect）
│  └─ ecosystem.md                   ← 官方包地图与可参考的社区插件
├─ scripts/
│  ├─ scaffold.mjs                   ← 生成插件骨架（内建 lossless 出口 / inject 降级 / 本机访问守卫 / 客户端不 throw）
│  ├─ selftest.mjs                   ← 桩上下文跑两半边（不碰真实 dsh web，**两条路线都认**）
│  ├─ probe-contracts.mjs            ← 契约探针（对已知良好基线比差异）
│  └─ test-skill.mjs                 ← 本技能的自测（探针 + 文档-实现一致性）
├─ assets/templates/                 ← 脚手架模板（Host/Client 两半边 + package.json + cordis.patch.yml）
└─ evals/evals.json                  ← 技能触发与表现的评估用例
```

## 装上

把整个目录放进你的技能目录即可（DSH 实时 watch 这个文件夹）：

```powershell
# 默认技能目录
$dest = Join-Path $env:USERPROFILE '.dsh\skills\dsh-plugin-win10'
git clone git@github.com:LoktLin/dsh-plugin-win10.git $dest
```

（换机器/换用户时目录名保持一致即可；`SKILL.md` 里的命令都用 `$env:USERPROFILE` / `npm root -g` 现算，
**不含任何作者机器的绝对路径**。）

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

agent 侧则直接说需求即可（「给 dsh 加个面板」「插件不生效」「DSH 升级后插件还能用吗」），
技能会按触发词自动加载。

## 两条值得单独说的设计

1. **判据只能有一份。** 两个入口做同一个判断时抽成一个函数 —— **漂移过的判据比没有判据更坏**。
2. **只报数字，不下判决。** 工具给「重叠 20px / 净空 6px」，不给「这关有问题」：
   阈值属于业务方。技能里带**测试断言**守住这条（输出里不许出现 `pass`/`reachable`/`verdict`）。

## 许可

[Apache-2.0](LICENSE)。

> 技能里的契约全部取证自本机安装的 DSH（`dsh 0.1.2-rc.1`）。**本体会升级，具体值会过期** ——
> 升级后先跑 `scripts/probe-contracts.mjs` 对比基线，别靠「看着还在」下结论。
