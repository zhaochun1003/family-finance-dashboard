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
test('version 1 backups migrate without losing ledger, snapshot or price', () => {
  const old = exampleState(); old.version = 1; delete old.tracking; delete old.history; delete old.accounts; delete old.notes; delete old.scenario;
  const next = C.validateState(old);
  assert.equal(next.version, 4); assert.equal(next.tracking, null);
  assert.deepEqual(next.ledger, old.ledger); assert.deepEqual(next.snapshot, old.snapshot);
});
function trackingState(rows) {
  const state = exampleState();
  state.snapshot.asOf = '2026-01-01T00:00:00.000Z';
  state.snapshot.values.cash = 100000; state.snapshot.values.shortDebt = 50000;
  state.tracking = { enabled: true, mappings: [{account:'测试银行卡',field:'cash'},{account:'测试信用卡',field:'shortDebt'},{account:'测试理财',field:'wealth'},{account:'测试股票',field:'stock'}] };
  state.ledger.transactions = C.parseRows([['日期时间','类型','类别','金额','币种','收付账户'], ...rows]);
  return state;
}
test('projection applies salary, card spending, repayment, refund and asset transfer once', () => {
  const state = trackingState([
    ['2026-01-01 07:59:59','收入','工资薪水',900,'人民币','测试银行卡'],
    ['2026-01-02 09:00:00','收入','工资薪水',100,'人民币','测试银行卡'],
    ['2026-01-02 10:00:00','支出','餐饮',20,'人民币','测试信用卡'],
    ['2026-01-02 11:00:00','转账','转账',50,'人民币','测试银行卡：-50.0，测试信用卡：+50.0'],
    ['2026-01-02 12:00:00','收入','退款返款',5,'人民币','测试信用卡'],
    ['2026-01-02 13:00:00','转账','转账',10,'人民币','测试银行卡：-10，测试理财：+10']
  ]);
  const p = C.project(state);
  assert.deepEqual(p.issues, []); assert.equal(p.applied, 5);
  assert.equal(p.values.cash,104000); assert.equal(p.values.shortDebt,46500); assert.equal(p.values.wealth,1000);
  assert.deepEqual(C.project(state).values,p.values); // Re-import starts from baseline, not prior projection.
  assert.equal(state.snapshot.values.cash,100000); // Baseline is immutable.
  state.ledger.transactions[1].amount=20000;
  assert.equal(C.project(state).values.cash,114000); // Corrected records replace previous effect.
});
test('projection pauses all balance changes for unknown accounts, shares, unbalanced transfers or loans', () => {
  for (const row of [
    ['2026-01-02 09:00:00','收入','工资薪水',100,'人民币','未分类账户'],
    ['2026-01-02 09:00:00','支出','投资',100,'人民币','测试股票'],
    ['2026-01-02 09:00:00','收入','股票',100,'人民币','测试银行卡'],
    ['2026-01-02 09:00:00','转账','转账',50,'人民币','测试银行卡：-50，测试信用卡：+40'],
    ['2026-01-02 09:00:00','借贷','借款',100,'人民币','测试银行卡'],
    ['2026-01-01','收入','工资薪水',100,'人民币','测试银行卡']
  ]) {
    const state=trackingState([['2025-12-31 10:00:00','收入','工资薪水',1,'人民币','测试银行卡'],row]);
    assert.ok(C.project(state).issues.length); assert.deepEqual(C.project(state).values,state.snapshot.values);
  }
});
test('account extraction and tracking settings validation', () => {
  const state=trackingState([['2026-01-01 07:00:00','转账','转账',1,'人民币','测试银行卡：-1，测试信用卡：+1']]);
  assert.deepEqual(new Set(C.ledgerAccounts(state.ledger.transactions)),new Set(['测试银行卡','测试信用卡']));
  state.tracking.mappings.push({...state.tracking.mappings[0]});
  assert.throws(()=>C.validateState(state),/分类/);
});

