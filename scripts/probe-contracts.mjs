#!/usr/bin/env node
/**
 * probe-contracts.mjs —— **DSH 本体更新后的契约自检探针**
 *
 * 解决的问题：DSH 一升级，我们所有插件依赖的官方 API 都可能变（改名 / 改签名 / 改语义 / 直接没）。
 * 靠人肉"感觉哪里不对"是查不出来的——**很多失效是静默的**（比如槽位没了 → 插件照常加载，
 * 只是 UI 永远不出现；patch 语义变了 → 配置静默不生效）。所以把「我们依赖的契约」变成
 * **可机械检查的断言**，并把「当前已知良好」的那一份存成基线，升级后一键对比。
 *
 * 用法：
 *   node probe-contracts.mjs                     # 跑检查 + 与基线对比（没基线就只跑检查）
 *   node probe-contracts.mjs --save-baseline     # 把当前状态存为基线（**确认一切正常后再存**）
 *   node probe-contracts.mjs --json              # 机器可读
 *   node probe-contracts.mjs --scan <目录>...    # 额外扫这些目录，报出"我们哪里用了这个 API"
 *
 * 退出码：0 = 全部 ok；1 = 有 changed/missing（需要人判断）；2 = 探针自身跑不起来
 *
 * ⚠️ 写这个探针时踩到的两条自我约束（都写进代码里了）：
 *   ① **每一条检查 token 必须先自己命中一次再留下**——否则它会变成"永远报警"的噪音，
 *      而噪音会让人忽略真问题（`PLATFORM_MODULES` 就是这么被我删掉的：本版本里 0 次命中）。
 *   ② **解析源码不要用「缩进+换行+大括号」这种正则**——真实代码缩进不统一，写死了就报假警报。
 *      用花括号配平来切块（见 braceBlock）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const has = (f) => argv.includes('--' + f);
const AS_JSON = has('json');
const SAVE = has('save-baseline');

/** 全程收集「不影响成败但要让人看到」的告警，最后统一输出。
 *  为什么要有这个：第一版里 DSH_CORE_DIR 指错路径会**静默回退**到自动探测——
 *  用户以为自己指定了被测本体，实际测的是另一个目录，结论看着一样其实完全无效。
 *  显式指定却没生效，必须出声。
 *  ⚠️ 必须声明在使用它的代码**之前**：`const` 有暂时性死区，提前引用会 ReferenceError。 */
const WARNINGS = [];

// JSON 读取（内联版）：本文件靠前的代码也要用，不能依赖后面的 `const readJsonSafe`（TDZ）。
const readJsonLoose = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

/** 计时起点：报告里要带 elapsedMs，让"跑得异常慢"这件事可被看见。 */
const T0 = Date.now();
/**
 * 使用面扫描目录。
 *
 * 三种来源（`--scan` 显式 > 默认自动发现 > `--no-scan` 关闭）：
 *  - `--scan <目录>...`  显式指定（可给多个）
 *  - 不给任何参数          → **自动发现**（见 defaultScanDirs）
 *  - `--no-scan`          → 明确不要使用面
 *
 * 为什么要自动发现：不给默认值时，别的 AI 第一次跑只会拿到"契约变了"，
 * 却不知道该改哪儿；而"改哪儿"恰恰是这个技能最该回答的问题。
 * 自动发现让**零参数**就能给出影响面。
 */
