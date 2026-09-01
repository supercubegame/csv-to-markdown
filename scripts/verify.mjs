#!/usr/bin/env node
// 快闸门：零依赖、离线、几十秒出结果。一条命令返回退出码。
//
// 三类检查混在一份报告里，但根因完全不同，所以每条都标了 kind：
//   behavior  产品行为对不对
//   structure 仓库结构 / 文档 / 流水线自己有没有腐化
//   mutant    把断言要守的东西故意改坏，证明它真的在守（不是装饰）
//
// 报告写进 artifacts/report.json，stdout 由本脚本自己 tee 进 artifacts/stdout-fast.log
// —— 故意不在 workflow 里用管道 tee，因为那会撞上以字面量构造的变异体，
// 而且管道会吃掉退出码。

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rd = (p) => readFileSync(join(ROOT, p), 'utf8');

const engine = await import(new URL('../src/engine.mjs', import.meta.url));
const ENGINE_SRC = rd('src/engine.mjs');

const checks = [];
const facts = [];
const check = (id, kind, name, fn) => checks.push({ id, kind, name, fn });
const fact = (label, value) => facts.push({ label, value });

class Fail extends Error {}
const eq = (actual, expected, what) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Fail(`${what}\n    期望 ${e}\n    实际 ${a}`);
};
const ok = (cond, what) => { if (!cond) throw new Fail(what); };

// ===========================================================================
// 剥注释与字符串。任何「某段里有没有 X」的检查都必须先把那段切出来 ——
// 注释里的字面量既会让扫描漏报，也会让它误报。修法做在扫描器里，
// 而不是靠「以后别在注释里提这些词」的约定。
// ===========================================================================
function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const two = src.slice(i, i + 2);
    if (two === '//') { while (i < n && src[i] !== '\n') i += 1; continue; }
    if (two === '/*') { i += 2; while (i < n && src.slice(i, i + 2) !== '*/') i += 1; i += 2; continue; }
    const q = src[i];
    if (q === '"' || q === "'" || q === '`') {
      i += 1;
      while (i < n && src[i] !== q) { if (src[i] === '\\') i += 1; i += 1; }
      i += 1;
      out += '""';
      continue;
    }
    out += src[i];
    i += 1;
  }
  return out;
}

const BANNED_IN_CORE = ['document', 'window', 'fetch(', 'require(', 'process.', 'localStorage',
  'XMLHttpRequest', 'readFile', 'writeFile', 'Date.now', 'new Date', 'Math.random'];

function scanPurity(src) {
  const stripped = stripCommentsAndStrings(src);
  // 自证：剥完必须还剩真东西。剥成空字符串的话，下面每条都会免费通过。
  ok(stripped.includes('export function'), '剥注释之后连 export function 都没了，扫描器自己坏了');
  ok(stripped.length >= src.length * 0.4,
    `剥注释之后只剩 ${stripped.length} 字节（原文 ${src.length}），低于四成，判定剥过头了`);
  return BANNED_IN_CORE.filter((t) => stripped.includes(t));
}