test('import preview counts duplicate rows as a multiset and replacements as add/remove', () => {
  const rows = C.parseRows(sample), a = rows[0], changed = { ...a, amount: a.amount + 1 };
  assert.deepEqual(C.ledgerDiff([a,a], [a,a]), {same:2,added:0,removed:0});
  assert.deepEqual(C.ledgerDiff([a,a], [a,changed]), {same:1,added:1,removed:1});
});
test('version 2 migration preserves personal state and initializes new sections', () => {
  const old=exampleState(); old.version=2; delete old.history; delete old.accounts; delete old.notes; delete old.scenario;
  const next=C.validateState(old); assert.equal(next.version,4);
  assert.deepEqual(next.history,[]); assert.equal(next.accounts.length,6); assert.deepEqual(next.snapshot,old.snapshot);
});
test('account reconciliation respects baseline, upper cutoff, debt and two-sided repayment', () => {
  const s=trackingState([
    ['2026-01-01 07:00:00','收入','工资薪水',999,'人民币','测试银行卡'],
    ['2026-01-02 09:00:00','收入','工资薪水',100,'人民币','测试银行卡'],
    ['2026-01-02 10:00:00','支出','餐饮',20,'人民币','测试信用卡'],
    ['2026-01-02 11:00:00','转账','转账',50,'人民币','测试银行卡：-50，测试信用卡：+50'],
    ['2026-01-03 10:00:00','收入','工资薪水',999,'人民币','测试银行卡']
  ]);
  const at='2026-01-02T04:00:00.000Z';
  const cash={account:'测试银行卡',debt:false,at:s.snapshot.asOf,balance:100000};
  const debt={account:'测试信用卡',debt:true,at:s.snapshot.asOf,balance:50000};
  assert.equal(C.reconcile(s,cash,105000,at).difference,0);
  assert.equal(C.reconcile(s,debt,47500,at).difference,500);
  assert.throws(()=>C.reconcile(s,cash,0,'2025-01-01T00:00:00Z'),/早于/);
  s.ledger.transactions.push({...s.ledger.transactions[1],at:null});
  assert.equal(C.reconcile(s,cash,0,at).expected,null);
});
test('history freezes valuation and validates malformed backups', () => {
  const s=exampleState(), entry=C.capture(s,s.snapshot);
  s.history.push(entry); s.quote.automatic.price=99999;
  assert.equal(s.history[0].total,180000); assert.equal(s.history[0].price,10000);
  assert.deepEqual(C.validateState(JSON.parse(JSON.stringify(s))),s);
  s.history[0].total++; assert.throws(()=>C.validateState(s),/不一致/);
  s.history[0].total--; s.history[0].values.cash=-1; assert.throws(()=>C.validateState(s));
});
test('account backup rejects duplicate account names and negative balances', () => {
  const s=exampleState(); const a={account:'虚构银行卡',debt:false,at:'2026-01-01T00:00:00Z',balance:10000,field:'cash',members:['虚构银行卡']};
  s.accounts=[a]; assert.deepEqual(C.validateState(s).accounts,[a]);
  s.accounts.push(a); assert.throws(()=>C.validateState(s));
  s.accounts=[{...a,balance:-1}]; assert.throws(()=>C.validateState(s));
});

