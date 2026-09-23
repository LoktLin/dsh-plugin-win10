#!/usr/bin/env node
/**
 * scripts/selftest.mjs —— 验证「脚手架生成的东西**真的能用**」。
 *
 * 为什么必须有它：Host 侧和 Client 侧的骨架里有大量隐式契约
 * （工具注册形状、`{ok,data}` 信封、本机访问守卫、CJS factory 壳、DOM 注入+自愈、
 * effect 回收、绝不 throw）。这些只要有一处对不上，插件就是**静默失效**——
 * 面板不出现、工具不注册，而日志里什么都没有。所以不能靠肉眼，必须跑。
 *
 * 做法：不碰真实的 dsh web，而是给插件一个**桩上下文**（stub ctx）：
 *   · Host：假 `ctx.inject` + 假 `req/res`，断言工具注册、路由回包、访问守卫；
 *   · Client：假 `window.__ModuleLoader__` + 一套极简 DOM，断言 apply() 真把入口
 *     挂进了（假）侧边栏，且 cleanup 能把副作用全部收回去。
 *
 * 用法：
 *   node scripts/selftest.mjs                       # 用临时目录现生成一个插件来测
 *   node scripts/selftest.mjs --plugin <插件目录>    # 测一个已存在的插件
 *   node scripts/selftest.mjs --json
 *
 * 退出码：0 全过 / 1 有失败
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const AS_JSON = argv.includes('--json');
const val = (f, d = '') => { const i = argv.indexOf('--' + f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const results = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then((detail) => { results.push({ name, ok: true, detail: detail === undefined ? '' : String(detail) }); })
    .catch((e) => { results.push({ name, ok: false, detail: String((e && e.message) || e) }); });
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

/* ============================ 桩：Host 侧 ctx ============================ */

function makeStubCtx() {
  const registered = { tools: [], webServer: [], prompts: [] };
  const effects = [];
  const ctx = {
    inject(names, cb) {
      const sub = {
        get(service) {
          if (service === 'tools') return { register: (def) => { registered.tools.push(def); return () => {}; } };
          if (service === 'webServer') return { register: (cfg) => { registered.webServer.push(cfg); return () => {}; } };
          if (service === 'systemPrompt') return { section: (sec) => { registered.prompts.push(sec); return () => {}; } };
          return undefined;
        },
        effect(fn, label) { const d = fn(); effects.push({ label, dispose: d }); return d; },
      };
      cb(sub);
    },
  };
  return { ctx, registered, effects };
}

/* ============================ 桩：HTTP req/res ============================ */

function fakeReq(method, url, { host = '127.0.0.1:3080', body = null } = {}) {
  const handlers = {};
  const req = {
    method, url, headers: { host },
    on(ev, cb) { (handlers[ev] = handlers[ev] || []).push(cb); return req; },
    destroy() {},
    emit(ev, arg) { for (const cb of handlers[ev] || []) cb(arg); },
  };
  if (body !== null) {
    setImmediate(() => { req.emit('data', Buffer.from(body, 'utf8')); req.emit('end'); });
  }
  return req;
}