// ===========================================================================
// 行为断言。**这一组会被原样套在变异体上**（同一个检查器，不是另写一套），
// 所以每条都只通过参数拿到 engine。
// ===========================================================================
const B = {
  plainExact(e) {
    const r = e.convert('name,qty\napple,3\npear,12');
    eq(r.markdown, [
      '| name  | qty  |',
      '| :---- | :--- |',
      '| apple | 3    |',
      '| pear  | 12   |',
    ].join('\n'), '3 行 2 列的输出必须逐字等于这份手写夹具');
    eq([r.rowCount, r.colCount, r.lineCount], [3, 2, 4], '行列数');
  },

  quotedComma(e) {
    const r = e.convert('a,"b,c",d\n1,2,3');
    // 朴素 split(',') 会得到 4 列。这条等号就是为了红在那上面。
    eq(r.colCount, 3, '引号里的逗号是数据，列数必须是 3');
    ok(r.markdown.includes('b,c'), '引号里的逗号必须原样留在单元格里');
  },

  escapedQuote(e) {
    const { rows } = e.parseCsv('"a""b",z');
    eq(rows[0][0], 'a"b', '两个连续引号是一个字面引号');
  },

  embeddedNewline(e) {
    const r = e.convert('h1,h2\n"line1\nline2",z');
    eq(r.rowCount, 2, '引号里的换行不许把一行劈成两行');
    eq(r.markdown.split('\n').length, 3, '输出必须恰好 3 行（表头 + 分隔 + 1 行数据）');
    ok(r.markdown.includes('<br>'), '单元格内换行要转成 <br>');
  },

  pipeEscaped(e) {
    const r = e.convert('a|b,c\n1,2');
    // 承重的那条：按「未转义的 |」切开，每行必须恰好切出 colCount+2 段。
    for (const line of r.markdown.split('\n')) {
      const parts = line.split(/(?<!\\)\|/);
      eq(parts.length, r.colCount + 2, `这一行的结构被单元格里的竖线劈开了：${line}`);
    }
    ok(r.markdown.includes('a\\|b'), '单元格里的竖线要转义成 \\|');
  },

  crlfEqualsLf(e) {
    eq(e.convert('a,b\r\nc,d').markdown, e.convert('a,b\nc,d').markdown, 'CRLF 与 LF 必须给出同一份输出');
  },

  detectSemicolon(e) { eq(e.detectDelimiter('a;b;c\n1;2;3'), ';', '分号文件'); },
  detectTab(e) { eq(e.detectDelimiter('a\tb\tc\n1\t2\t3'), '\t', '制表符文件'); },

  detectQuoteAware(e) {
    // 负向孪生：分号更多，但全在引号里。不引号感知的探测器会选错。
    const csv = 'a,"x;y;z;p;q;r;s",b\n1,2,3';
    eq(e.detectDelimiter(csv), ',', '引号里的分号是数据，不参与分隔符投票');
  },

  raggedPadded(e) {
    const r = e.convert('a,b,c\nd\ne,f');
    eq(r.colCount, 3, '按最长的行定列数');
    const bars = r.markdown.split('\n').map((l) => (l.match(/\|/g) || []).length);
    eq(new Set(bars).size, 1, '补齐之后每行的竖线数必须一致');
    ok(r.warnings.some((w) => w.includes('列数不一致')), '列数不齐要出一条警告');
  },

  emptyInput(e) {
    const r = e.convert('');
    eq([r.markdown, r.rowCount, r.lineCount], ['', 0, 0], '空输入');
    ok(!r.markdown.includes(':---'), '空输入不许留下一条孤立的分隔行');
  },

  alignRules(e) {
    eq(e.convert('a\nb', { align: 'left' }).markdown.split('\n')[1], '| :--- |', 'left');
    eq(e.convert('a\nb', { align: 'center' }).markdown.split('\n')[1], '| :---: |', 'center');
    eq(e.convert('a\nb', { align: 'right' }).markdown.split('\n')[1], '| ---: |', 'right');
  },

  alignFallback(e) { eq(e.convert('a\nb', { align: 'diagonal' }).align, 'left', '不认识的对齐值退回 left'); },

  headerOff(e) {
    const r = e.convert('a,b\nc,d', { header: false });
    eq(r.lineCount, 4, '关掉表头时，输出是 空表头 + 分隔 + 2 行数据');
    eq(r.markdown.split('\n')[0].replace(/[ |]/g, ''), '', '补出来的表头行必须是空的');
  },

  // 结构性的复杂度守卫，不是计时基准。谁把量宽挪进渲染循环（平方复杂度的
  // 经典写法），这个等号当场对不上。三条数据和三万条在计时上看不出区别。
  cellVisitsExact(e) {
    const rows = 40, cols = 7;
    const csv = Array.from({ length: rows }, (_, i) =>
      Array.from({ length: cols }, (_, j) => `c${i}_${j}`).join(',')).join('\n');
    const r = e.convert(csv);
    eq(r.stats.cellVisits, rows * cols * 2, '单元格访问次数必须恰好是 行 × 列 × 2');
  },

  deterministic(e) {
    const csv = 'k,v\n"a,1",2\nb|c,3';
    const first = e.convert(csv).markdown;
    for (let i = 0; i < 200; i += 1) eq(e.convert(csv).markdown, first, `第 ${i} 次输出与第一次不同`);
  },

  trailingNewline(e) { eq(e.convert('a,b\n').rowCount, 1, '结尾的换行不许造出一个空行'); },

  unterminatedQuote(e) {
    const r = e.convert('h,i\n"a,b');
    ok(r.warnings.some((w) => w.includes('引号没闭合')), '未闭合的引号要明确报出来，不许静默当成正常一遍');
  },

  // ALIGN_RULE 与列宽下限是一组耦合参数：改一个必须重算另一个。
  // 这条等号把两头钉在一起，散文里那句话钉不住。
  alignWidthCoupling(e) {
    for (const align of ['left', 'center', 'right']) {
      const lines = e.convert('a,b\nlonger,2', { align }).markdown.split('\n');
      eq(new Set(lines.map((l) => [...l].length)).size, 1, `${align}：分隔行与数据行宽度不一致`);
    }
  },
};

