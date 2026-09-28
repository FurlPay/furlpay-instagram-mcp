import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store,digest} from '../src/store.js';
import {InstagramError} from '../src/errors.js';
import {config,connection,harness,owned,approve,data} from './helpers.js';

test('encrypted tokens and pending content cannot be read directly from SQLite',t=>{
  const h=harness();t.after(()=>h.store.close());
  const a=h.store.requestApproval('publish',{caption:'private draft'},'123');
  const raw=JSON.stringify(h.store.db.prepare('SELECT * FROM connection').all())+JSON.stringify(h.store.db.prepare('SELECT * FROM approvals').all());
  assert.ok(!raw.includes(connection.accessToken));assert.ok(!raw.includes('private draft'));
  assert.equal(h.store.getApproval(a.id).input.caption,'private draft');
  const sealed=h.store.seal({secret:'value'});const other=new Store(':memory:',Buffer.alloc(32,8));t.after(()=>other.close());
  assert.throws(()=>other.unseal(sealed),/Encrypted state cannot be read/);
});
test('approval hashes are key-order independent and bind nested payloads',()=>{
  assert.equal(digest({a:1,b:{c:2}}),digest({b:{c:2},a:1}));
  assert.notEqual(digest({a:1,b:{c:2}}),digest({a:1,b:{c:3}}));
});
test('token and data-access expiry fail before a network request',async t=>{
  for(const patch of [{expiresAt:Date.now()-1},{dataAccessExpiresAt:Date.now()-1}]) {
    const h=harness();t.after(()=>h.store.close());h.store.saveConnection({...connection,...patch});
    const result=await h.registry.call('instagram_get_account',{});
    assert.equal(data(result.error).code,'INSTAGRAM_REAUTH_REQUIRED');assert.equal(h.calls.length,0);
  }
});
test('missing permission fails before creating approval or reaching Meta',async t=>{
  const h=harness();t.after(()=>h.store.close());h.store.saveConnection({...connection,permissions:['instagram_basic','pages_read_engagement']});
  const r=await h.registry.call('instagram_publish_image',{image_url:'https://cdn.example.com/a.jpg'});
  assert.equal(data(r.error).code,'INSTAGRAM_PERMISSION_REQUIRED');assert.equal(h.calls.length,0);
  assert.equal(h.store.db.prepare('SELECT count(*) AS n FROM approvals').get()!.n,0);
});
test('invalid IDs, extra token arguments and destructive confirmation are rejected',async t=>{
  const h=harness();t.after(()=>h.store.close());
  for(const [name,args] of [['instagram_get_media_by_id',{media_id:'../me'}],['instagram_get_account',{access_token:'secret'}],['instagram_delete_comment',{comment_id:'901'}]] as const){
    assert.equal(data((await h.registry.call(name,args)).error).code,'INSTAGRAM_INVALID_INPUT');
  }
  assert.equal(h.calls.length,0);
});
test('public HTTPS validation rejects private hosts and credentials',async t=>{
  const h=harness();t.after(()=>h.store.close());
  for(const url of ['http://cdn.example.com/a.jpg','https://127.0.0.1/a.jpg','https://[::1]/a.jpg','https://me:secret@cdn.example.com/a.jpg','https://host.internal/a.jpg','https://localhost/a.jpg']) {
    assert.equal(data((await h.registry.call('instagram_publish_image',{image_url:url})).error).code,'INSTAGRAM_INVALID_INPUT');
  }
});
test('profile response only exposes requested public fields without invented account type',async t=>{
  const h=harness(()=>({id:'123',username:'furlpay',followers_count:0,media_count:5,access_token:'should-never-return',debug:'hidden'}));t.after(()=>h.store.close());
  const r=await h.registry.call('instagram_get_account',{});
  assert.deepEqual(r.account,{id:'123',username:'furlpay',followers_count:0,media_count:5});
  assert.ok(!JSON.stringify(r).includes('should-never-return'));
  assert.equal(h.calls[0]!.headers.get('authorization'),`Bearer ${connection.accessToken}`);
  assert.equal(h.calls[0]!.params.has('access_token'),false);assert.ok(h.calls[0]!.params.get('appsecret_proof'));
});
test('pagination returns opaque cursor and never exposes or follows Meta next URL',async t=>{
  const h=harness(()=>({data:[{id:'501',media_type:'IMAGE'}],paging:{next:'https://evil.invalid/?access_token=secret',cursors:{after:'cursor123'}}}));t.after(()=>h.store.close());
  const r=await h.registry.call('instagram_get_media',{limit:2,cursor:'prior'});
  assert.deepEqual(r.paging,{has_next_page:true,cursor:'cursor123'});assert.equal(h.calls.length,1);assert.equal(h.calls[0]!.params.get('after'),'prior');
  assert.ok(!JSON.stringify(r).includes('secret'));
});
test('Reel filtering preserves a next page even when the source page has no Reels',async t=>{
  const h=harness(()=>({data:[{id:'501',media_product_type:'FEED'}],paging:{next:'https://graph.facebook.com/next',cursors:{after:'next'}}}));t.after(()=>h.store.close());
  const r=await h.registry.call('instagram_get_reels',{});assert.deepEqual(r.items,[]);assert.equal(data(r.paging).has_next_page,true);
});
test('tags pagination uses cursors without requiring next links',async t=>{
  const h=harness(()=>({data:[],paging:{cursors:{after:'tag-next'}}}));t.after(()=>h.store.close());
  const r=await h.registry.call('instagram_get_tagged_media',{});assert.equal(data(r.paging).has_next_page,true);
});
test('missing or mismatched media owner blocks comment writes',async t=>{
  for(const owner of [undefined,{id:'999'}]) {
    const h=harness(()=>({...owned,owner}));t.after(()=>h.store.close());
    const r=await h.registry.call('instagram_create_comment',{media_id:'501',message:'hello'});
    assert.equal(data(r.error).code,'INSTAGRAM_RESOURCE_FORBIDDEN');assert.ok(h.calls.every(c=>c.method==='GET'));
  }
});
test('comment deletion resolves comment media then checks media ownership',async t=>{
  const h=harness(c=>c.path==='/901'?{id:'901',media:{id:'501'}}:{...owned,owner:{id:'999'}});t.after(()=>h.store.close());
  const r=await h.registry.call('instagram_delete_comment',{comment_id:'901',confirmation:'DELETE_COMMENT'});
  assert.equal(data(r.error).code,'INSTAGRAM_RESOURCE_FORBIDDEN');assert.deepEqual(h.calls.map(c=>c.path),['/901','/501']);
});
test('write approval is human-only, expires, and binds exact parameters',async t=>{
  const h=harness(()=>owned);t.after(()=>h.store.close());
  const args={media_id:'501',message:'approved text'};
  const first=await h.registry.call('instagram_create_comment',args);const id=String(data(first.error).approval_id);
  assert.equal(data(first.error).code,'INSTAGRAM_APPROVAL_REQUIRED');
  assert.equal(data((await h.registry.call('instagram_create_comment',{...args,approval_id:id})).error).code,'INSTAGRAM_APPROVAL_REQUIRED');
  h.store.approve(id,'human');
  assert.equal(data((await h.registry.call('instagram_create_comment',{...args,message:'tampered',approval_id:id})).error).code,'INSTAGRAM_APPROVAL_INVALID');
  h.store.db.prepare('UPDATE approvals SET expires=0 WHERE id=?').run(id);
  assert.equal(data((await h.registry.call('instagram_create_comment',{...args,approval_id:id})).error).code,'INSTAGRAM_APPROVAL_REQUIRED');
  assert.ok(h.calls.every(c=>c.method==='GET'));
});
test('completed destructive action is returned on replay without deleting again',async t=>{
  const h=harness(c=>c.method==='DELETE'?{success:true}:owned);t.after(()=>h.store.close());
  const args=await approve(h,'instagram_delete_media',{media_id:'501',confirmation:'DELETE_MEDIA'});
  assert.equal((await h.registry.call('instagram_delete_media',args)).success,true);
  const count=h.calls.length;const again=await h.registry.call('instagram_delete_media',args);
  assert.equal(again.replayed,true);assert.equal(h.calls.length,count);assert.equal(h.calls.filter(c=>c.method==='DELETE').length,1);
  const logs=h.store.db.prepare('SELECT payload FROM audit').all().map(v=>String(v.payload)).join();
  assert.match(logs,/test-human/);assert.match(logs,/completed/);assert.ok(!logs.includes(connection.accessToken));
});
test('concurrent calls cannot consume the same approval twice',async t=>{
  const h=harness(c=>c.method==='POST'?{id:'901'}:owned);t.after(()=>h.store.close());
  const args=await approve(h,'instagram_create_comment',{media_id:'501',message:'hello'});
  const results=await Promise.all([h.registry.call('instagram_create_comment',args),h.registry.call('instagram_create_comment',args)]);
  assert.equal(h.calls.filter(c=>c.method==='POST').length,1);assert.ok(results.some(r=>r.success===true));
});
test('disconnect revokes outstanding approvals and erases webhook inbox',t=>{
  const h=harness();t.after(()=>h.store.close());const a=h.store.requestApproval('tool',{x:1},'123');h.store.approve(a.id,'human');
  h.store.event(digest('event'),'123','mentions',{media_id:'501'});h.store.clearConnection();
  assert.equal(h.store.getConnection(),undefined);assert.equal(h.store.getApproval(a.id).status,'revoked');assert.equal(h.store.events('123',Date.now()+1,50).length,0);
});
test('safe reads retry rate limits; non-idempotent writes never retry',async t=>{
  const h=harness((_c,i)=>i===0?Response.json({error:{code:4}},{status:429,headers:{'retry-after':'1'}}):{id:'123'});t.after(()=>h.store.close());
  assert.equal((await h.api.request('GET','/123')).id,'123');assert.equal(h.calls.length,2);
  const w=harness(()=>Response.json({error:{code:4}},{status:429}));t.after(()=>w.store.close());
  await assert.rejects(w.api.request('POST','/123/media',{image_url:'https://cdn.example.com/a.jpg'}),(e:unknown)=>e instanceof InstagramError&&e.code==='INSTAGRAM_RATE_LIMITED');assert.equal(w.calls.length,1);
});
test('timeout or 5xx write remains unknown and cannot replay a publication',async t=>{
  for(const failure of [new Error('network contains private token'),Response.json({error:{code:2}},{status:503})]) {
    const h=harness(c=>c.method==='POST'?failure:owned);t.after(()=>h.store.close());
    const args=await approve(h,'instagram_create_comment',{media_id:'501',message:'hello'});
    const first=await h.registry.call('instagram_create_comment',args);assert.equal(data(first.error).code,'INSTAGRAM_OUTCOME_UNKNOWN');assert.ok(!JSON.stringify(first).includes('private token'));
    const again=await h.registry.call('instagram_create_comment',args);assert.equal(data(again.error).code,'INSTAGRAM_OUTCOME_UNKNOWN');assert.equal(h.calls.filter(c=>c.method==='POST').length,1);
  }
});
test('Meta permission and expired-token responses are sanitized',async t=>{
  for(const [code,expected] of [[190,'INSTAGRAM_REAUTH_REQUIRED'],[200,'INSTAGRAM_PERMISSION_REQUIRED']] as const){
    const h=harness(()=>Response.json({error:{code,message:`secret ${connection.accessToken}`}},{status:400}));t.after(()=>h.store.close());
    const r=await h.registry.call('instagram_get_account',{});assert.equal(data(r.error).code,expected);assert.ok(!JSON.stringify(r).includes(connection.accessToken));
  }
});
test('circuit opens after repeated transient failures',async t=>{
  const h=harness(()=>Response.json({error:{code:2}},{status:503}));t.after(()=>h.store.close());
  await assert.rejects(h.api.request('GET','/123'));await assert.rejects(h.api.request('GET','/123'));
  const count=h.calls.length;await assert.rejects(h.api.request('GET','/123'),(e:unknown)=>e instanceof InstagramError&&e.code==='INSTAGRAM_CIRCUIT_OPEN');assert.equal(h.calls.length,count);
});
test('metric map rejects removed and incompatible metrics before insights requests',async t=>{
  const h=harness(()=>owned);t.after(()=>h.store.close());
  for(const metrics of [['impressions'],['ig_reels_avg_watch_time'],['total_views']]){
    const r=await h.registry.call('instagram_get_media_insights',{media_id:'501',metrics});assert.equal(data(r.error).code,'INSTAGRAM_UNSUPPORTED_METRIC');
  }
  assert.ok(h.calls.every(c=>c.path==='/501'));
});
test('account insight requests use current names, bounded range and total_value',async t=>{
  const h=harness(()=>({data:[]}));t.after(()=>h.store.close());const now=Math.floor(Date.now()/1000);
  const r=await h.registry.call('instagram_get_account_insights',{metrics:['views','reach'],since:now-86400,until:now});
  assert.equal(r.success,true);assert.deepEqual(r.metrics,[]);assert.match(String(r.empty_means),/not zero/);
  assert.equal(h.calls[0]!.params.get('metric_type'),'total_value');assert.equal(h.calls[0]!.params.get('period'),'day');
  const bad=await h.registry.call('instagram_get_account_insights',{metrics:['views'],since:now-31*86400,until:now});assert.equal(data(bad.error).code,'INSTAGRAM_INVALID_DATE_RANGE');
});
test('mentions use the exact parameterized field, never a fabricated listing edge',async t=>{
  const h=harness(()=>({id:'123',mentioned_media:{id:'501',caption:'@furlpay'}}));t.after(()=>h.store.close());
  const r=await h.registry.call('instagram_get_mentions',{media_id:'501'});assert.equal(data(r.media).caption,'@furlpay');assert.equal(h.calls[0]!.path,'/123');assert.match(h.calls[0]!.params.get('fields')!,/^mentioned_media\.media_id\(501\)/);
});
test('webhook event pagination does not lose events with equal timestamps',async t=>{
  const h=harness();t.after(()=>h.store.close());for(let i=0;i<3;i++)h.store.event(digest(i),'123','mentions',{media_id:String(i)});
  h.store.db.prepare('UPDATE events SET timestamp=?').run(Date.now()-1000);
  const seen:string[]=[];let cursor:unknown;
  for(let i=0;i<3;i++){const r=await h.registry.call('instagram_get_webhook_events',{limit:1,...(cursor?{cursor}:{})});const items=r.items as {id:string}[];seen.push(items[0]!.id);cursor=data(r.paging).cursor;}
  assert.equal(new Set(seen).size,3);assert.equal(cursor,undefined);
});
test('messaging requires verified fresh inbound event and configured human escalation',async t=>{
  const h=harness(()=>({recipient_id:'888',message_id:'m_reply'}));t.after(()=>h.store.close());
  const args={recipient_id:'888',message:'Hello',human_support_url:config.humanSupportUrl!};
  assert.equal(data((await h.registry.call('instagram_send_message',args)).error).code,'INSTAGRAM_MESSAGING_WINDOW_CLOSED');
  h.store.event(digest('old'),'123','messages',{sender_id:'888',timestamp:Date.now()-86_400_001});
  assert.equal(data((await h.registry.call('instagram_send_message',args)).error).code,'INSTAGRAM_MESSAGING_WINDOW_CLOSED');
  h.store.event(digest('fresh'),'123','messages',{sender_id:'888',timestamp:Date.now()-1000});
  const approved=await approve(h,'instagram_send_message',args);const r=await h.registry.call('instagram_send_message',approved);
  assert.equal(r.success,true);assert.equal(h.calls[0]!.path,'/456/messages');assert.equal(h.calls[0]!.headers.get('authorization'),`Bearer ${connection.pageAccessToken}`);
  assert.match(h.calls[0]!.params.get('message')!,/Human support:/);
});
test('conversation ownership failure prevents reading its messages',async t=>{
  const h=harness(()=>({id:'t_foreign',participants:{data:[{id:'999'}]}}));t.after(()=>h.store.close());
  const r=await h.registry.call('instagram_get_conversation_messages',{conversation_id:'t_foreign'});
  assert.equal(data(r.error).code,'INSTAGRAM_RESOURCE_FORBIDDEN');assert.equal(h.calls.length,1);
});

