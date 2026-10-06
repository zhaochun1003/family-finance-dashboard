(function(){
  'use strict';
  const URL='https://xwllhvmxdluabyzvhyoo.supabase.co';
  // Publishable key identifies the project; all access is enforced in the database.
  const KEY='sb_publishable_whIZ50XEh24t0WhaqWg05g__268HE4b';
  const client=window.supabase.createClient(URL,KEY,{auth:{flowType:'pkce',detectSessionInUrl:true,persistSession:true,autoRefreshToken:true}});
  function response(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});}
  function failure(error){return response({error:'同步服务暂时不可用'},error?.message?.includes('FINANCE_CONFLICT')?409:error?.code==='42501'?403:503);}
  async function user(){const {data,error}=await client.auth.getUser();if(error||!data.user)return null;return data.user;}
  window.FinanceCloud={
    async login(email){
      const {error}=await client.auth.signInWithOtp({email,options:{shouldCreateUser:true,emailRedirectTo:location.origin+location.pathname}});
      if(error)throw new Error(error.code==='over_email_send_rate_limit'?'发送次数已达限制，请稍后再试。':error.code==='email_address_not_authorized'?'默认邮件服务只允许项目成员邮箱，请使用创建项目的邮箱。':'登录邮件未发送，请稍后再试。');
    },
    onAuth(callback){client.auth.onAuthStateChange(()=>{setTimeout(callback,0);});},
    async request(path,options={}){
      if(path==='/api/status'){
        const {error}=await client.rpc('finance_is_owner');
        const missing=error?.code==='PGRST202';
        if(error&&!missing&&error.code!=='42501')return failure(error);
        return response({available:true,configured:!missing});
      }
      if(path==='/auth/logout'){const {error}=await client.auth.signOut({scope:'local'});return error?failure(error):response({ok:true});}
      const owner=await user();if(!owner)return response({error:'请先登录'},401);
      if(path==='/api/me'){
        const {data,error}=await client.rpc('finance_is_owner');
        if(error)return failure(error);return data?response({authenticated:true}):response({error:'账号没有财务数据访问权限'},403);
      }
      if(path.startsWith('/api/snapshot')&&(options.method||'GET')==='GET'){
        const columns=path.includes('meta=1')?'revision,digest,updated_at':'revision,digest,updated_at,payload';
        const {data,error}=await client.from('finance_snapshots').select(columns).eq('user_id',owner.id).maybeSingle();
        return error?failure(error):response(data||{revision:0,digest:null,updated_at:null});
      }
      if(path==='/api/snapshot'&&options.method==='PUT'){
        const value=JSON.parse(options.body);
        const {data,error}=await client.rpc('finance_write_snapshot',{p_revision:value.revision,p_payload:value.payload,p_digest:value.digest});
        return error?failure(error):response(data);
      }
      return response({error:'接口不存在'},404);
    }
  };
})();
