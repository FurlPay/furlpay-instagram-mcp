import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer} from '../src/server.js';
import {config,harness,approve,data,owned} from './helpers.js';

test('real MCP SDK client lists schemas and calls account tool with mock Meta',async t=>{
  const h=harness(()=>({id:'123',username:'furlpay',media_count:8}));t.after(()=>h.store.close());
  t.mock.method(globalThis,'fetch',h.fetcher);
  const server=createMcpServer(config,h.store);const client=new Client({name:'integration-client',version:'1.0.0'});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);await client.connect(clientTransport);
  t.after(async()=>{await client.close();await server.close();});
  const list=await client.listTools();assert.ok(list.tools.length>=30);
  assert.equal(list.tools.find(v=>v.name==='instagram_delete_comment')!.annotations!.destructiveHint,true);
  assert.equal(list.tools.some(v=>v.name==='instagram_http_request'),false);
  const r=await client.callTool({name:'instagram_get_account',arguments:{}});
  assert.equal(r.isError,false);assert.equal(data(data(r.structuredContent).account).username,'furlpay');
});
test('approved image publishes through quota, container, processing status and final publish exactly once',async t=>{
  const h=harness(c=>c.path.endsWith('content_publishing_limit')?{data:[{quota_usage:0,config:{quota_total:100}}]}:c.path==='/123/media'?{id:'700'}:c.path==='/700'?{status_code:'FINISHED'}:c.path==='/123/media_publish'?{id:'800'}:owned);t.after(()=>h.store.close());
  const args=await approve(h,'instagram_publish_image',{image_url:'https://cdn.example.com/a.jpg',caption:'FurlPay stablecoin rails'});
  assert.equal(h.calls.length,0);
  const result=await h.registry.call('instagram_publish_image',args);assert.equal(result.success,true);assert.equal(data(result.media).id,'800');
  assert.deepEqual(h.calls.map(c=>[c.method,c.path]),[['GET','/123/content_publishing_limit'],['POST','/123/media'],['GET','/700'],['POST','/123/media_publish']]);
  assert.equal(h.calls[3]!.params.get('creation_id'),'700');
  assert.equal((await h.registry.call('instagram_publish_image',args)).replayed,true);assert.equal(h.calls.length,4);
});
test('video publishes as REELS and resumes processing without creating another container',async t=>{
  let polls=0;
  const h=harness(c=>c.path.endsWith('content_publishing_limit')?{data:[]}:c.path==='/123/media'?{id:'700'}:c.path==='/700'?{status_code:++polls===1?'IN_PROGRESS':'FINISHED'}:{id:'800'});t.after(()=>h.store.close());
  const args=await approve(h,'instagram_publish_video',{video_url:'https://cdn.example.com/a.mp4'});
  const first=await h.registry.call('instagram_publish_video',args);assert.equal(first.status,'processing');assert.equal(h.calls[1]!.params.get('media_type'),'REELS');
  const count=h.calls.length;const early=await h.registry.call('instagram_publish_video',args);assert.equal(early.status,'processing');assert.equal(h.calls.length,count);
  const job=h.store.getJob(String(args.approval_id))!;h.store.updateJob(job.id,'processing',job.phase,{...job.data,nextPollAt:Date.now()-1});
  const final=await h.registry.call('instagram_publish_video',args);assert.equal(final.status,'published');assert.equal(h.calls.filter(c=>c.path==='/123/media').length,1);
});
test('carousel creates children first and applies AI declaration only to parent',async t=>{
  let next=700;
  const h=harness(c=>c.path.endsWith('content_publishing_limit')?{data:[]}:c.path==='/123/media'?{id:String(next++)}:c.path==='/123/media_publish'?{id:'800'}:{status_code:'FINISHED'});t.after(()=>h.store.close());
  const args=await approve(h,'instagram_publish_carousel',{items:[{type:'image',url:'https://cdn.example.com/a.jpg'},{type:'video',url:'https://cdn.example.com/b.mp4'}],caption:'Two slides',is_ai_generated:true});
  assert.equal((await h.registry.call('instagram_publish_carousel',args)).status,'published');
  const containers=h.calls.filter(c=>c.path==='/123/media');assert.equal(containers.length,3);
  assert.equal(containers[0]!.params.get('is_carousel_item'),'true');assert.equal(containers[1]!.params.get('media_type'),'VIDEO');
  assert.equal(containers[0]!.params.has('is_ai_generated'),false);assert.equal(containers[2]!.params.get('media_type'),'CAROUSEL');assert.equal(containers[2]!.params.get('children'),'700,701');assert.equal(containers[2]!.params.get('is_ai_generated'),'true');
});
test('failed and expired containers are never published',async t=>{
  for(const status of ['ERROR','EXPIRED']){
    const h=harness(c=>c.path.endsWith('content_publishing_limit')?{data:[]}:c.path==='/123/media'?{id:'700'}:{status_code:status});t.after(()=>h.store.close());
    const args=await approve(h,'instagram_publish_image',{image_url:'https://cdn.example.com/a.jpg'});const r=await h.registry.call('instagram_publish_image',args);
    assert.equal(r.success,false);assert.ok(!h.calls.some(c=>c.path.endsWith('media_publish')));
  }
});
test('ambiguous media_publish response cannot produce an automatic duplicate',async t=>{
  const h=harness(c=>c.path.endsWith('content_publishing_limit')?{data:[]}:c.path==='/123/media'?{id:'700'}:c.path==='/700'?{status_code:'FINISHED'}:new Error('connection reset'));t.after(()=>h.store.close());
  const args=await approve(h,'instagram_publish_reel',{video_url:'https://cdn.example.com/a.mp4'});
  const first=await h.registry.call('instagram_publish_reel',args);assert.equal(data(first.error).code,'INSTAGRAM_OUTCOME_UNKNOWN');
  const again=await h.registry.call('instagram_publish_reel',args);assert.equal(data(again.error).code,'INSTAGRAM_OUTCOME_UNKNOWN');
  assert.equal(h.calls.filter(c=>c.path.endsWith('media_publish')).length,1);
  assert.equal(h.store.getJob(String(args.approval_id))!.phase,'publishing');
});
test('current publishing quota prevents creation when exhausted',async t=>{
  const h=harness(()=>({data:[{quota_usage:50,config:{quota_total:50}}]}));t.after(()=>h.store.close());
  const args=await approve(h,'instagram_publish_image',{image_url:'https://cdn.example.com/a.jpg'});
  const r=await h.registry.call('instagram_publish_image',args);assert.equal(data(r.error).code,'INSTAGRAM_PUBLISHING_LIMIT');assert.equal(h.calls.length,1);
});
test('a crash checkpoint remains non-replayable after reconnecting to the job store',async t=>{
  const h=harness();t.after(()=>h.store.close());
  const args=await approve(h,'instagram_publish_image',{image_url:'https://cdn.example.com/a.jpg'});
  const {approval_id:approvalId,...input}=args;const job=h.store.beginJob(String(approvalId),'instagram_publish_image',input,'123');
  h.store.updateJob(job.id,'running','publishing',{containerId:'700'});
  const r=await h.registry.call('instagram_publish_image',args);assert.equal(data(r.error).code,'INSTAGRAM_OUTCOME_UNKNOWN');assert.equal(h.calls.length,0);
});
