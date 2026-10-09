/* Pure calculations and validation. Shared by the browser and Node checks. */
(function (root) {
  'use strict';
  const VERSION = 4;
  const MAX_RECORDS = 100000;
  const MAX_CENTS = 10000000000000;
  const fields = [
    ['cash', '现金 / 活期', '元'], ['wealth', '理财', '元'],
    ['provident', '公积金', '元'], ['shares', '金山办公持股', '股'],
    ['shortDebt', '信用卡等短期负债', '元'], ['otherAssets', '其他家庭资产', '元'],
    ['otherDebt', '其他家庭负债', '元'], ['unvested', '待归属股票', '股']
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
        const date = dateOnly(row[index['日期时间']], date1904);
        const timeMatch = String(row[index['日期时间']] ?? '').trim().match(/[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
        const at = timeMatch ? `${date}T${timeMatch[1].padStart(2, '0')}:${timeMatch[2]}:${timeMatch[3] || '00'}` : null;
        if (at && !validLocalTime(at)) fail('交易时间无效');
        const accountIndex = headers.indexOf('收付账户');
        const account = accountIndex >= 0 ? String(row[accountIndex] ?? '').trim() : null;
        if (account !== null && account.length > 1000) fail('账户名称过长');
        transactions.push({ date, type, category, amount: cents(row[index['金额']]), currency: 'CNY', at, account });
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
    let start = null, end = null, total = 0, excluded = 0, absoluteTotal = 0;
    for (const t of transactions) {
      absoluteTotal += Math.abs(t.amount);
      if (!Number.isSafeInteger(absoluteTotal)) fail('账本总金额超出可精确计算范围');
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
  function emptyState() { return { version: VERSION, ledger: null, snapshot: null, quote: { mode: 'auto', manual: null, automatic: null }, tracking: null, history: [], accounts: [], notes: [], scenario: null }; }
  function validLocalTime(value) { return typeof value === 'string' && /^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value) && validDate(value.slice(0, 10)); }
  function localTime(iso) { return new Date(Date.parse(iso) + 8 * 3600000).toISOString().slice(0, 19); }
  function isTime(value) { return typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)); }
  function validateState(raw) {
    if (raw?.version === 1 && keysExactly(raw, ['version', 'ledger', 'snapshot', 'quote'])) raw = { ...raw, version: 2, tracking: null };
    if (raw?.version === 2 && keysExactly(raw, ['version', 'ledger', 'snapshot', 'quote', 'tracking'])) raw = { ...raw, version: 3, history: [], accounts: [] };
    if (raw?.version === 3 && keysExactly(raw, ['version', 'ledger', 'snapshot', 'quote', 'tracking', 'history', 'accounts'])) raw = { ...raw, version: VERSION, accounts: migrateAccounts(raw), notes: [], scenario: null };
    if (!keysExactly(raw, ['version', 'ledger', 'snapshot', 'quote', 'tracking', 'history', 'accounts', 'notes', 'scenario']) || raw.version !== VERSION) fail('备份格式或版本不受支持');
    if (raw.ledger !== null) {
      const l = raw.ledger;
      if (!keysExactly(l, ['importedAt', 'transactions']) || !isTime(l.importedAt) || !Array.isArray(l.transactions) || !l.transactions.length || l.transactions.length > MAX_RECORDS) fail('账本备份无效');
      for (const t of l.transactions) {
        if (!(keysExactly(t, ['date', 'type', 'category', 'amount', 'currency']) || keysExactly(t, ['date', 'type', 'category', 'amount', 'currency', 'at', 'account'])) || !validDate(t.date) || !types.has(t.type) || typeof t.category !== 'string' || !t.category.trim() || t.category.length > 200 || !Number.isSafeInteger(t.amount) || Math.abs(t.amount) > MAX_CENTS || t.currency !== 'CNY') fail('账本交易格式无效');
        if (Object.hasOwn(t, 'at') && ((t.at !== null && (!validLocalTime(t.at) || t.at.slice(0, 10) !== t.date)) || (t.account !== null && (typeof t.account !== 'string' || t.account.length > 1000)))) fail('交易时间或账户格式无效');
      }
      summarize(l.transactions);
    }
    if (raw.snapshot !== null) {
      const s = raw.snapshot;
      if (!(keysExactly(s, ['savedAt', 'values']) || keysExactly(s, ['savedAt', 'asOf', 'values'])) || !isTime(s.savedAt) || (s.asOf !== undefined && !isTime(s.asOf)) || !keysExactly(s.values, fields.map(f => f[0]))) fail('资产快照格式无效');
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
    if (raw.tracking !== null) {
      const t = raw.tracking;
      if (!keysExactly(t, ['enabled', 'mappings']) || typeof t.enabled !== 'boolean' || !Array.isArray(t.mappings) || t.mappings.length > 500) fail('账户自动更新设置无效');
      const seen = new Set();
      for (const m of t.mappings) {
        if (!keysExactly(m, ['account', 'field']) || typeof m.account !== 'string' || !m.account.trim() || m.account.length > 200 || !['cash', 'wealth', 'provident', 'shortDebt', 'otherAssets', 'otherDebt', 'ignore', 'stock'].includes(m.field) || seen.has(m.account)) fail('账户分类设置无效');
        seen.add(m.account);
      }
    }
    if (!Array.isArray(raw.history) || raw.history.length > 500 || !Array.isArray(raw.accounts) || raw.accounts.length > 500) fail('历史或账户格式无效');
    for (const h of raw.history) {
      if (!keysExactly(h, ['at', 'total', 'partial', 'price', 'values']) || !isTime(h.at) || !Number.isSafeInteger(h.total) || typeof h.partial !== 'boolean' || (h.price !== null && (!Number.isSafeInteger(h.price) || h.price <= 0 || h.price > 100000000))) fail('历史快照格式无效');
      const historical = validateState({ ...emptyState(), snapshot: { savedAt: h.at, values: h.values }, quote: { mode: 'auto', manual: null, automatic: h.price === null ? null : { price: h.price, at: h.at } } });
      const computed = assets(historical);
      if (computed.total !== h.total || computed.partial !== h.partial) fail('历史净额与余额或股价不一致');
    }
    const accountNames = new Set();
    for (const a of raw.accounts) {
      if (!keysExactly(a, ['account', 'debt', 'at', 'balance', 'field', 'members']) || typeof a.account !== 'string' || !a.account.trim() || a.account.length > 200 || accountNames.has(a.account) || typeof a.debt !== 'boolean' || !isTime(a.at) || (a.balance !== null && (!Number.isSafeInteger(a.balance) || a.balance < 0 || a.balance > MAX_CENTS))) fail('账户余额格式无效');
      if (a.field !== null && !moneyFields.includes(a.field)) fail('账户资产分类无效');
      if (a.field !== null && a.debt !== debtFields.includes(a.field)) fail('账户负债分类不一致');
      if (a.members !== null && (!Array.isArray(a.members) || a.members.length > 500 || new Set(a.members).size !== a.members.length || a.members.some(m => typeof m !== 'string' || !m.trim() || m.length > 200))) fail('账户关联名称无效');
      if (a.field !== null && a.members === null && raw.accounts.some(b => b !== a && b.field === a.field)) fail('分类汇总与明细不能重复计入，请先拆分汇总账户');
      accountNames.add(a.account);
    }
    const linked = new Set();
    for (const a of raw.accounts.filter(a => a.field !== null && a.members !== null)) for (const m of a.members) { if (linked.has(m)) fail('同一账本账户不能关联多个余额'); linked.add(m); }
    if (!Array.isArray(raw.notes) || raw.notes.length > 1000) fail('核实记录格式无效');
    const noteIds = new Set();
    for (const n of raw.notes) {
      if (!keysExactly(Object.fromEntries(Object.entries(n).filter(([k])=>!['compensationYear','eventId'].includes(k))), ['id','title','detail','source','status','purpose','keys']) || (n.eventId!==undefined && (typeof n.eventId!=='string'||n.eventId.length>200)) || (n.compensationYear!==undefined && n.compensationYear!==null && (!Number.isInteger(n.compensationYear)||n.compensationYear<1900||n.compensationYear>2200)) || typeof n.id !== 'string' || !n.id || n.id.length > 100 || noteIds.has(n.id) || !['confirmed','pending'].includes(n.status) || !purposes.includes(n.purpose) || !Array.isArray(n.keys) || n.keys.length > 200 || n.keys.some(k => typeof k !== 'string' || k.length > 2000) || ['title','detail','source'].some(k => typeof n[k] !== 'string' || n[k].length > (k === 'title' ? 200 : 5000)) || !n.title.trim()) fail('核实记录内容无效');
      noteIds.add(n.id);
    }
    if (raw.scenario !== null && (!keysExactly(raw.scenario, ['price','subscription','tax']) || ['price','subscription','tax'].some(k => raw.scenario[k] !== null && (!Number.isSafeInteger(raw.scenario[k]) || raw.scenario[k] < 0 || raw.scenario[k] > MAX_CENTS)) || raw.scenario.price === 0 || raw.scenario.price > 100000000)) fail('股权情景格式无效');
    return JSON.parse(JSON.stringify(raw));
  }
  function accountMovements(t) {
    if (t.type === '收入' || t.type === '支出') {
      if (!t.account) fail('缺少收付账户，请重新导入新版挖财明细');
      return [{ account: t.account, delta: t.type === '收入' ? t.amount : -t.amount }];
    }
    if (t.type !== '转账') fail('借贷交易需核对，不能直接推算账户余额');
    const parts = String(t.account || '').split(/[，,]/);
    if (parts.length < 2) fail('转账缺少两侧账户及方向');
    const entries = parts.map(part => {
      const match = part.trim().match(/^(.+?)[：:]\s*([+-]\d+(?:\.\d+)?)$/);
      if (!match) fail('转账账户格式无法识别');
      return { account: match[1].trim(), delta: cents(match[2].replace(/^\+/, '')) };
    });
    if (entries.reduce((sum, entry) => sum + entry.delta, 0) !== 0 || entries.reduce((sum, entry) => sum + Math.max(0, entry.delta), 0) !== Math.abs(t.amount) || !entries.some(e => e.delta < 0) || !entries.some(e => e.delta > 0)) fail('转账两侧金额或明细金额未配平');
    return entries;
  }
  function ledgerAccounts(transactions) {
    const accounts = new Set();
    for (const t of transactions) {
      if (t.type === '收入' || t.type === '支出') { if (t.account) accounts.add(t.account); }
      else if (t.type === '转账') { try { for (const move of accountMovements(t)) accounts.add(move.account); } catch {} }
    }
    return [...accounts].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }
  function legacyProject(state) {
    const baseline = state.snapshot;
    if (!baseline) return null;
    const values = { ...baseline.values }, asOf = localTime(baseline.asOf || baseline.savedAt);
    const result = { values, asOf, through: null, active: Boolean(state.tracking?.enabled), applied: 0, issues: [] };
    if (!result.active || !state.ledger) return result;
    const map = new Map(state.tracking.mappings.map(m => [m.account, m.field]));
    const records = state.ledger.transactions;
    const summary = summarize(records);
    if (summary.start > asOf.slice(0, 10)) result.issues.push('账本未覆盖余额基准日，请导入包含基准日至今的完整账本。');
    for (const t of records) {
      if (t.date < asOf.slice(0, 10) || (t.at && t.at <= asOf)) continue;
      try {
        if (!t.at) fail('交易缺少具体时间，无法判定是否已计入余额基准');
        if (t.category.split('/').at(-1).trim() === '股票') fail('股票交易需确认股数后重设余额基准');
        const moves = accountMovements(t);
        const fieldsForRow = moves.map(move => {
          const field = map.get(move.account);
          if (!field) fail(`账户“${move.account}”尚未分类`);
          if (field === 'stock') fail('股票账户有新记录，请确认持股数后重设余额基准');
          if (field !== 'ignore' && values[field] === null) fail('对应资产项目的起始余额未知');
          return field;
        });
        moves.forEach((move, i) => { const field = fieldsForRow[i]; if (field !== 'ignore') values[field] += ['shortDebt', 'otherDebt'].includes(field) ? -move.delta : move.delta; });
        result.applied++;
        if (!result.through || t.at > result.through) result.through = t.at;
      } catch (error) { if (result.issues.length < 20) result.issues.push(`${t.at || t.date}：${error.message}`); }
    }
    if (Object.values(values).some(value => value !== null && (!Number.isSafeInteger(value) || value < 0 || value > MAX_CENTS))) result.issues.push('推算余额为负或超出范围，请核对账户记录并重设基准。');
    if (result.issues.length) { result.values = { ...baseline.values }; result.applied = 0; result.through = null; }
    return result;
  }

  const moneyFields = ['cash','wealth','provident','shortDebt','otherAssets','otherDebt'];
  const debtFields = ['shortDebt','otherDebt'];
  const purposes = ['unknown','consumption','family','investment','debt','refund','adjustment','disposal','internal','prepaid','salary','bonus','noncash'];
  function migrateAccounts(state) {
    const accounts = (state.accounts || []).map(a => ({ ...a, field: null, members: [a.account] }));
    if (state.snapshot) for (const field of moneyFields) accounts.push({ account: `分类汇总 · ${fields.find(f => f[0] === field)[1]}`, field, members: null, debt: debtFields.includes(field), balance: state.snapshot.values[field], at: state.snapshot.asOf || state.snapshot.savedAt });
    return accounts;
  }
  function accountMembers(state, account) {
    return (account.members === undefined ? [account.account] : account.members) ?? (state.tracking?.mappings || []).filter(m => m.field === account.field).map(m => m.account);
  }
  function mergeVehicle(state, patch) {
    if(!keysExactly(patch,['kind','version','accounts','notes']) || patch.kind!=='vehicle-update' || patch.version!==1 || !Array.isArray(patch.accounts) || patch.accounts.length!==2 || !Array.isArray(patch.notes) || patch.notes.length>3)fail('车辆更新文件格式无效');
    if(!patch.accounts.some(a=>a.account==='汽车' && a.field==='otherAssets') || !patch.accounts.some(a=>a.account==='车贷' && a.field==='otherDebt'))fail('车辆更新账户不匹配');
    const names=new Set(patch.accounts.map(a=>a.account)), ids=new Set(patch.notes.map(n=>n.id));
    if(patch.notes.some(n=>!['vehicle-loan-plan','vehicle-market-estimate','property-sold'].includes(n.id)))fail('车辆更新记录不匹配');
    const accounts=state.accounts.filter(a=>!names.has(a.account));
    for(const field of ['otherAssets','otherDebt']) {
      const aggregate=accounts.find(a=>a.field===field && a.members===null);
      if(aggregate && aggregate.balance!==null && aggregate.balance!==0)fail('家庭分类已有汇总金额，请先拆分以避免重复计入');
    }
    const next={...state,accounts:[...accounts.filter(a=>!(['otherAssets','otherDebt'].includes(a.field) && a.members===null)),...patch.accounts],notes:[...state.notes.filter(n=>!ids.has(n.id)),...patch.notes]};
    const checked=validateState(next);assets(checked);return checked;
  }
  function scheduledLoan(state, account, until = new Date().toISOString()) {
    const note=state.notes?.find(n=>n.id==='vehicle-loan-plan' && n.status==='confirmed');
    if(!note || account.field!=='otherDebt' || !account.debt || account.balance===null)return null;
    let plan;try{plan=JSON.parse(note.source);}catch{return null;}
    if(plan.version!==1 || plan.account!==account.account || !Number.isSafeInteger(plan.monthly) || plan.monthly<=0 || !Number.isInteger(plan.day) || plan.day<1 || plan.day>28)return null;
    const start=localTime(account.at),end=localTime(until);
    if(end<start)return null;
    const index=d=>Number(d.slice(0,4))*12+Number(d.slice(5,7))-1;
    let paid=0;for(let m=index(start);m<=index(end);m++){
      const date=String(Math.floor(m/12)).padStart(4,'0')+'-'+String(m%12+1).padStart(2,'0')+'-'+String(plan.day).padStart(2,'0')+'T23:59:59';
      if(date>start && date<=end)paid++;
    }
    return {balance:Math.max(0,account.balance-paid*plan.monthly),applied:paid,through:null,issues:[],scheduled:true};
  }
  function accountProjection(state, account, until = null) {
    const scheduled=scheduledLoan(state,account,until || new Date().toISOString());if(scheduled)return scheduled;
    const start = localTime(account.at), end = until ? localTime(until) : '9999';
    const members = new Set(accountMembers(state, account)), issues = [];
    let balance = account.balance, applied = 0, through = null;
    if (!state.tracking?.enabled) return { balance, applied, through, issues };
    const records = state.ledger?.transactions || [];
    if (!state.ledger) return { balance, applied, through, issues: ['未导入账本，展示实际余额基准'] };
    if (records.length && summarize(records).start > start.slice(0,10)) issues.push('账本未覆盖余额基准日');
    for (const t of records) {
      if (t.date < start.slice(0,10) || t.date > end.slice(0,10) || (t.at && (t.at <= start || t.at > end))) continue;
      try {
        const moves = accountMovements(t).filter(m => members.has(m.account));
        if (!moves.length) continue;
        if (!t.at) fail('交易缺少具体时间');
        if (balance === null) fail('起始余额未知');
        if (t.category.split('/').at(-1).trim() === '股票') fail('股票交易需核对持股及现金');
        for (const m of moves) balance += account.debt ? -m.delta : m.delta;
        applied++; if (!through || t.at > through) through = t.at;
      } catch(e) { if (issues.length < 20) issues.push(`${t.at || t.date}：${e.message}`); }
    }
    if (balance !== null && (!Number.isSafeInteger(balance) || balance < 0 || balance > MAX_CENTS)) issues.push('推算余额异常');
    return { balance: issues.length ? account.balance : balance, applied: issues.length ? 0 : applied, through: issues.length ? null : through, issues };
  }
  function project(state) {
    if (!state.accounts?.some(a => a.field !== null)) return legacyProject(state);
    const values = state.snapshot ? { ...state.snapshot.values } : Object.fromEntries(fields.map(([key]) => [key,null]));
    const result = { values, asOf: null, through: null, active: Boolean(state.tracking?.enabled), applied: 0, issues: [], rows: [] };
    for (const field of moneyFields) {
      const list = state.accounts.filter(a => a.field === field);
      values[field] = list.length && list.every(a => a.balance !== null) ? 0 : null;
      for (const a of list) {
        const p = accountProjection(state,a); result.rows.push({ ...a, ...p });
        if (values[field] !== null) values[field] += p.balance;
        result.applied += p.applied;
        if (p.through && (!result.through || p.through > result.through)) result.through = p.through;
        result.issues.push(...p.issues.map(i => `${a.account}：${i}`));
      }
    }
    if (result.active && state.ledger) {
      const included = state.accounts.filter(a => a.field !== null), earliest = included.map(a => localTime(a.at)).sort()[0];
      const owned = new Set(included.flatMap(a => accountMembers(state,a))), map = new Map((state.tracking?.mappings || []).map(m => [m.account,m.field]));
      for (const t of state.ledger.transactions) {
        if (t.date < earliest.slice(0,10) || (t.at && t.at <= earliest)) continue;
        try { for (const move of accountMovements(t)) if (!owned.has(move.account) && map.get(move.account) !== 'ignore') fail(`账户“${move.account}”未纳入余额或明确排除`); }
        catch(e) { if (result.issues.length < 40) result.issues.push(`${t.at || t.date}：${e.message}`); }
      }
    }
    if (result.issues.length) {
      // Never present a mix of partly updated accounts as a current complete balance sheet.
      for (const field of moneyFields) { const list=state.accounts.filter(a=>a.field===field); values[field]=list.length && list.every(a=>a.balance!==null) ? list.reduce((sum,a)=>sum+a.balance,0) : null; }
      result.applied = 0; result.through = null;
      result.rows = result.rows.map(a => ({ ...a, balance: state.accounts.find(b=>b.account===a.account).balance }));
    }
    return result;
  }
  function saveAccount(state, account) {
    const accounts = [...state.accounts.filter(a => a.account !== account.account), account];
    const next = { ...state, accounts };
    if (!next.snapshot) next.snapshot = { savedAt: account.at, asOf: account.at, values: Object.fromEntries(fields.map(([key])=>[key,null])) };
    return validateState(next);
  }
  function splitAccount(state, accountName, entries, at) {
    const group=state.accounts.find(a=>a.account===accountName);
    if (!group || group.members !== null || group.field === null) fail('只能拆分分类汇总');
    const p=accountProjection(state,group);
    if (p.issues.length || p.balance === null) fail('请先核实分类总余额，再拆分');
    if (!entries.length || entries.reduce((sum,a)=>sum+a.balance,0)!==p.balance) fail('明细合计必须与分类当前展示余额一致');
    const names=new Set(entries.map(a=>a.account));
    if (names.size !== entries.length) fail('账户名称重复');
    const accounts=state.accounts.filter(a=>a.account!==accountName && !(a.field===null && names.has(a.account)));
    for (const a of entries) accounts.push({ ...a, debt:group.debt,field:group.field,members:[a.account],at });
    const mappings=(state.tracking?.mappings || []).filter(m=>!names.has(m.account));
    for (const name of names) mappings.push({account:name,field:group.field});
    return validateState({ ...state, accounts, tracking: {enabled:Boolean(state.tracking?.enabled),mappings} });
  }
  function financial(state) {
    const result=assets(state); if (!result) return null;
    const items=result.items.filter(([key])=>['cash','wealth','provident','shares','shortDebt'].includes(key));
    const filled=items.filter(([,v])=>v!==null), total=filled.reduce((sum,[,v])=>sum+v,0);
    const positive=filled.reduce((sum,[,v])=>sum+Math.max(0,v),0);
    return {total,partial:filled.length!==items.length,any:filled.length>0,stock:result.stock,positive,concentration:result.stock!==null && positive>0 ? result.stock/positive : null, liquid:result.items.find(([k])=>k==='cash')[1]===null || result.items.find(([k])=>k==='wealth')[1]===null || result.items.find(([k])=>k==='shortDebt')[1]===null ? null : project(state).values.cash+project(state).values.wealth-project(state).values.shortDebt};
  }
  function transactionKey(t) { return JSON.stringify([t.date,t.at ?? null,t.type,t.category,t.amount,t.currency,t.account ?? null]); }
  function noteMatches(state,note) {
    const counts=new Map(); for (const t of state.ledger?.transactions || []) { const k=transactionKey(t); counts.set(k,(counts.get(k)||0)+1); }
    return note.keys.map(key=>({key,count:counts.get(key)||0}));
  }
  function cashflow(state, month) {
    let income=0,expense=0,transfers=0,loans=0,unreviewed=0;
    const buckets=Object.fromEntries(purposes.map(p=>[p,0])),bucketCounts=Object.fromEntries(purposes.map(p=>[p,0]));
    const counts=new Map();for(const t of state.ledger?.transactions||[]){const key=transactionKey(t);counts.set(key,(counts.get(key)||0)+1);}
    const notes=state.notes.filter(n=>n.status==='confirmed');
    for (const t of state.ledger?.transactions || []) {
      if (!t.date.startsWith(month)) continue;
      if (t.type==='转账') {transfers++;continue;} if(t.type==='借贷'){loans++;continue;}
      if(t.type==='收入') income+=t.amount; else expense+=t.amount;
      const matches=notes.filter(n=>n.keys.includes(transactionKey(t)));
      const purpose=matches.length===1 && counts.get(transactionKey(t))===1 ? matches[0].purpose : 'unknown';
      bucketCounts[purpose]++;buckets[purpose]+=t.type==='收入' ? t.amount : -t.amount;
      if(purpose==='unknown') unreviewed++;
    }
    return {income,expense,difference:income-expense,transfers,loans,unreviewed,buckets,bucketCounts};
  }
  // Analysis reads immutable ledger records. Conflicting links remain unknown.
  function analysis(state, year) {
    const tx=state.ledger?.transactions||[], counts=new Map(), links=new Map(),byKey=new Map();
    for(const t of tx){const k=transactionKey(t);counts.set(k,(counts.get(k)||0)+1);byKey.set(k,t);}
    for(const n of state.notes.filter(n=>n.status==='confirmed'))for(const k of new Set(n.keys)){if(!links.has(k))links.set(k,[]);links.get(k).push(n);}
    let income=0,expense=0,unknown=0,excluded=0,bonusUnknown=0,cashIncome=0,cashExpense=0,transferCount=0,adjustmentCount=0,unassignedBonus=0;
    const compensation={}, events=[];
    for(const t of tx){
      const k=transactionKey(t),ns=links.get(k)||[],n=counts.get(k)===1&&ns.length===1?ns[0]:null;
      const cash=t.type==='收入'||t.type==='支出', selected=t.date.slice(0,4)===String(year);
      if(selected && !cash)transferCount++;
      if(selected && cash){
        if(n && ['internal','adjustment','noncash'].includes(n.purpose)){adjustmentCount++;}else{if(t.type==='收入')cashIncome+=t.amount;else cashExpense+=t.amount;}
        if(t.type==='收入' && t.category.split('/').at(-1).trim()==='奖金' && (!n || n.compensationYear==null || !['salary','bonus'].includes(n.purpose)))unassignedBonus+=t.amount;
        if(n && ['internal','debt','adjustment','prepaid','noncash'].includes(n.purpose))excluded+=t.amount;else{if(t.type==='收入')income+=t.amount;else expense+=t.amount;if(!n||n.purpose==='unknown')unknown++;}}
      if(cash && n && ['salary','bonus'].includes(n.purpose) && t.type==='收入'){
        const y=n.compensationYear;if(y==null){if(selected)bonusUnknown+=t.amount;}else compensation[y]=(compensation[y]||0)+t.amount;
      }
    }
    for(const n of state.notes){if(!n.keys.length)continue;let incoming=0,outgoing=0,matched=0,unresolved=0;
      for(const k of new Set(n.keys)){
        const ns=links.get(k)||[];if(n.status!=='confirmed'||counts.get(k)!==1||ns.length!==1){unresolved++;continue;}
        const t=byKey.get(k);if(!['收入','支出'].includes(t.type)||['unknown','internal','debt','adjustment','prepaid','noncash'].includes(n.purpose)){unresolved++;continue;}
        matched++;if(t.type==='收入')incoming+=t.amount;else outgoing+=t.amount;
      }
      events.push({id:n.id,incoming,outgoing,net:outgoing-incoming,matched,unresolved});
    }
    const grouped=new Map();for(const e of events){const n=state.notes.find(n=>n.id===e.id),id=n.eventId||n.id;if(!grouped.has(id))grouped.set(id,{id,incoming:0,outgoing:0,net:0,matched:0,unresolved:0});const group=grouped.get(id);for(const k of ['incoming','outgoing','net','matched','unresolved'])group[k]+=e[k];}
    return {income,expense,difference:income-expense,unknown,excluded,bonusUnknown,compensation,cashIncome,cashExpense,cashDifference:cashIncome-cashExpense,transferCount,adjustmentCount,unassignedBonus,events,eventGroups:[...grouped.values()]};
  }
  function monthlyEstimate(state){
    const note=state.notes.find(n=>n.id==='monthly-forecast');if(!note)return null;
    let data;try{data=JSON.parse(note.detail);}catch{return null;}
    if(!data || !['salary','fixed','other'].every(k=>Number.isSafeInteger(data[k])&&data[k]>=0&&data[k]<=MAX_CENTS))return null;
    const high=data.otherHigh??data.other,extra=data.additional??0;
    if(!Number.isSafeInteger(high)||high<data.other||high>MAX_CENTS||!Number.isSafeInteger(extra)||extra<0||extra>MAX_CENTS)return null;
    const low=data.salary-data.fixed-high-extra,upper=data.salary-data.fixed-data.other-extra;
    if(!Number.isSafeInteger(low)||!Number.isSafeInteger(upper))return null;
    return {low,high:upper,data,source:note.source,reviewed:note.status==='confirmed' && data.version===2 && validDate(data.asOf),asOf:data.asOf||null};
  }
  function periodCoverage(transactions, month){
    if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month||''))return {count:0,start:null,end:null,partial:false};
    const dates=transactions.filter(t=>t.date.startsWith(month)).map(t=>t.date).sort();
    if(!dates.length)return {count:0,start:null,end:null,partial:false};
    const [year,m]=month.split('-').map(Number),last=new Date(Date.UTC(year,m,0)).toISOString().slice(0,10);
    const ledgerEnd=transactions.reduce((end,t)=>t.date>end?t.date:end,'');
    return {count:dates.length,start:dates[0],end:dates.at(-1),partial:ledgerEnd.startsWith(month)&&ledgerEnd<last};
  }
  function equityScenario(state) {
    const p=project(state), f=financial(state), scenario=state.scenario;
    if(!p || !f || !scenario || Object.values(scenario).some(v=>v===null) || p.values.shares===null || p.values.unvested===null || f.partial || f.liquid===null || f.stock===null) return null;
    const stock=(p.values.shares+p.values.unvested)*scenario.price;
    const cost=scenario.subscription+scenario.tax;
    const total=f.total-f.stock+stock-cost;
    if (![stock,cost,total].every(Number.isSafeInteger)) fail('情景金额超出范围');
    return {stock,total,liquid:f.liquid-cost,cost};
  }

  function activeQuote(state) { return state.quote.mode === 'manual' ? state.quote.manual : state.quote.automatic; }
  function assets(state) {
    if (!state.snapshot && !state.accounts?.some(a=>a.field!==null)) return null;
    const values = project(state).values;
    const price = activeQuote(state)?.price ?? null;
    const stock = values.shares === 0 ? 0 : values.shares === null || price === null ? null : values.shares * price;
    const items = [['cash', values.cash], ['wealth', values.wealth], ['provident', values.provident], ['shares', stock], ['otherAssets', values.otherAssets], ['shortDebt', values.shortDebt === null ? null : -values.shortDebt], ['otherDebt', values.otherDebt === null ? null : -values.otherDebt]];
    const filled = items.filter(([, value]) => value !== null);
    const total = filled.reduce((sum, [, value]) => sum + value, 0);
    if (!Number.isSafeInteger(total) || (stock !== null && !Number.isSafeInteger(stock))) fail('资产合计超出可精确计算范围');
    return { total, stock, items, partial: filled.length !== items.length, any: filled.length > 0, unvested: values.unvested };
  }

  function ledgerDiff(before, after) {
    // Multisets preserve legitimately identical transactions; no guessed transaction IDs.
    const key = t => JSON.stringify([t.date, t.at ?? null, t.type, t.category, t.amount, t.currency, t.account ?? null]);
    const counts = new Map();
    for (const t of before) { const k = key(t); counts.set(k, (counts.get(k) || 0) + 1); }
    let same = 0, added = 0;
    for (const t of after) { const k = key(t), n = counts.get(k) || 0; if (n) { same++; counts.set(k, n - 1); } else added++; }
    return { same, added, removed: before.length - same };
  }
  function ledgerChanges(before,after,limit=50) {
    const remaining=new Map();for(const t of before){const k=transactionKey(t);if(!remaining.has(k))remaining.set(k,[]);remaining.get(k).push(t);}
    const added=[];for(const t of after){const list=remaining.get(transactionKey(t));if(list?.length)list.pop();else if(added.length<limit)added.push(t);}
    const removed=[];for(const list of remaining.values())for(const t of list)if(removed.length<limit)removed.push(t);
    return {added,removed};
  }
  function reconcile(state, baseline, actual, actualAt) {
    const end = localTime(actualAt), start = localTime(baseline.at), issues = [];
    if (end < start) fail('核对时间不能早于账户基准');
    if (baseline.balance===null) fail('账户基准余额未知');
    if (!state.ledger) issues.push('尚未导入账本');
    const records = state.ledger?.transactions || [];
    if (records.length && summarize(records).start > start.slice(0, 10)) issues.push('账本未覆盖账户基准日');
    let expected = baseline.balance, applied = 0;
    for (const t of records) {
      if (t.date < start.slice(0, 10) || t.date > end.slice(0, 10) || (t.at && (t.at <= start || t.at > end))) continue;
      try {
        const moves = accountMovements(t), matching = moves.filter(m => accountMembers(state,baseline).includes(m.account));
        if (!matching.length) continue;
        if (!t.at) fail('缺少具体时间');
        if (t.category.split('/').at(-1).trim() === '股票') fail('股票交易需人工核对');
        for (const m of matching) expected += baseline.debt ? -m.delta : m.delta;
        applied++;
      } catch (e) { issues.push(`${t.at || t.date}：${e.message}`); }
    }
    if (!Number.isSafeInteger(expected) || expected < 0 || expected > MAX_CENTS) issues.push('推算余额异常');
    return { expected: issues.length ? null : expected, difference: issues.length ? null : actual - expected, applied, issues };
  }
  function capture(state, snapshot) {
    const frozen = { ...state, snapshot, tracking: null, accounts: [] };
    const result = assets(frozen);
    return { at: snapshot.asOf || snapshot.savedAt, total: result.total, partial: result.partial, price: activeQuote(state)?.price ?? null, values: { ...snapshot.values } };
  }
  function parseQuote(payload, now = Date.now()) {
    const data = payload?.data;
    if (payload?.rc !== 0 || data?.f57 !== '688111' || !Number.isInteger(data.f43) || data.f43 <= 0 || data.f43 > 100000000 || !Number.isInteger(data.f86) || data.f86 < 946684800 || data.f86 * 1000 > now + 300000) fail('行情数据不可用');
    return { price: data.f43, at: new Date(data.f86 * 1000).toISOString() };
  }
  const api = { VERSION, fields, emptyState, cents, dateOnly, parseRows, parseWorkbook, summarize, validateState, activeQuote, assets, parseQuote, accountMovements, ledgerAccounts, project, localTime, ledgerDiff, reconcile, capture, moneyFields, debtFields, purposes, ledgerChanges, accountMembers, accountProjection, mergeVehicle, scheduledLoan, migrateAccounts, saveAccount, splitAccount, financial, transactionKey, noteMatches, cashflow, analysis, monthlyEstimate, periodCoverage, equityScenario };
  root.FinanceCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
