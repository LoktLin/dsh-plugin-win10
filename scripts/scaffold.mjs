#!/usr/bin/env node
/**
 * scripts/scaffold.mjs —— 生成一个**能直接装上跑起来**的 DSH 插件骨架。
 *
 * 为什么值得做成脚本：每写一个新插件，Host 半边（lossless JSON、inject 降级、
 * http 路由信封、本机访问守卫）和 Client 半边（CJS factory 壳、DOM 注入+自愈、主题令牌、
 * 绝不 throw、effect 回收）都是**同一套**骨架，手抄一遍既慢又容易漏掉其中某条纪律。
 * 这里做成模板 + 一次性渲染，模板文件本身在 assets/templates/ 下可以直接读改。
 *
 * 用法：
 *   node scripts/scaffold.mjs dsh-mytool
 *   node scripts/scaffold.mjs dsh-mytool --dir D:\work --title "我的工具面板"
 *   node scripts/scaffold.mjs dsh-mytool --json
 *
 * 退出码：0 成功 / 1 参数或环境错误 / 2 目标已存在（需 --force）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = path.join(HERE, '..', 'assets', 'templates');

const argv = process.argv.slice(2);
const has = (f) => argv.includes('--' + f);
const val = (f, d = '') => { const i = argv.indexOf('--' + f); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };

const AS_JSON = has('json');
const FORCE = has('force');
const nameArg = argv.find((a) => !a.startsWith('--') && argv.indexOf(a) === 0);

function die(msg, code = 1) {
  if (AS_JSON) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
  else console.error('✗ ' + msg);
  process.exit(code);
}

/* ---------------- 参数与派生值 ---------------- */

if (!nameArg) {
  die('缺少插件名。用法：node scripts/scaffold.mjs dsh-mytool [--dir <输出目录>] [--title "面板标题"]');
}

const NAME = String(nameArg).trim();
if (!/^[a-z][a-z0-9-]*$/.test(NAME)) {
  die('插件名只能用小写字母/数字/连字符，且以字母开头（npm 包名规则）。收到：' + NAME);
}
if (!/^dsh-/.test(NAME)) {
  console.warn('⚠ 建议用 `dsh-` 前缀（本机其它插件都这么命名：dsh-eggy / dsh-task-board），便于一眼认出来源。');
}

/** 路由前缀：与 dsh-eggy → /eggy 保持同一约定（去掉 dsh- 前缀）。 */
const PREFIX = '/' + NAME.replace(/^dsh-/, '');
/** CSS 类与幂等属性前缀：只保留 [a-z0-9-]，避免选择器里的奇怪字符。 */
const ATTR = NAME.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
/**
 * 暴露给控制台的兜底对象名，**必须是合法 JS 标识符**。
 * 直接拿 ATTR 拼会踩坑：`dsh-my-tool` → `window.__dsh-my-toolPanel` 是语法错误
 * （实测被 selftest 当场抓到）→ 所以这里转成 camelCase。
 */
const GLOBAL = '__' + NAME.split(/[^a-zA-Z0-9]+/).filter(Boolean)
  .map((s, i) => (i === 0 ? s : s[0].toUpperCase() + s.slice(1))).join('') + 'Panel';
const TITLE = val('title', NAME.replace(/^dsh-/, '') + ' 面板');
const LABEL = val('label', NAME.replace(/^dsh-/, ''));
const DESCRIPTION = val('description', TITLE + '（DSH 插件）');
const VERSION = val('version', '0.1.0');
const TODAY = new Date().toISOString().slice(0, 10);

/**
 * **路线必须显式选，不能靠默认值替你做决定。**
 *
 * 这是迭代出来的教训：实测里 agent 拿到脚手架后，即使问题明确在问"该注册哪个槽位"，
 * 也倾向于照默认生成一整套 DOM 注入骨架 —— **工具的默认值会悄悄替 agent 做决定**，
 * 而 agent 不会质疑默认值（人可能会）。
 *
 *   dom  —— A 路线：DOM 注入 + MutationObserver 自愈。侧边栏没有官方座位、或想零 React 依赖时用。
 *   slot —— B 路线：注册进官方槽位，由壳的 React 渲染器决定位置。**有官方座位时首选**。
 */
const ROUTE = String(val('route', 'dom')).toLowerCase();
if (!['dom', 'slot'].includes(ROUTE)) die(`--route 只能是 dom 或 slot，收到：${ROUTE}`);
/** 槽位路线的目标座位。默认是侧栏底部「设置」旁的加性动作列表（见 references/contracts.md §1.5）。 */
const SLOT = val('slot', 'sidebar.footer.action');

const outRoot = path.resolve(val('dir', process.cwd()));
const target = path.join(outRoot, NAME);

