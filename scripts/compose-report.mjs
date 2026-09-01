#!/usr/bin/env node
// 把各条闸门的 report.json 合成一条 PR / commit 评论。
// 契约（由 supercubegame/ci-workflows 定）：
//   node scripts/compose-report.mjs reports        写出 comment.md
//   node scripts/compose-report.mjs reports --check 不写文件，只用退出码表示成败
//
// 判断标准只有一个：**只看那条评论，能不能定位到根因？** 不能就补。

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] || 'reports';
const checkOnly = process.argv.includes('--check');

// 登记表即期望：闸门名单从 manifest.json 来，多一条少一条都要看得见。
const EXPECTED = existsSync('manifest.json')
  ? JSON.parse(readFileSync('manifest.json', 'utf8')).gates
  : ['fast', 'web'];

const found = new Map();
const logs = [];
if (existsSync(dir)) {
  for (const sub of readdirSync(dir)) {
    const base = join(dir, sub);
    if (!statSync(base).isDirectory()) continue;
    for (const f of readdirSync(base)) {
      if (f === 'report.json') {
        try {
          const r = JSON.parse(readFileSync(join(base, f), 'utf8'));
          found.set(r.gate, r);
        } catch (err) { logs.push(`${sub}/report.json 解析失败：${err.message}`); }
      }
      if (f.startsWith('stdout-') && f.endsWith('.log')) logs.push(join(base, f));
    }
  }
}

const missing = EXPECTED.filter((g) => !found.has(g));
const unexpected = [...found.keys()].filter((g) => !EXPECTED.includes(g));

if (checkOnly) {
  let rc = 0;
  if (missing.length) { console.log(`没有产出报告的闸门：${missing.join(', ')}`); rc = 1; }
  if (unexpected.length) { console.log(`出现了未登记的闸门：${unexpected.join(', ')}（登记表即期望）`); rc = 1; }
  for (const [g, r] of found) {
    if (r.passed !== r.total) { console.log(`${g}: ${r.passed}/${r.total} 通过`); rc = 1; }
  }
  process.exit(rc);
}

const total = [...found.values()].reduce((n, r) => n + r.total, 0);
const passed = [...found.values()].reduce((n, r) => n + r.passed, 0);
const allGreen = missing.length === 0 && unexpected.length === 0 && total === passed && total > 0;

const out = [];
out.push(`## ${allGreen ? '✅' : '❌'} CSV → Markdown 闸门：${passed}/${total} 通过`);
out.push('');

if (missing.length) {
  out.push(`> ⚠️ **这些闸门一条报告都没产出：${missing.join(', ')}** —— 去看 workflow，不是看闸门。`);
  out.push('> 「没有产出报告」只说明监控坏了，不说明为什么。');
  out.push('');
}
if (unexpected.length) {
  out.push(`> ⚠️ **出现了未登记的闸门：${unexpected.join(', ')}** —— 登记表即期望，要么登记它，要么删掉它。`);
  out.push('');
}

out.push('| 闸门 | 通过 | 明细 |');
out.push('| --- | --- | --- |');
for (const g of EXPECTED) {
  const r = found.get(g);
  if (!r) { out.push(`| \`${g}\` | — | **报告缺失** |`); continue; }
  const detail = Object.entries(r.byKind || {})
    .map(([k, v]) => `${k} ${v.passed}/${v.total}`).join(' · ') || '—';
  out.push(`| \`${g}\` | ${r.passed}/${r.total} | ${detail} |`);
}
out.push('');

const facts = [...found.values()].flatMap((r) => r.facts || []);
if (facts.length) {
  out.push('<details><summary>实测值（这些是量出来的，不是拍的）</summary>');
  out.push('');
  for (const f of facts) out.push(`- ${f.label}: \`${f.value}\``);
  out.push('');
  out.push('</details>');
  out.push('');
}

const failures = [...found.values()].flatMap((r) => (r.results || [])
  .filter((x) => !x.pass).map((x) => ({ ...x, gate: r.gate })));
if (failures.length) {
  out.push(`### 失败的 ${failures.length} 条`);
  out.push('');
  for (const f of failures) {
    out.push(`**\`${f.gate}\` / \`${f.id}\`** — ${f.name}`);
    out.push('');
    out.push('```');
    out.push(String(f.detail || '(没有细节 —— 这本身是个问题，报告必须自带证据)').slice(0, 2000));
    out.push('```');
    out.push('');
  }
}

// 红了就把闸门的原始输出贴出来。CI 的运行日志我读不到，这条通道我读得到。
// 这一步**不是断言**,别让它的失败掩盖真正的失败。
if (!allGreen) {
  for (const log of logs.filter((l) => typeof l === 'string' && l.endsWith('.log'))) {
    try {
      const tail = readFileSync(log, 'utf8').split('\n').slice(-60).join('\n');
      out.push(`<details><summary>${log} 末尾 60 行</summary>`);
      out.push('');
      out.push('```');
      out.push(tail);
      out.push('```');
      out.push('');
      out.push('</details>');
      out.push('');
    } catch { /* 贴日志失败不许掩盖真正的失败 */ }
  }
}

const sha = String(process.env.GITHUB_SHA || '').slice(0, 7);
const runId = process.env.GITHUB_RUN_ID || 'local';
// 提交 SHA 与 run id 都要在正文里：幂等写入的审计必须钉在本次运行上，
// 「存在一条带 marker 的评论」是这类假绿的经典形状。
out.push(`<sub>提交 \`${sha}\` · run \`${runId}\`</sub>`);
out.push('');

writeFileSync('comment.md', out.join('\n'));
console.log(`comment.md 已写出（${passed}/${total}）`);
