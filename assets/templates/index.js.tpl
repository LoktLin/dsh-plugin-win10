/**
 * {{NAME}} — DSH 插件 · Host half     （由技能 dsh-plugin-win10 的脚手架生成，{{DATE}}）
 *
 * 职责：
 *   ① 向 agent 注册原生工具（`tools.register`），把「让模型拼 shell 命令」换成结构化工具调用；
 *   ② 给浏览器侧的 Client half 提供 `{{PREFIX}}/*` 同源 HTTP 路由（面板的数据来源）。
 *
 * ⚠️ 三条纪律（都是实测踩出来的，细节见技能 references/pitfalls.md）：
 *   · **返回值必须是 lossless JSON**。`undefined` / `NaN` / `Infinity` / `-0` 都不是合法 JSON，
 *     宿主会直接拒收整个结果并报 `returned invalid output: value is not lossless JSON`。
 *     所以所有工具出口统一过 `lossless()` —— 这一层不能省。
 *   · **绝不硬依赖任何服务**。用 `ctx.inject` 取，取不到就降级 + warn。
 *     一个可选服务缺失不该让插件加载失败（插件加载失败会牵连整个 profile）。
 *   · **落盘 ≠ 生效**。Host 代码是 `dsh web` **启动时**加载的快照，改完必须重启（见 references/install-lifecycle.md）。
 */
export const name = '{{NAME}}';

/** 不硬依赖：`tools` / `systemPrompt` / `webServer` 任意一个缺失都能活（降级并打警告）。 */
export const inject = [];

const PREFIX = '{{PREFIX}}';
const VERSION = '{{VERSION}}';
const TITLE = '{{TITLE}}';
const STARTED_AT = Date.now();

/** 工具返回值的默认渲染：给模型看 JSON 文本。 */
const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 1) }];

/**
 * 把任意值归一成 **lossless JSON**：`undefined` → `null`，非有限数字 → `null`，`-0` → `0`。
 * 递归处理数组与对象；其余原样返回。
 */
function lossless(value) {
  if (value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(lossless);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = lossless(value[key]);
    return out;
  }
  return value;
}

/** 带 HTTP 状态码的错误：路由层据此回状态码，工具层只取 message。 */
class HttpError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'HttpError'; this.status = status; }
}

/* ==================================================================== *
 * 工具定义
 *
 * 每个工具的形状（宿主认这些字段）：
 *   { name, description, parameters: <JSON Schema>, output: { schema, render }, execute(args, exec) }
 *
 * ⚠️ `parameters` 必须是**合法的 JSON Schema**：把 `description` 写成 `properties` 之类的笔误
 *    会让宿主在**注册期**抛错，严重时连「发消息」都失败（实测踩过，见 pitfalls）。
 *    改完用 `node -e "JSON.stringify(x)"` 或本技能 scripts/selftest.mjs 过一遍。
 * ==================================================================== */
const TOOLS = [
  {
    name: '{{NAME}}_ping',
    description:
      TITLE + '的连通性自检：返回插件是否已注册、版本号与进程信息。'
      + '在怀疑「插件没生效 / 工具没注册」时先调它，比翻日志快。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    async execute() {
      return {
        ok: true,
        plugin: name,
        version: VERSION,
        pid: process.pid,
        uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
        cwd: process.cwd(),
      };
    },
  },
  {
    name: '{{NAME}}_echo',
    description:
      '调试用：把传入的 text 原样回显，并附带插件版本。'
      + '用来验证「工具参数确实传到了 Host」——返回里带上你传的字符串，就不用猜参数有没有丢。',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: '要回显的字符串。' } },
      required: ['text'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    async execute(args = {}) {
      const text = String(args.text ?? '');
      return { ok: true, echoed: text, length: text.length, version: VERSION };
    },
  },
];

/** 插件自身的状态快照（路由与工具共用同一份，避免两处口径不一致）。 */
async function selfStatus() {
  return {
    ok: true,
    plugin: name,
    title: TITLE,
    version: VERSION,
    pid: process.pid,
    uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
    tools: TOOLS.map((t) => t.name),
    prefix: PREFIX,
  };
}

/* ==================================================================== *
 * 插件入口
 * ==================================================================== */
