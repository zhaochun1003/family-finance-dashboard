const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');
const XLSX = require('../vendor/xlsx.full.min.js');
const header = ['日期时间', '类型', '类别', '金额', '币种'];
const sample = [
  ['虚构测试数据'], header,
  ['2025-01-02 09:00:00', '收入', '工资薪水', 1000, '人民币'],
  ['2025-01-03 09:00:00', '收入', '奖金', 100, '人民币'],
  ['2025-01-04', '转账', '工资薪水', 700, '人民币'],
  ['2025-01-05', '收入', '退款返款', 25, '人民币'],
  ['2025-01-06', '收入', '漏记款', 90, '人民币'],
  ['2025-01-07', '收入', '公积金', 50, '人民币'],
  ['2025-01-08', '支出', '信用卡还款', 700, '人民币'],
  ['2026-02-01', '收入', '工资收入', 2000.01, '人民币'],
  ['2026-02-02', '收入', '加班收入', -1.01, '人民币'],
  ['2026-02-03', '借贷', '借款', 100, '人民币']
];
test('salary and bonus exclude transfers, repayment, refunds and adjustments; cents stay exact', () => {
  const records = C.parseRows(sample), summary = C.summarize(records);
  assert.equal(summary.count, 10); assert.equal(summary.total, 309900);
  assert.equal(summary.start, '2025-01-02'); assert.equal(summary.end, '2026-02-03');
  assert.deepEqual(summary.years.map(y => y.total), [110000, 199900]);
  assert.equal(summary.excluded, 6);
});
test('invalid rows fail with row number instead of silently dropping transactions', () => {
  assert.throws(() => C.parseRows([header, ['2025-02-30', '收入', '工资薪水', 1, '人民币']]), /第 2 行.*日期/);
  assert.throws(() => C.parseRows([header, ['2025-01-01', '未知', '工资薪水', 1, '人民币']]), /未知交易类型/);
  assert.throws(() => C.parseRows([header, ['2025-01-01', '收入', '工资薪水', 1, '美元']]), /币种/);
  assert.throws(() => C.parseRows([header, ['2025-01-01', '收入', '工资薪水', 'bad', '人民币']]), /金额/);
  assert.throws(() => C.parseRows([header]), /没有有效/);
});
test('Excel read path supports actual headers and rejects ambiguous sheets', () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sample), 'Sheet0');
  const read = XLSX.read(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  assert.equal(C.parseWorkbook(read, XLSX).length, 10);
  XLSX.utils.book_append_sheet(read, XLSX.utils.aoa_to_sheet(sample), 'Duplicate');
  assert.throws(() => C.parseWorkbook(read, XLSX), /多个/);
});
test('Excel serial and text dates preserve civil date and reject impossible dates', () => {
  assert.equal(C.dateOnly(46143.8), '2026-05-01');
  assert.equal(C.dateOnly('2026/1/2 12:30'), '2026-01-02');
  assert.equal(C.dateOnly(0, true), '1904-01-01');
  assert.throws(() => C.dateOnly(60), /日期/);
});
function exampleState() {
  const state = C.emptyState();
  state.ledger = { importedAt: '2026-01-01T00:00:00.000Z', transactions: C.parseRows(sample) };
  state.snapshot = { savedAt: '2026-01-01T00:00:00.000Z', values: Object.fromEntries(C.fields.map(([key]) => [key, 0])) };
  Object.assign(state.snapshot.values, { cash: 100000, shares: 10, unvested: 100, shortDebt: 20000 });
  state.quote.automatic = { price: 10000, at: '2026-01-01T00:00:00.000Z' };
  return state;
}
test('net assets deduct positive liabilities, exclude unvested shares, and mark unknown values', () => {
  const state = exampleState();
  assert.equal(C.assets(state).total, 180000); assert.equal(C.assets(state).partial, false);
  state.snapshot.values.cash = null; assert.equal(C.assets(state).partial, true);
  state.quote.automatic = null; assert.equal(C.assets(state).stock, null);
  state.snapshot.values.shares = 0; assert.equal(C.assets(state).stock, 0);
  assert.equal(C.assets(C.emptyState()), null);
});
test('backup round-trip, version, numbers, dates and extra keys validated', () => {
  const state = exampleState();
  assert.deepEqual(C.validateState(JSON.parse(JSON.stringify(state))), state);
  for (const mutate of [s => s.version = 99, s => s.snapshot.values.cash = -1, s => s.snapshot.values.shares = 1.5, s => s.ledger.transactions[0].amount = null, s => s.ledger.transactions[0].date = '2026-02-30', s => s.quote.mode = 'broken', s => s.quote.automatic.price = 0, s => s.extra = 'ignored']) {
    const copy = JSON.parse(JSON.stringify(state)); mutate(copy); assert.throws(() => C.validateState(copy));
  }
});
test('manual price persists when automatic quote changes', () => {
  const state = exampleState(); state.quote.mode = 'manual'; state.quote.manual = { price: 15000, at: '2026-01-01T00:00:00.000Z' };
  state.quote.automatic.price = 20000;
  assert.equal(C.assets(state).stock, 150000);
  state.quote.mode = 'auto'; assert.equal(C.assets(state).stock, 200000);
});
test('quote conversion validates stock identity, cents and timestamp', () => {
  const payload = { rc: 0, data: { f57: '688111', f43: 12345, f86: 1767225600 } };
  assert.equal(C.parseQuote(payload).price, 12345);
  assert.throws(() => C.parseQuote({ ...payload, data: { ...payload.data, f57: 'wrong' } }));
  assert.throws(() => C.parseQuote({ ...payload, data: { ...payload.data, f43: '-' } }));
});
