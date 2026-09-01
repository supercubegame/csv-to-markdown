// DOM 外壳。所有逻辑都在 engine.mjs 里，这里只搬数据。
// 元素一律用稳定 id，断言认 id 不认显示名 —— 这样改文案是响亮的，不是承重的。
import { convert, snapshot } from './engine.mjs';

const $ = (id) => document.getElementById(id);
let last = null;

// 只读诊断出口。闸门通过它读真实状态，字段可以增加，不许删改。
window.__diag = () => (last ? snapshot(last) : null);

function buildPreview(result) {
  const table = $('preview');
  table.replaceChildren();
  if (result.rowCount === 0) return;
  const rows = result.rows;
  const body = result.header ? rows.slice(1) : rows;
  const head = result.header ? rows[0] : new Array(result.colCount).fill('');

  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (let c = 0; c < result.colCount; c += 1) {
    const th = document.createElement('th');
    th.textContent = head[c] === undefined ? '' : head[c];
    th.style.textAlign = result.align;
    htr.appendChild(th);
  }
  thead.appendChild(htr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const r of body) {
    const tr = document.createElement('tr');
    for (let c = 0; c < result.colCount; c += 1) {
      const td = document.createElement('td');
      // textContent，不是 innerHTML：单元格内容是数据，不是标记。
      td.textContent = r[c] === undefined ? '' : r[c];
      td.style.textAlign = result.align;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
}

function render() {
  const result = convert($('csv-in').value, {
    delimiter: $('delimiter').value,
    header: $('header-on').checked,
    align: $('align').value,
  });
  last = result;

  $('md-out').value = result.markdown;
  $('row-count').textContent = result.rowCount > 0
    ? `${result.rowCount} 行 × ${result.colCount} 列`
    : '还没有可识别的数据';
  $('delim-shown').textContent = { ',': '逗号', ';': '分号', '\t': '制表符' }[result.delimiter] || result.delimiter;

  // 给不出的结果不能读起来像干净的一遍：警告要明确出现，不许静默。
  $('warnings').textContent = result.warnings.join('；');
  $('warnings').hidden = result.warnings.length === 0;

  buildPreview(result);
  $('copy').disabled = result.markdown === '';
}

for (const id of ['csv-in', 'delimiter', 'header-on', 'align']) {
  $(id).addEventListener('input', render);
  $(id).addEventListener('change', render);
}

$('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('md-out').value);
    $('copy').textContent = '已复制';
  } catch {
    $('md-out').select();
    $('copy').textContent = '复制失败，已选中，请按 Ctrl+C';
  }
  setTimeout(() => { $('copy').textContent = '复制 Markdown'; }, 1600);
});

$('sample').addEventListener('click', () => {
  $('csv-in').value = '商品,数量,单价\n"苹果, 红富士",12,4.50\n香蕉,3,2.10\n"备注: a|b",1,0';
  render();
});

render();
