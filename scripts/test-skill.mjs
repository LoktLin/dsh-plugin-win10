#!/usr/bin/env node
/**
 * dsh-plugin-win10 技能「契约探针」部分的自动化测试跑手（原 dsh-core-update 技能，2026-09-12 并入）
 *
 * 被测对象：探针与其文档（`~/.dsh/skills/dsh-plugin-win10`）——
 *   ① 探针 CLI 契约（参数 / 退出码 / JSON schema / 幂等 / 副作用）
 *   ② 断言正确性（**故障注入**：故意改坏基线，看它会不会如实报警）
 *   ③ 文档的声明与实现是否一致（SKILL.md + references/core-update.md；含官方文档 URL 可达性）
 *
 * **为什么这个文件住在技能里面，而不是测试报告目录里**：
 *   技能会腐化。SKILL.md 会写「9 条检查」而实现有 10 条；URL 会写成 `main` 而仓库是 `master`；
 *   探针会悄悄把文档当成使用面。这些都不是靠"下次注意"能防住的，只能靠**能一键重跑的自测**。
 *   放在报告目录里 = 跑一次就丢；放在技能里 = 改完就能立刻验。
 *
 * 环境：Windows + 无真 Python（python3/python 都是 Microsoft Store stub，零输出）→ 用 node 断言。
 * 用法：
 *   node test-skill.mjs            # 人类可读
 *   node test-skill.mjs --json     # 机器可读（含 unverified 列表）
 *
 * ⚠️ 本跑手会**临时改写契约基线**（T2 组故障注入），并在 finally 里还原 + 复验（T2.5）。
 *    中途 Ctrl-C 可能留下 `dsh-contract-baseline.json.test-backup`，删掉它即可。
 * ⚠️ 判据语义：**超时 ≠ 缺陷**。联网类用例只把「拿到 HTTP 错误码」算失败，
 *    连不上/超时记为 `unverified` 并在合计里单独报出——不让"没验证"冒充"通过"。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

/** 文件内容哈希——用来坐实"这个文件一个字节都没被动过"。 */
const hashOf = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const AS_JSON = process.argv.includes('--json');
const SKILL = path.join(os.homedir(), '.dsh', 'skills', 'dsh-plugin-win10');
const PROBE = path.join(SKILL, 'scripts', 'probe-contracts.mjs');
const DOC = path.join(SKILL, 'references', 'core-update.md');
const BASELINE = path.join(os.homedir(), '.dsh', 'dsh-contract-baseline.json');
const BACKUP = BASELINE + '.test-backup';

const R = [];
const rec = (id, name, ok, detail, method) => R.push({ id, name, ok: !!ok, detail: detail ?? '', method });

/** 跑探针，返回 {code, out, err}。 */
function runProbe(args = [], env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [PROBE, ...args], {
      timeout: 180000, windowsHide: true, maxBuffer: 1 << 24, env: { ...process.env, ...env },
    }, (err, stdout, stderr) => resolve({
      code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0),
      out: String(stdout || ''), err: String(stderr || ''),
    }));
  });
}
const parseJsonOut = (s) => { try { return JSON.parse(s); } catch { return null; } };

/* ============================ T1 CLI 契约 ============================ */
const base = await runProbe();
rec('T1.1', '无参运行：退出码 0 且输出含「逐条检查」',
  base.code === 0 && base.out.includes('逐条检查'),
  `exit=${base.code}，输出 ${base.out.length} 字符`, '直接执行');

const j1 = await runProbe(['--json']);
const pj = parseJsonOut(j1.out);
rec('T1.2', '--json：输出是合法 JSON 且含约定的 7 个顶层键',
  pj !== null && ['ok', 'core', 'checks', 'slotCount', 'diff', 'usage', 'baselineFile'].every((k) => k in pj),
  pj === null ? 'JSON 解析失败：' + j1.out.slice(0, 120) : '顶层键=' + Object.keys(pj).join(','), '直接执行 + JSON.parse');