export function apply(ctx) {
  const log = (...a) => console.log('[' + name + ']', ...a);

  // ---------- ① 注册工具 ----------
  // 用 ctx.inject(['tools'], ...)：服务出现时会（重新）调用回调，拿到的是**子上下文**。
  // 所有副作用都包在 subCtx.effect(() => 注册结果, 标签) 里 —— 返回的 disposer 保证插件卸载时能干净回收。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['tools'], (toolsCtx) => {
      const tools = toolsCtx.get('tools');
      if (!tools || typeof tools.register !== 'function') {
        console.warn('[' + name + '] tools 服务不可用：工具未注册（面板仍可用）');
        return;
      }
      let n = 0;
      for (const def of TOOLS) {
        try {
          const guarded = {
            ...def,
            async execute(args, exec) { return lossless(await def.execute(args, exec)); },
          };
          toolsCtx.effect(() => tools.register(guarded), name + ': tool ' + def.name);
          n += 1;
        } catch (e) {
          console.warn('[' + name + '] 注册工具 ' + def.name + ' 失败：' + (e && e.message ? e.message : e));
        }
      }
      log('已注册 ' + n + '/' + TOOLS.length + ' 个工具');
    });
  } else {
    console.warn('[' + name + '] ctx.inject 不可用：工具未注册（GUI 仍可用）');
  }

  // ---------- ② 系统提示补充（可选） ----------
  // 让 agent 知道「这个插件存在、什么时候该用它」。order 越小越靠前；插件类建议 100~200。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['systemPrompt'], (promptCtx) => {
      const systemPrompt = promptCtx.get('systemPrompt');
      if (!systemPrompt || typeof systemPrompt.section !== 'function') return;
      try {
        const text = [
          TITLE + '（插件 ' + name + '）已装载，提供工具：' + TOOLS.map((t) => t.name).join('、') + '。',
          '当用户提到「' + TITLE + '」相关需求时优先用这些工具，而不是自己拼命令。',
        ].join('\n');
        promptCtx.effect(
          () => systemPrompt.section({ name: 'plugin:' + name, order: 150, text }),
          name + ': prompt section',
        );
      } catch (e) {
        console.warn('[' + name + '] 系统提示注入失败：' + (e && e.message ? e.message : e));
      }
    });
  }

  // ---------- ③ 面板 HTTP 路由 ----------
  // kind:'prefix' → 前缀匹配，path 之下全部交给 handler；handler 就是裸 Node (req, res)。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      const webServer = webCtx.get('webServer');
      if (!webServer || typeof webServer.register !== 'function') {
        console.warn('[' + name + '] webServer 不可用：控制面板拿不到数据');
        return;
      }
      try {
        webCtx.effect(
          () => webServer.register({ kind: 'prefix', path: PREFIX, handler: makeHandler() }),
          name + ': ' + PREFIX + ' routes',
        );
        log('已挂载 ' + PREFIX + '/* 面板路由');
      } catch (e) {
        console.warn('[' + name + '] 路由注册失败：' + (e && e.message ? e.message : e));
      }
    });
  }
}

/* ==================================================================== *
 * HTTP 层
 * ==================================================================== */

/** 只允许本机页面访问：GUI 是 127.0.0.1，外部 Host 一律拒绝。 */
function isLocalRequest(req) {
  const host = String((req.headers && req.headers.host) || '');
  const bare = host.replace(/^\[/, '').split(']')[0].split(':')[0].toLowerCase();
  return bare === '' || bare === '127.0.0.1' || bare === 'localhost' || bare === '::1';
}

/** 读请求体（默认上限 1 MiB，超了直接 413，别让面板把宿主内存打满）。 */
function readBody(req, limitBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) { reject(new HttpError('请求体过大', 413)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); } catch { reject(new HttpError('请求体不是合法 JSON', 400)); }
    });
    req.on('error', reject);
  });
}

/** 统一回包：`{ok:true,data}` / `{ok:false,error}` —— Client half 的 api() 直接认这个信封。 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(lossless(payload), null, 1);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** 按名字调用工具（面板走这条路复用工具实现，避免「面板一套、工具一套」两份逻辑）。 */
async function runToolByName(toolName, args) {
  const def = TOOLS.find((t) => t.name === String(toolName || '').trim());
  if (!def) throw new HttpError('没有工具 ' + toolName + '（可用：' + TOOLS.map((t) => t.name).join(', ') + '）', 404);
  try {
    return { name: def.name, ok: true, data: lossless(await def.execute({ ...(args || {}) }, {})) };
  } catch (e) {
    return { name: def.name, ok: false, error: (e && e.message) || String(e) };
  }
}

function makeHandler() {
  return async (req, res) => {
    if (!isLocalRequest(req)) { sendJson(res, 403, { ok: false, error: '仅允许本机访问' }); return; }
    const url = new URL(req.url || PREFIX, 'http://127.0.0.1');
    const route = url.pathname.replace(/\/+$/, '') || PREFIX;
    try {
      if (route === PREFIX || route === PREFIX + '/status') {
        sendJson(res, 200, { ok: true, data: await selfStatus() });
        return;
      }
      if (route === PREFIX + '/tools') {
        sendJson(res, 200, {
          ok: true,
          data: {
            tools: TOOLS.map((t) => ({
              name: t.name,
              description: String(t.description || '').replace(/\s+/g, ' ').slice(0, 160),
              parameters: t.parameters,
            })),
          },
        });
        return;
      }
      if (route === PREFIX + '/tool' && req.method === 'POST') {
        const body = await readBody(req);
        sendJson(res, 200, { ok: true, data: await runToolByName(body.name, body.args) });
        return;
      }
      sendJson(res, 404, { ok: false, error: '未知路由：' + route });
    } catch (e) {
      sendJson(res, (e && e.status) || 500, { ok: false, error: (e && e.message) || String(e) });
    }
  };
}