function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/** 我们的插件/技能都住在哪？从 profile 的 bundles 与 skills 目录反查。 */
function defaultScanDirs() {
  const out = [];
  const seen = new Set();
  const add = (p) => {
    if (!p || seen.has(p) || out.length >= 12) return;
    try { if (!fs.statSync(p).isDirectory()) return; } catch { return; }
    seen.add(p);
    out.push(p);
  };

  // ① profile bundles 里指向**工作区**（而不是 node_modules 里装的包）的那些 —— 那就是我们自己在开发的插件
  const profRoot = path.join(dshHome(), 'profiles');
  let profiles = [];
  try { profiles = fs.readdirSync(profRoot); } catch { /* 没有 profiles 就算了 */ }
  for (const name of profiles) {
    const pkg = readJsonLoose(path.join(profRoot, name, 'package.json'));
    const bundles = pkg && pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles;
    if (!Array.isArray(bundles)) continue;
    for (const b of bundles) {
      const link = path.join(profRoot, name, 'node_modules', ...String(b).split('/'));
      let real = null;
      try { real = fs.realpathSync(link); } catch { continue; }
      // 真身不在 node_modules 里 ⇒ 是软链到工作区的开发中插件
      if (!/[\\/]node_modules[\\/]/.test(real)) add(real);
    }
  }

  // ② 带 scripts/ 的技能（技能自己也可能依赖这些 API）
  const skillRoot = path.join(dshHome(), 'skills');
  let skills = [];
  try { skills = fs.readdirSync(skillRoot); } catch { /* 同上 */ }
  for (const s of skills) {
    const d = path.join(skillRoot, s);
    try { if (fs.statSync(path.join(d, 'scripts')).isDirectory()) add(d); } catch { /* 没 scripts 就跳过 */ }
  }
  return out;
}

const scanDefault = defaultScanDirs();
const NO_SCAN = has('no-scan');
const SCAN_EXPLICIT = (() => {
  const i = argv.indexOf('--scan');
  if (i < 0) return null;
  const out = [];
  for (let k = i + 1; k < argv.length && !argv[k].startsWith('--'); k += 1) out.push(argv[k]);
  return out;
})();
let SCAN_SOURCE;
let SCAN_DIRS;
if (NO_SCAN) {
  SCAN_SOURCE = 'none'; SCAN_DIRS = [];
} else if (SCAN_EXPLICIT && SCAN_EXPLICIT.length) {
  SCAN_SOURCE = 'explicit'; SCAN_DIRS = SCAN_EXPLICIT;
} else {
  if (SCAN_EXPLICIT && !SCAN_EXPLICIT.length) {
    WARNINGS.push('`--scan` 后面没跟目录 —— 已改用自动发现的使用面。要彻底关掉请用 `--no-scan`。');
  }
  SCAN_SOURCE = scanDefault.length ? 'default' : 'none';
  SCAN_DIRS = scanDefault;
}

// 基线**刻意**仍锚在 `~/.dsh`（而不是 dshHome()）：基线是"已知良好快照"，
// 若跟着 DSH_HOME 走，一旦有人设了 DSH_HOME，会悄悄变成"没有基线"→ diff=null，
// 把探针最核心的「跟上次比变了什么」无声地关掉。这种"看起来正常其实失效"最危险。
const BASELINE_FILE = path.join(os.homedir(), '.dsh', 'dsh-contract-baseline.json');

/* ------------------------------------------------------------------ *
 * 定位 DSH 本体安装目录
 * ------------------------------------------------------------------ */
function findDshCore() {
  const cands = [];
  const envDir = process.env.DSH_CORE_DIR;
  if (envDir) {
    // 显式指定过就必须校验，且校验失败要留下痕迹（见 WARNINGS 的说明）
    if (!fs.existsSync(path.join(envDir, 'package.json'))) {
      WARNINGS.push(`DSH_CORE_DIR="${envDir}" 下找不到 package.json —— **该路径无效，已回退到自动探测**。`
        + '本次测的可能不是你指定的那个本体，结论请勿采信为"指定本体的契约"。');
    } else {
      cands.push(envDir);
    }
  }
  const nodeDir = path.dirname(process.execPath);
  cands.push(path.join(nodeDir, 'node_modules', '@deepseek-ai', 'dsh'));
  cands.push(path.join(nodeDir, 'node_global', 'node_modules', '@deepseek-ai', 'dsh'));
  for (const c of cands) if (fs.existsSync(path.join(c, 'package.json'))) return c;
  try {
    const root = String(execFileSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 20000, windowsHide: true })).trim();
    const p = path.join(root, '@deepseek-ai', 'dsh');
    if (fs.existsSync(path.join(p, 'package.json'))) return p;
  } catch { /* ignore */ }
  return null;
}