test('v3 migration converts aggregate balances into authoritative accounts without changing totals',()=>{
  const old=exampleState();old.version=3;delete old.notes;delete old.scenario;
  const next=C.validateState(old);assert.equal(next.accounts.length,6);assert.equal(C.assets(next).total,C.assets(old).total);
  const cash=next.accounts.find(a=>a.field==='cash');
  const changed=C.saveAccount(next,{...cash,balance:200000});
  assert.equal(C.assets(changed).total-C.assets(next).total,100000);
  assert.equal(changed.snapshot.values.cash,100000); // Legacy snapshot is no longer a second source of cash.
});
test('complete group splitting preserves total and individual reconciliation updates aggregate',()=>{
  const s=exampleState();s.accounts=C.migrateAccounts(s);
  const group=s.accounts.find(a=>a.field==='cash');
  assert.throws(()=>C.splitAccount(s,group.account,[{account:'虚构账户A',balance:1}],group.at),/合计/);
  const next=C.splitAccount(s,group.account,[{account:'虚构账户A',balance:60000},{account:'虚构账户B',balance:40000}],group.at);
  assert.equal(C.assets(next).total,C.assets(s).total);
  const a=next.accounts.find(a=>a.account==='虚构账户A');const changed=C.saveAccount(next,{...a,balance:65000});
  assert.equal(C.project(changed).values.cash,105000);
  assert.throws(()=>C.saveAccount(s,{account:'新现金',field:'cash',debt:false,members:['新现金'],balance:1,at:group.at}),/重复计入/);
});
test('canonical account projection handles different timestamps and two-sided debt repayment',()=>{
  const s=trackingState([
    ['2025-12-31 10:00:00','收入','工资薪水',1,'人民币','测试银行卡'],
    ['2026-01-02 09:00:00','转账','转账',50,'人民币','测试银行卡：-50，测试信用卡：+50']
  ]);
  s.accounts=[{account:'测试银行卡',field:'cash',debt:false,members:['测试银行卡'],balance:100000,at:s.snapshot.asOf},{account:'测试信用卡',field:'shortDebt',debt:true,members:['测试信用卡'],balance:50000,at:s.snapshot.asOf}];
  const p=C.project(s);assert.deepEqual(p.issues,[]);assert.equal(p.values.cash,95000);assert.equal(p.values.shortDebt,45000);
  assert.equal(C.financial(s).total,150000); // Stock 100000 plus cash minus debt; unknown other fields excluded.
  s.accounts[1].balance=45000;s.accounts[1].at='2026-01-02T04:00:00Z';assert.equal(C.project(s).values.shortDebt,45000);
  assert.equal(C.project(s).values.cash,95000);
});
test('financial scope excludes other household assets and debts but reports unknown financial fields',()=>{
  const s=exampleState();Object.assign(s.snapshot.values,{otherAssets:1000000,otherDebt:300000});
  assert.equal(C.financial(s).total,180000);assert.equal(C.assets(s).total,880000);
  assert.equal(C.financial(s).liquid,80000);
  assert.ok(Math.abs(C.financial(s).concentration-0.5)<1e-9);
});
test('equity scenario requires explicit subscription and tax, excludes unvested from current assets',()=>{
  const s=exampleState();s.scenario={price:10000,subscription:null,tax:0};assert.equal(C.equityScenario(s),null);
  s.scenario.subscription=50000;const result=C.equityScenario(s);
  assert.equal(C.assets(s).total,180000);assert.equal(result.stock,1100000);assert.equal(result.total,1130000);assert.equal(result.liquid,30000);
});
test('local annotations survive reimport but edited or duplicate transactions are not uniquely matched',()=>{
  const s=exampleState(),key=C.transactionKey(s.ledger.transactions[0]);
  s.notes=[{id:'fictional-note',title:'虚构工资用途',detail:'测试',source:'虚构凭据',status:'confirmed',purpose:'family',keys:[key]}];
  assert.equal(C.noteMatches(s,s.notes[0])[0].count,1);
  assert.equal(C.cashflow(s,'2025-01').buckets.family,100000);
  s.ledger.transactions.push({...s.ledger.transactions[0]});assert.equal(C.noteMatches(s,s.notes[0])[0].count,2);
  assert.equal(C.cashflow(s,'2025-01').buckets.family,0);
  s.ledger.transactions=s.ledger.transactions.filter(t=>C.transactionKey(t)!==key);assert.equal(C.noteMatches(s,s.notes[0])[0].count,0);
  assert.equal(s.notes.length,1);
});

test('import change preview preserves duplicate multiplicity and includes old/new edited rows',()=>{
 const row=C.parseRows(sample)[0],changed={...row,account:'虚构账户'};
 const diff=C.ledgerChanges([row,row],[row,changed]);assert.deepEqual(diff.added,[changed]);assert.deepEqual(diff.removed,[row]);
});

 test('fixed interest-free loan reduces only debt at due dates and floors at zero',()=>{
 const s=C.emptyState();s.notes=[{id:'vehicle-loan-plan',status:'confirmed',source:JSON.stringify({version:1,account:'测试车贷',monthly:10000,day:20})}];
 const a={account:'测试车贷',field:'otherDebt',debt:true,balance:25000,at:'2025-01-21T00:00:00Z'};
 assert.equal(C.scheduledLoan(s,a,'2025-02-19T00:00:00Z').balance,25000);
 assert.equal(C.scheduledLoan(s,a,'2025-02-21T00:00:00Z').balance,15000);
 assert.equal(C.scheduledLoan(s,a,'2025-05-21T00:00:00Z').balance,0);
 s.notes[0].source='invalid';assert.equal(C.scheduledLoan(s,a),null);
 });

test('cashflow distinguishes a confirmed zero net amount from no confirmed records',()=>{
 const s=C.emptyState(),t={date:'2025-01-01',type:'支出',category:'虚构',amount:100,currency:'CNY'};
 s.ledger={transactions:[t,{...t,date:'2025-01-02',type:'收入'}]};
 let f=C.cashflow(s,'2025-01');assert.equal(f.bucketCounts.consumption,0);assert.equal(f.unreviewed,2);
 s.notes=[{status:'confirmed',purpose:'consumption',keys:s.ledger.transactions.map(C.transactionKey)}];
 f=C.cashflow(s,'2025-01');assert.equal(f.buckets.consumption,0);assert.equal(f.bucketCounts.consumption,2);assert.equal(f.unreviewed,0);
});