function fakeRes() {
  const state = { status: 0, headers: {}, chunks: [] };
  const res = {
    writeHead(status, headers) { state.status = status; state.headers = headers || {}; },
    end(chunk) { if (chunk !== undefined && chunk !== null) state.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')); },
  };
  Object.defineProperty(res, 'result', {
    get() { return { status: state.status, headers: state.headers, text: Buffer.concat(state.chunks).toString('utf8') }; },
  });
  return res;
}

/** 调一次路由：等 setImmediate 让 `data`/`end` 事件发出来。 */
async function callRoute(handler, method, url, opts = {}) {
  const req = fakeReq(method, url, opts);
  const res = fakeRes();
  await handler(req, res);
  await new Promise((r) => setImmediate(r));
  return res.result;
}

/* ============================ 桩：极简 DOM ============================ */

/**
 * 只实现我们真正用到的选择器形态：`[attr]`、`[attr="v"]`、`[attr*="v"]`、
 * 可带标签前缀（如 `button[class*="newSession"]`）、逗号分隔取首个命中。
 */
function matches(el, spec) {
  const s = spec.trim();
  const m = /^([a-zA-Z]*)\s*\[([^\]]+)\]$/.exec(s);
  if (!m) return false;
  const [, tag, attrExpr] = m;
  if (tag && el.tagName !== tag.toUpperCase()) return false;
  const a = /^([a-zA-Z-]+)\s*(\*=|=)\s*"?([^"]*)"?$/.exec(attrExpr);
  if (!a) {
    // 裸属性选择器 `[attr]`：只判「有没有这个属性」。
    // 插件用 `setAttribute(x, "")` 打标记，所以这里不能拿空串当「没有」。
    const bare = /^([a-zA-Z-]+)$/.exec(attrExpr.trim());
    return bare ? el.getAttribute(bare[1]) !== null : false;
  }
  const [, attr, op, want] = a;
  const have = attr === 'class' ? String(el.className || '') : el.getAttribute(attr);
  if (have === null || have === undefined) return false;
  return op === '*=' ? String(have).includes(want) : String(have) === want;
}

function selectFirst(root, selector) {
  for (const spec of String(selector).split(',')) {
    const stack = [...(root.children || [])];
    while (stack.length) {
      const cur = stack.shift();
      if (matches(cur, spec)) return cur;
      if (cur.children) stack.push(...cur.children);
    }
    if (root !== undefined && matches(root, spec)) return root;
  }
  // ⚠️ 必须返回 **null**（真实 DOM 找不到时就是 null）。
  //    返回 undefined 会让插件里 `querySelector(...) !== null` 这类幂等守卫**误判成"已存在"**
  //    ——这个不一致被本文件当场抓到过，所以这里写死 null。
  return null;
}

function makeDom() {
  const all = [];
  function elem(tag) {
    const e = {
      tagName: String(tag).toUpperCase(),
      children: [],
      parentElement: null,
      isConnected: true,
      className: '',
      id: '',
      textContent: '',
      innerHTML: '',
      hidden: false,
      type: '',
      value: '',
      placeholder: '',
      disabled: false,
      style: {},
      _attrs: {},
      _listeners: {},
      setAttribute(k, v) { this._attrs[k] = String(v); },
      getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
      removeAttribute(k) { delete this._attrs[k]; },
      append(...kids) { for (const k of kids) this.appendChild(k); },
      appendChild(k) { k.parentElement = this; this.children.push(k); all.push(k); return k; },
      insertBefore(k, ref) {
        k.parentElement = this;
        const i = ref ? this.children.indexOf(ref) : -1;
        if (i < 0) this.children.push(k); else this.children.splice(i, 0, k);
        all.push(k);
        return k;
      },
      removeChild(k) {
        const i = this.children.indexOf(k);
        if (i >= 0) this.children.splice(i, 1);
        k.parentElement = null; k.isConnected = false;
        const j = all.indexOf(k); if (j >= 0) all.splice(j, 1);
        return k;
      },
      remove() {
        if (this.parentElement) this.parentElement.removeChild(this);
        else { this.isConnected = false; const j = all.indexOf(this); if (j >= 0) all.splice(j, 1); }
      },
      get parentNode() { return this.parentElement; },
      set parentNode(v) { this.parentElement = v; },
      addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
      removeEventListener(t, fn) { const a = this._listeners[t] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },
      querySelector(sel) { return selectFirst(this, sel); },
      querySelectorAll() { return []; },
      get firstElementChild() { return this.children[0] || null; },
      get nextElementSibling() {
        if (!this.parentElement) return null;
        const i = this.parentElement.children.indexOf(this);
        return i >= 0 ? (this.parentElement.children[i + 1] || null) : null;
      },    };
    return e;
  }

  const head = elem('head');
  const body = elem('body');
  const doc = {
    head, body,
    createElement: (t) => elem(t),
    getElementById: (id) => all.find((e) => e.id === id) || null,
    querySelector: (sel) => (selectFirst(head, sel) || selectFirst(body, sel) || null),
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  };

  /** 造一个「像真壳」的侧边栏：column > wrapper > [新会话按钮, 另一插件按钮, 工作区 DIV]。 */
  const column = elem('div');
  column.setAttribute('data-pane', 'sidebar');
  const wrapper = elem('div');
  const newBtn = elem('button');
  newBtn.className = 'newSessionBtn';
  const otherBtn = elem('button');
  otherBtn.className = 'someOtherPluginEntry';
  const region = elem('div');
  region.className = 'regionArea';
  wrapper.append(newBtn, otherBtn, region);
  column.appendChild(wrapper);
  doc.body.appendChild(column);

  return { doc, all, refs: { column, wrapper, newBtn, otherBtn, region } };
}

