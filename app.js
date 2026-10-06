(function () {
  'use strict';
  const C = window.FinanceCore;
  const STORAGE_KEY = 'family-finance-dashboard.v1';
  const $ = id => document.getElementById(id);
  const money = cents => (cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
    $('snapshot-date').textContent = state.snapshot ? `余额保存于 ${time(state.snapshot.savedAt)}` : '尚未保存快照';
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
  function render() { renderLedger(); renderAssets(); renderQuote(); }
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
    if (!file || importing) return;
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
      if (state.ledger && !confirm(`导入 ${transactions.length.toLocaleString('zh-CN')} 笔记录并替换当前账本？资产快照保持不变。`)) { notify('已取消导入，原数据保留。'); return; }
      commit(next, `已导入 ${transactions.length.toLocaleString('zh-CN')} 笔记录，文件未上传。`);
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
    for (const [key, , unit] of C.fields) { const value = state.snapshot?.values[key]; $(`asset-${key}`).value = value == null ? '' : unit === '股' ? value : value / 100; }
    $('asset-dialog').showModal();
  });
  $('close-assets').addEventListener('click', () => $('asset-dialog').close());
  $('cancel-assets').addEventListener('click', () => $('asset-dialog').close());
  $('asset-form').addEventListener('submit', e => {
    e.preventDefault();
    try {
      const values = {};
      for (const [key, , unit] of C.fields) { const raw = $(`asset-${key}`).value.trim(); values[key] = raw === '' ? null : unit === '股' ? Number(raw) : C.cents(raw, false); }
      const snapshot = { savedAt: new Date().toISOString(), values };
      if (commit({ ...state, snapshot }, '资产快照已保存。')) $('asset-dialog').close();
    } catch (error) { notify(error.message, true); }
  });
  $('price-form').addEventListener('submit', e => {
    e.preventDefault();
    try { const manual = { price: C.cents($('manual-price').value, false), at: new Date().toISOString() }; commit({ ...state, quote: { ...state.quote, mode: 'manual', manual } }, '已采用手动股价。自动行情仍会更新，但不会覆盖手动价格。'); }
    catch (error) { notify(error.message, true); }
  });
  $('auto-price').addEventListener('click', () => { commit({ ...state, quote: { ...state.quote, mode: 'auto' } }, '已恢复采用自动行情。'); refreshQuote(); });
  $('refresh-quote').addEventListener('click', refreshQuote);
  $('export-backup').addEventListener('click', () => {
    if (storageBlocked && !originalStored) return notify('浏览器阻止读取本地存储，无法导出原始副本。请检查浏览器设置。', true);
    const blob = new Blob([storageBlocked && originalStored ? originalStored : JSON.stringify(state)], { type: 'application/json' });
    const date = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
    const url = URL.createObjectURL(blob); const link = element('a'); link.href = url; link.download = `family-finance-backup-${date}.json`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify(storageBlocked ? '已生成原始存储副本，请保存文件。内容可能损坏，请保留副本后恢复有效备份。' : '已生成备份，请在浏览器中保存文件；其中包含个人数据，请妥善保管。');
  });
  $('backup-file').addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    try {
      if (file.size > 25 * 1024 * 1024) throw new Error('备份超过 25 MB');
      const next = C.validateState(JSON.parse(await file.text())); C.assets(next);
      if (!confirm('此备份将覆盖当前浏览器的账本、资产快照和股价设置。建议先导出当前备份。确定恢复？')) return;
      quoteEpoch++; quoteStatus = '已恢复备份中的价格；等待刷新';
      commit(next, '备份已恢复到当前浏览器。', true); refreshQuote();
    } catch (error) { notify(`恢复失败：${error.message}。原数据保留。`, true); }
    finally { e.target.value = ''; }
  });
  $('clear-data').addEventListener('click', () => {
    if (!confirm('删除此浏览器保存的所有账本、资产和股价设置？请先导出备份。')) return;
    try { localStorage.removeItem(STORAGE_KEY); quoteEpoch++; state = C.emptyState(); storageBlocked = false; originalStored = null; quoteStatus = '已清空；点击刷新获取行情'; render(); notify('本地数据已清空。'); }
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