for (const [id, fn] of Object.entries(B)) {
  check(id, 'behavior', `行为：${id}`, () => fn(engine));
}

// 只有这一条不套在变异体上：它量的是时间，不是行为。
check('perf-measured', 'behavior', '行为：5000 × 8 的表能跑完（只记实测值，不设阈值）', () => {
  const csv = Array.from({ length: 5000 }, (_, i) =>
    Array.from({ length: 8 }, (_, j) => `r${i}c${j}`).join(',')).join('\n');
  const t0 = process.hrtime.bigint();
  const r = engine.convert(csv);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  eq(r.lineCount, 5001, '5000 行输入应得 5001 行输出');
  eq(r.stats.cellVisits, 5000 * 8 * 2, '大表的访问次数同样要对得上');
  fact('5000 × 8 转换耗时（实测，未设阈值）', `${ms.toFixed(1)} ms`);
});

check('snapshot-fields', 'structure', '诊断出口的字段一个都没少', () => {
  const s = engine.snapshot(engine.convert('a,b\nc,d'));
  eq(Object.keys(s).sort(), ['align', 'cellVisits', 'charsScanned', 'colCount', 'delimiter',
    'header', 'lineCount', 'rowCount', 'warningCount'].sort(),
    '闸门认这些字段名。可以增加，不许删改 —— 删掉就等于把闸门弄哑了');
});

// ===========================================================================
// 结构类
// ===========================================================================
check('core-purity', 'structure', '纯核心里没有任何 I/O', () => {
  eq(scanPurity(ENGINE_SRC), [], '纯核心里出现了 I/O 关键字（已剥掉注释与字符串）');
});

check('purity-scanner-selfproof', 'structure', '纯度扫描器在一个必然违规的样本上会判红', () => {
  const dirty = 'export function f() {\n  const el = document.body;\n  return Math.random() + el;\n}\n' +
    'export function g() { return 1; }\n'.repeat(20);
  const hits = scanPurity(dirty);
  ok(hits.length >= 2, `正向对照只抓到 ${hits.length} 条，扫描器没在干活`);
});

const MANIFEST = JSON.parse(rd('manifest.json'));

check('src-manifest-equal', 'structure', 'src/ 里实际的文件集合等于登记集合', () => {
  eq(readdirSync(join(ROOT, 'src')).sort(), [...MANIFEST.src].sort(),
    '手写清单追不上目录：新加一个文件而忘了登记，这条就该红');
});

