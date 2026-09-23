# {{NAME}}

{{DESCRIPTION}}

由技能 `dsh-plugin-win10` 的脚手架生成（{{DATE}}）。这是一个 **DSH Web GUI 插件包**，由两半边组成：

| 半边 | 文件 | 运行在哪 | 职责 |
|---|---|---|---|
| Host | `index.js` | `dsh web` 的 Node 进程 | 注册原生工具（`tools.register`）、系统提示补充、`{{PREFIX}}/*` HTTP 路由 |
| Client | `lib/client.js` | 浏览器页面 | 侧边栏入口 + 面板；通过 fetch 调 Host 的路由 |

## 安装（开发态）

```powershell
# ① 把包挂进 web profile（软链，改代码立即生效；不用 npm publish）
cmd /c mklink /J "$env:USERPROFILE\.dsh\profiles\web\node_modules\{{NAME}}" "<本目录绝对路径>"

# ② 在 profile 层启用（如果 install 命令没自动加）
#    编辑 ~/.dsh/profiles/web/cordis.patch.yml，加一行：
#    [ { id: {{NAME}}, name: {{NAME}}, disabled: false } ]

# ③ 重启 dsh web（Host 代码是启动时快照，不重启不生效）
```

## 验证

```powershell
# 工具是否注册：问 agent 调 {{NAME}}_ping（或看 dsh web 控制台有没有 "[{{NAME}}] 已注册 N/N 个工具"）
# 路由是否挂上：
curl.exe "http://127.0.0.1:3080{{PREFIX}}/status"
# 面板是否出现：刷新浏览器 → 侧边栏「新会话」下方应多一行入口
```

## 改代码后的生效规则

- **`index.js` / `lib/*.mjs`（Host）** → 必须**重启 `dsh web`**。Host 半边是启动时加载的快照。
- **`lib/client.js`（Client）** → **刷新浏览器**即可（client bundle 在激活时快照；若在跑 `pnpm run dev:web`，客户端插件可热重载）。
- 两者都改 → 重启 + 刷新。
