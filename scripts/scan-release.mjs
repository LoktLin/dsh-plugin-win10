#!/usr/bin/env node
/**
 * scan-release.mjs —— 发布前扫描（技能自带，无依赖，可携带）
 *
 * 扫四类（发布面文档 + 全部文本文件）：
 *   ① 敏感信息：令牌 / 密钥 / 带凭据的 URL / 本机绝对路径 / 游戏账号 ID / 内网 IP / 手机号 / 邮箱
 *   ② 技能外信息：工作区路径（Desktop\yuanshen、案子/、tools/、packages/dsh-miliastra、_ref/）、跨技能引用
 *   ③ 断链：markdown 链接与反引号路径**在本仓内解析不到**（双基解析：文件目录 + 仓根）
 *   ④ 日期水印：`YYYY-MM-DD`（INFO —— 可能是内容日期，逐处看）
 *
 * 用法：
 *   node scripts/scan-release.mjs                 # 扫本仓（脚本所在目录的上一级）
 *   node scripts/scan-release.mjs --dir <目录>
 *   node scripts/scan-release.mjs --json          # 机器可读
 *   node scripts/scan-release.mjs --allow <子串>   # 白名单（可多次；命中行含该子串则跳过）
 *   node scripts/scan-release.mjs --selftest      # 正反例自检（证伪用）
 *
 * 行级豁免：该行里出现 `scan-release:allow` 就跳过（给"必须提到这些形态"的文档用，例如本流程自身的规则表）。
 * 退出码：0 无 ERROR ｜ 1 有 ERROR ｜ 2 用法错
 * ⚠️ 它只报**事实与位置**，不下判决；密钥一律**脱敏显示**（首尾各留 4 字符）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXTS = new Set(['.md', '.mjs', '.js', '.json', '.yml', '.yaml', '.txt', '.ps1', '.py', '.lua', '.html']);
const SKIP_DIRS = /(^|[\\/])(\.git|node_modules|_backup|_tests|projects)([\\/]|$)/;

const SECRET = [
    { id: 'TOKEN_GH', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, level: 'ERROR' },
    { id: 'TOKEN_GH_PAT', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, level: 'ERROR' },
    { id: 'TOKEN_SK', re: /\bsk-[A-Za-z0-9]{20,}/g, level: 'ERROR' },
    { id: 'TOKEN_AWS', re: /\bAKIA[0-9A-Z]{16}\b/g, level: 'ERROR' },
    { id: 'TOKEN_NPM', re: /_authToken\s*=\s*\S+/g, level: 'ERROR' },
    { id: 'URL_CRED', re: /https?:\/\/[^\s/@:]+:[^\s/@]+@/g, level: 'ERROR' },
    { id: 'PRIVATE_KEY', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, level: 'ERROR' },
    { id: 'WIN_ABS_PATH', re: /[A-Za-z]:[\\/]Users[\\/][^\s\\/`"'）)，,]+/g, level: 'ERROR' },
    { id: 'POSIX_HOME', re: /\/(?:Users|home)\/[A-Za-z0-9._-]+\//g, level: 'ERROR' },
    { id: 'GAME_ACCOUNT', re: /BeyondLocal[\\/]\d{6,}/g, level: 'ERROR' },
    { id: 'PRIVATE_IP', re: /\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g, level: 'ERROR' },
    { id: 'PHONE_CN', re: /(^|[^\w.])(1[3-9]\d{9})(?![\w.])/g, level: 'WARN' },
    { id: 'EMAIL', re: /(?<![A-Za-z0-9._%+-])(?!(?:git|ssh|hg|svn|oauth2|root|noreply|admin|user|www)@)[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, level: 'WARN' },
];

const OUTSIDE = [
    { id: 'WORKSPACE_DESKTOP', re: /Desktop[\\/]yuanshen[\\/]?/gi, level: 'ERROR' },
    { id: 'CASE_DIR', re: /(^|[^\w])案子[\\/]/g, level: 'WARN' },
    { id: 'WORKSPACE_TOOL', re: /(^|[^\w])tools[\\/][A-Za-z0-9_.-]+\.mjs/g, level: 'WARN' },
    { id: 'PLUGIN_PKG', re: /packages[\\/]dsh-miliastra/g, level: 'ERROR' },
    { id: 'UPSTREAM_REF', re: /(^|[^\w])_ref[\\/]/g, level: 'ERROR' },
    { id: 'OTHER_SKILL_REL', re: /(?<![\w.])\.\.\/[A-Za-z0-9_-]+\//g, level: 'WARN' },
];

const DATE = /\b20\d{2}-\d{2}-\d{2}\b/g;
const LINK = /\[[^\]]*\]\(([^)\s]+)\)/g;
const SPAN = /`((?:\.\.\/)+[A-Za-z0-9_\-./\u4e00-\u9fa5]+|(?:references|assets|scripts)\/[A-Za-z0-9_\-./\u4e00-\u9fa5]+)\.(md|mjs|js|json|yml|yaml|txt|png|gia|lua|ps1)`/g;

const redact = (s) => (s.length <= 10 ? s : s.slice(0, 4) + '…' + s.slice(-4));

function scanText(txt, root, file) {
    const out = [];
    const rel = path.relative(root, file).replace(/\\/g, '/');
    const lines = txt.split('\n');
    const at = (idx) => txt.slice(0, idx).split('\n').length;
    const hit = (idx, cat, id, level, raw, note) => out.push({ file: rel, line: at(idx), cat, id, level, text: redact(raw.trim()), note: note || '' });

    for (const r of [...SECRET, ...OUTSIDE]) {
        for (const m of txt.matchAll(r.re)) {
            // 跳过"落在 URL 里"的命中（同一行内、URL 起点之后）—— 那多半是别人仓库/网页里的路径或串
            const lineStart = txt.lastIndexOf('\n', m.index) + 1;
            if (/https?:\/\//.test(txt.slice(lineStart, m.index))) continue;
            hit(m.index, SECRET.includes(r) ? '敏感信息' : '技能外信息', r.id, r.level, m[0]);
        }
    }
    for (const m of txt.matchAll(DATE)) hit(m.index, '日期', 'DATE_STAMP', 'INFO', m[0]);
    for (const m of txt.matchAll(LINK)) {
        let t = m[1];
        if (/^(https?:|mailto:|#)/.test(t)) continue;
        t = t.split('#')[0];
        if (!t) continue;
        const cands = [path.resolve(path.dirname(file), t), path.resolve(root, t)];
        if (!cands.some((c) => fs.existsSync(c))) {
            const ln = at(m.index);
            const hasUrl = /https?:\/\//.test(lines[ln - 1] || '');
            out.push({ file: rel, line: ln, cat: '断链', id: 'LINK_UNRESOLVED', level: hasUrl ? 'INFO' : 'ERROR', text: t, note: hasUrl ? '同行有外部 URL —— 可能是别人仓库里的路径' : 'markdown 链接在本仓内解析不到' });
        }
    }
    for (const m of txt.matchAll(SPAN)) {
        const t = `${m[1]}.${m[2]}`;
        const cands = [path.resolve(path.dirname(file), t), path.resolve(root, t)];
        if (!cands.some((c) => fs.existsSync(c))) {
            const ln = at(m.index);
            const hasUrl = /https?:\/\//.test(lines[ln - 1] || '');
            out.push({ file: rel, line: ln, cat: '断链', id: 'PATH_UNRESOLVED', level: hasUrl ? 'INFO' : 'ERROR', text: t, note: hasUrl ? '同行有外部 URL —— 可能是别人仓库里的路径' : '反引号路径在本仓内解析不到' });
        }
    }
    return { hits: out.filter((h) => !(lines[h.line - 1] || '').includes('scan-release:allow')), lines: lines.length };
}

function walk(dir, root, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (SKIP_DIRS.test(p)) continue;
        if (e.isDirectory()) { walk(p, root, out); continue; }
        if (!EXTS.has(path.extname(e.name))) continue;
        if (/\.bak/.test(e.name)) continue;
        if (path.resolve(p) === path.resolve(fileURLToPath(import.meta.url))) continue;   // 不扫自己（正则字面量会自我命中）
        out.push(p);
    }
    return out;
}

// ── 自检：坏样本必须全命中，干净样本必须零命中 ──────────────────────
const argv = process.argv.slice(2);
if (argv.includes('--selftest')) {
    const dirty = [
        'token=' + 'ghp_' + 'A'.repeat(30),
        'url=https://oauth2:' + 's3cr3t' + '@example.com/x.git',
        'path=' + 'C:' + '\\Users\\SomeUser\\Desktop\\yuanshen\\案子\\x.lua',
        'acct=BeyondLocal\\' + '201170108' + '\\Beyond_Local_Save_Level',
        'ip=' + ['10', '1', '2', '3'].join('.'),
        'mail=someone@example.com',
        'tool=' + 'tools/check-lua-scope.mjs',
        'link=[x](references/nope.md)',
        'date=2026-01-01',
    ].join('\n');
    const clean = [
        '# 标题',
        '安装：git clone <仓库> "$env:USERPROFILE\\.dsh\\skills\\name"',
        '跑：node scripts/scaffold.mjs mytool --dir D:\\myplugins',
        '见 `references/pitfalls.md`',
    ].join('\n');
    const fakeRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '__selftest__');
    fs.mkdirSync(path.join(fakeRoot, 'references'), { recursive: true });
    fs.writeFileSync(path.join(fakeRoot, 'references', 'pitfalls.md'), 'x');
    const d = scanText(dirty, fakeRoot, path.join(fakeRoot, 'a.md')).hits;
    const c = scanText(clean, fakeRoot, path.join(fakeRoot, 'b.md')).hits;
    fs.rmSync(fakeRoot, { recursive: true, force: true });
    const cats = new Set(d.map((h) => h.id));
    const want = ['TOKEN_GH', 'URL_CRED', 'WIN_ABS_PATH', 'GAME_ACCOUNT', 'PRIVATE_IP', 'EMAIL', 'WORKSPACE_TOOL', 'LINK_UNRESOLVED', 'DATE_STAMP'];
    const miss = want.filter((w) => !cats.has(w));
    const cleanBad = c.filter((h) => h.level !== 'INFO');
    console.log(`自检坏样本：命中 ${d.length} 处，覆盖 ${[...cats].join(' / ')}`);
    console.log(`自检干净样本：命中 ${c.length} 处${c.length ? '（' + c.map((h) => h.id).join(' / ') + '）' : ''}`);
    if (miss.length || cleanBad.length) { console.error(`❌ 自检未通过（缺 ${miss.join('/') || '无'}；干净样本误报 ${cleanBad.length}）`); process.exit(1); }
    console.log('自检通过 ✓');
    process.exit(0);
}

const dirIdx = argv.indexOf('--dir');
const json = argv.includes('--json');
const allow = [];
for (let i = 0; i < argv.length; i++) if (argv[i] === '--allow' && argv[i + 1]) allow.push(argv[i + 1]);

const root = dirIdx >= 0 ? path.resolve(argv[dirIdx + 1])
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');   // scripts/ 的上一级 = 技能/仓库根
if (!fs.existsSync(root)) { console.error('❌ 目录不存在：' + root); process.exit(2); }

let all = [];
const files = walk(root, root);
for (const f of files) {
    let txt;
    try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const h of scanText(txt, root, f).hits) {
        if (allow.some((a) => h.text.includes(a))) continue;
        all.push(h);
    }
}
all.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

const count = (lv) => all.filter((h) => h.level === lv).length;
if (json) {
    console.log(JSON.stringify({ root, files: files.length, errors: count('ERROR'), warns: count('WARN'), infos: count('INFO'), hits: all }, null, 2));
} else {
    const lv = { ERROR: '⛔', WARN: '⚠️ ', INFO: 'ℹ️ ' };
    let cur = '';
    for (const h of all) {
        if (h.file !== cur) { cur = h.file; console.log(`\n${cur}`); }
        console.log(`  ${lv[h.level]} L${h.line} [${h.id}] ${h.text}${h.note ? '  — ' + h.note : ''}`);
    }
    console.log(`\n扫了 ${files.length} 个文件 ｜ ERROR ${count('ERROR')} ｜ WARN ${count('WARN')} ｜ INFO ${count('INFO')}`);
    if (count('ERROR')) {
        console.log('⛔ 有 ERROR：发布前必须处理（删 / 改成读者动作 / 移进开发文档）。');
        console.log('   —— 技能外路径若确实是"读者必须知道的路径来源"，改成通用写法（`<工作区>/案子/<地图>/…`），别写本机绝对路径。');
    } else {
        console.log('✅ 无 ERROR（WARN/INFO 逐处判断：日期可能是内容，邮箱可能是作者公开联系方式）。');
    }
}
process.exit(count('ERROR') ? 1 : 0);