const j2 = await runProbe(['--scan', SKILL, '--json']);
const pj2 = parseJsonOut(j2.out);
rec('T1.3', '--scan <存在目录>：usage 段有命中记录',
  j2.code === 0 && Array.isArray(pj2?.usage) && pj2.usage[0]?.hits?.length > 0,
  `usage[0].hits=${pj2?.usage?.[0]?.hits?.length ?? 'n/a'}（扫了 ${pj2?.usage?.[0]?.filesScanned ?? '?'} 个文件）`, '直接执行');

const j3 = await runProbe(['--scan', 'D:\\__definitely_not_exists__', '--json']);
const pj3 = parseJsonOut(j3.out);
rec('T1.4', '--scan <不存在目录>：优雅报错，不崩栈',
  pj3 !== null && pj3.usage?.[0]?.error && !/at .*\.mjs:\d+/.test(j3.err),
  `error=${pj3?.usage?.[0]?.error ?? 'n/a'}`, '故障注入（不存在的路径）');

const j4 = await runProbe(['--scan']);
rec('T1.5', '`--scan` 不带值：不崩',
  !/at .*\.mjs:\d+/.test(j4.err) && j4.code <= 1,
  `exit=${j4.code}`, '边界输入');

const j5 = await runProbe(['--bogus-flag', 'x']);
rec('T1.6', '未知参数：不崩（当前实现忽略未知参数）',
  !/at .*\.mjs:\d+/.test(j5.err) && j5.code <= 1,
  `exit=${j5.code}`, '边界输入');

const b1 = fs.existsSync(BASELINE) ? fs.statSync(BASELINE).mtimeMs : 0;
await runProbe();
const b2 = fs.existsSync(BASELINE) ? fs.statSync(BASELINE).mtimeMs : 0;
rec('T1.7', '不带 --save-baseline 时**不写**基线文件（无副作用）',
  b1 === b2 && b1 !== 0,
  `mtime ${b1} → ${b2}`, '副作用检查');

const j6 = await runProbe(['--json']);
const pj6 = parseJsonOut(j6.out);
rec('T1.8', '幂等：连续两次跑，第二次对比结果应为「无变化」',
  pj6?.diff && pj6.diff.versionChanged === false && pj6.diff.slotsAdded.length === 0
  && pj6.diff.slotsRemoved.length === 0 && pj6.diff.statusFlipped.length === 0,
  `versionChanged=${pj6?.diff?.versionChanged} added=${pj6?.diff?.slotsAdded?.length} removed=${pj6?.diff?.slotsRemoved?.length} flipped=${pj6?.diff?.statusFlipped?.length}`,
  '重复执行');

const j7 = await runProbe([], { DSH_CORE_DIR: 'D:\\__no_such_dsh__' });
rec('T1.9', 'DSH_CORE_DIR 指向无效路径：优雅降级（回退探测或明确退出 2），不崩栈',
  !/at .*\.mjs:\d+/.test(j7.err),
  `exit=${j7.code}${j7.err ? ' stderr=' + j7.err.split('\n')[0].slice(0, 80) : ''}`, '故障注入（错误的环境变量）');

/* ============================ T2 断言正确性（故障注入） ============================ */
const hasBaseline = fs.existsSync(BASELINE);
if (hasBaseline) fs.copyFileSync(BASELINE, BACKUP);
const mutate = (fn) => { const j = JSON.parse(fs.readFileSync(BACKUP, 'utf8')); fn(j); fs.writeFileSync(BASELINE, JSON.stringify(j)); };
const restore = () => { if (hasBaseline) fs.copyFileSync(BACKUP, BASELINE); };

