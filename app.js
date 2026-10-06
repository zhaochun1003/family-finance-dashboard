(function () {
  'use strict';
  const C = window.FinanceCore;
  const STORAGE_KEY = 'family-finance-dashboard.v1';
  const $ = id => document.getElementById(id);
  const money = cents => ((cents || 0) / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const headline = cents => Math.abs(cents) >= 10000000 ? (cents / 1000000).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' 万' : money(cents);
  const time = iso => new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  let state = C.emptyState(), quoteStatus = '正在获取公开行情…', loading = false;
  let storageBlocked = false, originalStored = null;
  let quoteEpoch = 0;
  function notify(text, error = false) {
    $('message').textContent = text;
    $('message').classList.toggle('error', error);
    $('message').hidden = false;
  }
  try {
    originalStored = localStorage.getItem(STORAGE_KEY);
    if (originalStored) { const checked = C.validateState(JSON.parse(originalStored)); C.assets(checked); state = checked; }
  } catch { storageBlocked = true; notify('无法读取已保存的数据，可能是存储被禁用或内容损坏。已暂停覆盖；可导出原始存储副本，再恢复有效备份或清空数据。', true); }
  function commit(next, message, recover = false) {
    try {
      if (storageBlocked && !recover) throw new Error('原存储无法读取，请先导出原始副本并恢复备份，或清空本地数据');
      const checked = C.validateState(next);
      C.assets(checked);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(checked));
      state = checked;
      storageBlocked = false; originalStored = null;
      render();
      if (message) notify(message);
      return true;
    } catch (error) {
      notify(`未保存：${error.message}。若浏览器空间不足，请先导出备份再清理空间。原数据保留。`, true);
      return false;
    }
  }
  // Keep one import recovery point outside localStorage, avoiding duplicate ledger quota.
  function recovery(mode, value) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('family-finance-recovery', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('recovery');
      request.onerror = () => reject(new Error('无法保存导入恢复点，请检查浏览器存储权限'));
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction('recovery', mode === 'read' ? 'readonly' : 'readwrite');
        const store = tx.objectStore('recovery');
        const action = mode === 'read' ? store.get('ledger') : mode === 'clear' ? store.delete('ledger') : store.put(value, 'ledger');
        tx.oncomplete = () => { resolve(action.result); db.close(); };
        tx.onabort = tx.onerror = () => { reject(new Error('恢复点保存失败')); db.close(); };
      };
    });
  }
  let recoveryBusy = false;
  recovery('read').then(value => { $('undo-import').hidden = value === undefined; }).catch(() => {});
  $('undo-import').addEventListener('click', async () => {
    if (importing || recoveryBusy || !confirm('恢复最近一次导入之前的账本？当前资产基准、账户基准和历史记录保留，推算余额将重新计算。')) return;
    recoveryBusy = true;
    try {
      const ledger = await recovery('read');
      if (ledger === undefined) throw new Error('没有可用的恢复点');
      if (commit({ ...state, ledger }, '账本已恢复，资产按当前基准重新推算。')) { await recovery('clear'); $('undo-import').hidden = true; }
    } catch (e) { notify(e.message, true); }
    finally { recoveryBusy = false; }
  });
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function renderLedger() {
    const ledger = state.ledger;
    $('ledger-results').hidden = !ledger;
    $('drop-zone').hidden = Boolean(ledger);
    if (!ledger) {
      $('labor-value').textContent = '—'; $('labor-note').textContent = '导入挖财账本后显示';
      $('record-count').textContent = '—'; $('date-range').textContent = '尚未导入账本';
      $('year-rows').replaceChildren(); $('income-chart').replaceChildren(); return;
    }
    const summary = C.summarize(ledger.transactions);
    $('labor-value').textContent = headline(summary.total);
    $('labor-note').textContent = `${summary.start.slice(0, 4)}—${summary.end.slice(0, 4)} · 元`;
    $('record-count').textContent = summary.count.toLocaleString('zh-CN') + ' 笔';
    $('date-range').textContent = `${summary.start} 至 ${summary.end}`;
    $('ledger-meta').textContent = `导入于 ${time(ledger.importedAt)} · ${summary.excluded.toLocaleString('zh-CN')} 笔不属于工资奖金`;
    const chart = $('income-chart'); chart.replaceChildren();
    const rows = $('year-rows'); rows.replaceChildren();
    const max = Math.max(1, ...summary.years.map(y => Math.max(0, y.salary) + Math.max(0, y.bonus)));
    for (const year of summary.years) {
      const barRow = element('div', undefined, 'bar-row');
      const track = element('div', undefined, 'bar-track');
      const salary = element('span', undefined, 'bar-salary'); salary.style.width = `${Math.max(0, year.salary) / max * 100}%`;
      const bonus = element('span', undefined, 'bar-bonus'); bonus.style.width = `${Math.max(0, year.bonus) / max * 100}%`;
      track.append(salary, bonus);
      barRow.append(element('span', year.year), track, element('span', money(year.total), 'bar-value'));
      chart.append(barRow);
      const row = element('tr');
      for (const value of [year.year, money(year.salary), money(year.bonus), money(year.total)]) row.append(element('td', value));
      rows.append(row);
    }
    const legend = element('div', undefined, 'chart-legend');
    for (const [name, cls] of [['工资', ''], ['奖金', 'bonus']]) { const entry = element('span'); entry.append(element('i', undefined, cls), document.createTextNode(name)); legend.append(entry); }
    chart.append(legend);
    if (summary.years.some(y => y.salary < 0 || y.bonus < 0)) chart.append(element('p', '负数调整计入表格合计，图中不绘制负值。', 'small muted'));
    chart.setAttribute('aria-label', `年度工资奖金趋势，${summary.start.slice(0, 4)} 至 ${summary.end.slice(0, 4)} 年，累计 ${money(summary.total)} 元；详细数值见下表。`);
  }
  function renderAssets() {
    const result = C.assets(state);
    const list = $('asset-list'); list.replaceChildren();
    const composition = $('asset-composition'); composition.replaceChildren();
    $('net-value').textContent = result?.any ? headline(result.total) : '—';
    $('net-label').textContent = result?.partial ? '已填项目净额' : '当前净资产';
    $('net-note').textContent = !result ? '填写资产快照后显示' : result.partial ? '部分项目未知，未计入 · 元' : '当前资产 − 当前负债 · 元';
    $('stock-value').textContent = result?.stock != null ? headline(result.stock) : '—';
    const quote = C.activeQuote(state);
    $('stock-note').textContent = state.snapshot?.values.shares != null ? `${state.snapshot.values.shares.toLocaleString('zh-CN')} 股${quote ? ` · 采用${state.quote.mode === 'manual' ? '手动' : '自动'}价格` : ' · 缺少股价'}` : '持股数量 × 当前采用价格';
    const projection = C.project(state);
    $('snapshot-date').textContent = state.snapshot ? `余额基准：${time(state.snapshot.asOf || state.snapshot.savedAt)}` : '尚未保存快照';
    $('tracking-status').textContent = !projection?.active ? '账本自动调整未启用。' : projection.issues.length ? `自动调整暂停，显示基准余额：\n${projection.issues.slice(0, 3).join('\n')}${projection.issues.length > 3 ? '\n更多记录也需核对。' : ''}` : `账本自动调整已启用 · 基准之后 ${projection.applied} 笔${projection.through ? ` · 推算至 ${projection.through.replace('T', ' ')}` : ' · 尚无新增记录'}`;
    if (result) {
      const colors = { cash: '#68b7cf', wealth: '#2d88ca', provident: '#6a88b5', shares: '#174574', otherAssets: '#87a9be' };
      const positive = result.items.reduce((sum, [, value]) => sum + Math.max(0, value ?? 0), 0);
      for (const [key, value] of result.items) {
        const entry = element('div');
        const label = key === 'shares' ? '股票市值' : C.fields.find(f => f[0] === key)[1];
        entry.append(element('dt', label), element('dd', value === null ? '未填写 / 未知' : money(value))); list.append(entry);
        if (value > 0 && positive > 0) { const segment = element('span'); segment.style.width = `${value / positive * 100}%`; segment.style.backgroundColor = colors[key]; segment.title = `${label} ${money(value)} 元`; composition.append(segment); }
      }
      $('unvested-note').textContent = result.unvested === null ? '待归属股票未填写，不计入当前净资产。' : `待归属 ${result.unvested.toLocaleString('zh-CN')} 股，不计入当前净资产。`;
    } else { list.append(element('p', '填写现金、理财和负债，建立你的第一份资产快照。', 'muted')); $('unvested-note').textContent = '待归属股票不计入当前净资产。'; }
  }
  function renderQuote() {
    const quote = C.activeQuote(state);
    $('quote-price').textContent = quote ? money(quote.price) : '—';
    $('quote-status').textContent = `${state.quote.mode === 'manual' ? '采用手动价格 · ' : ''}${quote ? `价格时间 ${time(quote.at)} · ` : ''}${quoteStatus}`;
    $('auto-price').hidden = state.quote.mode !== 'manual';
    $('refresh-quote').disabled = loading;
    if (state.quote.manual && document.activeElement !== $('manual-price')) $('manual-price').value = state.quote.manual.price / 100;
    if (!state.quote.manual && document.activeElement !== $('manual-price')) $('manual-price').value = '';
  }
  function renderReview() {
    const projection = C.project(state), result = C.assets(state);
    $('data-health').textContent = !state.snapshot ? '下一步：确认实际余额并填写资产快照。挖财交易文件不包含当前账户余额。' : projection?.issues.length ? `余额推算已暂停：当前展示基准余额，股价仍按采用价格估值。请核对：${projection.issues.join('；')}` : `${result.partial ? '部分资产未知，展示已填项目净额。' : '资产项目已填写。'}${projection?.active ? ' 余额来自账本推算，尚需与实际账户核对。' : ' 余额来自已填写基准。'} 股票按采用价格估值。`;
    $('data-health').classList.toggle('error', Boolean(projection?.issues.length));
    const rows = $('account-rows'); rows.replaceChildren();
    for (const a of state.accounts) {
      const row = element('tr'); row.append(element('td', a.account + (a.debt ? ' · 负债' : '')), element('td', money(a.balance)), element('td', time(a.at)));
      const cell = element('td'), button = element('button', '核对', 'text-button'); button.type = 'button'; button.addEventListener('click', () => openAccount(a)); cell.append(button); row.append(cell); rows.append(row);
    }
    $('account-empty').hidden = Boolean(state.accounts.length);
    const history = $('history-rows'); history.replaceChildren();
    for (const h of [...state.history].sort((a,b) => b.at.localeCompare(a.at))) {
      const row = element('tr');
      for (const v of [time(h.at), money(h.total), h.partial ? '已填项目净额' : '全部已填项目净资产', h.price === null ? '未知' : money(h.price)]) row.append(element('td', v));
      history.append(row);
    }
    $('history-empty').hidden = Boolean(state.history.length);
    $('record-history').disabled = !state.snapshot || Boolean(projection?.issues.length);
  }
  function render() { renderLedger(); renderAssets(); renderQuote(); renderReview(); }
  function openAccount(a) {
    const names = $('account-names'); names.replaceChildren();
    for (const name of C.ledgerAccounts(state.ledger?.transactions || [])) { const option = element('option'); option.value = name; names.append(option); }
    $('account-name').value = a?.account || ''; $('account-debt').checked = a?.debt || false;
    $('account-balance').value = ''; $('account-at').value = C.localTime(new Date().toISOString()); $('account-result').hidden = true;
    $('account-dialog').showModal();
  }
  function accountInput() {
    if (!$('account-form').reportValidity()) return null;
    const account = $('account-name').value.trim(); if (!account) throw new Error('请输入账户名称');
    return { account, debt: $('account-debt').checked, balance: C.cents($('account-balance').value, false), at: new Date($('account-at').value + '+08:00').toISOString() };
  }
  $('edit-account').addEventListener('click', () => openAccount());
  $('close-account').addEventListener('click', () => $('account-dialog').close());
  $('account-form').addEventListener('submit', e => {
    e.preventDefault();
    try {
      const actual = accountInput(); if (!actual) return;
      const baseline = state.accounts.find(a => a.account === actual.account);
      let text;
      if (!baseline) text = '尚无该账户基准，请确认实际余额后建立基准。';
      else if (baseline.debt !== actual.debt) throw new Error('账户资产 / 负债口径与原基准不同，请先核实后再建立新基准');
      else {
        const r = C.reconcile(state, baseline, actual.balance, actual.at);
        text = r.issues.length ? `无法可靠推算：${r.issues.join('；')}` : `推算余额 ${money(r.expected)} 元；实际余额 ${money(actual.balance)} 元；差额（实际 − 推算）${money(r.difference)} 元。${r.difference === 0 ? '本次金额一致；仍需确认账本无漏记。' : '请核对漏记、方向、付款账户及未入账交易。'} 基准后计入 ${r.applied} 笔。`;
      }
      $('account-result').textContent = text; $('account-result').hidden = false;
    } catch (e) { notify(e.message, true); }
  });
  $('save-account').addEventListener('click', () => {
    try {
      const a = accountInput(); if (!a) return;
      if (!confirm('确认此余额和时间来自实际账户？将替换该账户基准，差额不会被记成消费或收入，资产快照需另行更新。')) return;
      const accounts = [...state.accounts.filter(x => x.account !== a.account), a];
      if (commit({ ...state, accounts }, '账户实际余额基准已保存；资产快照未改变。')) $('account-dialog').close();
    } catch (e) { notify(e.message, true); }
  });
  $('record-history').addEventListener('click', () => {
    if (!state.snapshot || C.project(state).issues.length) return;
    if (!confirm('确认当前展示的余额用于记录历史？股价与未知项目按当前状态保留；此操作不重设自动调整基准。')) return;
    const snapshot = { savedAt: new Date().toISOString(), asOf: new Date().toISOString(), values: C.project(state).values };
    commit({ ...state, history: [...state.history, C.capture(state, snapshot)] }, '当前展示值已记录到资产历史。');
  });
  async function refreshQuote() {
    if (loading || document.hidden) return;
    loading = true; renderQuote();
    const epoch = quoteEpoch;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch('https://push2.eastmoney.com/api/qt/stock/get?secid=1.688111&fields=f43,f57,f58,f86&invt=2', { signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
      if (!response.ok) throw new Error('接口暂不可用');
      const automatic = C.parseQuote(await response.json());
      if (epoch !== quoteEpoch) return;
      const age = Date.now() - Date.parse(automatic.at);
      quoteStatus = age > 24 * 60 * 60 * 1000 ? '最近交易日行情（非当前实时成交）' : '已更新自动行情';
      if (!commit({ ...state, quote: { ...state.quote, automatic } })) quoteStatus = '行情已获取，但无法保存';
    } catch {
      if (epoch === quoteEpoch) quoteStatus = '刷新失败；保留已有价格，可手动输入';
    } finally { clearTimeout(timeout); loading = false; renderQuote(); }
  }
  let importing = false;
  async function importLedger(file) {
    if (!file || importing || recoveryBusy) return;
    if (!/\.xlsx$/i.test(file.name)) return notify('请选择挖财导出的 .xlsx 文件。', true);
    if (file.size > 30 * 1024 * 1024) return notify('文件超过 30 MB，请缩小导出范围。', true);
    importing = true; $('ledger-file').disabled = true; notify('正在本机解析账本…');
    try {
      const buffer = await file.arrayBuffer();
      // Yield once so the progress message can paint before synchronous parsing.
      await new Promise(resolve => requestAnimationFrame(resolve));
      const workbook = XLSX.read(buffer, { type: 'array', cellDates: false });
      const transactions = C.parseWorkbook(workbook, XLSX);
      const next = { ...state, ledger: { importedAt: new Date().toISOString(), transactions } };
      const diff = C.ledgerDiff(state.ledger?.transactions || [], transactions), summary = C.summarize(transactions);
      const projection = C.project(next), before = C.assets(state), after = C.assets(next);
      $('import-summary').textContent = `${summary.count.toLocaleString('zh-CN')} 笔 · ${summary.start} 至 ${summary.end}。相同 ${diff.same} 笔，加入 ${diff.added} 笔，移除 ${diff.removed} 笔。`;
      $('import-impact').textContent = projection?.issues.length ? `自动推算将暂停，显示基准余额：${projection.issues.join('；')}` : after && before ? `展示净额由 ${money(before.total)} 元变为 ${money(after.total)} 元（${after.partial ? '含未知项目，非完整净资产' : '按当前股价'}）。` : '导入账本不会自动建立当前资产余额。';
      const signature = () => JSON.stringify([state.ledger, state.snapshot, state.tracking, state.accounts, state.history]);
      const previewSignature = signature();
      const accepted = await new Promise(resolve => {
        const dialog = $('import-dialog'); let accepted = false;
        const onConfirm = () => { accepted = true; dialog.close(); }, onCancel = () => dialog.close();
        $('confirm-import').addEventListener('click', onConfirm); $('cancel-import').addEventListener('click', onCancel);
        dialog.addEventListener('close', () => { $('confirm-import').removeEventListener('click', onConfirm); $('cancel-import').removeEventListener('click', onCancel); resolve(accepted); }, { once: true });
        dialog.showModal();
      });
      if (!accepted) { notify('已取消导入，原数据保留。'); return; }
      // Do not overwrite changes made while the preview was open (including another tab).
      if (signature() !== previewSignature) throw new Error('预览期间数据已变化，请重新导入');
      const previousRecovery = await recovery('read');
      await recovery('write', state.ledger);
      if (signature() !== previewSignature) { await recovery(previousRecovery === undefined ? 'clear' : 'write', previousRecovery); throw new Error('保存期间数据已变化，请重新导入'); }
      const saved = commit({ ...state, ledger: next.ledger }, `已导入 ${transactions.length.toLocaleString('zh-CN')} 笔记录，文件未上传。${projection?.active ? projection.issues.length ? '余额自动调整暂停，请查看当前快照的核对提示。' : `余额已按基准之后 ${projection.applied} 笔记录调整。` : ''}`);
      if (!saved) await recovery(previousRecovery === undefined ? 'clear' : 'write', previousRecovery);
      $('undo-import').hidden = !saved && previousRecovery === undefined;
    } catch (error) { notify(`导入失败：${error.message} 原数据保留。`, true); }
    finally { importing = false; $('ledger-file').disabled = false; $('ledger-file').value = ''; }
  }
  $('ledger-file').addEventListener('change', e => importLedger(e.target.files[0]));
  const drop = $('ledger-panel') || document.querySelector('.ledger-panel');
  drop.addEventListener('dragover', e => { e.preventDefault(); $('drop-zone').classList.add('dragging'); });
  drop.addEventListener('dragleave', () => $('drop-zone').classList.remove('dragging'));
  drop.addEventListener('drop', e => { e.preventDefault(); $('drop-zone').classList.remove('dragging'); if (e.dataTransfer.files.length !== 1) notify('请一次导入一个挖财文件。', true); else importLedger(e.dataTransfer.files[0]); });
  for (const [key, label, unit] of C.fields) {
    const wrapper = element('label', `${label}（${unit}）`);
    const input = element('input'); input.id = `asset-${key}`; input.name = key; input.type = 'number'; input.min = '0'; input.max = unit === '股' ? '1000000000' : '100000000000'; input.step = unit === '股' ? '1' : '0.01'; input.placeholder = '未知可留空';
    wrapper.append(input); $('asset-fields').append(wrapper);
  }
  $('edit-assets').addEventListener('click', () => {
    const values = C.project(state)?.values;
    for (const [key, , unit] of C.fields) { const value = values?.[key]; $(`asset-${key}`).value = value == null ? '' : unit === '股' ? value : value / 100; }
    $('asset-asof').value = C.localTime(new Date().toISOString());
    $('asset-dialog').showModal();
  });
  $('close-assets').addEventListener('click', () => $('asset-dialog').close());
  $('cancel-assets').addEventListener('click', () => $('asset-dialog').close());
  $('asset-form').addEventListener('submit', e => {
    e.preventDefault();
    try {
      const values = {};
      for (const [key, , unit] of C.fields) { const raw = $(`asset-${key}`).value.trim(); values[key] = raw === '' ? null : unit === '股' ? Number(raw) : C.cents(raw, false); }
      const asOf = new Date($('asset-asof').value + '+08:00').toISOString();
      const snapshot = { savedAt: new Date().toISOString(), asOf, values };
      if (commit({ ...state, snapshot, history: [...state.history, C.capture(state, snapshot)] }, '资产快照已保存并记录历史。')) $('asset-dialog').close();
    } catch (error) { notify(error.message, true); }
  });
  $('price-form').addEventListener('submit', e => {
    e.preventDefault();
    try { const manual = { price: C.cents($('manual-price').value, false), at: new Date().toISOString() }; commit({ ...state, quote: { ...state.quote, mode: 'manual', manual } }, '已采用手动股价。自动行情仍会更新，但不会覆盖手动价格。'); }
    catch (error) { notify(error.message, true); }
  });
  $('auto-price').addEventListener('click', () => { commit({ ...state, quote: { ...state.quote, mode: 'auto' } }, '已恢复采用自动行情。'); refreshQuote(); });
  $('refresh-quote').addEventListener('click', refreshQuote);
  const mappingOptions = [['', '需确认'], ['cash', '现金 / 活期'], ['wealth', '理财'], ['provident', '公积金'], ['shortDebt', '短期负债'], ['otherAssets', '其他资产'], ['otherDebt', '其他负债'], ['stock', '股票（需核对股数）'], ['ignore', '排除于此快照']];
  function suggestField(account) {
    if (/公积金/.test(account)) return 'provident';
    if (/信用卡|花呗|白条|月付/.test(account)) return 'shortDebt';
    if (/理财/.test(account)) return 'wealth';
    if (/股票|证券|金山/.test(account)) return 'stock';
    if (/银行|储蓄|现金|零钱|余额宝|支付宝|借记/.test(account)) return 'cash';
    return '';
  }
  $('edit-tracking').addEventListener('click', () => {
    if (!state.snapshot) return notify('请先填写并保存资产余额及对应时间。', true);
    const accounts = C.ledgerAccounts(state.ledger?.transactions || []);
    if (!accounts.length) return notify('账本缺少账户信息，请重新导入挖财 .xlsx 后设置自动调整。', true);
    const existing = new Map((state.tracking?.mappings || []).map(m => [m.account, m.field]));
    const list = $('tracking-fields'); list.replaceChildren();
    for (const account of [...new Set([...accounts, ...existing.keys()])]) {
      const label = element('label', account), select = element('select');
      select.dataset.account = account;
      for (const [value, name] of mappingOptions) { const option = element('option', name); option.value = value; select.append(option); }
      select.value = existing.get(account) || suggestField(account); label.append(select); list.append(label);
    }
    $('tracking-enabled').checked = Boolean(state.tracking?.enabled);
    $('tracking-dialog').showModal();
  });
  $('close-tracking').addEventListener('click', () => $('tracking-dialog').close());
  $('tracking-form').addEventListener('submit', e => {
    e.preventDefault();
    const mappings = [...$('tracking-fields').querySelectorAll('select')].filter(s => s.value).map(s => ({ account: s.dataset.account, field: s.value }));
    const tracking = { enabled: $('tracking-enabled').checked, mappings };
    if (commit({ ...state, tracking }, '账户分类已保存。之后导入账本时会按余额基准推算；不明确的记录会暂停调整。')) $('tracking-dialog').close();
  });
  $('export-backup').addEventListener('click', () => {
    if (storageBlocked && !originalStored) return notify('浏览器阻止读取本地存储，无法导出原始副本。请检查浏览器设置。', true);
    const blob = new Blob([storageBlocked && originalStored ? originalStored : JSON.stringify(state)], { type: 'application/json' });
    const date = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
    const url = URL.createObjectURL(blob); const link = element('a'); link.href = url; link.download = `family-finance-backup-${date}.json`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify(storageBlocked ? '已生成原始存储副本，请保存文件。内容可能损坏，请保留副本后恢复有效备份。' : '已生成备份，请在浏览器中保存文件；其中包含个人数据，请妥善保管。');
  });
  $('backup-file').addEventListener('change', async e => {
    if (importing || recoveryBusy) { e.target.value = ''; return notify('请先完成或取消当前导入。', true); }
    const file = e.target.files[0]; if (!file) return;
    try {
      if (file.size > 25 * 1024 * 1024) throw new Error('备份超过 25 MB');
      const next = C.validateState(JSON.parse(await file.text())); C.assets(next);
      if (!confirm('此备份将覆盖当前浏览器的账本、资产快照和股价设置。建议先导出当前备份。确定恢复？')) return;
      quoteEpoch++; quoteStatus = '已恢复备份中的价格；等待刷新';
      if (commit(next, '备份已恢复到当前浏览器。', true)) { await recovery('clear'); $('undo-import').hidden = true; } refreshQuote();
    } catch (error) { notify(`恢复失败：${error.message}。原数据保留。`, true); }
    finally { e.target.value = ''; }
  });
  $('clear-data').addEventListener('click', async () => {
    if (importing || recoveryBusy) return notify('请先完成或取消当前导入。', true);
    if (!confirm('删除此浏览器保存的所有账本、资产和股价设置？请先导出备份。')) return;
    try { await recovery('clear'); $('undo-import').hidden = true; localStorage.removeItem(STORAGE_KEY); quoteEpoch++; state = C.emptyState(); storageBlocked = false; originalStored = null; quoteStatus = '已清空；点击刷新获取行情'; render(); notify('本地数据已清空。'); }
    catch { notify('浏览器未允许清空存储，请检查浏览器设置。', true); }
  });
  window.addEventListener('storage', e => {
    if (e.key !== STORAGE_KEY) return;
    try { const next = e.newValue ? C.validateState(JSON.parse(e.newValue)) : C.emptyState(); C.assets(next); state = next; quoteEpoch++; render(); notify('数据已随此浏览器的另一个页面更新。'); }
    catch { notify('另一个页面写入的数据无法识别，当前页面保留原数据。', true); }
  });
  render(); refreshQuote();
  setInterval(refreshQuote, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshQuote(); });
})();
