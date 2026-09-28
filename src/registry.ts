import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import { ApiClient, object, records } from './api.js';
import { InstagramError, publicError, required } from './errors.js';
import { ACCOUNT_METRICS, MEDIA_METRICS, checkMetrics } from './metrics.js';
import { comment, insights, media, MEDIA_FIELDS, page, pick } from './normalize.js';
import { Publisher, type PublicationKind } from './publishing.js';
import type { Job, Store } from './store.js';
import type { Config, Data } from './types.js';

const id = z.string().regex(/^\d{1,40}$/, 'Use a numeric Instagram ID, not a URL or username.');
const uuid = z.string().uuid();
const cursor = z.string().min(1).max(4096);
const pagination = { limit: z.number().int().min(1).max(50).default(25), cursor: cursor.optional() };
const approval = { approval_id: uuid.optional() };
const url = z.string().url().max(4096).refine(value => {
  const u = new URL(value);
  return u.protocol === 'https:' && !u.username && !u.password && !u.hash && (!u.port || u.port === '443')
    && !isIP(u.hostname.replace(/^\[|\]$/g, '')) && u.hostname.includes('.')
    && !/(^|\.)(localhost|local|internal|test|invalid)$/.test(u.hostname);
}, 'Use a publicly reachable HTTPS media URL without credentials, a fragment, or a private host.');
const message = z.string().min(1).max(2200);
const base = ['instagram_basic', 'pages_read_engagement'];
const commentPermissions = [...base, 'instagram_manage_comments'];
const publishPermissions = [...base, 'instagram_content_publish'];
const insightPermissions = [...base, 'instagram_manage_insights'];
const source = 'https://developers.facebook.com/documentation/instagram-platform/';
const commonErrors = ['INSTAGRAM_REAUTH_REQUIRED','INSTAGRAM_PERMISSION_REQUIRED','INSTAGRAM_RATE_LIMITED','INSTAGRAM_RESOURCE_FORBIDDEN','INSTAGRAM_API_REJECTED'];