check('workflow-writeback-enumerated', 'structure', '每一条流水线都接了回写（白名单式，从目录枚举）', () => {
  const dir = join(ROOT, '.github/workflows');
  const files = readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  ok(files.length > 0, '一条 workflow 都没找到,先怀疑这把尺子');
  const missing = files.filter((f) => !readFileSync(join(dir, f), 'utf8').includes('ci-workflows/.github/workflows/report.yml@'));
  eq(missing, [], '这些流水线没有回写通道，它们失败的原因只存在于我读不到的 CI 日志里');
  fact('已枚举的流水线', files.join(', '));
});

// 先剥掉 YAML 注释再切块。第一版没剥，结果它被 verify.yml 里一句**解释这条
// 规矩本身**的注释判红了 —— 注释里的字面量既会让扫描漏报，也会让它误报，
// 而修法只有一个：剥注释做在扫描器里，不要靠「以后别在注释里提这些词」的约定。
// 两侧都有自证：该抓的必须抓到，注释里的提及必须不抓。
const stripYamlComments = (yaml) => yaml.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

const teeNeedsPipefail = (yaml) => {
  const blocks = stripYamlComments(yaml).split(/\n(?=\s{6,}- )/);
  return blocks.filter((b) => b.includes('| tee') && !b.includes('set -o pipefail')).length;
};

check('tee-needs-pipefail', 'structure', '凡是用管道 tee 的脚本块都开了 pipefail', () => {
  const dir = join(ROOT, '.github/workflows');
  for (const f of readdirSync(dir)) {
    eq(teeNeedsPipefail(readFileSync(join(dir, f), 'utf8')), 0,
      `${f}：管道会把闸门的退出码换成 tee 的，永远是 0`);
  }
  // 正向对照：同一个检查器在一个必然违规的块上必须数出 1。
  eq(teeNeedsPipefail('\n      - name: x\n        run: |\n          npm run verify | tee log.txt\n'), 1,
    '正向对照没命中，说明这个检查器压根没在切块');
  // 负向那侧（第一版就栽在这里）：注释里提到管道 tee 不许算违规。
  eq(teeNeedsPipefail('\n      # 故意不写 | tee，因为管道会吃掉退出码\n      - name: x\n        run: node scripts/verify.mjs\n'), 0,
    '扫描器被注释骗了：它会把一句解释这条规矩的注释判成违规');
});

const SECRET_PATTERNS = [/gh[pousr]_[A-Za-z0-9]{36}/g, /AKIA[0-9A-Z]{16}/g, /-----BEGIN [A-Z ]*PRIVATE KEY-----/g];
const scanSecrets = (text) => SECRET_PATTERNS.reduce((n, re) => n + (text.match(re) || []).length, 0);

