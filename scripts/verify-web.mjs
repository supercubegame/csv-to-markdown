#!/usr/bin/env node
// 慢闸门：无头浏览器驱动真实页面，做真实输入，断言真实 DOM 与剪贴板。
//
// **这把尺子的期望值是手写的字面量，不是 engine 算出来的。** 两个闸门读同一个
// oracle 的话，引擎一旦错，两边会一起错而且错得完全一致,报告看起来像「两个
// 独立闸门都同意了」，实际只有一个真值来源。

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

// 手写的承重夹具。engine 没有参与生成它。
const FIXTURE_CSV = 'name,qty\napple,3\npear,12';
const FIXTURE_MD = [
  '| name  | qty  |',
  '| :---- | :--- |',
  '| apple | 3    |',
  '| pear  | 12   |',
].join('\n');

const server = createServer(async (req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  const file = join(ROOT, p === '/' ? 'index.html' : p.replace(/^\/+/, ''));
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end('not found'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

const { chromium } = await import('playwright');
const browser = await chromium.launch();
const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
const page = await context.newPage();

const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`console.error: ${m.text()}`); });

await page.goto(BASE, { waitUntil: 'load' });

const checks = [];
const facts = [];
class Fail extends Error {}
const eq = (a, e, what) => {
  const A = JSON.stringify(a); const E = JSON.stringify(e);
  if (A !== E) throw new Fail(`${what}\n    期望 ${E}\n    实际 ${A}`);
};
const ok = (c, what) => { if (!c) throw new Fail(what); };
const check = (id, name, fn) => checks.push({ id, kind: 'web', name, fn });
const diag = () => page.evaluate(() => window.__diag());
const type = async (csv) => {
  await page.fill('#csv-in', csv);
  // 轮询驱动，不睡固定时间。返回布尔,返回计数的话 0 会被当成「还没成立」等到超时。
  await page.waitForFunction((n) => {
    const d = window.__diag();
    return Boolean(d && d.rowCount === n);
  }, csv.trim() === '' ? 0 : csv.split('\n').length);
};
const shot = async (name) => {
  const buf = await page.locator('#preview').screenshot();
  await mkdir(join(ROOT, 'artifacts'), { recursive: true });
  await writeFile(join(ROOT, `artifacts/${name}.png`), buf);
  return { bytes: buf.length, sha: createHash('sha256').update(buf).digest('hex').slice(0, 16) };
};

check('empty-state', '空状态：输出为空、预览零行、复制按钮禁用', async () => {
  await type('');
  eq(await page.inputValue('#md-out'), '', '空输入不许产出任何 Markdown');
  eq(await page.locator('#preview tr').count(), 0, '空输入不许渲染表格行');
  eq(await page.locator('#copy').isDisabled(), true, '没内容可复制时按钮要禁用');
  ok(!(await page.inputValue('#md-out')).includes(':---'), '空输入不许留下孤立的分隔行');
  eq((await diag()).rowCount, 0, '诊断出口也要说 0 行');
});

check('typed-exact', '真实输入后，输出逐字等于手写夹具', async () => {
  await type(FIXTURE_CSV);
  eq(await page.inputValue('#md-out'), FIXTURE_MD, '页面产出的 Markdown 与手写夹具不一致');
});

check('dom-counts-exact', '预览表的节点数是等号，不是范围', async () => {
  await type(FIXTURE_CSV);
  eq(await page.locator('#preview thead th').count(), 2, '表头单元格');
  eq(await page.locator('#preview tbody tr').count(), 2, '数据行');
  eq(await page.locator('#preview tbody td').count(), 4, '数据单元格 = 行 × 列');
});

check('cell-is-data-not-markup', '单元格内容当数据渲染，不当标记', async () => {
  await type('h1,h2\n<b>x</b>,2');
  eq(await page.locator('#preview b').count(), 0, '单元格里的标签被当成 HTML 解析了');
  eq(await page.locator('#preview tbody td').first().textContent(), '<b>x</b>', '标签文本必须原样显示');
});

check('align-changes-output', '换对齐方式，输出跟着变（比差值，不比绝对值）', async () => {
  await type(FIXTURE_CSV);
  const before = await page.inputValue('#md-out');
  await page.selectOption('#align', 'right');
  await page.waitForFunction(() => Boolean(window.__diag()) && window.__diag().align === 'right');
  const after = await page.inputValue('#md-out');
  ok(after !== before, '换了对齐方式而输出一个字都没变');
  ok(after.split('\n')[1].includes('---:'), '右对齐的分隔行要以 ---: 结尾');
  await page.selectOption('#align', 'left');
});