/* ============================ 加载被测插件 ============================ */

async function loadHostHalf(pluginDir) {
  const entry = path.join(pluginDir, 'index.js');
  assert(fs.existsSync(entry), '缺 index.js：' + entry);
  const mod = await import(pathToFileURL(entry).href + '?t=' + Date.now());
  return mod;
}

/**
 * 极简 React 桩。
 * ⚠️ 必须有——**槽位路线的客户端会 `require("react")`**，桩如果一拒了之，
 * 就会把一个做对了的插件判成错的（实测踩过：同一份包走槽位路线 13✅/3❌，换成 DOM 版 16/16）。
 * 这里只提供最小可用面：注册阶段通常只用得上 createElement / Fragment。
 */
function makeReactStub() {
  const el = (type, props, ...children) => ({ $$typeof: 'element', type, props: { ...(props || {}), children } });
  return {
    createElement: el, Fragment: Symbol('Fragment'), Component: class {}, PureComponent: class {},
    createContext: (v) => ({ Provider: (p) => p?.children ?? null, Consumer: () => null, _v: v }),
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    useEffect: () => {}, useLayoutEffect: () => {}, useMemo: (f) => (typeof f === 'function' ? f() : undefined),
    useRef: (v) => ({ current: v }), useCallback: (f) => f, useReducer: (r, i) => [i, () => {}],
    memo: (c) => c, forwardRef: (c) => c, createRef: () => ({ current: null }),
  };
}