const CORE = findDshCore();
if (!CORE) {
  console.error('✗ 找不到 DSH 本体安装目录。可设环境变量 DSH_CORE_DIR 指向 @deepseek-ai/dsh 的目录。');
  process.exit(2);
}
const PKGS = path.join(CORE, 'node_modules', '@deepseek-ai');

const readFileSafe = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const readJsonSafe = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

/**
 * 从 `startIdx` 起按**花括号配平**截取一段。
 * 不要用「缩进几个空格 + 换行 + }」这种正则——真实代码的缩进/嵌套/单行块都不统一。
 */
function braceBlock(text, startIdx) {
  const open = text.indexOf('{', startIdx);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (depth === 0) return text.slice(open + 1, i); }
  }
  return null;
}

/** 找出所有匹配 `re` 的位置，返回其花括号块体。 */
function findBlocks(text, re) {
  const out = [];
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m;
  while ((m = g.exec(text)) !== null) {
    const body = braceBlock(text, m.index);
    if (body !== null) out.push(body);
    if (m[0].length === 0) g.lastIndex += 1;
  }
  return out;
}

/** 递归收集文件内容（跳过嵌套 node_modules；**limit 要开得足够大**，否则会在到达目标包之前截断）。 */
function collectFiles(dir, exts, { maxBytes = 1024 * 1024, limit = 5000 } = {}) {
  const out = [];
  const walk = (d) => {
    if (out.length >= limit) return;
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (out.length >= limit) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
      if (!exts.some((x) => e.name.endsWith(x))) continue;
      try { if (fs.statSync(p).size > maxBytes) continue; } catch { continue; }
      const text = readFileSafe(p);
      if (text !== null) out.push({ path: p, text });
    }
  };
  walk(dir);
  return out;
}

/* ------------------------------------------------------------------ *
 * 检查项：每条 = 一个「我们依赖的契约」
 * ------------------------------------------------------------------ */
const CHECKS = [];
const ok = (id, name, detail, extra = {}) => CHECKS.push({ id, name, status: 'ok', detail, ...extra });
const bad = (id, name, detail, status = 'missing', extra = {}) => CHECKS.push({ id, name, status, detail, ...extra });

/** 1. 版本指纹 */
{
  const corePkg = readJsonSafe(path.join(CORE, 'package.json'));
  const cordis = readJsonSafe(path.join(PKGS, 'cordis', 'package.json'));
  ok('version', 'DSH 本体与 cordis 版本', `dsh=${corePkg?.version ?? '?'} cordis=${cordis?.version ?? '?'}`,
    { data: { dsh: corePkg?.version ?? null, cordis: cordis?.version ?? null } });
}

const DTS = collectFiles(PKGS, ['.d.ts']);

/** 2. 服务名（我们的插件靠 ctx.get('<名>') 取） */
{
  const NEEDED = ['tools', 'webServer', 'systemPrompt', 'sessions', 'slots'];
  const found = new Set();
  for (const f of DTS) {
    if (!f.text.includes("declare module '@deepseek-ai/cordis'")) continue;
    for (const body of findBlocks(f.text, /declare module '@deepseek-ai\/cordis'/)) {
      for (const key of NEEDED) {
        if (found.has(key)) continue;
        if (new RegExp('(^|\\n)\\s*' + key + '\\s*[:?]').test(body)) found.add(key);
      }
    }
  }
  const missing = NEEDED.filter((k) => !found.has(k));
  const detail = `需要 ${NEEDED.length} 个服务，找到 ${found.size} 个${missing.length ? '；缺：' + missing.join(', ') : ''}`;
  if (missing.length) bad('services', '我们依赖的 cordis 服务名', detail, 'missing', { data: { needed: NEEDED, found: [...found] } });
  else ok('services', '我们依赖的 cordis 服务名', detail, { data: { found: [...found] } });
}

