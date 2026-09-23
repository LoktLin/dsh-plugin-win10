# B 路线：TS + tsdown + React + 官方槽位

> 什么时候从 A 升级到 B：① 要发布给别人；② 需求复杂到手写 DOM 不划算（多视图/表格/状态管理）；
> ③ 发现绕不开官方接缝（必须出现在侧栏入口、设置页、对话区、全局浮层）。
> 本机 `@linxin666/*` 那一支 20 个插件（v0.3.19）都是这个形态，可以直接抄。

## 1. package.json

```jsonc
{
  "name": "dsh-mytool",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".":                 { "types": "./lib/types/index.d.ts",        "default": "./lib/index.js" },
    "./client":          { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml", "README.md"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      // 官方包名：客户端半边真正依赖谁就写谁（信息性元数据，预检/HMR diff 用）
      "inject": [
        "@deepseek-ai/dsh-client-connection",
        "@deepseek-ai/dsh-client-ui-renderer",
        "@deepseek-ai/dsh-api-session-controller"
      ]
    }
  },
  "peerDependencies": { "react": "^18.2.0" },     // ★ React 走 peer，绝不打包进 bundle
  "devDependencies": {
    "@deepseek-ai/cordis": "^4.0.2",
    "@deepseek-ai/dsh-client-ui-renderer": "*",
    "tsdown": "^0.x", "typescript": "^5.x", "vitest": "^2.x"
  }
}
```

三条不该省的：**React 走 peer**（打进去会复制 runtime identity）、**`exports["./client"]` 必须指向真实文件**（否则启动期 FAILED fiber）、**`files` 与产物一致**。

## 2. 双 tsconfig（为什么必须分开）

Host 跑在 Node，Client 跑在浏览器，两者对**同名 Context service 的声明合并**会互相污染。
所以官方仓库用两个聚合 program：`tsconfig.host.json`（排除 `packages/client/**`）与 `tsconfig.client.json`（含各 client 包、CSS module 声明、client 测试）。
你的插件同理——**至少在客户端侧单独开一个 tsconfig**，JSX 用 `react-jsx`。

## 3. 客户端入口

```tsx
// src/client/index.tsx
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'   // ★ type-only：拉入 SlotMap 合并

export const name = 'dsh-mytool/client'
export const inject = ['slots']                                    // ★ 真正的依赖等待在这里

export function apply(ctx: Context): void {
  ctx.slots.inject('sidebar.footer.action', () => {
    const dispose = ctx.slots.register(
      { name: 'sidebar.footer.action', id: 'mytool', order: 110 },
      ToolEntry,
    )
    return () => dispose()
  })
}

function ToolEntry(props: { wide: boolean }) {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <button aria-label="我的工具" onClick={() => setOpen(v => !v)}>
        <Icon />{props.wide && <span>我的工具</span>}
      </button>
      {open && <Panel onClose={() => setOpen(false)} />}
    </>
  )
}
```

**要点**

- **type-only import 拉入 SlotMap 合并**：不这么写，`'sidebar.footer.action'` 这个字符串在类型层就是未知的。
- **`export const inject = ['slots']`** 才是客户端 fiber 真正的依赖等待；`package.json` 里的 `dsh.client.inject` 是元数据。两者**不可互相替代**。
- **`ctx.slots.register` 的返回值必须被 dispose**——串进 `ctx.effect`，或用 `inject` 回调的返回值（它会随声明塌陷自动回收）。
- **props 不要自己重述**：用 `ComposedProps`（见 `contracts.md` §1.2 的四份额）。

## 4. 全局浮层用 `shell.overlay`，不要 body portal

```tsx
ctx.slots.inject('shell.overlay', () => ctx.slots.register(
  { name: 'shell.overlay', id: 'mytool-float', order: 200 },
  FloatingPanel,
))
```

`shell.overlay` 是 `kind: 'list'` 的帧级浮层，位于所有栏之上、**默认点击穿透**——你的条目要自己 opt-in pointer events。
**它的价值**：不用自己 fixed 定位、不会被浏览器滚动/裁剪吃掉、多个插件的浮层能自己排序、和 React 生命周期天然一致。

确无全局角落槽位时才退回 body portal（A 路线的做法），并且要自己负责：
React root / DOM / window listener / 全局 attribute 的 disposer、跟随 session 过滤、导航时立即收起、
只依赖稳定的 `data-*` 属性（**别耦合哈希 class**）、键盘与 `:focus-visible`/`aria-*`/Escape/reduced motion。
面板高度限制为容器的一部分、内容区内部滚动；轮询用 `no-store` + in-flight guard + 响应形状校验 + unmount 防护。

## 5. 构建

```jsonc
// package.json
"scripts": {
  "build": "tsdown",
  "watch": "tsdown --watch",
  "typecheck": "tsc --noEmit",
  "test": "vitest run"
}
```

产物必须是**自注册的 CJS factory**：

```js
window.__ModuleLoader__.load({ id: "<包名>", factory: (require) => { /* bundle */ } })
```

构建必须保留这四样，否则会出现难查的怪问题：

| 必须保留 | 不保留的后果 |
|---|---|
| **Host/Client 两半产物并存**（client build 不清空 host 输出） | Host 半边消失，工具全部没注册 |
| sourcemap | 页面报错永远指向压缩后的第 1 行 |
| CSS Modules 编译 + `style[data-plugin]` 注入 | 宿主无法追踪/回收你的样式 |
| **client bundle purity gate** | 越界 import 到运行期才炸 |

## 6. import 纯度（浏览器侧最容易踩）

浏览器模块表**只回答两类名字**：

1. **平台 seed 模块**（壳提供的单例）：`react`、`react/jsx-runtime`、`react-dom/client`、Cordis、slots、web-react、primitives、attachment、schema-form 等；
2. **图里声明过的插件行**（`external`）：包名，或 `<pkg>/client`（归一化到同一份 exports）。

规则：

- **纯类型 import 会被擦除**，可以跨包随便拉（`import type {} from '…'`）。
- **跨插件的值 import 禁止**——协作必须走 Cordis service / remote / slot。
- wire types、生成的 remote codec、明确 vendored 的纯库，只有在官方模板允许时才 inline。
- 违反 → **构建期纯度门**或**运行时 require** 报错（后者更难查）。

## 7. 验证

```powershell
pnpm typecheck ; pnpm build ; pnpm test
# 组合期
dsh --profile web --dump-config | Select-String "dsh-mytool"
# 临时 profile 试装（比动 web 安全）
dsh plugin --profile scratch add <包名> ; dsh --profile scratch --dump-config
# GUI：真实浏览器验证 名册/路由/交互/刷新/宽窄屏/滚动/焦点/reduced motion
```

客户端单测建议用 jsdom lane，通过 **SlotTestRuntime** 或最小 fake services mount 插件，并断言：

- slot 注册、渲染、**session 隔离**、connection reset；
- **dispose 之后 registry / DOM / style / controller 全部清理**（每个 registry 贡献至少一个 dispose/HMR 安全测试）。