export interface ToolDefinition {
  name: string; description: string; inputSchema: z.AnyZodObject; requiredPermissions: string[];
  endpoints: { method: string; path: string }[]; write: boolean; destructive: boolean;
  documentation: string; requiredFeatures?: string[]; validation: string; errorMapping: string[];
  conditionalPermissions?: Record<string, string[]>;
  preflight?: (input: Data) => Promise<void>;
  run: (input: Data, job?: Job) => Promise<Data>;
}
export interface Registry { tools: ToolDefinition[]; call(name: string, args: unknown): Promise<Data> }
const cache = new WeakMap<Store, Registry>();
export function createRegistry(config: Config, store: Store, client?: ApiClient): Registry {
  if (!client && cache.has(store)) return cache.get(store)!;
  const api = client ?? new ApiClient(config, store), publisher = new Publisher(api, store);
  const tools: ToolDefinition[] = [];
  const read = <S extends z.AnyZodObject>(name: string, description: string, schema: S, permissions: string[], endpoints: ToolDefinition['endpoints'], documentation: string,
    run: (args: z.output<S>) => Promise<Data>) => tools.push({ name, description, inputSchema: schema.strict(), requiredPermissions: permissions,
      endpoints, documentation: source + documentation, write: false, destructive: false, validation: 'Strict schema; account binding; bounded pagination.', errorMapping: commonErrors,
      run: args => run(schema.parse(args)) });
  const write = <S extends z.AnyZodObject>(name: string, description: string, schema: S, permissions: string[], endpoints: ToolDefinition['endpoints'], documentation: string,
    run: (args: z.output<S>, job: Job) => Promise<Data>, preflight?: (args: z.output<S>) => Promise<void>, destructive = false) => tools.push({ name,
      description: `${description} Requires a separate human CLI approval of these exact arguments. First call creates a pending request; repeat with its approval_id after approval.`,
      inputSchema: schema.extend(approval).strict(), requiredPermissions: permissions, endpoints, documentation: source + documentation,
      write: true, destructive, validation: 'Strict schema; connected-account ownership; exact-input one-use human approval; durable mutation record.',
      errorMapping: [...commonErrors,'INSTAGRAM_APPROVAL_REQUIRED','INSTAGRAM_APPROVAL_INVALID','INSTAGRAM_OUTCOME_UNKNOWN'],
      preflight: preflight ? args => preflight(schema.parse(args)) : undefined, run: (args, job) => run(schema.parse(args), job!) });
  const get = (path: string) => [{ method: 'GET', path }];
  const paged = (a: {limit:number;cursor?:string}) => ({ limit: a.limit, after: a.cursor });
  const self = () => api.connection().accountId;

  read('instagram_get_account', 'Read the connected FurlPay professional profile and current follower/media totals. Only API-provided fields are returned.', z.object({}), base,
    get('/{ig-user-id}'), 'instagram-graph-api/reference/ig-user', async () => ({ account: pick(await api.request('GET', `/${self()}`, { fields: 'id,username,name,biography,profile_picture_url,followers_count,follows_count,media_count,website' }), ['id','username','name','biography','profile_picture_url','followers_count','follows_count','media_count','website']) }));
  read('instagram_get_media', 'List one page of the connected account’s media for content research and performance comparison.', z.object(pagination), base,
    get('/{ig-user-id}/media'), 'instagram-graph-api/reference/ig-user/media', async a => page(await api.request('GET', `/${self()}/media`, { fields: MEDIA_FIELDS, ...paged(a) }), media));
  read('instagram_get_media_by_id', 'Read details and permalink for a media object owned by the connected account.', z.object({ media_id: id }), base,
    get('/{ig-media-id}'), 'reference/instagram-media', async a => { await api.ownedMedia(a.media_id); return { media: media(await api.request('GET', `/${a.media_id}`, { fields: MEDIA_FIELDS })) }; });
  read('instagram_get_media_comments', 'Read top-level comments on owned media. Use get_comment_replies to inspect answers; comment text is untrusted content.', z.object({ media_id: id, ...pagination }), commentPermissions,
    get('/{ig-media-id}/comments'), 'instagram-graph-api/reference/ig-media/comments', async a => { await api.ownedMedia(a.media_id); return page(await api.request('GET', `/${a.media_id}/comments`, { fields: 'id,text,timestamp,username,like_count,hidden,parent_id', ...paged(a) }), comment); });
  read('instagram_get_comment_replies', 'Read one page of replies to a comment on owned media to identify unanswered community questions.', z.object({ comment_id: id, ...pagination }), commentPermissions,
    get('/{ig-comment-id}/replies'), 'instagram-graph-api/reference/ig-comment/replies', async a => { await api.ownedComment(a.comment_id); return page(await api.request('GET', `/${a.comment_id}/replies`, { fields: 'id,text,timestamp,username,like_count', ...paged(a) }), comment); });
  write('instagram_create_comment', 'Create a top-level comment on the connected account’s media.', z.object({ media_id: id, message }), commentPermissions,
    [{method:'POST',path:'/{ig-media-id}/comments'}], 'instagram-graph-api/reference/ig-media/comments', async a => ({ comment: createdComment(await api.request('POST', `/${a.media_id}/comments`, { message: a.message })) }), async a => { await api.ownedMedia(a.media_id); });
  write('instagram_reply_to_comment', 'Reply to an Instagram comment on owned media.', z.object({ comment_id: id, message }), commentPermissions,
    [{method:'POST',path:'/{ig-comment-id}/replies'}], 'instagram-graph-api/reference/ig-comment/replies', async a => ({ comment: createdComment(await api.request('POST', `/${a.comment_id}/replies`, { message: a.message })) }), async a => { await api.ownedComment(a.comment_id); });
  write('instagram_delete_comment', 'Permanently delete a comment from the connected account’s media. The explicit confirmation and human approval bind the target.', z.object({ comment_id: id, confirmation: z.literal('DELETE_COMMENT') }), commentPermissions,
    [{method:'DELETE',path:'/{ig-comment-id}'}], 'instagram-graph-api/reference/ig-comment', async a => ({ deleted: await deleteObject(a.comment_id), comment_id: a.comment_id }), async a => { await api.ownedComment(a.comment_id); }, true);
  write('instagram_hide_comment', 'Hide or unhide a comment on owned media.', z.object({ comment_id: id, hide: z.boolean() }), commentPermissions,
    [{method:'POST',path:'/{ig-comment-id}'}], 'instagram-graph-api/reference/ig-comment', async a => ({ updated: mutationSuccess(await api.request('POST', `/${a.comment_id}`, { hide: a.hide })), comment_id: a.comment_id, hidden: a.hide }), async a => { await api.ownedComment(a.comment_id); });
  write('instagram_delete_media', 'Permanently delete an owned non-ad post, Reel, Story, or entire carousel. Carousel children cannot be deleted separately.', z.object({ media_id: id, confirmation: z.literal('DELETE_MEDIA') }), [...base,'instagram_manage_contents'],
    [{method:'DELETE',path:'/{ig-media-id}'}], 'reference/instagram-media#delete', async a => ({ deleted: await deleteObject(a.media_id), media_id: a.media_id }), async a => { await api.ownedMedia(a.media_id); }, true);
  for (const action of ['like','unlike'] as const) write(`instagram_${action}_media`, `${action === 'like' ? 'Like' : 'Unlike'} an owned public Feed post or Reel using the current account engagement API.`, z.object({media_id:id}), [...base,'instagram_manage_engagement'],
    [{method:action === 'like' ? 'POST' : 'DELETE',path:'/{ig-user-id}/likes'}], 'instagram-graph-api/reference/ig-user/user-likes', async a => ({ updated: mutationSuccess(await api.request(action === 'like' ? 'POST' : 'DELETE', `/${self()}/likes`, {media_id:a.media_id})), media_id:a.media_id }), async a => { const m=await api.ownedMedia(a.media_id); required(m.media_product_type !== 'STORY','INSTAGRAM_UNSUPPORTED_OPERATION','Stories do not support this like operation.'); });

  const publishEndpoints = [{method:'GET',path:'/{ig-user-id}/content_publishing_limit'},{method:'POST',path:'/{ig-user-id}/media'},{method:'GET',path:'/{ig-container-id}?fields=status_code'},{method:'POST',path:'/{ig-user-id}/media_publish'}];
  const commonPublish = {caption: z.string().max(2200).optional(), is_ai_generated: z.boolean().optional()};
  const publish = <S extends z.AnyZodObject>(name:string,description:string,schema:S,kind:PublicationKind) => write(name, description, schema, publishPermissions, publishEndpoints, 'content-publishing', async (_a, job) => publisher.execute(job,kind));
  publish('instagram_publish_image','Publish a public JPEG image via a media container. Returns processing state if Meta is still preparing it.',z.object({image_url:url,...commonPublish}),'image');
  for (const name of ['instagram_publish_reel','instagram_publish_video']) publish(name,'Publish a video as a Reel (REELS). Standalone legacy VIDEO publishing is not used. Supply a public supported MP4/MOV URL.',z.object({video_url:url,share_to_feed:z.boolean().default(true),...commonPublish}),'reel');
  publish('instagram_publish_carousel','Publish 2–10 images/videos as a carousel, processing each child and the parent before publication. is_ai_generated applies to the parent.',z.object({items:z.array(z.object({type:z.enum(['image','video']),url}).strict()).min(2).max(10),...commonPublish}),'carousel');
  publish('instagram_publish_story','Publish a Story for a Business account only. An operator must confirm business eligibility; Meta enforces the actual account restriction.',z.object({type:z.enum(['image','video']),url,business_account_confirmed:z.literal(true),is_ai_generated:z.boolean().optional()}),'story');
  read('instagram_get_publishing_limit','Read Meta’s current publishing usage and configuration; quota values are not assumed.',z.object({}),publishPermissions,
    get('/{ig-user-id}/content_publishing_limit'),'instagram-graph-api/reference/ig-user/content_publishing_limit',async()=>({items:records((await api.request('GET',`/${self()}/content_publishing_limit`,{fields:'quota_usage,config'})).data).map(v=>pick(v,['quota_usage','config']))}));
  read('instagram_get_publish_status','Inspect a durable publish job. Repeat its original approved publishing call to continue processing when due; this inspection never publishes.',z.object({job_id:uuid}),base,
    [{method:'LOCAL',path:'encrypted publishing job store'}],'content-publishing',async a=>{const job=store.getJob(a.job_id); required(job && job.accountId===self(),'INSTAGRAM_RESOURCE_FORBIDDEN','The job is not associated with the connected account.'); return {job:{id:job.id,tool:job.tool,status:job.status,phase:job.phase,...pick(job.data,['containerId','currentChild','childIds','nextPollAt']),result:job.result}};});

  read('instagram_get_media_insights','Analyze owned Feed, Reel or Story performance with the current metric capability map. Removed metrics are rejected; missing values are not zero.',z.object({media_id:id,metrics:z.array(z.string().min(1).max(80)).min(1).max(15),breakdown:z.enum(['action_type','story_navigation_action_type']).optional()}),insightPermissions,
    get('/{ig-media-id}/insights'),'reference/instagram-media/insights',async a=>{
      const m=await api.ownedMedia(a.media_id), product=String(m.media_product_type);
      required(MEDIA_METRICS[product],'INSTAGRAM_UNSUPPORTED_METRIC','The returned media product type has no supported insight map.');
      checkMetrics(a.metrics,MEDIA_METRICS[product]);
      required(!a.metrics.includes('total_views') || m.media_type==='VIDEO','INSTAGRAM_UNSUPPORTED_METRIC','Aggregated total_views is restricted to video media because current Meta documentation differs on non-video eligibility. Use views for other formats.');
      if (a.breakdown) required(a.metrics.length===1 && ((a.metrics[0]==='profile_activity' && a.breakdown==='action_type') || (a.metrics[0]==='navigation' && a.breakdown==='story_navigation_action_type')),'INSTAGRAM_UNSUPPORTED_METRIC','This breakdown is only supported with its corresponding single metric.');
      return insights(await api.request('GET',`/${a.media_id}/insights`,{metric:a.metrics.join(','),breakdown:a.breakdown}));
    });
  read('instagram_get_account_insights','Analyze current account interaction metrics for a bounded date range. Follower totals are available from get_account. Deprecated impressions are rejected.',z.object({metrics:z.array(z.string().min(1).max(80)).min(1).max(12),since:z.number().int().positive(),until:z.number().int().positive()}),insightPermissions,
    get('/{ig-user-id}/insights'),'api-reference/instagram-user/insights',async a=>{
      checkMetrics(a.metrics,ACCOUNT_METRICS); required(a.until>a.since && a.until-a.since<=30*86400 && a.since>=Math.floor(Date.now()/1000)-90*86400 && a.until<=Math.floor(Date.now()/1000)+60,'INSTAGRAM_INVALID_DATE_RANGE','Use a range of at most 30 days within the last 90 days; dates are Unix seconds.');
      return insights(await api.request('GET',`/${self()}/insights`,{metric:a.metrics.join(','),period:'day',metric_type:'total_value',since:a.since,until:a.until}));
    });
  read('instagram_search_hashtag','Find the official hashtag ID for stablecoin or other content research. Requires Instagram Public Content Access review. Meta allows 30 unique hashtags per rolling 7 days.',z.object({hashtag:z.string().min(1).max(100).regex(/^[\p{L}\p{N}_]+$/u)}),base,
    get('/ig_hashtag_search?user_id={ig-user-id}&q={hashtag}'),'instagram-graph-api/reference/ig-hashtag-search',async a=>({items:records((await api.request('GET','/ig_hashtag_search',{user_id:self(),q:a.hashtag})).data).map(v=>pick(v,['id']))}));
  tools[tools.length-1]!.requiredFeatures=['Instagram Public Content Access'];
  read('instagram_get_hashtag_media','Read recent (past 24 hours) or top public hashtagged media. No username is inferred. A repeated recent-media cursor can still be valid.',z.object({hashtag_id:id,feed:z.enum(['recent','top']).default('recent'),...pagination}),base,
    get('/{ig-hashtag-id}/{recent_media|top_media}?user_id={ig-user-id}'),'instagram-api-with-facebook-login/hashtag-search',async a=>page(await api.request('GET',`/${a.hashtag_id}/${a.feed}_media`,{user_id:self(),fields:'id,caption,media_type,media_url,permalink,timestamp,comments_count,like_count',...paged(a)}),media));
  tools[tools.length-1]!.requiredFeatures=['Instagram Public Content Access'];
  read('instagram_get_mentions','Resolve a specific caption mention of FurlPay using the media ID supplied by a mention webhook. This API is not a global mention search or listing edge.',z.object({media_id:id}),commentPermissions,
    get('/{ig-user-id}?fields=mentioned_media.media_id({media-id}){...}'),'instagram-graph-api/reference/ig-user/mentioned_media',async a=>({media:media(object((await api.request('GET',`/${self()}`,{fields:`mentioned_media.media_id(${a.media_id}){id,caption,media_type,media_url,timestamp,username,comments_count,like_count}`})).mentioned_media))}));
  read('instagram_get_mentioned_comment','Resolve a specific comment mention identified by an Instagram webhook.',z.object({comment_id:id}),commentPermissions,
    get('/{ig-user-id}?fields=mentioned_comment.comment_id({comment-id}){...}'),'instagram-graph-api/reference/ig-user/mentioned_comment',async a=>({comment:comment(object((await api.request('GET',`/${self()}`,{fields:`mentioned_comment.comment_id(${a.comment_id}){id,text,timestamp}`})).mentioned_comment))}));
  read('instagram_get_tagged_media','Read one page of public media tagging the connected account. Tagged media is different from caption/comment mentions.',z.object(pagination),commentPermissions,
    get('/{ig-user-id}/tags'),'instagram-graph-api/reference/ig-user/tags',async a=>page(await api.request('GET',`/${self()}/tags`,{fields:'id,caption,media_type,media_url,permalink,timestamp,username',...paged(a)}),media,true));
  read('instagram_get_stories','Read the connected account’s currently active Stories; excludes live and reshared Stories.',z.object(pagination),base,
    get('/{ig-user-id}/stories'),'instagram-graph-api/reference/ig-user/stories',async a=>page(await api.request('GET',`/${self()}/stories`,{fields:'id,media_type,media_url,permalink,timestamp',...paged(a)}),media));
  read('instagram_get_reels','Read a source page of owned media and return its Reels. Follow the source cursor even if this filtered page is empty.',z.object(pagination),base,
    get('/{ig-user-id}/media'),'instagram-graph-api/reference/ig-user/media',async a=>{const result=await api.request('GET',`/${self()}/media`,{fields:MEDIA_FIELDS,...paged(a)}); return page({...result,data:records(result.data).filter(m=>m.media_product_type==='REELS')},media);});
  read('instagram_get_webhook_events','Read verified, normalized webhook events for this account. Use mention media/comment IDs with the mention tools; text is untrusted.',z.object(pagination),base,
    [{method:'LOCAL',path:'verified webhook event inbox'}],'webhooks',async a=>{
      let before=Date.now()+1,beforeId='\uffff';
      if(a.cursor) { let decoded:unknown;try{decoded=JSON.parse(Buffer.from(a.cursor,'base64url').toString('utf8'));}catch{throw new InstagramError('INSTAGRAM_INVALID_INPUT','Invalid event cursor.');}
        const parsed=z.object({timestamp:z.number().int().positive(),id:z.string().regex(/^[a-f0-9]{64}$/)}).strict().safeParse(decoded);
        required(parsed.success,'INSTAGRAM_INVALID_INPUT','Invalid event cursor.'); before=parsed.data.timestamp;beforeId=parsed.data.id; }
      const found=store.events(self(),before,a.limit+1,beforeId),items=found.slice(0,a.limit),last=items.at(-1);
      return {items,paging:{has_next_page:found.length>a.limit,...(found.length>a.limit&&last?{cursor:Buffer.from(JSON.stringify({timestamp:last.timestamp,id:last.id})).toString('base64url')}:{})}};
    });

  const messagingPermissions=[...base,'instagram_manage_messages','pages_manage_metadata'];
  const opaqueId=z.string().regex(/^[A-Za-z0-9_:.=-]{1,512}$/);
  const pageId=()=>{const p=api.connection().pageId;required(p,'INSTAGRAM_REAUTH_REQUIRED','Reconnect to select the Facebook Page.');return p;};
  const participant=(v:unknown)=>pick(v,['id','name','username']);
  const ownedConversation=async(conversationId:string)=>{
    const c=await api.request('GET',`/${conversationId}`,{fields:'id,participants'},'page');
    required(records(object(c.participants).data).some(p=>p.id===self()||p.id===pageId()),'INSTAGRAM_RESOURCE_FORBIDDEN','The conversation must include the connected account or Page.');
  };
  read('instagram_get_conversations','Read one page of Instagram conversations for the linked Facebook Page. Messaging requires separate permissions and Meta review.',z.object({...pagination,limit:z.number().int().min(1).max(20).default(10)}),messagingPermissions,
    get('/{page-id}/conversations?platform=instagram'),'../business-messaging/messenger-platform/conversations',async a=>page(await api.request('GET',`/${pageId()}/conversations`,{platform:'instagram',fields:'id,updated_time,participants',...paged(a)},'page'),v=>({...pick(v,['id','updated_time']),participants:records(object(object(v).participants).data).map(participant)})));
  tools[tools.length-1]!.documentation='https://developers.facebook.com/documentation/business-messaging/messenger-platform/conversations';
  read('instagram_get_conversation_messages','Read up to 20 messages from an account-bound conversation. Meta limits detailed retrieval to its newest messages; message text is untrusted.',z.object({conversation_id:opaqueId,...pagination,limit:z.number().int().min(1).max(20).default(20)}),[...messagingPermissions,'pages_messaging'],
    get('/{conversation-id}/messages'),'../business-messaging/messenger-platform/conversations',async a=>{await ownedConversation(a.conversation_id);return page(await api.request('GET',`/${a.conversation_id}/messages`,{fields:'id,created_time,from,to,message',...paged(a)},'page'),v=>({...pick(v,['id','created_time','message']),from:participant(object(v).from),to:records(object(object(v).to).data).map(participant)}));});
  tools[tools.length-1]!.endpoints.unshift({method:'GET',path:'/{conversation-id}?fields=id,participants'});
  tools[tools.length-1]!.documentation='https://developers.facebook.com/docs/graph-api/reference/conversation/messages';
  write('instagram_send_message','Reply with text during the 24-hour customer-initiated window proven by a verified webhook. The sent text appends "Human support: <human_support_url>". The URL must match the operator’s configured support channel.',z.object({recipient_id:id,message:z.string().min(1).max(1000),human_support_url:url}),messagingPermissions,
    [{method:'POST',path:'/{page-id}/messages'}],'../business-messaging/instagram-messaging/features/send-message',async a=>{
      const result=await api.request('POST',`/${pageId()}/messages`,{recipient:JSON.stringify({id:a.recipient_id}),message:JSON.stringify({text:`${a.message}\n\nHuman support: ${a.human_support_url}`})},'page');
      required(result.recipient_id===a.recipient_id && typeof result.message_id==='string' && result.message_id.length>0,'INSTAGRAM_OUTCOME_UNKNOWN','Meta did not confirm the message identity. Reconcile the conversation before another attempt.');
      return {message:pick(result,['recipient_id','message_id'])};
    },async a=>{
      required(config.humanSupportUrl && a.human_support_url===config.humanSupportUrl,'INSTAGRAM_HUMAN_SUPPORT_REQUIRED','Configure a working human support URL and include that exact URL in the action.');
      required(Buffer.byteLength(`${a.message}\n\nHuman support: ${a.human_support_url}`,'utf8')<=1000,'INSTAGRAM_INVALID_INPUT','The message including the human support footer must fit within 1,000 UTF-8 bytes.');
      required(store.inboundMessageAt(self(),a.recipient_id),'INSTAGRAM_MESSAGING_WINDOW_CLOSED','A verified inbound message from this recipient within the last 24 hours is required.');
    });
  tools[tools.length-1]!.documentation='https://developers.facebook.com/documentation/business-messaging/instagram-messaging/features/send-message';
  const webhookPermissions:Record<string,string[]>={comments:['instagram_manage_comments'],live_comments:['instagram_manage_comments'],mentions:['instagram_manage_comments'],story_insights:['instagram_manage_insights'],messages:['instagram_manage_messages']};
  write('instagram_subscribe_webhooks','Subscribe the linked Facebook Page to supported Instagram webhook fields after configuring and verifying the app callback URL in Meta.',z.object({fields:z.array(z.enum(['comments','live_comments','mentions','story_insights','messages'])).min(1).max(5)}),[...base,'pages_show_list','pages_manage_metadata'],
    [{method:'POST',path:'/{page-id}/subscribed_apps'}],'webhooks/setup',async a=>({subscribed:mutationSuccess(await api.request('POST',`/${pageId()}/subscribed_apps`,{subscribed_fields:[...new Set(a.fields)].join(',')},'page')),fields:a.fields}),async a=>{api.connection([...new Set(a.fields.flatMap(f=>webhookPermissions[f]!))]);required(config.webhookVerifyToken,'INSTAGRAM_CONFIG_ERROR','Configure the webhook verification token before subscribing.');});
  tools[tools.length-1]!.conditionalPermissions=webhookPermissions;

  async function deleteObject(target:string) { return mutationSuccess(await api.request('DELETE',`/${target}`)); }
  function createdComment(result:Data):Data { required(id.safeParse(result.id).success,'INSTAGRAM_OUTCOME_UNKNOWN','Meta did not confirm the created comment ID. Reconcile the media before another attempt.'); return pick(result,['id']); }
  function mutationSuccess(result:Data):boolean { required(result.success===true,'INSTAGRAM_OUTCOME_UNKNOWN','Meta did not confirm the mutation. Check the resource before another attempt.'); return true; }
  const registry:Registry={tools,async call(name,args) {
    const requestId=randomUUID(); let active:Job|undefined; let definition:ToolDefinition|undefined;
    try {
      definition=tools.find(t=>t.name===name);
      required(definition,'INSTAGRAM_TOOL_NOT_FOUND','The requested tool is not registered.');
      const parsed=definition.inputSchema.safeParse(args);
      if(!parsed.success) throw new InstagramError('INSTAGRAM_INVALID_INPUT','The tool arguments are invalid.',{fields:parsed.error.issues.map(i=>i.path.join('.'))});
      const input:Data={...parsed.data}; const approvalId=input.approval_id; delete input.approval_id;
      const account=api.connection(definition.requiredPermissions);
      const tool=definition;
      return await api.withConnection(account, async()=>{
      if(!tool.write) return {success:true,...await tool.run(input),request_id:requestId};
      // Check completed actions before accessing deleted resources, so harmless retries return the cached result.
      if(typeof approvalId==='string') {
        const existing=store.getJob(approvalId);
        if(existing?.status==='completed') { active=store.beginJob(approvalId,name,input,account.accountId); return {success:true,...active.result,replayed:true,request_id:requestId}; }
      }
      await tool.preflight?.(input);
      if(typeof approvalId!=='string') {
        const pending=store.requestApproval(name,input,account.accountId);
        store.audit({actor:'mcp_client',tool:name,accountId:account.accountId,operation:'request_approval',result:'pending',requestId});
        throw new InstagramError('INSTAGRAM_APPROVAL_REQUIRED','A human must review and approve this exact action using the operator CLI.',{approval_id:pending.id,expires_at:new Date(pending.expiresAt).toISOString(),review_command:`furlpay-instagram-mcp approve ${pending.id}`});
      }
      active=store.beginJob(approvalId,name,input,account.accountId);
      store.audit({actor:'mcp_client',tool:name,accountId:account.accountId,operation:'execute',result:'started',requestId});
      const result=await tool.run(input,active);
      if(result.status!=='processing') store.updateJob(active.id,'completed','done',store.getJob(active.id)!.data,result);
      store.audit({actor:'mcp_client',tool:name,accountId:account.accountId,operation:'execute',resourceId:String(object(result.media).id??object(result.comment).id??input.media_id??input.comment_id??active.id),result:result.status==='processing'?'processing':'completed',requestId});
      return {success:true,...result,request_id:requestId};
      });
    } catch(error) {
      if(active && store.getJob(active.id)?.status!=='completed') {
        const code=error instanceof InstagramError?error.code:'INSTAGRAM_INTERNAL_ERROR';
        const state=code==='INSTAGRAM_OUTCOME_UNKNOWN'?'unknown':'failed';
        store.updateJob(active.id,state,store.getJob(active.id)?.phase??'error',store.getJob(active.id)?.data??{}, {error_code:code});
        store.audit({actor:'mcp_client',tool:name,accountId:active.accountId,operation:'execute',result:code,requestId});
      } else if(definition?.write && !active) {
        const c=store.getConnection();
        if(c)store.audit({actor:'mcp_client',tool:name,accountId:c.accountId,operation:'authorize',result:error instanceof InstagramError?error.code:'INSTAGRAM_INTERNAL_ERROR',requestId});
      }
      return publicError(error,requestId);
    }
  }};
  if(!client) cache.set(store,registry);
  return registry;
}