/** 客户端入口解析：优先 package.json 的 exports["./client"]，解析不到再退化探测常见路径。 */
function resolveClientEntry(pluginDir, pkg) {
  const ex = (pkg && pkg.exports) || {};
  const pick = (v) => (typeof v === 'string' ? v : (v && (v.default || v.import || v.require)) || null);
  const cands = [pick(ex['./client']), 'lib/client.js', 'client.js', 'dist/client.js', 'lib/client.mjs'];
  for (const c of cands) {
    if (!c || typeof c !== 'string') continue;
    const p = path.resolve(pluginDir, c);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  return null;
}

/**
 * 加载客户端半边。
 * 两条路线都要能跑：
 *   · **DOM 路线**（无构建模板）：注入侧边栏 + 面板；
 *   · **槽位路线**（官方接缝）：`ctx.slots.register(...)` 注册 React 组件。
 * 所以 `require` 必须给得出手（不能"一 require 就判死"），`ctx` 也必须同时带 `effect` 与 `slots`。
 */
async function loadClientHalf(pluginDir, pkg) {
  const entry = resolveClientEntry(pluginDir, pkg);
  assert(entry !== null, '找不到客户端入口（exports["./client"] / lib/client.js / client.js 都没有）');
  const code = fs.readFileSync(entry, 'utf8');
  const dom = makeDom();
  const required = [];
  let captured = null;
  const win = { __ModuleLoader__: { load: (spec) => { captured = spec; } } };
  const requireStub = (spec) => {
    const s = String(spec);
    required.push(s);
    if (s === 'react' || s.startsWith('react/') || s.startsWith('react-dom')) return makeReactStub();
    return {};                    // 其它模块给空对象：不假装它存在，但也别因为不认识就判死
  };
  const MO = function () { this.observe = () => {}; this.disconnect = () => {}; this.takeRecords = () => []; };
  const runner = new Function('window', 'document', 'MutationObserver', 'fetch', 'console',
    'with (window) { ' + code + ' }');
  runner(win, dom.doc, MO, async () => { throw new Error('selftest 不该真的发请求'); }, console);
  assert(captured !== null, '客户端没有调用 window.__ModuleLoader__.load({...})');
  assert(typeof captured.factory === 'function', 'load() 里缺 factory 函数');
  const mod = captured.factory(requireStub);
  return {
    exports: mod, dom, id: captured.id, required,
    entry: path.relative(pluginDir, entry).replace(/\\/g, '/'),
  };
}

/** 造一个「两条路线都能用」的客户端 ctx 桩：既有 effect，也有 slots。 */
function makeClientStubCtx(onSlot) {
  const effects = [];
  const slots = [];
  const injected = [];
  const ctx = {
    effect(fn, label) { const d = fn(); effects.push({ label, dispose: d }); return d; },
    slots: {
      inject(key, cb) { injected.push(String(key)); try { cb(); } catch { /* 记下来即可 */ } return () => {}; },
      register(spec) { slots.push(spec || {}); if (onSlot) onSlot(spec); return () => {}; },
      entries() { return []; },
    },
  };
  return { ctx, effects, slots, injected };
}

/* ============================ 主流程 ============================ */

let tmpDir = null;
let pluginDir = val('plugin', '');
if (!pluginDir) {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-selftest-'));
  await new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(HERE, 'scaffold.mjs'), 'dsh-selftest-probe', '--dir', tmpDir, '--json'],
      { timeout: 60000, windowsHide: true, maxBuffer: 1 << 22 },
      (err, stdout) => {
        if (err) { reject(new Error('脚手架执行失败：' + String(stdout || err.message))); return; }
        try { JSON.parse(stdout); resolve(); } catch { reject(new Error('脚手架没回 JSON：' + stdout)); }
      });
  });
  pluginDir = path.join(tmpDir, 'dsh-selftest-probe');
}

const cleanup = () => { if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ } } };

try {
  await check('脚手架产物齐全', () => {
    const need = ['package.json', 'cordis.patch.yml', 'index.js', path.join('lib', 'client.js'), 'README.md'];
    const missing = need.filter((f) => !fs.existsSync(path.join(pluginDir, f)));
    assert(missing.length === 0, '缺文件：' + missing.join(', '));
    return need.length + ' 个文件';
  });

  await check('package.json 声明了 client 半边与 bundle patch', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'));
    assert(pkg.type === 'module', 'type 必须是 module（Host 半边是 ESM）');
    assert(pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch, '缺 dsh.bundle.patch —— 宿主不会挂这个插件');
    assert(pkg.dsh.client && pkg.dsh.client.platform === 'web', '缺 dsh.client.platform=web —— 客户端半边不会被打包');
    assert(pkg.exports && pkg.exports['./client'], '缺 exports["./client"] —— 客户端半边入口找不到');
    return 'ok';
  });

  await check('两个半边都是合法 JS 语法', async () => {
    for (const f of ['index.js', path.join('lib', 'client.js')]) {
      await new Promise((resolve, reject) => {
        execFile(process.execPath, ['--check', path.join(pluginDir, f)], { timeout: 30000, windowsHide: true },
          (err, _o, stderr) => (err ? reject(new Error(f + ' 语法错误：' + stderr)) : resolve()));
      });
    }
    return '2 个文件';
  });

  const host = await loadHostHalf(pluginDir);
  const stub = makeStubCtx();
  let applyError = null;
  await check('Host: apply(ctx) 不抛错', () => {
    try { host.apply(stub.ctx); } catch (e) { applyError = e; }
    assert(applyError === null, 'apply 抛错：' + (applyError && applyError.message));
    return 'ok';
  });

  await check('Host: 导出了 name 与 inject（且 inject 不硬依赖）', () => {
    assert(typeof host.name === 'string' && host.name.length > 0, '缺 name');
    assert(Array.isArray(host.inject), 'inject 必须是数组（缺服务时才能降级）');
    assert(host.inject.length === 0, '脚手架默认 inject 为空，硬依赖会让插件在缺服务时加载失败');
    return host.name;
  });

  await check('Host: 工具已注册且形状合法', () => {
    assert(stub.registered.tools.length >= 2, '应至少注册 2 个工具，实际 ' + stub.registered.tools.length);
    for (const t of stub.registered.tools) {
      assert(typeof t.name === 'string' && t.name, '工具有个缺 name');
      assert(typeof t.execute === 'function', t.name + ' 缺 execute');
      assert(t.parameters && typeof t.parameters === 'object', t.name + ' 缺 parameters（JSON Schema）');
      // 宿主会在注册期校验 schema：description 必须是字符串，properties 必须是对象
      const p = t.parameters;
      if (p.properties !== undefined) assert(typeof p.properties === 'object' && p.properties !== null, t.name + '.parameters.properties 必须是对象');
      if (p.description !== undefined) assert(typeof p.description === 'string', t.name + '.parameters.description 必须是字符串（写成对象会让宿主注册期抛错）');
      assert(t.output && t.output.render, t.name + ' 缺 output.render（工具结果没法渲染给模型）');
    }
    return stub.registered.tools.map((t) => t.name).join(', ');
  });

  await check('Host: 工具返回值是 lossless JSON', async () => {
    const bad = [];
    for (const t of stub.registered.tools) {
      const v = await t.execute({ text: 'x' }, {});
      const walk = (x, p) => {
        if (x === undefined) bad.push(p + ' = undefined');
        else if (typeof x === 'number' && !Number.isFinite(x)) bad.push(p + ' = ' + x);
        else if (typeof x === 'number' && Object.is(x, -0)) bad.push(p + ' = -0');
        else if (Array.isArray(x)) x.forEach((y, i) => walk(y, p + '[' + i + ']'));
        else if (x && typeof x === 'object') Object.keys(x).forEach((k) => walk(x[k], p + '.' + k));
      };
      walk(v, t.name);
    }
    assert(bad.length === 0, '出现非法 JSON 值（宿主会拒收）：' + bad.join('; '));
    return '全部通过';
  });

  await check('Host: 路由注册成 prefix 形态', () => {
    assert(stub.registered.webServer.length === 1, '应注册 1 条路由，实际 ' + stub.registered.webServer.length);
    const cfg = stub.registered.webServer[0];
    assert(cfg.kind === 'prefix', 'kind 应为 prefix，实际 ' + cfg.kind);
    assert(typeof cfg.path === 'string' && cfg.path.startsWith('/'), 'path 必须以 / 开头，实际 ' + cfg.path);
    assert(typeof cfg.handler === 'function', 'handler 必须是函数');
    return cfg.path;
  });

  const route = stub.registered.webServer[0];
  const base = route.path;

  await check('Host: GET ' + base + '/status 回 {ok:true,data}', async () => {
    const r = await callRoute(route.handler, 'GET', base + '/status');
    assert(r.status === 200, 'HTTP ' + r.status + '：' + r.text.slice(0, 200));
    const j = JSON.parse(r.text);
    assert(j.ok === true, '信封缺 ok:true');
    assert(j.data && typeof j.data === 'object', '缺 data');
    assert(typeof j.data.version === 'string', 'data.version 缺失');
    assert(Array.isArray(j.data.tools) && j.data.tools.length >= 2, 'data.tools 应为工具名数组');
    return j.data.plugin + ' v' + j.data.version;
  });

  await check('Host: POST ' + base + '/tool 能按名调用工具并回显', async () => {
    const toolName = stub.registered.tools.find((t) => /_echo$/.test(t.name)).name;
    const r = await callRoute(route.handler, 'POST', base + '/tool', {
      body: JSON.stringify({ name: toolName, args: { text: 'hello-dsh' } }),
    });
    assert(r.status === 200, 'HTTP ' + r.status + '：' + r.text.slice(0, 200));
    const j = JSON.parse(r.text);
    assert(j.ok === true && j.data && j.data.ok === true, '工具调用失败：' + r.text.slice(0, 200));
    assert(j.data.data.echoed === 'hello-dsh', '回显不对：' + JSON.stringify(j.data.data));
    return 'echoed=hello-dsh';
  });

  await check('Host: 非本机 Host 头被 403 拒绝', async () => {
    const r = await callRoute(route.handler, 'GET', base + '/status', { host: 'evil.example.com' });
    assert(r.status === 403, '应 403，实际 ' + r.status);
    return '403';
  });

  await check('Host: 未知路由回 404（而不是 500/静默）', async () => {
    const r = await callRoute(route.handler, 'GET', base + '/nope');
    assert(r.status === 404, '应 404，实际 ' + r.status);
    return '404';
  });

  // ---------------- Client 半边 ----------------
  const clientPkg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'));
  const client = await loadClientHalf(pluginDir, clientPkg);

  await check('Client: 通过 __ModuleLoader__ 注册了 CJS factory', () => {
    assert(typeof client.id === 'string' && client.id, 'load({id}) 缺 id');
    assert(client.exports && typeof client.exports.apply === 'function', 'exports.apply 缺失');
    assert(typeof client.exports.name === 'string' && client.exports.name, 'exports.name 缺失');
    assert(Array.isArray(client.exports.inject), 'exports.inject 必须是数组');
    return client.id + '（入口 ' + client.entry + '；require: ' + (client.required.length ? client.required.join(', ') : '无') + '）';
  });

  /** 找出带 `*-entry` / `*-panel` 幂等属性标记的元素。 */
  const withAttrSuffix = (dom, suffix) => dom.all.filter((e) => e._attrs && Object.keys(e._attrs).some((k) => k.endsWith(suffix)));

  let firstCleanup = null;
  /** 'slot' | 'dom' | 'none' —— 这一轮 apply 实际走的路线。 */
  let clientRoute = 'none';

  await check('Client: apply(ctx) 不抛错，且**确实挂上了 UI**（槽位 或 DOM 任一条）', () => {
    const st = makeClientStubCtx();
    let cleanupFn = null;
    try { cleanupFn = client.exports.apply(st.ctx); }
    catch (e) { throw new Error('apply 抛错（会拖垮整个 Web 壳）：' + e.message); }
    firstCleanup = cleanupFn;

    const domEntry = client.dom.doc.querySelector('[data-dsh-plugin]');
    clientRoute = st.slots.length ? 'slot' : (domEntry !== null ? 'dom' : 'none');
    assert(clientRoute !== 'none',
      'apply 既没有注册任何槽位、也没有往 DOM 插入口 —— 这个客户端什么也没挂上。'
      + '（DOM 路线检查 sidebarRoot/placeEntry 的选择器；槽位路线检查 ctx.slots.register 调用）');

    if (clientRoute === 'slot') {
      const bad = st.slots.filter((s) => !s.name || !s.id);
      assert(bad.length === 0, '槽位注册缺 name 或 id（list 型必须带 id）：' + JSON.stringify(bad).slice(0, 200));
      return '槽位路线 → ' + st.slots.map((s) => s.name + '#' + s.id).join(', ')
        + '；inject 等待 ' + (st.injected.length ? st.injected.join(', ') : '无') + ' 个声明';
    }
    assert(domEntry.getAttribute('data-dsh-part') === 'sidebar-entry', '入口行缺 data-dsh-part="sidebar-entry" 语义属性');
    assert(withAttrSuffix(client.dom, '-panel').length === 1, '面板元素没有挂到 document.body');
    return 'DOM 路线 → 入口已插入 + 面板 1 个';
  });

  await check('Client: （仅 DOM 路线）入口落在「新会话」之后的入口块里', () => {
    if (clientRoute !== 'dom') return '槽位路线，跳过：位置由槽位的 order 决定，不插 DOM';
    const { wrapper, region, newBtn } = client.dom.refs;
    const entry = client.dom.doc.querySelector('[data-dsh-plugin]');
    assert(entry !== null, '找不到入口行');
    const iNew = wrapper.children.indexOf(newBtn);
    const iEntry = wrapper.children.indexOf(entry);
    const iRegion = wrapper.children.indexOf(region);
    assert(iNew >= 0 && iEntry > iNew, '入口应在「新会话」之后');
    assert(iRegion < 0 || iEntry < iRegion, '入口应在工作区/页脚区之前（否则会跑到侧边栏最底部）');
    return '位置正确（新会话 < 入口 < 工作区）';
  });

  await check('Client: cleanup 把副作用全部收回，且回收后能重挂（热重载不留幽灵）', () => {
    assert(typeof firstCleanup === 'function', '上一项没拿到 cleanup 函数（apply 必须返回 cleanup，或至少能把副作用交给 ctx.effect 回收）');
    firstCleanup();
    if (clientRoute === 'dom') {
      assert(client.dom.doc.querySelector('[data-dsh-plugin]') === null, 'cleanup 之后入口行仍在 DOM 里');
      assert(withAttrSuffix(client.dom, '-entry').length === 0, 'cleanup 之后仍残留带 entry 标记的元素');
      assert(withAttrSuffix(client.dom, '-panel').length === 0, 'cleanup 之后面板仍在 DOM 里');
      assert(client.dom.all.every((e) => !String(e.id).endsWith('-style')), 'cleanup 之后 <style> 仍挂在 head 上');
    }
    // 回收干净之后必须还能再挂一次（否则热重载后插件就再也起不来了）
    const st2 = makeClientStubCtx();
    const c2 = client.exports.apply(st2.ctx);
    const remounted = st2.slots.length > 0 || client.dom.doc.querySelector('[data-dsh-plugin]') !== null;
    assert(remounted, 'cleanup 之后重挂失败（幂等性坏了）');
    if (typeof c2 === 'function') c2();
    if (clientRoute === 'dom') assert(client.dom.doc.querySelector('[data-dsh-plugin]') === null, '第二次 cleanup 没生效');
    return clientRoute === 'dom' ? '已回收且可重挂（DOM 路线）' : '已回收且可重挂（槽位路线）';
  });
} catch (e) {
  results.push({ name: 'selftest 运行期异常', ok: false, detail: String((e && e.message) || e) });
} finally {
  cleanup();
}

const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;

if (AS_JSON) {
  console.log(JSON.stringify({ ok: failed === 0, passed, failed, results }, null, 2));
} else {
  console.log('');
  console.log('=== dsh-plugin-win10 脚手架自检    插件：' + pluginDir + ' ===');
  console.log('');
  for (const r of results) console.log((r.ok ? '✅' : '❌') + ' ' + r.name + (r.detail ? '  → ' + r.detail : ''));
  console.log('');
  console.log('合计：' + passed + ' 项 ✅ / ' + failed + ' 项 ❌');
}
process.exit(failed === 0 ? 0 : 1);