/** 3. 工具注册契约（dsh-tools） */
{
  const t = readFileSafe(path.join(PKGS, 'dsh-tools', 'lib', 'types', 'index.d.ts'));
  if (t === null) bad('tools', 'dsh-tools 的类型入口', '读不到 dsh-tools/lib/types/index.d.ts');
  else {
    const needed = [
      ['register', /register\s*\(/],
      ['output.render', /render/],
      ['ToolRestriction（按 scope 过滤）', /ToolRestriction/],
      ['RUN_CODE_NAME（保留名）', /RUN_CODE_NAME/],
      ['schema 校验', /assertSupportedJsonSchema|SupportedJsonSchema/],
    ];
    const miss = needed.filter(([, re]) => !re.test(t)).map(([n]) => n);
    if (miss.length) bad('tools', '工具注册契约（dsh-tools）', '缺：' + miss.join('、'), 'changed');
    else ok('tools', '工具注册契约（dsh-tools）', 'register / output.render / ToolRestriction / RUN_CODE_NAME / schema 校验 都在');
  }
}

/** 4. webServer 路由契约 */
{
  const t = readFileSafe(path.join(PKGS, 'dsh-host-webserver', 'lib', 'types', 'index.d.ts'));
  if (t === null) bad('webserver', 'webServer 路由契约', '读不到 dsh-host-webserver 的类型入口');
  else {
    const needed = [
      ['WebRouteKind(exact|prefix)', /WebRouteKind/],
      ['register', /register\s*\(/],
      ['registerUpgrade', /registerUpgrade/],
      ['registerFallback', /registerFallback/],
      ['tapIndex', /tapIndex/],
    ];
    const miss = needed.filter(([, re]) => !re.test(t)).map(([n]) => n);
    if (miss.length) bad('webserver', 'webServer 路由契约', '缺：' + miss.join('、'), 'changed');
    else ok('webserver', 'webServer 路由契约', 'register / registerUpgrade / registerFallback / tapIndex 都在');
  }
}

/** 5. 槽位目录：收集所有 SlotMap 声明里的 key，并与基线对比增删 */
let slotKeys = [];
{
  const keys = new Set();
  const perFile = new Map();
  for (const f of DTS) {
    if (!f.text.includes('interface SlotMap')) continue;
    let n = 0;
    for (const body of findBlocks(f.text, /interface SlotMap/)) {
      for (const k of body.matchAll(/(^|\n)\s*'([a-zA-Z][a-zA-Z0-9_.\-]*)':\s*\{/g)) { keys.add(k[2]); n += 1; }
    }
    if (n) perFile.set(path.relative(PKGS, f.path), n);
  }
  slotKeys = [...keys].sort();
  const CRITICAL = ['sidebar.footer.action', 'shell.overlay', 'root'];
  const missCritical = CRITICAL.filter((k) => !slotKeys.includes(k));
  const src = [...perFile.entries()].map(([f, n]) => f + '(' + n + ')').join(' ');
  const data = { keys: slotKeys, perFile: Object.fromEntries(perFile) };
  if (missCritical.length) bad('slots', '槽位目录', `关键槽位缺失：${missCritical.join('、')}（共发现 ${slotKeys.length} 个，来自 ${perFile.size} 个文件）`, 'changed', { data });
  else ok('slots', '槽位目录', `共 ${slotKeys.length} 个（来自 ${perFile.size} 个文件）：${src}`, { data });

  // 关键槽位的 kind 必须仍是 list（若是 single，语义就变成"注册=替换"了）
  const side = readFileSafe(path.join(PKGS, 'dsh-client-ui-sidebar', 'lib', 'types', 'client', 'contract', 'slots.d.ts'));
  const lay = readFileSafe(path.join(PKGS, 'dsh-client-ui-layout', 'lib', 'types', 'client', 'index.d.ts'));
  const kindOf = (txt, key) => {
    if (!txt) return null;
    const re = new RegExp("'" + key.replace(/\./g, '\\.') + "'\\s*:\\s*\\{[^}]*?kind\\s*:\\s*'([a-z]+)'");
    const m = re.exec(txt);
    return m ? m[1] : null;
  };
  const k1 = kindOf(side, 'sidebar.footer.action');
  const k2 = kindOf(lay, 'shell.overlay');
  const badKind = [['sidebar.footer.action', k1], ['shell.overlay', k2]].filter(([, k]) => k !== 'list');
  if (badKind.length) bad('slot-kind', '关键槽位的 kind 必须仍是 list（加性）', badKind.map(([n, k]) => `${n}=${k ?? '?'}`).join('、'), 'changed');
  else ok('slot-kind', '关键槽位的 kind 必须仍是 list（加性）', 'sidebar.footer.action=list, shell.overlay=list');
}

/** 6. 客户端模块系统 / require 白名单 / 主题令牌（**扫全部产物**，不能只看最大的那个） */
{
  const distDir = path.join(PKGS, 'dsh-web-frontend', 'dist', 'assets');
  const files = fs.existsSync(distDir) ? fs.readdirSync(distDir).filter((n) => /\.js$/.test(n)) : [];
  if (!files.length) bad('client-boot', '前端产物（客户端模块系统）', '找不到 dsh-web-frontend/dist/assets/*.js');
  else {
    const needed = [
      ['__ModuleLoader__', /__ModuleLoader__/],
      ['__DSH_BOOT__', /__DSH_BOOT__/],
      ['react（平台单例）', /react-dom\/client/],
      ['primitives（官方 UI 原语）', /dsh-client-ui-primitives/],
      ['SlotCore 运行期校验', /requires options\.id/],
      ['--dsw-alias 令牌', /--dsw-alias-/],
    ];
    // 曾经这里有一条 `PLATFORM_MODULES` —— 本版本两个产物里都是 0 次命中，是照搬别人笔记写进来的。
    // 探针里每条 token 都要先自己命中一次再留下；否则它变成永久噪音，而噪音会掩盖真问题。
    const hit = new Map();
    let scanned = 0;
    const bySize = files.slice().sort((a, b) => fs.statSync(path.join(distDir, b)).size - fs.statSync(path.join(distDir, a)).size);
    for (const n of bySize) {
      if (hit.size === needed.length || scanned >= 40) break;
      const text = readFileSafe(path.join(distDir, n));
      if (text === null) continue;
      scanned += 1;
      for (const [label, re] of needed) if (!hit.has(label) && re.test(text)) hit.set(label, n);
    }
    const miss = needed.filter(([n]) => !hit.has(n)).map(([n]) => n);
    const data = { files: files.length, scanned, foundIn: Object.fromEntries(hit) };
    if (miss.length) bad('client-boot', '客户端模块系统 / require 白名单 / 主题令牌', `扫了 ${scanned}/${files.length} 个产物仍缺：${miss.join('、')}`, 'changed', { data });
    else ok('client-boot', '客户端模块系统 / require 白名单 / 主题令牌', `${needed.length} 项标志全在（__ModuleLoader__ 在 ${hit.get('__ModuleLoader__')}）`, { data });
  }
}

/** 7. dsh.client 声明字段 */
{
  const blob = (readFileSafe(path.join(PKGS, 'dsh-client-modules', 'lib', 'types', 'client', 'manifest.d.ts')) ?? '')
    + (readFileSafe(path.join(PKGS, 'dsh-client-modules', 'lib', 'types', 'index.d.ts')) ?? '');
  if (!blob) bad('client-decl', 'dsh.client 声明字段', '读不到 dsh-client-modules 的类型');
  else {
    const needed = [['platform', /platform/], ['inject', /inject/], ['immediately', /immediately/], ['external', /external/]];
    const miss = needed.filter(([, re]) => !re.test(blob)).map(([n]) => n);
    if (miss.length) bad('client-decl', 'dsh.client 声明字段', '可能缺：' + miss.join('、'), 'changed');
    else ok('client-decl', 'dsh.client 声明字段', 'platform / inject / immediately / external 都在');
  }
}

/** 8. profile 侧：装配清单与 patch 热加载语义 */
{
  const prof = path.join(os.homedir(), '.dsh', 'profiles', 'web', 'package.json');
  const j = readJsonSafe(prof);
  if (!j) bad('profile', 'profile 的 dsh.profile 段', '读不到 ' + prof);
  else {
    const bundles = j.dsh?.profile?.bundles;
    const reload = j.dsh?.profile?.patchReload;
    if (!Array.isArray(bundles)) bad('profile', 'profile 的 dsh.profile.bundles', '不再是数组（装配清单语义可能变了）', 'changed');
    else if (!reload) bad('profile', 'profile 的 dsh.profile.patchReload', '缺 patchReload —— 「patch 改了要不要重启」的判断依据没了', 'changed');
    else ok('profile', 'profile 装配清单与 patchReload', `bundles ${bundles.length} 项；patchReload=${reload}`, { data: { bundles, patchReload: reload } });
  }
}

/** 9. CLI 旗标（我们文档里教别人用这几个） */
{
  const blob = (readFileSafe(path.join(CORE, 'lib', 'bin.js')) ?? '') + (readFileSafe(path.join(CORE, 'lib', 'args.js')) ?? '');
  if (!blob) bad('cli', 'CLI 旗标', '读不到 dsh 的 bin/args 产物', 'changed');
  else {
    const need = [['--patch', /patch/], ['--dump-config', /dump-config/], ['--dump-default-config', /dump-default-config/]];
    const miss = need.filter(([, re]) => !re.test(blob)).map(([n]) => n);
    if (miss.length) bad('cli', 'CLI 旗标 --patch / --dump-config', '可能缺：' + miss.join('、'), 'changed');
    else ok('cli', 'CLI 旗标 --patch / --dump-config', '都在');
  }
}

/* ------------------------------------------------------------------ *
 * 使用面扫描：我们哪里用了这些 API
 * ------------------------------------------------------------------ */
const USAGE_TOKENS = [
  ['ctx.slots.register', /slots\.register\s*\(/],
  ['ctx.slots.inject', /slots\.inject\s*\(/],
  ['sidebar.footer.action', /sidebar\.footer\.action/],
  ['shell.overlay', /shell\.overlay/],
  ['__ModuleLoader__.load', /__ModuleLoader__\.load/],
  ['require("react")', /require\(\s*["']react["']\s*\)/],
  ['style[data-plugin]', /data-plugin/],
  ['--dsw-alias 令牌', /--dsw-alias-/],
  ['ctx.tools.register', /tools\.register\s*\(/],
  ['ctx.webServer.register', /webServer\.register\s*\(/],
  ['ctx.inject([...])', /\.inject\s*\(\s*\[/],
  ['{ok,data} 信封', /ok:\s*true/],
  ['dsh.profile.bundles', /profile\.bundles|dsh\.profile/],
  ['--patch 启动', /--patch/],
];
const usage = [];
for (const dir of SCAN_DIRS) {
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs)) { usage.push({ dir: abs, error: '目录不存在' }); continue; }
  // ⚠️ **只把「代码」当使用面，不把「文档」当使用面**。
  //    第一版图省事连 .md/.json 一起算，结果：技能目录里只是**描述**了
  //    `sidebar.footer.action` 的 SKILL.md / references/*.md / evals.json 全被记成"我们在用这个槽位"，
  //    凭空造出一大片假使用面 —— 而"这一行要改哪儿"正是这份报告存在的理由，噪声直接摧毁它。
  //    判据：**能被执行的东西才算用**（.js/.mjs/.cjs/.ts/.tsx）。
  const CODE_EXT = ['.js', '.mjs', '.cjs', '.ts', '.tsx'];
  // 再排掉**探针自己**：它内部就有一张 token 表（`'sidebar.footer.action'`、`shell.overlay` …），
  // 不排除就会把"量尺"当成"被测物"，报出根本不存在的使用面。
  const SELF = path.resolve(process.argv[1] || '');
  const files = collectFiles(abs, CODE_EXT, { limit: 2000 }).filter((f) => path.resolve(f.path) !== SELF);
  const hits = [];
  for (const t of USAGE_TOKENS) {
    let n = 0; const where = [];
    for (const f of files) {
      const c = (f.text.match(new RegExp(t[1].source, 'g')) || []).length;
      if (c) { n += c; if (where.length < 3) where.push(path.relative(abs, f.path)); }
    }
    if (n) hits.push({ api: t[0], count: n, files: where });
  }
  usage.push({ dir: abs, filesScanned: files.length, hits });
}

/* ------------------------------------------------------------------ *
 * 与基线对比
 * ------------------------------------------------------------------ */
const snapshot = {
  at: new Date().toISOString(),
  core: CORE,
  version: CHECKS.find((c) => c.id === 'version')?.data ?? null,
  checks: Object.fromEntries(CHECKS.map((c) => [c.id, { status: c.status, detail: c.detail }])),
  slotKeys,
  corePackageCount: (() => { try { return fs.readdirSync(PKGS).length; } catch { return null; } })(),
};

let baseline = null;
let diff = null;
if (fs.existsSync(BASELINE_FILE)) {
  baseline = readJsonSafe(BASELINE_FILE);
  if (baseline) {
    const added = slotKeys.filter((k) => !(baseline.slotKeys || []).includes(k));
    const removed = (baseline.slotKeys || []).filter((k) => !slotKeys.includes(k));
    const flipped = Object.keys(snapshot.checks).filter((k) => baseline.checks?.[k] && baseline.checks[k].status !== snapshot.checks[k].status);
    const versionChanged = baseline.version?.dsh !== snapshot.version?.dsh || baseline.version?.cordis !== snapshot.version?.cordis;
    const pkgDelta = (snapshot.corePackageCount ?? 0) - (baseline.corePackageCount ?? 0);
    diff = { versionChanged, from: baseline.version, to: snapshot.version, slotsAdded: added, slotsRemoved: removed, statusFlipped: flipped, corePackageDelta: pkgDelta };
  }
}

/* ------------------------------------------------------------------ *
 * 保存基线 —— **带守卫**
 * ------------------------------------------------------------------ *
 * ⚠️ 为什么必须挡一道：基线代表「已知良好」，它是"下次升级比什么"的唯一参照。
 *    在插件还没跑通的时候存基线 = 把坏状态固化成"正常"，**下次升级就永远比不出东西**，
 *    而且失效是**静默**的（探针照样绿，你以为一切正常）。
 *    这种"看起来正常其实已经废了"的失效模式，是本技能最该防的一类。
 *    所以：有非 ok 项时**拒绝保存**，要存必须显式 `--force`。
 */
const failedNow = CHECKS.filter((c) => c.status !== 'ok');
const FORCE = has('force');
if (SAVE) {
  if (failedNow.length && !FORCE) {
    console.error('');
    console.error(`✗ 拒绝保存基线：当前有 ${failedNow.length} 项不是 ok —— ${failedNow.map((c) => c.id).join(', ')}`);
    console.error('  基线代表「已知良好」。把坏状态存成基线，下次升级就**永久比不出东西**，而且是静默失效。');
    console.error('  先修到全绿再存；确实只想记录现状（明知它坏）请显式加 --force。');
    console.error('');
    process.exit(3);
  }
  if (failedNow.length && FORCE) {
    WARNINGS.push('用 --force 存下了**非全绿**的基线（' + failedNow.map((c) => c.id).join(', ')
      + ' 不是 ok）——下次升级时这些项**无法通过基线对比发现变化**。');
  }
  fs.mkdirSync(path.dirname(BASELINE_FILE), { recursive: true });
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(snapshot, null, 2));
}

/* ------------------------------------------------------------------ *
 * 输出
 * ------------------------------------------------------------------ */
const failed = failedNow;
const exitCode = failed.length ? 1 : 0;

if (AS_JSON) {
  console.log(JSON.stringify({
    ok: !failed.length,
    // 元数据：自动化消费要用（判断"这份报告是什么时候、什么环境下产的、为什么退出"）
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - T0,
    exitCode,
    core: CORE,
    coreVersion: snapshot.version,
    checks: CHECKS,
    slotCount: slotKeys.length,
    diff,
    usage,
    scanSource: SCAN_SOURCE,
    scanDirs: SCAN_DIRS,
    warnings: WARNINGS,
    baselineFile: BASELINE_FILE,
    baselineSaved: SAVE,
  }, null, 2));
} else {
  console.log('');
  console.log('=== DSH 契约探针 ===   本体：' + CORE);
  for (const w of WARNINGS) {
    console.log('');
    console.log('⚠️  告警：' + w);
  }
  if (diff) {
    console.log('');
    console.log('--- 与基线（' + String(baseline.at || '?').slice(0, 19) + '）对比 ---');
    console.log('  版本变化：' + (diff.versionChanged ? `是  ${diff.from?.dsh} → ${diff.to?.dsh}（cordis ${diff.from?.cordis} → ${diff.to?.cordis}）` : '否'));
    console.log('  槽位新增：' + (diff.slotsAdded.length ? diff.slotsAdded.join(', ') : '无'));
    console.log('  槽位移除：' + (diff.slotsRemoved.length ? '⚠️ ' + diff.slotsRemoved.join(', ') : '无'));
    console.log('  状态翻转：' + (diff.statusFlipped.length ? '⚠️ ' + diff.statusFlipped.join(', ') : '无'));
    console.log('  官方包数量变化：' + (diff.corePackageDelta === 0 ? '0' : (diff.corePackageDelta > 0 ? '+' : '') + diff.corePackageDelta));
    if (diff.slotsRemoved.length || diff.statusFlipped.length) console.log('  ⇒ **有移除或状态翻转：逐条对应下面的"使用面"，看谁在用、怎么改**');
  } else {
    console.log('');
    console.log('  （还没有基线。确认当前一切正常后跑一次 --save-baseline）');
  }
  console.log('');
  console.log('--- 逐条检查 ---');
  for (const c of CHECKS) {
    const icon = c.status === 'ok' ? '✅' : (c.status === 'missing' ? '❌' : '⚠️');
    console.log(`${icon} [${c.id}] ${c.name}`);
    console.log('      ' + c.detail);
  }
  if (usage.length) {
    console.log('');
    console.log('--- 使用面（我们哪里用了这些 API） ---');
    console.log('    （来源：' + (SCAN_SOURCE === 'default' ? '自动发现——按 profile bundles 的软链与 skills/*/scripts 反查；'
      + '要指定别的目录用 `--scan <目录>`，不要用 `--no-scan` 关掉）'
      : SCAN_SOURCE === 'explicit' ? '你显式指定的 `--scan`' : '已关闭（`--no-scan`）') + '）');
    for (const u of usage) {
      if (u.error) { console.log('  ' + u.dir + ' → ' + u.error); continue; }
      console.log('  ' + u.dir + '（扫了 ' + u.filesScanned + ' 个文件）');
      for (const h of u.hits) console.log('     ' + String(h.count).padStart(5) + ' 次  ' + h.api + '   ' + h.files.join(', '));
    }
  } else if (SCAN_SOURCE === 'none') {
    console.log('');
    console.log('--- 使用面：（已跳过） ---');
    console.log('    自动发现没找到开发中的插件/技能。用 `--scan <你的插件目录>` 指定，');
    console.log('    否则"契约变了要改哪儿"这个问题这份报告回答不了。');
  }
  console.log('');
  console.log('基线文件：' + BASELINE_FILE + (SAVE ? '（本次已更新）' : ''));
  console.log('合计：' + (CHECKS.length - failed.length) + ' ok / ' + failed.length + ' 需要处理'
    + '（耗时 ' + (Date.now() - T0) + 'ms）');
  console.log('');
}
process.exit(exitCode);