try {
  if (!hasBaseline) {
    rec('T2.0', '基线存在（T2 组的前提）', false, '找不到 ' + BASELINE, '前置条件');
  } else {
    // T2.1 槽位移除
    const victim = (JSON.parse(fs.readFileSync(BACKUP, 'utf8')).slotKeys || [])[0];
    mutate((j) => { j.slotKeys = j.slotKeys.filter((k) => k !== victim); });
    const r1 = parseJsonOut((await runProbe(['--json'])).out);
    rec('T2.1', `基线里删掉槽位 ${victim} → 应报「槽位移除」`,
      r1?.diff?.slotsAdded?.includes(victim), `slotsAdded=${JSON.stringify(r1?.diff?.slotsAdded)}`, '故障注入');
    restore();

    // T2.2 状态翻转
    mutate((j) => { j.checks.version.status = 'changed'; });
    const r2 = parseJsonOut((await runProbe(['--json'])).out);
    rec('T2.2', '基线里把某检查状态改坏 → 应报「状态翻转」',
      r2?.diff?.statusFlipped?.includes('version'), `statusFlipped=${JSON.stringify(r2?.diff?.statusFlipped)}`, '故障注入');
    restore();

    // T2.3 版本变化
    mutate((j) => { j.version = { dsh: '0.0.0-fake', cordis: '0.0.0' }; });
    const r3 = parseJsonOut((await runProbe(['--json'])).out);
    rec('T2.3', '基线版本号改掉 → 应报「版本变化：是」',
      r3?.diff?.versionChanged === true, `versionChanged=${r3?.diff?.versionChanged}`, '故障注入');
    restore();

    // T2.4 基线损坏
    fs.writeFileSync(BASELINE, '{ 这不是 JSON');
    const r4 = await runProbe(['--json']);
    const p4 = parseJsonOut(r4.out);
    rec('T2.4', '基线文件损坏（非法 JSON）→ 优雅降级，不崩栈',
      p4 !== null && !/at .*\.mjs:\d+/.test(r4.err), `exit=${r4.code} diff=${JSON.stringify(p4?.diff)}`, '故障注入');
    restore();

    // T2.5 恢复
    const r5 = parseJsonOut((await runProbe(['--json'])).out);
    rec('T2.5', '恢复基线后回到全绿（10/0）',
      r5?.ok === true && r5.checks.every((c) => c.status === 'ok'),
      `ok=${r5?.ok} 检查数=${r5?.checks?.length}`, '恢复后复验');
  }
} finally {
  restore();
  if (fs.existsSync(BACKUP)) fs.unlinkSync(BACKUP);
}

/* ============================ T3 文档与实现一致性 ============================ */
const skillMd = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
const docMd = fs.readFileSync(DOC, 'utf8');
// 文档断言覆盖两份文本：SKILL.md（入口小节）+ references/core-update.md（契约工作流正文——
// 检查条数声明、附录数值、官方 URL、脚本路径、参数说明都住在后者）
const docAll = skillMd + '\n' + docMd;
const probeSrc = fs.readFileSync(PROBE, 'utf8');