if (fs.existsSync(target) && !FORCE) {
  die('目标目录已存在：' + target + '\n  确认要覆盖请加 --force（会重写骨架文件，不会删除你另外加的文件）', 2);
}
if (!fs.existsSync(TEMPLATE_DIR)) {
  die('找不到模板目录：' + TEMPLATE_DIR + '（技能安装不完整？）');
}

/* ---------------- 渲染 ---------------- */

const SUBST = {
  NAME, PREFIX, ATTR, GLOBAL, TITLE, LABEL, DESCRIPTION, VERSION, SLOT, DATE: TODAY,
};

function render(text) {
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (m, key) => {
    if (!(key in SUBST)) throw new Error('模板里有未知占位符：' + m);
    return String(SUBST[key]);
  });
}

/** 模板文件 → 输出相对路径。客户端那一份按 `--route` 选。 */
const PLAN = [
  ['package.json.tpl', 'package.json'],
  ['cordis.patch.yml.tpl', 'cordis.patch.yml'],
  ['index.js.tpl', 'index.js'],
  [ROUTE === 'slot' ? 'client-slot.js.tpl' : 'client.js.tpl', path.join('lib', 'client.js')],
  ['README.md.tpl', 'README.md'],
];

const written = [];
for (const [tpl, rel] of PLAN) {
  const src = path.join(TEMPLATE_DIR, tpl);
  if (!fs.existsSync(src)) die('缺模板：' + src);
  const dest = path.join(target, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, render(fs.readFileSync(src, 'utf8')));
  written.push({ file: dest, bytes: fs.statSync(dest).size });
}

/* ---------------- 输出 ---------------- */

const profileDir = path.join(os.homedir(), '.dsh', 'profiles', 'web');
const linkPath = path.join(profileDir, 'node_modules', NAME);

const routeNote = ROUTE === 'slot'
  ? `客户端路线：**slot（官方接缝）** → 注册进 ${SLOT}，由壳的 React 渲染器决定位置；不碰 DOM 结构。`
  : '客户端路线：**dom（DOM 注入兜底）** → 自己找侧边栏并插节点 + MutationObserver 自愈。';

const nextSteps = [
  routeNote,
  ...(ROUTE === 'dom'
    ? [
      '  ⚠️ 如果你的需求是「侧栏入口 / 浮层 / 设置块」这类**官方已经留好座位**的事，',
      '     官方座位比 DOM 注入更稳（不会因为壳改结构而失联）。换路线只要：',
      `     node "${path.join(HERE, 'scaffold.mjs')}" ${NAME} --dir <目录> --route slot --force`,
      '     官方可抄的完整先例见技能 references/contracts.md §1.6。',
    ]
    : [
      `  · 换座位：--slot <槽位名>（可用座位见 references/contracts.md §1.5）`,
      '  · 要**帧级浮层**（不贴着入口）再单独注册 shell.overlay；',
      '  · 浮层定位/点外关闭优先用官方 primitives（见 contracts.md §1.8），别手写监听。',
    ]),
  '',
  '① 挂进 web profile（开发态用目录软链，改代码立即生效，不必 npm publish）：',
  '     cmd /c mklink /J "' + linkPath + '" "' + target + '"',
  '   ⚠️ **光软链不会让插件被装配**：装配清单是 profile 的 `dsh.profile.bundles`。',
  '     要么走 `dsh plugin --profile web add <包名>@<版本>`（会自动补进 bundles），',
  '     要么自己把包名加进 ' + path.join(profileDir, 'package.json') + ' 的 dsh.profile.bundles。',
  '② 先用**零侵入**方式验证，别动用户的 profile：',
  `     npm dsh web --patch <本目录>/cordis.patch.yml`,
  '③ 自检：node "' + path.join(HERE, 'selftest.mjs') + '" --plugin "' + target + '"',
  '④ 路由连通性：curl.exe "http://127.0.0.1:3080' + PREFIX + '/status"',
];

if (AS_JSON) {
  console.log(JSON.stringify({
    ok: true,
    plugin: NAME,
    dir: target,
    route: ROUTE,
    slot: ROUTE === 'slot' ? SLOT : null,
    prefix: PREFIX,
    title: TITLE,
    files: written,
    linkPath,
    profilePatch: path.join(profileDir, 'cordis.patch.yml'),
    profileBundles: path.join(profileDir, 'package.json'),
    nextSteps,
  }, null, 2));
} else {
  console.log('✓ 已生成插件骨架：' + target);
  for (const w of written) console.log('   ' + String(w.bytes).padStart(7) + ' B  ' + path.relative(target, w.file));
  console.log('');
  console.log('路由前缀：' + PREFIX + '   工具：' + NAME + '_ping / ' + NAME + '_echo');
  console.log('');
  for (const s of nextSteps) console.log(s);
}
