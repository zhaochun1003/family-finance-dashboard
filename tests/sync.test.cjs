const test=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const vm=require('node:vm');
test('sync codec preserves a complete backup and ignores automatic market-price changes',async()=>{
  const window={};vm.runInNewContext(readFileSync(require('node:path').join(__dirname,'../sync.js'),'utf8'),{window,crypto,Blob,Response,TextEncoder,CompressionStream,DecompressionStream,Uint8Array,btoa,atob});
  const S=window.FinanceSync;
  const state={version:4,ledger:{transactions:[{category:'虚构工资',amount:12345}]},accounts:[{name:'虚构银行卡',balance:10000}],notes:[],history:[],snapshot:null,tracking:null,scenario:null,quote:{mode:'auto',manual:null,automatic:{price:100,at:'2026-01-01'}}};
  const text=S.canonical(state);assert.equal(await S.unpack(await S.pack(text)),text);
  assert.equal(await S.hash(S.canonical({...state,quote:{...state.quote,automatic:{price:200}}})),await S.hash(text));
  assert.notEqual(await S.hash(S.canonical({...state,accounts:[]})),await S.hash(text));
  await assert.rejects(S.unpack('%%%='));
});
async function syncHarness(local,cloud,base,{enabled=true,invalid=false,blocked=false,initialStorage}={}) {
  const elements=new Map(),calls=[],applied=[];
  const element=id=>{if(!elements.has(id))elements.set(id,{hidden:false,textContent:'',classList:{toggle(){}},handlers:{},addEventListener(type,fn){this.handlers[type]=fn;}});return elements.get(id);};
  const storage=new Map([['family-finance-cloud.supabase.v1',JSON.stringify({version:1,enabled,revision:1,base})]]);
  if(initialStorage){storage.clear();for(const [key,value] of initialStorage)storage.set(key,value);}
  const window={FinanceCore:{validateState:s=>s,assets(){}} ,addEventListener(){}};
  const context={window,crypto,Blob,Response,TextEncoder,CompressionStream,DecompressionStream,Uint8Array,btoa,atob,document:{getElementById:element,addEventListener(){},hidden:false},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},setInterval(){},setTimeout,confirm:()=>true,fetch:async(path,options)=>{
    calls.push([path,options?.method||'GET']);
    if(path==='/api/status')return Response.json({available:true,configured:true});
    if(path==='/api/me')return Response.json({authenticated:true});
    const S=window.FinanceSync,payload=await S.pack(S.canonical(cloud));
    return Response.json({revision:2,payload,digest:invalid?'0'.repeat(64):await S.hash(payload),updated_at:'2026-01-01T00:00:00Z'});
  }};
  vm.runInNewContext(readFileSync(require('node:path').join(__dirname,'../sync.js'),'utf8'),context);
  window.FinanceSync.init({get:()=>local,blocked:()=>blocked,apply:s=>{applied.push(s);return true;}});
  for(let i=0;i<20&&!applied.length&&!element('sync-status').textContent;i++)await new Promise(r=>setTimeout(r,5));
  await new Promise(r=>setTimeout(r,30));
  return{elements,calls,applied,storage};
}
const fictional=amount=>({version:4,ledger:null,accounts:[{name:'虚构账户',balance:amount}],notes:[],history:[],snapshot:null,tracking:null,scenario:null,quote:{mode:'auto',manual:null,automatic:null}});
const canonicalHash=s=>crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({...s,quote:{...s.quote,automatic:null}}))).then(value=>[...new Uint8Array(value)].map(x=>x.toString(16).padStart(2,'0')).join(''));
test('a clean second device adopts a new cloud revision',async()=>{
  const local=fictional(100),cloud=fictional(200),result=await syncHarness(local,cloud,await canonicalHash(local));
  assert.equal(result.applied.length,1);assert.equal(result.applied[0].accounts[0].balance,200);
  assert.ok(!result.calls.some(c=>c[1]==='PUT'));
});
test('independent edits show conflict and never auto-overwrite either copy',async()=>{
  const result=await syncHarness(fictional(150),fictional(200),await canonicalHash(fictional(100)));
  assert.equal(result.applied.length,0);assert.equal(result.elements.get('sync-conflict').hidden,false);
  assert.ok(!result.calls.some(c=>c[1]==='PUT'));
});
test('disabled sync sends no financial request and corrupted cloud data is not applied',async()=>{
  const local=fictional(100),base=await canonicalHash(local);
  const disabled=await syncHarness(local,fictional(200),base,{enabled:false});
  assert.ok(!disabled.calls.some(c=>c[0].startsWith('/api/snapshot')));
  const bad=await syncHarness(local,fictional(200),base,{invalid:true});
  assert.equal(bad.applied.length,0);assert.match(bad.elements.get('sync-status').textContent,/校验失败/);
});

test('enabling persists before a blocked reconciliation and survives reload',async()=>{
  const local=fictional(100),base=await canonicalHash(local);
  const first=await syncHarness(local,fictional(200),base,{enabled:false,blocked:true});
  await first.elements.get('sync-enable').handlers.click();
  const saved=JSON.parse(first.storage.get('family-finance-cloud.supabase.v1'));
  assert.equal(saved.enabled,true);
  assert.equal(saved.base,base);
  assert.ok(!first.calls.some(c=>c[0].startsWith('/api/snapshot')));
  const refreshed=await syncHarness(local,fictional(200),base,{initialStorage:first.storage});
  assert.equal(refreshed.applied.length,1);
});