check('delimiter-override', '手动指定分隔符真的会覆盖自动识别', async () => {
  await type('a,b,c\n1,2,3');
  eq((await diag()).colCount, 3, '自动识别应得 3 列');
  await page.selectOption('#delimiter', ';');
  await page.waitForFunction(() => window.__diag().delimiter === ';');
  eq((await diag()).colCount, 1, '强制用分号切一份逗号 CSV，应该只剩 1 列 —— 覆盖没生效的话这里还是 3');
  await page.selectOption('#delimiter', 'auto');
});

check('warning-surfaces', '警告真的显示出来（含负向孪生）', async () => {
  await type('a,b,c\nd\ne,f');
  eq(await page.locator('#warnings').isHidden(), false, '列数不齐时警告必须可见');
  ok((await page.textContent('#warnings')).includes('列数不一致'), '警告文案');
  await type(FIXTURE_CSV);
  eq(await page.locator('#warnings').isHidden(), true, '干净的输入不许挂着警告 —— 这是负向那侧');
});

check('clipboard-roundtrip', '复制按钮真的写进了剪贴板（验最终产物，不验接口被调用）', async () => {
  await type(FIXTURE_CSV);
  await page.click('#copy');
  await page.waitForFunction(() => document.getElementById('copy').textContent === '已复制');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  eq(clip, FIXTURE_MD, '剪贴板里的内容与手写夹具不一致');
});

check('cjk-font-available', '运行环境真的装了中日韩字体', async () => {
  const has = await page.evaluate(() =>
    document.fonts.check('15px "Noto Sans CJK SC"') || document.fonts.check('15px "Noto Sans CJK JP"'));
  ok(has, 'runner 不带中日韩字体，界面上的中文会渲染成方块 —— 装 fonts-noto-cjk');
});

check('screenshot-differs', '截图：空状态与填充状态必须是两张不同的图', async () => {
  await type('');
  const empty = await shot('shot-empty');
  await type(FIXTURE_CSV);
  const filled = await shot('shot-filled');
  ok(empty.sha !== filled.sha, '两个状态的截图哈希相同,说明画面根本没更新');
  ok(filled.bytes > 0 && empty.bytes > 0, '截图字节数为 0');
  facts.push({ label: '截图实测字节数（空 / 填充，未设阈值）', value: `${empty.bytes} / ${filled.bytes}` });
  facts.push({ label: '截图哈希前 16 位（空 / 填充）', value: `${empty.sha} / ${filled.sha}` });
});

const results = [];
for (const c of checks) {
  try { await c.fn(); results.push({ id: c.id, kind: c.kind, name: c.name, pass: true }); }
  catch (err) { results.push({ id: c.id, kind: c.kind, name: c.name, pass: false, detail: err.message }); }
}

// 页面报错单独算一条，放最后 —— 前面的操作跑完才知道整场有没有报错。
results.push(consoleErrors.length === 0
  ? { id: 'console-clean', kind: 'web', name: '整场没有页面报错', pass: true }
  : { id: 'console-clean', kind: 'web', name: '整场没有页面报错', pass: false, detail: consoleErrors.join('\n') });

await browser.close();
server.close();

const failed = results.filter((r) => !r.pass);
const lines = [`浏览器闸门：${results.length - failed.length}/${results.length} 通过`, ''];
for (const r of results) lines.push(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.id}  ${r.name}`);
lines.push('');
if (facts.length) { lines.push('实测值：'); for (const f of facts) lines.push(`  ${f.label}: ${f.value}`); lines.push(''); }
if (failed.length) {
  lines.push('失败详情：');
  for (const r of failed) lines.push(`\n  ✗ ${r.id} — ${r.name}\n    ${r.detail.split('\n').join('\n    ')}`);
}
const text = lines.join('\n');
console.log(text);

await mkdir(join(ROOT, 'artifacts'), { recursive: true });
await writeFile(join(ROOT, 'artifacts/report.json'), JSON.stringify({
  gate: 'web', total: results.length, passed: results.length - failed.length,
  byKind: { web: { total: results.length, passed: results.length - failed.length } },
  facts, results,
}, null, 2));
await writeFile(join(ROOT, 'artifacts/stdout-web.log'), text);

process.exit(failed.length ? 1 : 0);