// T3.1 检查项条数
const actualChecks = (() => { const m = probeSrc.match(/const ok = /); return null; })();
const checkIds = [...probeSrc.matchAll(/\b(?:ok|bad)\('([a-z-]+)'/g)].map((m) => m[1]);
const uniqIds = [...new Set(checkIds)];
const claimedCount = (docAll.match(/(\d+)\s*条检查/g) || []).map((s) => Number(s.match(/(\d+)/)[1]));
const claimOk = claimedCount.length > 0 && claimedCount.every((n) => n === uniqIds.length);
rec('T3.1', `文档声明的检查条数与实现一致（实现 ${uniqIds.length} 条）`,
  claimOk, `文档声明=${JSON.stringify(claimedCount)}，实现=${uniqIds.length} 条（${uniqIds.join(', ')}）`,
  '静态比对：正则抽 SKILL.md 的数字 vs 抽探针源码里的检查 id');

// T3.2 官方文档 URL 的正确性
// ⚠️ 分工：本条是**离线静态护栏**（不需要网，永远能跑，永不假失败）；
//    真实可达性交给下面的 T3.2b（有网才断言）。
//    ⚠️ 不要把"连不上"判成"URL 错"——那是把环境限制记成产品缺陷。
//    （第一版曾误判本机"没有直连出网"，后来实测：HTTPS GET 通、`git clone` 超时，
//      两者不是一回事。结论已修正，见测试报告 §4。）
const badBranch = /deepseek-harness\/main\//.test(docAll);
// ⚠️ 只在 **URL 里**出现 CHANGELOG.md 才算问题——文档正文写"这里没有 changelog"是**正确信息**，不是缺陷。
//    （第一版护栏没区分这点，把"说没有"当成了"引用了没有的" → 假警报。）
const badChangelogUrl = (docAll.match(/https?:\/\/\S+/g) || []).some((u) => /CHANGELOG\.md/i.test(u));
const mainMentions = (docAll.match(/deepseek-harness\/main\//g) || []).length;
rec('T3.2', '官方文档 URL 分支名正确（须 master）且没有指向不存在的 CHANGELOG.md',
  !badBranch && !badChangelogUrl,
  `含 'deepseek-harness/main/' ${mainMentions} 处；URL 里指向 CHANGELOG.md=${badChangelogUrl}`,
  '离线静态护栏（不需要网，永不假失败；真实可达性见 T3.2b）');

// T3.2b 官方文档 URL 的**真实可达性**
//   为什么不直接断言：GitHub 抖动/断网会让整份测试变成假失败，而**假失败会训练人忽略测试**。
//   设计：先探连通性 → 通则把 SKILL.md 里的官方 URL 逐条 GET 并断言 2xx；不通则记为「跳过（未验证）」。
//   ⚠️ 「跳过」必须**明确写成未验证**，不能写成通过——否则断网时这份报告会谎称 URL 都对。
//   ⚠️ 本机 `git clone` 会超时（实测 >120s），但**同主机 HTTPS GET 只要 ~1s**；
//      所以"clone 不动"≠"没网"，别把前者误判成环境无网。
{
  const urls = [...new Set((docAll.match(/https?:\/\/[^\s`)'"<>，。]+/g) || []))]
    .filter((u) => /github\.com|deepseek/i.test(u)).slice(0, 8);
  let online = false, note = '';
  try {
    const r = await fetch('https://api.github.com/', { method: 'GET', signal: AbortSignal.timeout(8000) });
    online = r.ok || r.status === 404; note = 'HTTP ' + r.status;
  } catch (e) { note = String(e && e.message).slice(0, 60); }
  if (!online) {
    rec('T3.2b', '官方文档 URL 真实可达（**跳过：当前连不上网，未验证**）', true,
      `连通性探测失败：${note} —— 这几条 URL **没有被验证**，有网时请重跑本用例`, '跳过（环境限制，非通过）');
  } else {
    // ⚠️ 判据语义（本轮踩出来的）：**超时 ≠ URL 错**。
    //    实测本机 `raw.githubusercontent.com` 时快时慢（一次 1.1s 通、一次 >12s 超时），
    //    把它算成"URL 不可达"就是**假失败**；而假失败会训练人忽略测试。
    //    ⇒ 只有**拿到了 HTTP 错误状态码**才算真缺陷（这正是本用例要抓的：分支写错 → 404）；
    //      连不上/超时一律记为「未验证」，明确写出"没验证"，不冒充通过。
    const httpBad = [], inconclusive = [];
    for (const u of urls) {
      let lastErr = '';
      let got = null;
      for (let attempt = 1; attempt <= 2 && got === null; attempt += 1) {
        try {
          const r = await fetch(u, { method: 'GET', signal: AbortSignal.timeout(20000), redirect: 'follow' });
          got = r.status;
        } catch (e) { lastErr = String(e && e.message).slice(0, 40); }
      }
      if (got === null) inconclusive.push(`${u}（${lastErr}）`);
      else if (got < 200 || got >= 300) httpBad.push(`${u} → HTTP ${got}`);
    }
    const okAll = !httpBad.length && !inconclusive.length;
    const detail = httpBad.length ? '❌ HTTP 错误：' + httpBad.join('；')
      + (inconclusive.length ? `｜另有 ${inconclusive.length} 条未验证：${inconclusive.join('；')}` : '')
      : inconclusive.length ? `⚠️ **未验证**（${inconclusive.length}/${urls.length} 条连不上或超时，无 HTTP 错误）：${inconclusive.join('；')}`
      : `${urls.length} 条全部 2xx（连通性探测 ${note}）`;
    rec('T3.2b', `官方文档 URL 可达性（HTTP 错误才算缺陷；超时记未验证）`, !httpBad.length,
      detail, '联网实测（HTTPS GET ×2 次重试）');
    if (inconclusive.length && !httpBad.length) {
      // 把它诚实标记出来：这条**没有真正被验证**，别让它看起来像通过
      R[R.length - 1].unverified = true;
    }
    void okAll;
  }
}

// T3.3 附录数值 vs 探针实际输出
const pjv = parseJsonOut((await runProbe(['--json'])).out);
const numInDoc = (label) => { const m = new RegExp(label + '[^\\d]{0,12}(\\d+)').exec(docAll); return m ? Number(m[1]) : null; };
const docSlots = numInDoc('槽位总数');
const docPkgs = numInDoc('官方包数量');
rec('T3.3', 'core-update.md 附录的数值（槽位数 / 官方包数）与探针实际一致',
  docSlots === pjv?.slotCount && docPkgs === (fs.readdirSync(path.join(pjv.core, 'node_modules', '@deepseek-ai')).length),
  `文档 槽位=${docSlots}/包=${docPkgs}；实际 槽位=${pjv?.slotCount}/包=${fs.readdirSync(path.join(pjv.core, 'node_modules', '@deepseek-ai')).length}`,
  '静态比对');

// T3.4 文档里提到的**脚本路径**真实存在
//   ⚠️ 旧版只认 `scripts/<名字>.mjs` 这种形态，一律当成"技能自带"去 SKILL/scripts/ 下找。
//      一旦 SKILL.md 里提到**别的工程**的脚本（例如 `D:\lua_danzai\packages\dsh-eggy\scripts\test-entry-anchors.mjs`），
//      它也会被当成技能自带的 → 报"不存在" → **假警报**。
//      而假警报会训练人忽略测试，比没有检查更糟。
//   ⇒ 现在按**路径形态**分流：裸 `scripts/x.mjs` 才相对技能目录；
//      带盘符 / UNC / `$env:USERPROFILE` 的按那个绝对路径校验。
const rawScriptPaths = [...new Set((docAll.match(/[^\s`"'()｜]*scripts[\\/][\w.-]+\.mjs/g) || []))];
const resolveScriptRef = (raw) => {
  let p = raw.replace(/\$env:USERPROFILE/gi, os.homedir());
  const isAbs = /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\');
  return isAbs ? p : path.join(SKILL, p);
};
const scriptRefs = rawScriptPaths.map((raw) => ({ raw, file: resolveScriptRef(raw) }));
rec('T3.4', '文档提到的脚本路径真实存在（技能自带的按相对解析，外部工程按绝对解析）',
  scriptRefs.length > 0 && scriptRefs.every((r) => fs.existsSync(r.file)),
  scriptRefs.map((r) => `${r.raw}${fs.existsSync(r.file) ? ' ✓' : ' ✗'}`).join(', '),
  '文件系统（按路径形态分流）');

// T3.5 文档提到的参数**行为上**真实可用（比 grep 源码字符串可靠——实现里写的是 has('json')，不带横线）
const flagBehavior = [
  ['--json', j1.code === 0 && parseJsonOut(j1.out) !== null],
  ['--scan', Array.isArray(parseJsonOut((await runProbe(['--scan', SKILL, '--json'])).out)?.usage)
    && parseJsonOut((await runProbe(['--scan', SKILL, '--json'])).out).usage.length > 0],
  ['--save-baseline', (() => { const t0 = fs.statSync(BASELINE).mtimeMs; return t0 > 0; })()],
];
rec('T3.5', '文档提到的 CLI 参数行为上真实可用',
  flagBehavior.every(([, ok]) => ok),
  flagBehavior.map(([f, ok]) => `${f}=${ok ? '✓' : '✗'}`).join(', '), '行为验证（不 grep 源码字符串）');

/* ============ T1.10~T1.13 本轮优化项回归（新增功能必须有测试） ============ */

// T1.10 显式指定却无效 → 必须出声（第一版是静默回退，用户会以为测的是他指定的本体）
const jEnv = await runProbe(['--json'], { DSH_CORE_DIR: 'D:\\__not_a_dsh_core__' });
const pjEnv = parseJsonOut(jEnv.out);
rec('T1.10', 'DSH_CORE_DIR 无效时必须发出告警（**不得静默回退**）',
  pjEnv !== null && Array.isArray(pjEnv.warnings) && pjEnv.warnings.some((w) => /DSH_CORE_DIR/.test(w)),
  `warnings=${JSON.stringify(pjEnv?.warnings ?? null)}`, '故障注入（无效环境变量）');

// T1.11 自动化消费所需元数据
const metaOk = pjEnv && typeof pjEnv.generatedAt === 'string' && !Number.isNaN(Date.parse(pjEnv.generatedAt))
  && Number.isFinite(pjEnv.elapsedMs) && pjEnv.elapsedMs >= 0
  && typeof pjEnv.exitCode === 'number' && pjEnv.exitCode === 0
  && typeof pjEnv.scanSource === 'string' && Array.isArray(pjEnv.scanDirs);
rec('T1.11', '--json 含自动化消费所需元数据（generatedAt/elapsedMs/exitCode/scanSource/scanDirs）', !!metaOk,
  `generatedAt=${pjEnv?.generatedAt ?? 'n/a'}, elapsedMs=${pjEnv?.elapsedMs ?? 'n/a'}, exitCode=${pjEnv?.exitCode ?? 'n/a'}, scanSource=${pjEnv?.scanSource ?? 'n/a'}, scanDirs=${pjEnv?.scanDirs?.length ?? 'n/a'} 个`,
  'JSON schema 断言');

// T1.12 零参数 = 自动发现使用面；`--no-scan` = 明确关闭
const pjAuto = parseJsonOut((await runProbe(['--json'])).out);
const pjNo = parseJsonOut((await runProbe(['--no-scan', '--json'])).out);
rec('T1.12', '零参数自动发现使用面 / `--no-scan` 明确关闭',
  pjAuto?.scanSource === 'default' && pjAuto.usage.length > 0 && pjAuto.usage.some((u) => u.hits?.length)
  && pjNo?.scanSource === 'none' && pjNo.usage.length === 0,
  `默认 scanSource=${pjAuto?.scanSource}（${pjAuto?.usage?.length ?? 0} 个目录，有命中的 ${pjAuto?.usage?.filter((u) => u.hits?.length).length ?? 0}）；`
  + `--no-scan scanSource=${pjNo?.scanSource}（${pjNo?.usage?.length ?? 0} 个目录）`, '行为验证');

// T1.13 **回归护栏**：文档不得被当成"使用面"
//   本轮修过一个真噪声：探针原先把 .md/.json 一起算进出，于是 SKILL.md / references/*.md / evals.json
//   里**只是描述**了 `sidebar.footer.action` 也被记成"我们在用这个槽位"，凭空造出一大片假使用面。
//   这个用例钉住这条边界：夹具里 .md 提到 token、.js 没提到 → 命中数必须为 0。
{
  const fix = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-fixture-'));
  fs.writeFileSync(path.join(fix, 'doc.md'), '我们在用 sidebar.footer.action 这个槽位，还有 shell.overlay。\n');
  fs.writeFileSync(path.join(fix, 'code.js'), 'export const x = 1;\n');
  const out = parseJsonOut((await runProbe(['--scan', fix, '--json'])).out);
  const hits = out?.usage?.[0]?.hits ?? [];
  const scanned = out?.usage?.[0]?.filesScanned;
  try { fs.rmSync(fix, { recursive: true, force: true }); } catch { /* 清不掉也不影响结论 */ }
  rec('T1.13', '使用面只统计**代码**，不把文档/配置当成使用（回归护栏）',
    hits.length === 0 && scanned === 1,
    `夹具：doc.md 提到 sidebar.footer.action/shell.overlay，code.js 无关 → 命中 ${hits.length} 条（应为 0），扫到 ${scanned} 个文件（应为 1，即只扫 .js）`,
    '夹具故障注入（专治"假使用面"）');
}

// T1.14 **基线守卫**：非全绿时 `--save-baseline` 必须**拒绝**，且**不得改动基线文件**
//   为什么这条重要：基线代表「已知良好」。在坏状态下存基线 = 把坏状态固化成"正常"，
//   下次升级就**永久比不出东西**，而且是**静默**失效（探针照样绿）。
//   ⚠️ 本用例直接对着**真实基线文件**跑，所以必须：① 只走拒绝路径（绝不带 --force）；
//      ② 前后比对哈希，坐实"一个字节都没动"。
{
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-dsh-core-'));
  fs.writeFileSync(path.join(fake, 'package.json'), '{"name":"not-dsh","version":"0.0.0"}\n');
  const before = fs.existsSync(BASELINE) ? hashOf(BASELINE) : null;
  const r = await runProbe(['--save-baseline'], { DSH_CORE_DIR: fake });
  const after = fs.existsSync(BASELINE) ? hashOf(BASELINE) : null;
  try { fs.rmSync(fake, { recursive: true, force: true }); } catch { /* 不影响结论 */ }
  rec('T1.14', '非全绿时 `--save-baseline` 必须拒绝，且**基线文件一个字节都不许动**',
    r.code === 3 && before === after && /拒绝保存基线/.test(r.err),
    `exit=${r.code}（应 3）、拒绝信息=${/拒绝保存基线/.test(r.err) ? '有' : '无'}、基线哈希 ${before === after ? '未变 ✅' : '**被改写了 ❌**'}`,
    '故障注入（假本体目录）+ 哈希比对');
}

// T3.6 新参数 --no-scan 在文档里说清楚、且行为真实可用
rec('T3.6', '文档记录了 `--no-scan`（避免"文档没写但实现有"）',
  /--no-scan/.test(docAll), /--no-scan/.test(docAll) ? 'core-update.md 已记录' : '❌ 文档没提 --no-scan，别的 AI 不会知道它能关',
  '文档-实现一致性');

/* ============================ 输出 ============================ */
const unverified = R.filter((r) => r.unverified);
if (AS_JSON) {
  console.log(JSON.stringify({
    results: R, passed: R.filter((r) => r.ok).length, failed: R.filter((r) => !r.ok).length,
    // 把"没真正验证"的单独报出来：通过的用例里也有"因环境跳过"的，混在一起会让报告撒谎
    unverified: unverified.map((r) => r.id),
  }, null, 2));
} else {
  console.log('');
  console.log('===== dsh-plugin-win10·契约探针测试（原 dsh-core-update） =====');
  console.log('');
  for (const r of R) {
    const mark = r.ok ? (r.unverified ? '⚠️' : '✅') : '❌';
    console.log(mark + ` [${r.id}] ${r.name}`);
    console.log('      ' + r.detail);
    console.log('      （判据：' + r.method + '）');
  }
  const p = R.filter((r) => r.ok).length;
  console.log('');
  console.log(`合计：${p} 通过 / ${R.length - p} 失败`
    + (unverified.length ? `（其中 ${unverified.length} 条**未真正验证**：${unverified.map((r) => r.id).join(', ')}）` : ''));
  // ⚠️ 必须显式退出码 —— 早先这段**没有 process.exit**，于是「3 项失败」也照样 exit 0，
  //    接进 CI 或 `if ($LASTEXITCODE) {...}` 时完全看不出来（实测就是这么被瞒过一次）。
  //    **不会失败的测试比没有测试更坏**：它训练人忽略测试。
  //    判据只算 `failed`：`unverified`（联网类）是环境限制，不是失败。
  process.exit(R.length - p > 0 ? 1 : 0);
}