check('secret-scan', 'structure', '仓库里没有密钥形状的字符串（带正向对照）', () => {
  // 只扫文本文件：仓库里进了图片之后，二进制里凑巧出现一段密钥形状的字节
  // 会给出一条谁也看不懂的偶发红。
  const exts = ['.mjs', '.js', '.html', '.json', '.yml', '.yaml', '.md'];
  const walk = (d, acc = []) => {
    for (const ent of readdirSync(join(ROOT, d), { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'artifacts') continue;
      const p = d ? `${d}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(p, acc);
      else if (exts.some((x) => ent.name.endsWith(x))) acc.push(p);
    }
    return acc;
  };
  const files = walk('');
  ok(files.length >= 8, `只扫到 ${files.length} 个文本文件，先怀疑这把尺子`);
  const hits = files.filter((f) => scanSecrets(rd(f)) > 0);
  eq(hits, [], '这些文件里出现了密钥形状的字符串');
  // 哨兵：运行时拼出来，所以它不作为字面量存在于任何文件里。
  // 「没找到」这个结论，必须同时有一个「一定找得到」的对照才算数。
  const sentinel = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
  eq(scanSecrets(sentinel), 1, '正向对照没命中：那些 0 说的是通道，不是世界');
  fact('扫过的文本文件', String(files.length));
});

check('agents-line-limit', 'structure', 'AGENTS.md 不超过 200 行', () => {
  const n = rd('AGENTS.md').split('\n').length;
  ok(n <= 200, `AGENTS.md 已经 ${n} 行。压措辞或者拆文件，绝不调宽这条上限`);
  fact('AGENTS.md 行数（上限 200）', String(n));
});

check('agents-claude-identical', 'structure', 'CLAUDE.md 与 AGENTS.md 逐字相同', () => {
  eq(rd('CLAUDE.md'), rd('AGENTS.md'), '两份规矩文件已经分叉');
});

check('docs-count-crosscheck', 'structure', '文档里写的检查条数等于实际注册的条数', () => {
  const total = checks.length;
  for (const f of ['AGENTS.md', 'README.md']) {
    const m = rd(f).match(/闸门共 (\d+) 条检查/);
    ok(m, `${f} 里找不到那句带条数的话,正向对照失败，这条断言当场变空`);
    eq(Number(m[1]), total, `${f} 里的条数漂了。散文里的数字要么由机器生成，要么配一条等号断言`);
  }
});

check('no-prose-promises', 'structure', '文档里没有无人看守的散文承诺', () => {
  const words = ['下次一定', '稍后补上', '以后优化', '待补充', 'TODO'];
  const bad = [];
  for (const f of ['AGENTS.md', 'README.md']) {
    // 先剥掉历史叙述（带日期的、引号里的、带「之前 / 当时」的），
    // 否则扫描器会被文档自己写的历史骗到。和「剥注释」完全同形。
    const lines = rd(f).split('\n').filter((l) =>
      !/\d{4}-\d{2}-\d{2}/.test(l) && !/之前|当时|曾经/.test(l) && !/^\s*>/.test(l));
    for (const w of words) if (lines.join('\n').includes(w)) bad.push(`${f}: ${w}`);
  }
  eq(bad, [], '这些承诺没有任何判据在守。改写成不承诺任何事的话，或者登记进 manifest.json 的 obligations');
});

check('obligations-registered', 'structure', '带期限的义务有判据，且做完了就不再挂着', () => {
  const list = MANIFEST.obligations || [];
  for (const o of list) {
    ok(o.id && o.what && o.evidence && o.due, `义务 ${o.id || '(无 id)'} 缺字段：必须有 what / evidence / due`);
    ok(o.done !== true, `义务 ${o.id} 已完成却还挂着。挂着已完成事项的清单，没人会再读它`);
  }
  fact('登记在册的义务', list.length ? list.map((o) => `${o.id}(至 ${o.due})`).join(', ') : '无');
});

// ===========================================================================
// CI 结构：手写清单永远追不上目录，所以让枚举本身成为期望。
// ===========================================================================
const VERIFY_YML = rd('.github/workflows/verify.yml');

check('gates-manifest-equal', 'structure', '流水线里的产物名集合等于登记的闸门名单', () => {
  const slugs = [...VERIFY_YML.matchAll(/name: report-([a-z0-9-]+)/g)].map((m) => m[1]);
  ok(slugs.length > 0, '一个 report-* 产物都没扫到,先怀疑这把尺子');
  eq(slugs.sort(), [...MANIFEST.gates].sort(),
    '加一个闸门 job 而忘了登记（或者别的 job 占了 report-* 这个命名空间），这条就该红');
});

// marker 必须在两处逐字相同：report 的入口参数，和 attest 回头查的那个。
// 可复用 workflow 的 with: 读不到 env 上下文，所以这个字面量注定要写两遍 ——
// 那就让它变成一组有断言看守的耦合参数。
check('marker-coupling', 'structure', 'marker 在两处逐字相同，且与登记表一致', () => {
  const marker = MANIFEST.marker;
  ok(marker && marker.startsWith('<!--'), 'manifest.json 里没登记 marker');
  const n = VERIFY_YML.split(marker).length - 1;
  eq(n, 2, `marker 在 verify.yml 里出现了 ${n} 次。必须恰好 2 次：report 传进去的，和 attest 查的`);
});

check('cron-coupling', 'structure', '定时频率与新鲜度上限钉在一起', () => {
  const m = VERIFY_YML.match(/cron: '([^']+)'/);
  ok(m, 'verify.yml 里找不到 cron');
  eq(m[1], MANIFEST.cron, 'workflow 里的 cron 与登记表不一致');
  const [minute, , dom, month, dow] = m[1].split(/\s+/);
  ok(Number(minute) !== 0, '别取整点，整点是平台排队高峰');
  eq([dom, month, dow], ['*', '*', '*'], '这条 cron 不是每天一次,新鲜度上限是按每天算的');
  const maxAge = MANIFEST.max_heartbeat_age_days;
  ok(maxAge >= 2, `新鲜度上限 ${maxAge} 天对每天一次的 cron 太紧：正常波动就会撞，那是一台假红工厂`);
  ok(maxAge <= 7, `新鲜度上限 ${maxAge} 天太松：一条死了快一周的 cron 还不喊`);
});

// 判定抽成纯函数，好让同一个判定器套在合成样本上自证。
function judgeHeartbeat(hb, opts) {
  const { maxAgeDays, toleranceMin, nowMs, dueMs } = opts;
  const stamp = hb.last_scheduled_run;
  if (!stamp) {
    if (nowMs > dueMs) {
      return { ok: false, reason: '宽限期已过，而定时闸门一次都没被平台唤起过。写完就搁着的断言，价值是零' };
    }
    const days = Math.ceil((dueMs - nowMs) / 86400000);
    return { ok: true, reason: `未确认：定时闸门还没跑过第一次，宽限期还剩 ${days} 天（义务 heartbeat-first-tick）` };
  }
  const ageMs = nowMs - Date.parse(stamp);
  if (ageMs < -toleranceMin * 60000) {
    return { ok: false, reason: `心跳时间戳在未来 ${Math.round(-ageMs / 60000)} 分钟，超出 ${toleranceMin} 分钟容差,有个钟在说谎` };
  }
  const days = ageMs / 86400000;
  if (days > maxAgeDays) {
    return { ok: false, reason: `最近一次定时运行是 ${days.toFixed(1)} 天前，超过 ${maxAgeDays} 天。平台很可能已经静默停用了这条 cron` };
  }
  return { ok: true, reason: `最近一次定时运行是 ${days.toFixed(1)} 天前（上限 ${maxAgeDays} 天）` };
}

const HB_OPTS = () => ({
  maxAgeDays: MANIFEST.max_heartbeat_age_days,
  toleranceMin: MANIFEST.future_timestamp_tolerance_minutes,
  nowMs: Date.now(),
  dueMs: Date.parse(MANIFEST.obligations.find((o) => o.id === 'heartbeat-first-tick').due + 'T23:59:59Z'),
});

check('heartbeat-freshness', 'structure', '定时闸门留下的正向痕迹够新', () => {
  const verdict = judgeHeartbeat(JSON.parse(rd('heartbeat.json')), HB_OPTS());
  fact('心跳', verdict.reason);
  ok(verdict.ok, verdict.reason);
});

check('heartbeat-selfproof', 'structure', '心跳判定器在必然失效的样本上会判红', () => {
  const base = HB_OPTS();
  const old = judgeHeartbeat({ last_scheduled_run: new Date(base.nowMs - 99 * 86400000).toISOString() }, base);
  ok(!old.ok, '99 天前的心跳被判成了新鲜,这条断言是装饰');
  const future = judgeHeartbeat({ last_scheduled_run: new Date(base.nowMs + 5 * 3600000).toISOString() }, base);
  ok(!future.ok, '未来 5 小时的时间戳被放过了,容差那一侧不承重');
  const overdue = judgeHeartbeat({ last_scheduled_run: null }, { ...base, dueMs: base.nowMs - 86400000 });
  ok(!overdue.ok, '宽限期过了而心跳仍为空，却没判红');
});

// ===========================================================================
// 变异体：读代码判断不了一条断言是不是装饰。把它要守的东西故意改坏一次，
// 看它红不红。三条纪律：先证明替换真的发生了；真货和变异体走同一个检查器；
// 量一下朴素写法会放走几个。
// ===========================================================================
const MUTANTS = [
  { id: 'mutant-pipe', guards: 'pipeEscaped', why: '去掉竖线转义',
    from: "return String(value).split('|').join('\\\\|')", to: 'return String(value)' },
  { id: 'mutant-naive-split', guards: 'quotedComma', why: '把引号感知的解析降级成朴素 split',
    from: "if (ch === '\"') { quoted = true; touched = true; i += 1; continue; }", to: '' },
  { id: 'mutant-quadratic-width', guards: 'cellVisitsExact', why: '把量宽挪进渲染循环（平方复杂度）',
    from: '      cellVisits += 1;\n      const v = cells[c];', to: '      cellVisits += 1 + rows.length;\n      const v = cells[c];' },
  { id: 'mutant-detect-quote-blind', guards: 'detectQuoteAware', why: '让分隔符探测器不认引号',
    from: '    if (quoted) continue;', to: '' },
];

for (const m of MUTANTS) {
  check(m.id, 'mutant', `变异体：${m.why} → ${m.guards} 必须红`, async () => {
    ok(ENGINE_SRC.includes(m.from), `变异体的锚点在源码里找不到,这时候说谎的是夹具，不是产品`);
    const mutated = ENGINE_SRC.replace(m.from, m.to);
    ok(mutated !== ENGINE_SRC, '替换没有真的发生：那会得到一份和原文相同的「变异体」，它当然活下来');
    const url = 'data:text/javascript;base64,' + Buffer.from(mutated, 'utf8').toString('base64');
    let mod;
    try { mod = await import(url); }
    catch (err) { return; } // 改坏到语法/加载都过不去，同样算被抓住
    let survived = false;
    try { B[m.guards](mod); survived = true; } catch { /* 被抓住了，正是期望 */ }
    ok(!survived, `变异体活下来了：${m.guards} 这条断言是装饰，不承重`);
  });
}

// ===========================================================================
// 跑
// ===========================================================================
const results = [];
for (const c of checks) {
  try { await c.fn(); results.push({ ...c, fn: undefined, pass: true }); }
  catch (err) { results.push({ ...c, fn: undefined, pass: false, detail: err.message }); }
}

const failed = results.filter((r) => !r.pass);
const lines = [];
lines.push(`CSV → Markdown 闸门：${results.length - failed.length}/${results.length} 通过`);
lines.push('');
for (const kind of ['behavior', 'structure', 'mutant']) {
  const group = results.filter((r) => r.kind === kind);
  lines.push(`[${kind}] ${group.filter((g) => g.pass).length}/${group.length}`);
  for (const r of group) lines.push(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.id}  ${r.name}`);
  lines.push('');
}
if (facts.length) {
  lines.push('实测值：');
  for (const f of facts) lines.push(`  ${f.label}: ${f.value}`);
  lines.push('');
}
if (failed.length) {
  lines.push('失败详情（按依赖顺序，前面的失败会连带后面一片）：');
  for (const r of failed) lines.push(`\n  ✗ ${r.id} — ${r.name}\n    ${r.detail.split('\n').join('\n    ')}`);
  lines.push('');
}
const text = lines.join('\n');
console.log(text);

mkdirSync(join(ROOT, 'artifacts'), { recursive: true });
writeFileSync(join(ROOT, 'artifacts/report.json'), JSON.stringify({
  gate: 'fast', total: results.length, passed: results.length - failed.length,
  byKind: Object.fromEntries(['behavior', 'structure', 'mutant'].map((k) => {
    const g = results.filter((r) => r.kind === k);
    return [k, { total: g.length, passed: g.filter((x) => x.pass).length }];
  })),
  facts, results,
}, null, 2));
writeFileSync(join(ROOT, 'artifacts/stdout-fast.log'), text);

process.exit(failed.length ? 1 : 0);
