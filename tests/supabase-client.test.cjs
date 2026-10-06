const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {readFileSync}=require('node:fs');
const source=readFileSync(require('node:path').join(__dirname,'../supabase-client.js'),'utf8');
function setup({user={id:'fictional-owner'},owner=true,error=null}={}){
  const calls=[];
  const client={auth:{getUser:async()=>({data:{user},error:null}),onAuthStateChange(){},signOut:async()=>({error:null})},rpc:async(name,args)=>{calls.push({name,args});return{data:owner,error};},from(name){calls.push({table:name});return{select(columns){calls.push({columns});return this;},eq(column,value){calls.push({column,value});return this;},async maybeSingle(){return{data:null,error:null};}};}};
  const window={supabase:{createClient(url,key,options){calls.push({url,key,options});return client;}}};
  vm.runInNewContext(source,{window,Response,location:{origin:'https://fictional.example',pathname:'/dashboard/'},setTimeout});
  return{service:window.FinanceCloud,calls};
}
test('client uses only the publishable key and PKCE authentication',()=>{
  const {calls}=setup();assert.match(calls[0].key,/^sb_publishable_/);assert.equal(calls[0].options.auth.flowType,'pkce');
});
test('unsigned users never query financial tables',async()=>{
  const {service,calls}=setup({user:null});assert.equal((await service.request('/api/snapshot')).status,401);assert.ok(!calls.some(c=>c.table));
});
test('non-owner identity is refused and owner reads are scoped to its ID',async()=>{
  const denied=setup({owner:false});assert.equal((await denied.service.request('/api/me')).status,403);
  const allowed=setup();assert.equal((await allowed.service.request('/api/snapshot?meta=1')).status,200);assert.ok(allowed.calls.some(c=>c.column==='user_id'&&c.value==='fictional-owner'));
});
test('writes use guarded RPC and stale revisions surface as conflicts',async()=>{
  const {service,calls}=setup({error:{message:'FINANCE_CONFLICT',code:'P0001'}});
  const result=await service.request('/api/snapshot',{method:'PUT',body:JSON.stringify({revision:3,payload:'dGVzdA==',digest:'0'.repeat(64)})});
  assert.equal(result.status,409);assert.ok(calls.some(c=>c.name==='finance_write_snapshot'&&c.args.p_revision===3));assert.ok(!calls.some(c=>c.table));
});
test('unconfigured permissions disable syncing rather than pretending readiness',async()=>{
  const {service}=setup({error:{code:'PGRST202'}});assert.equal((await(await service.request('/api/status')).json()).configured,false);
});
