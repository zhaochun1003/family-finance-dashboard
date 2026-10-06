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
  let applyingCloud = false, cloudSync = null;
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
      if (!applyingCloud) window.dispatchEvent(new Event('finance-change'));
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
    const result=C.assets(state), financial=C.financial(state), projection=C.project(state);
    $('net-value').textContent=financial?.any ? headline(financial.total) : '—';
    $('net-label').textContent=financial?.partial ? '已知金融项目净额' : '金融净资产';
    $('net-note').textContent=!financial ? '添加余额后显示' : financial.partial ? '金融项目尚未填全 · 元' : '现金、理财、公积金、股票 − 短债 · 元';
    $('liquid-value').textContent=financial?.liquid===null || !financial ? '—' : headline(financial.liquid);
    $('concentration-value').textContent=financial?.concentration==null ? '—' : (financial.concentration*100).toFixed(1)+'%';
    $('stock-value').textContent=result?.stock==null ? '—' : headline(result.stock);
    const quote=C.activeQuote(state), shares=projection?.values.shares;
    $('stock-note').textContent=shares==null ? '持股数量 × 采用价格' : `${shares.toLocaleString('zh-CN')} 股 · ${quote ? '价格时间 '+time(quote.at) : '缺少股价'}`;
    const list=$('asset-list'), composition=$('asset-composition'); list.replaceChildren();composition.replaceChildren();
    $('snapshot-date').textContent=state.accounts.length ? '余额来源：账户页；每个账户保留自己的基准时间' : '尚未建立余额';
    $('tracking-status').textContent=projection?.issues.length ? `推算暂停，显示各账户原基准余额：${projection.issues.slice(0,3).join('；')}` : projection?.active ? '已启用账本推算，仍需定期核对实际余额。' : '当前展示已填写余额；账本推算未启用。';
    const colors={cash:'#68b7cf',wealth:'#2d88ca',provident:'#6a88b5',shares:'#174574',otherAssets:'#87a9be'};
    const positive=result?.items.reduce((sum,[,v])=>sum+Math.max(0,v??0),0)||0;
    if(result) for(const [key,value] of result.items) {
      const entry=element('div'), label=key==='shares' ? '股票市值' : C.fields.find(f=>f[0]===key)[1].replace('其他资产','其他家庭资产').replace('其他负债','其他家庭负债');
      entry.append(element('dt',label),element('dd',value===null?'未知':money(value)));list.append(entry);
      if(value>0 && positive>0){const segment=element('span');segment.style.width=`${value/positive*100}%`;segment.style.backgroundColor=colors[key];segment.title=label+' '+money(value)+' 元';composition.append(segment);}
    }
    else list.append(element('p','添加账户余额，或先填写分类余额建立基准。','muted'));
    $('unvested-note').textContent=result?.unvested==null ? '待归属股数未知，不计当前净资产。' : `待归属 ${result.unvested.toLocaleString('zh-CN')} 股，不计当前净资产。`;
    $('family-status').textContent=!result?'尚未核全家庭资产。':`已知家庭项目净额 ${headline(result.total)}。${result.partial?'其他家庭项目仍有未知项。':'字段已填全，家庭覆盖范围仍需人工确认。'}`;
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
  let activeView='summary', editingAccount=null, splittingAccount=null;
  const purposeLabels={unknown:'用途待核实',consumption:'消费',family:'家庭拨款 / 礼物',investment:'资产取得 / 股权认购',debt:'债务清偿 / 垫款归还',refund:'退款',adjustment:'记账调整'};
  function showView(view) {
    const changed=activeView!==view;activeView=view;
    for(const page of document.querySelectorAll('[data-page]')) page.hidden=page.dataset.page!==view;
    const root=['summary','ledger','settings'].includes(view)?view:'summary';
    for(const button of document.querySelectorAll('[data-view]')) button.setAttribute('aria-pressed',String(button.dataset.view===root));
    $('detail-nav').hidden=['summary','ledger','settings'].includes(view);
    const titles={summary:['资产总览','看看现在的资产，以及需要关注的变化。'],ledger:['我的账本','导入一次，查看收入和资金去向。'],settings:['我的','管理数据、备份和设备。'],accounts:['账户余额','更新实际余额，总览随之更新。'],notes:['核实与事件','保留资金变化的原因和依据。'],equity:['股票与归属','查看持仓估值和归属资金情景。'],history:['资产历史','查看已确认的资产记录。']};
    $('view-title').textContent=titles[view][0];$('view-subtitle').textContent=titles[view][1];
    $('data-health').hidden=view!=='summary';
    if(changed)window.scrollTo({top:0,behavior:'instant'});
  }
  for(const button of document.querySelectorAll('[data-view],[data-open]')) button.addEventListener('click',()=>showView(button.dataset.view||button.dataset.open));
  $('update-data').addEventListener('click',()=>$('update-dialog').showModal());
  $('close-update').addEventListener('click',()=>$('update-dialog').close());
  $('back-summary').addEventListener('click',()=>showView('summary'));
  $('update-ledger').addEventListener('click',()=>{$('update-dialog').close();showView('ledger');$('ledger-file').click();});
  $('update-balances').addEventListener('click',()=>{$('update-dialog').close();if(state.snapshot)showView('accounts');else $('edit-assets').click();});
  $('update-restore').addEventListener('click',()=>{$('update-dialog').close();showView('settings');$('backup-file').click();});
  function renderReview() {
    const projection=C.project(state), f=C.financial(state);
    $('data-health').textContent=!projection ? state.ledger?'账本已导入。点击“更新数据”恢复完整备份或填写余额，即可建立资产总览。':'点击“更新数据”开始：恢复完整备份，或分别导入账本与填写余额。' : projection.issues.length ? `余额推算已暂停，展示各账户基准余额，不能视为同一时点的当前余额。${projection.issues.slice(0,3).join('；')}` : `${f?.partial?'金融项目尚未核全。':'金融账户口径；完整家庭资产仍需核实。'} ${projection.active?'余额按账本推算，需与实际账户核对。':'展示实际余额基准。'} 行情时间与余额时间分别保留。`;
    $('data-health').classList.toggle('error',Boolean(projection?.issues.length));
    const rows=$('account-rows');rows.replaceChildren();
    for(const a of state.accounts) {
      const p=C.accountProjection(state,a), shown=projection?.issues.length ? a.balance : p.balance;
      const row=element('tr');
      row.append(element('td',a.account),element('td',a.field?C.fields.find(f=>f[0]===a.field)[1]:'未纳入资产'),element('td',shown===null?'未知':money(shown)),element('td',time(a.at)));
      const cell=element('td'), button=element('button','核对 / 更新','text-button');button.addEventListener('click',()=>openAccount(a));cell.append(button);
      if(a.field && a.members===null && a.balance!==null){const split=element('button','拆分明细','text-button');split.addEventListener('click',()=>{splittingAccount=a;$('split-meta').textContent=`${a.account} · 当前展示 ${shown===null?'未知':money(shown)+' 元'}；拆分后这些账户直接计入首页。`;$('split-entries').value='';$('split-dialog').showModal();});cell.append(split);}
      row.append(cell);rows.append(row);
    }
    $('account-empty').hidden=Boolean(state.accounts.length);
    const history=$('history-rows');history.replaceChildren();
    for(const h of [...state.history].sort((a,b)=>b.at.localeCompare(a.at))) {const row=element('tr');for(const v of [time(h.at),money(h.total),h.partial?'已知家庭项目净额':'已填写家庭项目净额',h.price===null?'未知':money(h.price)])row.append(element('td',v));history.append(row);}
    $('history-empty').hidden=Boolean(state.history.length);
    $('record-history').disabled=!projection || Boolean(projection.issues.length);
    const attention=$('attention-list');attention.replaceChildren();
    const items=[];
    if(!state.snapshot)items.push(state.ledger?'账本已准备好，请补充当前余额或恢复完整备份。':'从“更新数据”开始建立你的财务首页。');
    if(projection?.issues.length)items.push(...projection.issues.slice(0,3));
    if(state.accounts.some(a=>a.field && a.members===null && a.balance!==null))items.push('部分余额仍为分类汇总，可用完整明细拆分；不要重复添加已包含的账户。');
    if(!state.history.length)items.push('资产历史尚无记录，确认当前余额后可记录第一份。');
    for(const n of state.notes){const matches=C.noteMatches(state,n);if(n.status==='pending'||matches.some(m=>m.count!==1))items.push(`${n.title}${matches.some(m=>m.count!==1)?'：关联交易需重核':''}`);}
    if(!items.length)items.push('暂无已标记事项；请定期核对账户余额及备份。');
    for(const item of items.slice(0,1))attention.append(element('li',item));
  }
  function renderFlow() {
    const month=$('flow-month').value, flow=C.cashflow(state,month);
    $('flow-summary').textContent=!state.ledger?'导入账本后显示。':`${month} · 原账收入 ${money(flow.income)} 元，原账支出 ${money(flow.expense)} 元，差额 ${money(flow.difference)} 元；${flow.transfers} 笔转账、${flow.loans} 笔借贷另列。${flow.unreviewed} 笔收支尚无唯一确认用途。`;
    const list=$('flow-buckets');list.replaceChildren();
    for(const [purpose,value]of Object.entries(flow.buckets)){const row=element('div');row.append(element('span',purposeLabels[purpose]),element('span',money(value)+' 元'));list.append(row);}
  }
  function renderNotes() {
    const list=$('note-list');list.replaceChildren();
    for(const n of state.notes) {
      const card=element('article',undefined,'note-card');card.dataset.status=n.status;card.append(element('h3',n.title),element('p',`${n.status==='confirmed'?'结论已确认':'待核对 / 待处理'} · ${n.purpose==='unknown'?'背景 / 未用于收支归类':purposeLabels[n.purpose]}`,'small muted'),element('p',n.detail),element('p','依据：'+(n.source||'未填写'),'small muted'));
      const matches=C.noteMatches(state,n);card.append(element('p',!n.keys.length?'事件背景，未关联具体交易。':`关联 ${n.keys.length} 条；唯一匹配 ${matches.filter(m=>m.count===1).length} 条；${matches.filter(m=>m.count!==1).length} 条缺失或不唯一，需重新核对。`,'small muted'));
      const button=element('button','编辑 / 关联交易','text-button');button.addEventListener('click',()=>openNote(n));card.append(button);list.append(card);
    }
    $('note-empty').hidden=Boolean(state.notes.length);
  }
  function renderEquity() {
    const p=C.project(state), f=C.financial(state), result=C.equityScenario(state);
    $('equity-baseline').textContent=!p?'先填写持股和资产余额。':`已归属持股 ${p.values.shares===null?'未知':p.values.shares} 股；待归属 ${p.values.unvested===null?'未知':p.values.unvested} 股。${f?.stock===null?'':`当前股票市值 ${money(f.stock)} 元。`}`;
    for(const key of ['price','subscription','tax']) if(document.activeElement!==$('scenario-'+key))$('scenario-'+key).value=state.scenario?.[key]==null?'':state.scenario[key]/100;
    $('scenario-result').textContent=p?.issues.length?'余额推算存在问题，请先核实；情景暂不展示。':!result?'补齐股数、金融余额及情景金额后计算；未知认购款与税款不会按 0 处理。':`全部归属后的情景股票市值 ${money(result.stock)} 元；认购与税款合计 ${money(result.cost)} 元；情景金融净额 ${money(result.total)} 元；现金与理财净额 ${money(result.liquid)} 元${result.liquid<0?'，存在资金缺口':''}。`;
  }
  function render() { renderLedger();renderAssets();renderQuote();renderReview();renderFlow();renderNotes();renderEquity();for(const id of ['account-rows','history-rows']){const body=$(id),labels=[...body.closest('table').querySelectorAll('thead th')].map(th=>th.textContent);for(const row of body.rows)for(let i=0;i<row.cells.length;i++)row.cells[i].dataset.label=labels[i];}showView(activeView); }
  function openAccount(a) {
    editingAccount=a||null;
    const names=$('account-names');names.replaceChildren();for(const name of C.ledgerAccounts(state.ledger?.transactions||[])){const option=element('option');option.value=name;names.append(option);}
    $('account-name').value=a?.account||'';$('account-name').disabled=Boolean(a);$('account-field').value=a?.field||'';$('account-field').disabled=Boolean(a?.field);
    $('account-debt').checked=a?.debt||false;$('account-debt').disabled=Boolean(a?.field);
    $('account-baseline-note').textContent=a?`原实际余额 ${a.balance===null?'未知':money(a.balance)+' 元'} · ${time(a.at)}。确认后首页自动更新。`:'已有分类汇总所包含的账户请使用“拆分明细”，避免重复计入。';
    $('account-balance').value='';$('account-at').value=C.localTime(new Date().toISOString());$('account-result').hidden=true;$('account-dialog').showModal();
  }
  function accountInput() {
    if(!$('account-form').reportValidity())return null;
    const account=$('account-name').value.trim();if(!account)throw new Error('请输入账户名称');
    const field=$('account-field').value||null;
    return {account,field,debt:field?C.debtFields.includes(field):$('account-debt').checked,balance:C.cents($('account-balance').value,false),at:new Date($('account-at').value+'+08:00').toISOString(),members:editingAccount?.members===null?null:[account]};
  }
  $('edit-account').addEventListener('click',()=>openAccount());$('close-account').addEventListener('click',()=>$('account-dialog').close());
  $('account-form').addEventListener('submit',e=>{
    e.preventDefault();try{const actual=accountInput();if(!actual)return;const baseline=state.accounts.find(a=>a.account===actual.account);let text;
      if(!baseline||baseline.balance===null)text='尚无已知余额基准，请用实际余额建立。';
      else{if(baseline.debt!==actual.debt)throw new Error('资产 / 负债口径与原基准不同');const r=C.reconcile(state,baseline,actual.balance,actual.at);text=r.issues.length?'无法可靠推算：'+r.issues.join('；'):`推算 ${money(r.expected)} 元，实际 ${money(actual.balance)} 元；差额（实际 − 推算）${money(r.difference)} 元。金额一致仍不能证明没有漏记。`;}
      $('account-result').textContent=text;$('account-result').hidden=false;
    }catch(e){notify(e.message,true);}
  });
  $('save-account').addEventListener('click',()=>{
    try{const account=accountInput();if(!account)return;if(!confirm('确认这是对应时间的实际余额？将更新账户及首页资产；差额不记作收入或消费。'))return;
      const next=C.saveAccount(state,account);if(commit(next,'账户余额已保存，首页资产已重新汇总。'))$('account-dialog').close();
    }catch(e){notify(e.message,true);}
  });
  $('close-split').addEventListener('click',()=>$('split-dialog').close());
  $('split-form').addEventListener('submit',e=>{
    e.preventDefault();try{const entries=$('split-entries').value.trim().split(/\n/).map(line=>{const parts=line.split('|');if(parts.length!==2)throw new Error('每行需要“账户名称 | 余额”');return {account:parts[0].trim(),balance:C.cents(parts[1],false)};});
      if(!confirm('确认明细是同一时间的完整实际余额？将用明细替换分类汇总，金额不重复计入。'))return;
      const next=C.splitAccount(state,splittingAccount.account,entries,new Date().toISOString());if(commit(next,'分类汇总已拆分；首页改为账户明细汇总。'))$('split-dialog').close();
    }catch(e){notify(e.message,true);}
  });
  $('record-history').addEventListener('click',()=>{
    const p=C.project(state);if(!p||p.issues.length)return;
    if(!confirm('确认当前展示余额用于记录历史？此操作不改变账户基准，股价按现在冻结。'))return;
    const snapshot={savedAt:new Date().toISOString(),asOf:new Date().toISOString(),values:p.values};commit({...state,history:[...state.history,C.capture(state,snapshot)]},'当前展示值已记录到资产历史。');
  });
  $('flow-month').value=C.localTime(new Date().toISOString()).slice(0,7);$('flow-month').addEventListener('change',renderFlow);
  $('scenario-form').addEventListener('submit',e=>{e.preventDefault();try{const scenario=Object.fromEntries(['price','subscription','tax'].map(k=>[k,$('scenario-'+k).value.trim()===''?null:C.cents($('scenario-'+k).value,false)]));commit({...state,scenario},'情景已保存在本浏览器，不改变当前资产。');}catch(e){notify(e.message,true);}});
  let editingNote=null, selectedKeys=new Set();
  function openNote(note) {
    editingNote=note||null;selectedKeys=new Set(note?.keys||[]);
    for(const key of ['title','detail','source'])$('note-'+key).value=note?.[key]||'';
    $('note-status').value=note?.status||'pending';$('note-purpose').value=note?.purpose||'unknown';$('note-search').value='';renderNoteSearch();$('note-dialog').showModal();
  }
  function renderNoteSearch() {
    const query=$('note-search').value.trim().toLowerCase(), list=$('note-transactions');list.replaceChildren();
    const records=(state.ledger?.transactions||[]).filter(t=>selectedKeys.has(C.transactionKey(t)) || (query && `${t.at||t.date} ${t.account||''} ${t.category} ${t.amount/100}`.toLowerCase().includes(query))).slice(0,60);
    for(const t of records){const key=C.transactionKey(t),label=element('label'),input=element('input');input.type='checkbox';input.checked=selectedKeys.has(key);input.addEventListener('change',()=>input.checked?selectedKeys.add(key):selectedKeys.delete(key));label.append(input,document.createTextNode(`${t.at||t.date} · ${t.type} · ${t.category} · ${money(t.amount)} 元 · ${t.account||'账户未知'}`));list.append(label);}
    if(!records.length)list.append(element('p',query?'没有匹配交易。':'输入关键词筛选；最多显示 60 条。','small muted'));
  }
  $('add-note').addEventListener('click',()=>openNote());$('close-note').addEventListener('click',()=>$('note-dialog').close());$('note-search').addEventListener('input',renderNoteSearch);$('clear-note-links').addEventListener('click',()=>{selectedKeys.clear();renderNoteSearch();});
  $('note-form').addEventListener('submit',e=>{e.preventDefault();const note={id:editingNote?.id||crypto.randomUUID(),title:$('note-title').value.trim(),detail:$('note-detail').value,source:$('note-source').value,status:$('note-status').value,purpose:$('note-purpose').value,keys:[...selectedKeys]};if(commit({...state,notes:[...state.notes.filter(n=>n.id!==note.id),note]},'核实记录已保存，原账本未修改。'))$('note-dialog').close();});
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
      const projection = C.project(next), before = C.financial(state), after = C.financial(next);
      $('import-summary').textContent = `${summary.count.toLocaleString('zh-CN')} 笔 · ${summary.start} 至 ${summary.end}。相同 ${diff.same} 笔，加入 ${diff.added} 笔，移除 ${diff.removed} 笔。`;
      $('import-impact').textContent = projection?.issues.length ? `自动推算将暂停，显示基准余额：${projection.issues.join('；')}` : after && before ? `金融净额由 ${money(before.total)} 元变为 ${money(after.total)} 元（${after.partial ? '含未知项目，非完整净资产' : '按当前股价'}）。` : '导入账本不会自动建立当前资产余额。';
      const signature = () => JSON.stringify([state.ledger, state.snapshot, state.tracking, state.accounts, state.history, state.notes, state.scenario]);
      const changes=C.ledgerChanges(state.ledger?.transactions||[],transactions),changeRows=$('import-change-rows');changeRows.replaceChildren();
      for(const [kind,records]of [['加入',changes.added],['移除',changes.removed]])for(const t of records){const row=element('tr');for(const value of [kind,t.at||t.date,`${t.type} / ${t.category}`,money(t.amount),t.account||'未知'])row.append(element('td',value));changeRows.append(row);}
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
      const saved = commit({ ...state, ledger: next.ledger }, `已导入 ${transactions.length.toLocaleString('zh-CN')} 笔记录，原始 Excel 文件未上传。${projection?.active ? projection.issues.length ? '余额自动调整暂停，请查看当前快照的核对提示。' : `余额已按基准之后 ${projection.applied} 笔记录调整。` : ''}`);
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
    for (const [key, , unit] of C.fields) { const value = values?.[key]; $(`asset-${key}`).value = value == null ? '' : unit === '股' ? value : value / 100; $(`asset-${key}`).disabled = C.moneyFields.includes(key) && state.accounts.some(a=>a.field===key); }
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
      const accounts=[...state.accounts]; for(const field of C.moneyFields)if(!accounts.some(a=>a.field===field))accounts.push({account:`分类汇总 · ${C.fields.find(f=>f[0]===field)[1]}`,field,members:null,debt:C.debtFields.includes(field),balance:values[field],at:asOf});
      const next={...state,snapshot,accounts}; const frozen={...snapshot,values:C.project(next).values};
      if(commit({...next,history:[...state.history,C.capture(next,frozen)]},'股数与初始余额已保存，已有账户余额保持。'))$('asset-dialog').close();
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
    try { cloudSync?.pause(); await recovery('clear'); $('undo-import').hidden = true; localStorage.removeItem(STORAGE_KEY); quoteEpoch++; state = C.emptyState(); storageBlocked = false; originalStored = null; quoteStatus = '已清空；点击刷新获取行情'; render(); notify('本地数据已清空。'); }
    catch { notify('浏览器未允许清空存储，请检查浏览器设置。', true); }
  });
  window.addEventListener('storage', e => {
    if (e.key !== STORAGE_KEY) return;
    try { const next = e.newValue ? C.validateState(JSON.parse(e.newValue)) : C.emptyState(); C.assets(next); state = next; quoteEpoch++; render(); notify('数据已随此浏览器的另一个页面更新。'); }
    catch { notify('另一个页面写入的数据无法识别，当前页面保留原数据。', true); }
  });
  cloudSync = window.FinanceSync?.init({
    get: () => state,
    blocked: () => storageBlocked || importing || recoveryBusy || !!document.querySelector('dialog[open]'),
    apply: next => { applyingCloud = true; try { quoteEpoch++; return commit(next, '已读取云端数据。'); } finally { applyingCloud = false; } }
  });
  render(); refreshQuote();
  setInterval(refreshQuote, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshQuote(); });
})();
