(function () {
  'use strict';
  const MAX_JSON=25*1024*1024, MAX_PACKED=1500000;
  const META_KEY='family-finance-cloud.supabase.v1';
  const transport=window.FinanceCloud;
  const canonical=state=>JSON.stringify({...state,quote:{...state.quote,automatic:null}});
  const hash=async text=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(x=>x.toString(16).padStart(2,'0')).join('');
  async function pack(text) {
    const bytes=new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
    const payload=btoa(binary);if(payload.length>MAX_PACKED)throw new Error('账本超过当前同步容量，请保留本地备份');return payload;
  }
  async function unpack(payload) {
    if(typeof payload!=='string'||payload.length>MAX_PACKED)throw new Error('云端内容超过容量');
    const bytes=Uint8Array.from(atob(payload),c=>c.charCodeAt(0));
    const reader=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
    const chunks=[];let size=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>MAX_JSON){await reader.cancel();throw new Error('云端备份解压后超过容量');}chunks.push(value);}}finally{reader.releaseLock();}
    return new Blob(chunks).text();
  }
  function hasData(state) {return !!(state.ledger||state.snapshot||state.accounts.length||state.notes.length||state.history.length||state.tracking||state.scenario||state.quote.manual);}
  function init(adapter) {
    const $=id=>document.getElementById(id);
    let enabled=false,meta=null,busy=false,again=false,conflict=null,authenticated=false;
    let corruptMeta=false;
    try {const saved=localStorage.getItem(META_KEY);if(saved){meta=JSON.parse(saved);if(meta.version!==1||typeof meta.enabled!=='boolean'||!Number.isSafeInteger(meta.revision)||meta.revision<0||!(meta.base===null||/^[a-f0-9]{64}$/.test(meta.base)))throw new Error('meta');enabled=meta.enabled;}}catch{corruptMeta=true;}
    function status(text,error=false) {$('sync-status').textContent=text;$('sync-status').classList.toggle('error',error);const badge=document.querySelector?.('.local-badge');if(badge){badge.textContent=text.startsWith('已同步')?'已同步':error?'同步需检查':enabled?'同步已开启':'仅本机保存';badge.title=text;}}
    function save(revision,base) {const next={version:1,enabled,revision,base};localStorage.setItem(META_KEY,JSON.stringify(next));meta=next;}
    async function api(path,options={}) {
      const response=transport ? await transport.request(path,options) : await fetch(path,{...options,credentials:'same-origin',cache:'no-store',headers:{'X-Finance-Request':'1',...(options.body?{'Content-Type':'application/json'}:{}),...options.headers}});
      if(response.status===401){authenticated=false;throw new Error('登录已过期，请重新登录；本地数据保留');}
      if(response.status===409){const error=new Error('另一台设备已更新');error.conflict=true;throw error;}
      if(!response.ok)throw new Error('云服务暂时不可用，数据已保存在本机');
      return response.json();
    }
    async function remote() {
      const row=await api('/api/snapshot');
      if(!Number.isSafeInteger(row.revision)||row.revision<0)throw new Error('无法识别云端版本');
      if(!row.revision)return {...row,state:null,base:null};
      if(await hash(row.payload)!==row.digest)throw new Error('云端备份校验失败，本地数据保留');
      const state=window.FinanceCore.validateState(JSON.parse(await unpack(row.payload)));window.FinanceCore.assets(state);
      return {...row,state,base:await hash(canonical(state))};
    }
    function showConflict(row) {conflict=row;$('sync-conflict').hidden=false;status('两台设备的数据不同，请选择保留哪一份。自动覆盖已暂停。',true);}
    async function adopt(row) {
      if(!enabled)return;
      if(adapter.blocked()){status('云端有更新，完成当前操作后会自动读取。');return;}
      const localQuote=adapter.get().quote.automatic,cloudQuote=row.state.quote.automatic;
      const automatic=localQuote&&(!cloudQuote||Date.parse(localQuote.at)>=Date.parse(cloudQuote.at))?localQuote:cloudQuote;
      const next={...row.state,quote:{...row.state.quote,automatic}};
      if(!adapter.apply(next))throw new Error('无法保存云端数据，本地原数据保留');
      save(row.revision,row.base);status('已同步 · '+new Date(row.updated_at).toLocaleString('zh-CN'));conflict=null;$('sync-conflict').hidden=true;
    }
    async function upload(revision) {
      const text=canonical(adapter.get()),base=await hash(text),payload=await pack(JSON.stringify(adapter.get()));
      if(!enabled)return;
      const row=await api('/api/snapshot',{method:'PUT',body:JSON.stringify({revision,payload,digest:await hash(payload)})});
      save(row.revision,base);status('已同步 · '+new Date(row.updated_at).toLocaleTimeString('zh-CN'));
      if(await hash(canonical(adapter.get()))!==base)again=true;
    }
    async function reconcile() {
      if(!enabled||!authenticated||corruptMeta)return;
      if(busy){again=true;return;}busy=true;
      try {
        if(adapter.blocked()){status('完成当前操作后继续同步。');return;}
        const head=await api('/api/snapshot?meta=1');
        if(!enabled)return;
        let localBase=await hash(canonical(adapter.get()));
        if(meta&&meta.base!==null&&head.revision===meta.revision){
          if(localBase!==meta.base){status('正在同步…');await upload(head.revision);}
          else if(head.revision){
            const row=await remote();
            if(!enabled)return;
            if(row.revision!==meta.revision||await hash(canonical(adapter.get()))!==meta.base){again=true;return;}
            const localQuote=adapter.get().quote.automatic,cloudQuote=row.state.quote.automatic;
            if(localQuote&&(!cloudQuote||Date.parse(localQuote.at)>Date.parse(cloudQuote.at)))await upload(head.revision);
            else if(cloudQuote&&(!localQuote||Date.parse(cloudQuote.at)>Date.parse(localQuote.at)))await adopt(row);
            else status('已同步 · 自动同步已开启');
          }else status('云端为空，更新数据后会自动同步。');
          return;
        }
        const row=await remote();
        if(!enabled)return;
        // The user may have edited during the network request. Compare the latest copy.
        localBase=await hash(canonical(adapter.get()));
        if(meta&&meta.revision>row.revision){again=true;return;}
        if(!row.revision){
          if(hasData(adapter.get()))await upload(0);else{save(0,localBase);status('云端为空，更新数据后会自动同步。');}return;
        }
        if(row.base===localBase){save(row.revision,row.base);conflict=null;$('sync-conflict').hidden=true;status('已同步');return;}
        if((meta&&localBase===meta.base)||((!meta||meta.base===null)&&!hasData(adapter.get()))){await adopt(row);return;}
        showConflict(row);
      } catch(error) {
        if(error.conflict){try{showConflict(await remote());}catch(e){status(e.message,true);}}
        else status(error.message,true);
      } finally {busy=false;if(again){again=false;setTimeout(reconcile,1000);}}
    }
    $('sync-use-cloud').addEventListener('click',async()=>{
      if(!conflict||busy||adapter.blocked())return;
      if(!confirm('采用云端数据将覆盖这台设备的账本和资产。请先导出本机备份。确定采用？'))return;
      busy=true;try{await adopt(await remote());}catch(e){status(e.message,true);}finally{busy=false;}
    });
    $('sync-use-local').addEventListener('click',async()=>{
      if(!conflict||busy||adapter.blocked())return;
      if(!confirm('将这台设备的数据覆盖云端版本，其他设备随后会读取这一份。请先保留两份备份。确定覆盖？'))return;
      busy=true;try{await upload(conflict.revision);conflict=null;$('sync-conflict').hidden=true;}catch(e){status(e.conflict?'另一台设备又有更新，请刷新后重新比较。':e.message,true);}finally{busy=false;}
    });
    $('sync-enable').addEventListener('click',async()=>{
      if(!authenticated){$('sync-login').hidden=false;$('sync-email').focus();return;}
      if(!confirm('启用后，账本交易、账户资产、核实记录和资产历史会同步到你账户下的 Supabase 私有数据库；其他已登录设备会自动读取。原始 Excel 文件不上传。确定启用？'))return;
      enabled=true;
      try{save(meta?.revision||0,meta?.base||null);}catch{enabled=false;status('无法保存同步设置，请检查浏览器存储权限；财务数据未上传。',true);return;}
      corruptMeta=false;$('sync-enable').hidden=true;$('sync-pause').hidden=false;await reconcile();
    });
    function pause() {enabled=false;save(meta?.revision||0,meta?.base||null);status('同步已暂停，本机和云端数据均保留。');$('sync-enable').hidden=false;$('sync-pause').hidden=true;}
    $('sync-pause').addEventListener('click',pause);
    $('sync-logout').addEventListener('click',async()=>{try{await api('/auth/logout',{method:'POST'});pause();authenticated=false;$('sync-enable').textContent='邮箱登录';$('sync-logout').hidden=true;status('已退出登录，本机数据仍保留。');}catch(e){status(e.message,true);}});
    async function start() {
      if(transport){$('sync-controls').hidden=false;$('sync-local-description').hidden=true;}
      try {
        const response=transport ? await transport.request('/api/status') : await fetch('/api/status',{cache:'no-store'});
        if(!response.ok||!(response.headers.get('Content-Type')||'').includes('application/json'))return;
        const service=await response.json();if(!service.available)return;
        $('sync-controls').hidden=false;$('sync-local-description').hidden=true;
        if(!service.configured){status('同步服务正在配置，本地使用不受影响。');$('sync-enable').disabled=true;return;}
        $('sync-enable').disabled=false;
        try{await api('/api/me');authenticated=true;}catch{authenticated=false;}
        $('sync-enable').textContent=authenticated?'启用自动同步':'邮箱登录';$('sync-logout').hidden=!authenticated;
        $('sync-enable').hidden=enabled&&authenticated;$('sync-pause').hidden=!(enabled&&authenticated);
        if(corruptMeta){enabled=false;status('同步设置无法读取，请重新启用；财务数据未改动。',true);}
        else if(!authenticated)status('登录后，手机与电脑可共享同一份数据。');
        else if(!enabled){$('sync-login').hidden=true;status('已登录。启用同步后，当前数据才会存入云端。');}
        else await reconcile();
      }catch{status('无法连接同步服务，本地数据保留。',true);}
    }
    window.addEventListener('finance-change',()=>{if(conflict){status('本机有修改，选择数据版本后再同步。',true);return;}reconcile();});
    window.addEventListener('online',reconcile);
    window.addEventListener('storage',event=>{
      if(event.key!==META_KEY)return;
      try {
        const next=event.newValue?JSON.parse(event.newValue):null;
        if(next&&(next.version!==1||typeof next.enabled!=='boolean'||!Number.isSafeInteger(next.revision)||next.revision<0||!(next.base===null||/^[a-f0-9]{64}$/.test(next.base))))throw new Error('meta');
        meta=next;enabled=!!next?.enabled;
        if(!enabled)status('同步已在此浏览器的另一页面暂停。');
      }catch{enabled=false;corruptMeta=true;status('同步设置无法读取，已暂停覆盖。',true);}
    });
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)reconcile();});
    setInterval(()=>{if(!document.hidden&&!conflict)reconcile();},15000);
    $('sync-login').addEventListener('submit',async event=>{
      event.preventDefault();if(!transport)return;
      const button=$('sync-send-link');button.disabled=true;
      try{await transport.login($('sync-email').value.trim());status('登录邮件已发送。请在此设备打开邮件里的链接；完成登录后回来启用同步。');setTimeout(()=>{button.disabled=false;},60000);}
      catch(error){status(error.message,true);button.disabled=false;}
    });
    transport?.onAuth(start);
    start();
    return {pause};
  }
  window.FinanceSync={init,canonical,pack,unpack,hash,hasData};
})();