test('malformed success responses never complete or replay comment writes',async t=>{
  const h=harness(c=>c.method==='POST'?{}:owned);t.after(()=>h.store.close());
  const args=await approve(h,'instagram_create_comment',{media_id:'501',message:'hello'});
  const result=await h.registry.call('instagram_create_comment',args);
  assert.equal(data(result.error).code,'INSTAGRAM_OUTCOME_UNKNOWN');
  assert.equal(data((await h.registry.call('instagram_create_comment',args)).error).code,'INSTAGRAM_OUTCOME_UNKNOWN');
  assert.equal(h.calls.filter(c=>c.method==='POST').length,1);
});

test('oversized upstream bodies are bounded and writes remain unknown',async t=>{
  for(const method of ['GET','POST'] as const){
    const h=harness(()=>new Response('x'.repeat(2_000_001)));t.after(()=>h.store.close());
    await assert.rejects(h.api.request(method,'/123'),(e:unknown)=>e instanceof InstagramError&&e.code===(method==='GET'?'INSTAGRAM_RESPONSE_TOO_LARGE':'INSTAGRAM_OUTCOME_UNKNOWN'));
    assert.equal(h.calls.length,1);
  }
});

test('connection changes during upstream reads prevent returning data or continuing',async t=>{
  const h=harness(()=>{h.store.saveConnection({...connection,accountId:'999',connectedAt:Date.now()+1});return owned;});t.after(()=>h.store.close());
  const result=await h.registry.call('instagram_get_media_by_id',{media_id:'501'});
  assert.equal(data(result.error).code,'INSTAGRAM_CONNECTION_CHANGED');assert.equal(h.calls.length,1);assert.equal(result.media,undefined);
});

test('reconnecting revokes pending approval even for the same account',t=>{
  const h=harness();t.after(()=>h.store.close());const pending=h.store.requestApproval('instagram_create_comment',{media_id:'501',message:'hello'},'123');
  h.store.approve(pending.id,'human');h.store.saveConnection({...connection,connectedAt:connection.connectedAt+1});
  assert.equal(h.store.getApproval(pending.id).status,'revoked');
});

test('event reads purge expired inbox content without waiting for new webhooks',t=>{
  const h=harness();t.after(()=>h.store.close());h.store.event(digest('expired'),'123','mentions',{media_id:'501'});
  h.store.db.prepare('UPDATE events SET timestamp=?').run(Date.now()-31*86400_000);
  assert.equal(h.store.events('123',Date.now()+1,20).length,0);
  assert.equal(h.store.db.prepare('SELECT count(*) AS count FROM events').get()!.count,0);
});
