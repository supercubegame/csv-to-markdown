// CSV → Markdown 表格：纯核心。
//
// 铁律（同时写在 AGENTS.md）：这个文件不读文件、不碰 DOM、不发网络请求、
// 不用系统时间、不用未播种的随机。有一条扫描器在守，它只看可执行代码
// （先剥注释和字符串再找），所以注释里出现 document 这个词不会误报。
//
// 改这里必须跑 npm run verify。

export const ALIGNMENTS = ['left', 'center', 'right'];

export const DELIMITER_CHARS = { comma: ',', semicolon: ';', tab: '\t' };

const ALIGN_RULE = { left: ':---', center: ':---:', right: '---:' };

// 分隔符探测**必须是引号感知的**：引号里的分号是数据，不是结构。
// 这一条有负向孪生守着（一个逗号 CSV，某个被引号包住的字段里塞了 6 个分号），
// 也有变异体守着（把引号跳过那一段拆掉，那条断言必须红）。
export function detectDelimiter(text) {
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') { i += 1; continue; }
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (Object.prototype.hasOwnProperty.call(counts, ch)) counts[ch] += 1;
  }
  let best = ',';
  for (const ch of [',', ';', '\t']) {
    if (counts[ch] > counts[best]) best = ch;
  }
  return counts[best] === 0 ? ',' : best;
}

// RFC4180 单遍扫描：引号内的分隔符、换行、以及 "" 转义都算数据。
// charsScanned 只是一个诚实的计量口（报告里带出来），不是复杂度断言 ——
// 单遍扫描下它恒等于 text.length，也就是说拿它当断言是空的。
// 真正守结构的那条在 toMarkdown 的 cellVisits 上。
export function parseCsv(text, delimiter = ',') {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let touched = false;
  let scanned = 0;
  const n = text.length;
  let i = 0;

  while (i < n) {
    const ch = text[i];
    scanned += 1;

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; scanned += 1; continue; }
        quoted = false; i += 1; continue;
      }
      field += ch; i += 1; continue;
    }

    if (ch === '"') { quoted = true; touched = true; i += 1; continue; }

    if (ch === delimiter) { row.push(field); field = ''; touched = true; i += 1; continue; }

    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') { i += 1; scanned += 1; }
      row.push(field);
      rows.push(row);
      row = []; field = ''; touched = false;
      i += 1; continue;
    }

    field += ch; touched = true; i += 1;
  }

  if (touched || field !== '' || row.length > 0) { row.push(field); rows.push(row); }

  return { rows, unterminatedQuote: quoted, stats: { charsScanned: scanned } };
}

// 单元格里的 | 会把表格结构劈开，换行会把一行劈成两行。两个都要转义。
export function escapeCell(value) {
  return String(value).split('|').join('\\|').replace(/\r\n|\r|\n/g, '<br>');
}

// 列宽下限就是对齐标记本身的长度，否则分隔行会比数据行宽,
// 这两个是一组耦合参数（改 ALIGN_RULE 必须重算下限），有等号断言守着。
// 宽度**故意分成独立的一遍**量完，第二遍只渲染，不许再算宽度。
// cellVisits 恒等于 行数 × 列数 × 2 是一条等号断言：谁把量宽挪进渲染循环
// （那是平方复杂度的经典写法），这个数当场对不上。三条数据和三万条数据在
// 计时上看不出区别，在这个数上看得出来。
export function toMarkdown(rows, options = {}) {
  const header = options.header !== false;
  const align = ALIGNMENTS.includes(options.align) ? options.align : 'left';

  if (rows.length === 0) {
    return { markdown: '', colCount: 0, lineCount: 0, stats: { cellVisits: 0 } };
  }

  let colCount = 0;
  for (const r of rows) if (r.length > colCount) colCount = r.length;

  let cellVisits = 0;
  const widths = new Array(colCount).fill(ALIGN_RULE[align].length);
  const grid = rows.map((r) => {
    const out = new Array(colCount);
    for (let c = 0; c < colCount; c += 1) {
      cellVisits += 1;
      const v = escapeCell(r[c] === undefined ? '' : r[c]);
      out[c] = v;
      const w = [...v].length;
      if (w > widths[c]) widths[c] = w;
    }
    return out;
  });

  const renderRow = (cells) => {
    const parts = new Array(colCount);
    for (let c = 0; c < colCount; c += 1) {
      cellVisits += 1;
      const v = cells[c];
      parts[c] = v + ' '.repeat(Math.max(0, widths[c] - [...v].length));
    }
    return '| ' + parts.join(' | ') + ' |';
  };

  const body = header ? grid.slice(1) : grid;
  const headCells = header ? grid[0] : new Array(colCount).fill('');
  if (!header) cellVisits += colCount; // 补出来的空表头也走一遍渲染，等号才成立

  const rule = '| ' + widths
    .map((w) => {
      const r = ALIGN_RULE[align];
      const dashes = Math.max(0, w - r.length);
      return align === 'right' ? '-'.repeat(dashes) + r : r + '-'.repeat(dashes);
    })
    .join(' | ') + ' |';

  const lines = [renderRow(headCells), rule, ...body.map(renderRow)];
  return { markdown: lines.join('\n'), colCount, lineCount: lines.length, stats: { cellVisits } };
}

export function convert(text, options = {}) {
  const wanted = options.delimiter;
  const delimiter = wanted && wanted !== 'auto' ? wanted : detectDelimiter(text);
  const parsed = parseCsv(text, delimiter);
  const md = toMarkdown(parsed.rows, options);

  const warnings = [];
  if (parsed.unterminatedQuote) warnings.push('有一个引号没闭合，最后一个字段可能不完整');
  if (parsed.rows.length > 0 && parsed.rows.some((r) => r.length !== md.colCount)) {
    warnings.push('各行列数不一致，短的行已用空单元格补齐');
  }

  return {
    markdown: md.markdown,
    rows: parsed.rows,
    rowCount: parsed.rows.length,
    colCount: md.colCount,
    lineCount: md.lineCount,
    delimiter,
    autoDetected: !wanted || wanted === 'auto',
    header: options.header !== false,
    align: ALIGNMENTS.includes(options.align) ? options.align : 'left',
    warnings,
    stats: { charsScanned: parsed.stats.charsScanned, cellVisits: md.stats.cellVisits },
  };
}

// 只读诊断出口。字段可以增加，不许删改 —— 闸门认这些名字，
// 一次重构把它们改掉就等于把闸门弄哑了（AGENTS.md 里有这条铁律）。
export function snapshot(result) {
  return {
    rowCount: result.rowCount,
    colCount: result.colCount,
    lineCount: result.lineCount,
    delimiter: result.delimiter,
    align: result.align,
    header: result.header,
    warningCount: result.warnings.length,
    charsScanned: result.stats.charsScanned,
    cellVisits: result.stats.cellVisits,
  };
}
