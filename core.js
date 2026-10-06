/* Pure calculations and validation. Shared by the browser and Node checks. */
(function (root) {
  'use strict';
  const VERSION = 1;
  const MAX_RECORDS = 100000;
  const MAX_CENTS = 10000000000000;
  const fields = [
    ['cash', '现金 / 活期', '元'], ['wealth', '理财', '元'],
    ['provident', '公积金', '元'], ['shares', '金山办公持股', '股'],
    ['shortDebt', '信用卡等短期负债', '元'], ['otherAssets', '其他资产', '元'],
    ['otherDebt', '其他负债', '元'], ['unvested', '待归属股票', '股']
  ];
  const salaryCategories = new Set(['工资薪水', '工资收入', '加班收入']);
  const types = new Set(['收入', '支出', '转账', '借贷']);
  const currencies = new Set(['人民币', 'CNY', 'RMB', '￥', '¥']);
  const keysExactly = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
  function fail(message) { throw new Error(message); }
  function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(value + 'T00:00:00Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value && value >= '1900-01-01' && value <= '2100-12-31';
  }
  function dateOnly(value, date1904 = false) {
    if (typeof value === 'number') {
      // Excel's fictitious 1900-02-29 (serial 60) is not a valid civil date.
      if (!Number.isFinite(value) || (!date1904 && Math.floor(value) === 60)) fail('日期值无效');
      const days = Math.floor(value);
      value = new Date(Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 31) + (date1904 ? days : days > 60 ? days - 1 : days) * 86400000).toISOString().slice(0, 10);
    }
    const match = String(value ?? '').trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/);
    if (!match) fail('日期格式无法识别');
    const date = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
    if (!validDate(date)) fail('日期值无效');
    return date;
  }
  function cents(value, signed = true) {
    const string = String(value ?? '').trim().replace(/[,，]/g, '');
    if (!/^-?\d+(?:\.\d+)?$/.test(string)) fail('金额必须是数字');
    const number = Number(string);
    const result = Math.round(number * 100);
    if (!Number.isSafeInteger(result) || Math.abs(result) > MAX_CENTS || (!signed && result < 0)) fail('金额超出范围');
    if (Math.abs(number * 100 - result) > 0.0001) fail('金额最多保留两位小数');
    return result;
  }
  function parseRows(rows, date1904 = false) {
    const expected = ['日期时间', '类型', '类别', '金额', '币种'];
    const headerIndex = rows.findIndex((row, i) => i < 50 && expected.every(name => row.some(cell => String(cell).trim() === name)));
    if (headerIndex < 0) fail('未找到挖财表头：需要“日期时间、类型、类别、金额、币种”。请使用挖财账单明细 .xlsx 导出。');
    const headers = rows[headerIndex].map(cell => String(cell).trim());
    if (expected.some(name => headers.filter(h => h === name).length !== 1)) fail('表头重复，无法确定对应列。');
    const index = Object.fromEntries(expected.map(name => [name, headers.indexOf(name)]));
    const transactions = [];
    for (let i = headerIndex + 1; i < rows.length; i++) {
      const row = rows[i];
      if (row.every(cell => cell == null || String(cell).trim() === '')) continue;
      try {
        const type = String(row[index['类型']] ?? '').trim();
        const category = String(row[index['类别']] ?? '').trim();
        const currency = String(row[index['币种']] ?? '').trim();
        if (!types.has(type)) fail(`未知交易类型“${type || '空值'}”`);
        if (!currencies.has(currency)) fail(`暂不支持币种“${currency || '空值'}”，不能直接折算成人民币`);
        if (!category || category.length > 200) fail('类别为空或过长');
        transactions.push({ date: dateOnly(row[index['日期时间']], date1904), type, category, amount: cents(row[index['金额']]), currency: 'CNY' });
        if (transactions.length > MAX_RECORDS) fail('交易笔数超过 100,000 笔');
      } catch (error) { fail(`第 ${i + 1} 行：${error.message}。本次未导入，原数据保留。`); }
    }
    if (!transactions.length) fail('表中没有有效交易记录。');
    summarize(transactions);
    return transactions;
  }
  function parseWorkbook(workbook, XLSX) {
    const candidates = [];
    for (const name of workbook.SheetNames) {
      const sheet = workbook.Sheets[name];
      const ref = sheet['!ref'];
      if (!ref) continue;
      const range = XLSX.utils.decode_range(ref);
      if (range.e.r > MAX_RECORDS + 100 || range.e.c > 100) fail('工作表范围过大，最多支持 100,000 笔、101 列。');
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '', blankrows: true });
      if (rows.slice(0, 50).some(row => ['日期时间', '类型', '类别', '金额', '币种'].every(h => row.some(c => String(c).trim() === h)))) candidates.push(rows);
    }
    if (candidates.length > 1) fail('发现多个账单明细工作表，请只保留需要导入的一个，避免重复统计。');
    if (!candidates.length) fail('未找到挖财账单明细表；需要“日期时间、类型、类别、金额、币种”五列。');
    return parseRows(candidates[0], Boolean(workbook.Workbook?.WBProps?.date1904));
  }
  function summarize(transactions) {
    const years = new Map();
    let start = null, end = null, total = 0, excluded = 0;
    for (const t of transactions) {
      if (!start || t.date < start) start = t.date;
      if (!end || t.date > end) end = t.date;
      const year = t.date.slice(0, 4);
      if (!years.has(year)) years.set(year, { year, salary: 0, bonus: 0, total: 0 });
      const bucket = years.get(year);
      const leaf = t.category.split('/').at(-1).trim();
      if (t.type === '收入' && t.currency === 'CNY' && (salaryCategories.has(leaf) || leaf === '奖金')) {
        bucket[leaf === '奖金' ? 'bonus' : 'salary'] += t.amount;
        bucket.total += t.amount;
        total += t.amount;
        if (![bucket.total, bucket.salary, bucket.bonus, total].every(Number.isSafeInteger)) fail('汇总金额超出可精确计算范围');
      } else excluded++;
    }
    return { years: [...years.values()].sort((a, b) => a.year.localeCompare(b.year)), start, end, total, count: transactions.length, excluded };
  }
  function emptyState() { return { version: VERSION, ledger: null, snapshot: null, quote: { mode: 'auto', manual: null, automatic: null } }; }
  function isTime(value) { return typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)); }
  function validateState(raw) {
    if (!keysExactly(raw, ['version', 'ledger', 'snapshot', 'quote']) || raw.version !== VERSION) fail('备份格式或版本不受支持');
    if (raw.ledger !== null) {
      const l = raw.ledger;
      if (!keysExactly(l, ['importedAt', 'transactions']) || !isTime(l.importedAt) || !Array.isArray(l.transactions) || !l.transactions.length || l.transactions.length > MAX_RECORDS) fail('账本备份无效');
      for (const t of l.transactions) {
        if (!keysExactly(t, ['date', 'type', 'category', 'amount', 'currency']) || !validDate(t.date) || !types.has(t.type) || typeof t.category !== 'string' || !t.category.trim() || t.category.length > 200 || !Number.isSafeInteger(t.amount) || Math.abs(t.amount) > MAX_CENTS || t.currency !== 'CNY') fail('账本交易格式无效');
      }
      summarize(l.transactions);
    }
    if (raw.snapshot !== null) {
      const s = raw.snapshot;
      if (!keysExactly(s, ['savedAt', 'values']) || !isTime(s.savedAt) || !keysExactly(s.values, fields.map(f => f[0]))) fail('资产快照格式无效');
      for (const [key, , unit] of fields) {
        const value = s.values[key];
        if (value !== null && (!Number.isSafeInteger(value) || value < 0 || value > (unit === '股' ? 1000000000 : MAX_CENTS))) fail('资产数值无效');
      }
    }
    const q = raw.quote;
    if (!keysExactly(q, ['mode', 'manual', 'automatic']) || !['auto', 'manual'].includes(q.mode)) fail('行情格式无效');
    for (const key of ['manual', 'automatic']) {
      const p = q[key];
      if (p !== null && (!keysExactly(p, ['price', 'at']) || !Number.isSafeInteger(p.price) || p.price <= 0 || p.price > 100000000 || !isTime(p.at))) fail('股价格式无效');
    }
    if (q.mode === 'manual' && q.manual === null) fail('手动股价缺失');
    return JSON.parse(JSON.stringify(raw));
  }
  function activeQuote(state) { return state.quote.mode === 'manual' ? state.quote.manual : state.quote.automatic; }
  function assets(state) {
    if (!state.snapshot) return null;
    const values = state.snapshot.values;
    const price = activeQuote(state)?.price ?? null;
    const stock = values.shares === 0 ? 0 : values.shares === null || price === null ? null : values.shares * price;
    const items = [['cash', values.cash], ['wealth', values.wealth], ['provident', values.provident], ['shares', stock], ['otherAssets', values.otherAssets], ['shortDebt', values.shortDebt === null ? null : -values.shortDebt], ['otherDebt', values.otherDebt === null ? null : -values.otherDebt]];
    const filled = items.filter(([, value]) => value !== null);
    const total = filled.reduce((sum, [, value]) => sum + value, 0);
    if (!Number.isSafeInteger(total) || (stock !== null && !Number.isSafeInteger(stock))) fail('资产合计超出可精确计算范围');
    return { total, stock, items, partial: filled.length !== items.length, any: filled.length > 0, unvested: values.unvested };
  }
  function parseQuote(payload, now = Date.now()) {
    const data = payload?.data;
    if (payload?.rc !== 0 || data?.f57 !== '688111' || !Number.isInteger(data.f43) || data.f43 <= 0 || data.f43 > 100000000 || !Number.isInteger(data.f86) || data.f86 < 946684800 || data.f86 * 1000 > now + 300000) fail('行情数据不可用');
    return { price: data.f43, at: new Date(data.f86 * 1000).toISOString() };
  }
  const api = { VERSION, fields, emptyState, cents, dateOnly, parseRows, parseWorkbook, summarize, validateState, activeQuote, assets, parseQuote };
  root.FinanceCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
