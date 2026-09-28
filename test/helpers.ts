import { Store } from '../src/store.js';
import { ApiClient } from '../src/api.js';
import { createRegistry } from '../src/registry.js';
import type { Config, Connection, Data, Fetch } from '../src/types.js';

export const config: Config = {product:'facebook_login',apiVersion:'v26.0',appId:'100',appSecret:'fixture-client-secret',encryptionKey:Buffer.alloc(32,7),databasePath:':memory:',redirectUri:'http://localhost:8787/oauth/callback',httpHost:'127.0.0.1',httpPort:8788,webhookVerifyToken:'fixture-verify-token',humanSupportUrl:'https://furlpay.com/support'};
export const connection: Connection = {product:'facebook_login',accountId:'123',username:'furlpay',appId:'100',accessToken:'fixture-user-secret',pageAccessToken:'fixture-page-secret',pageId:'456',userId:'789',issuedAt:Date.now(),connectedAt:Date.now(),expiresAt:Date.now()+3_600_000,permissions:['instagram_basic','pages_read_engagement','pages_show_list','instagram_content_publish','instagram_manage_comments','instagram_manage_insights','instagram_manage_contents','instagram_manage_engagement','instagram_manage_messages','pages_manage_metadata','pages_messaging']};
export interface Call {method:string;path:string;params:URLSearchParams;headers:Headers}
export type Reply = Data | Response | Error;
export function harness(reply: (call:Call,index:number)=>Reply = ()=>({})) {
  const store=new Store(':memory:',config.encryptionKey);store.saveConnection(connection);
  const calls:Call[]=[];let time=Date.now();
  const fetcher:Fetch=async (input,init)=>{
    const url=new URL(String(input));
    const call={method:init?.method??'GET',path:url.pathname.replace('/v26.0',''),params:init?.method==='POST'?new URLSearchParams(String(init.body)):url.searchParams,headers:new Headers(init?.headers)};
    calls.push(call);const value=reply(call,calls.length-1);
    if(value instanceof Error) throw value;
    return value instanceof Response?value:Response.json(value);
  };
  const api=new ApiClient(config,store,fetcher,async ms=>{time+=ms;},()=>time);
  return {store,calls,api,fetcher,registry:createRegistry(config,store,api)};
}
export function data(value:unknown):Data {return value as Data;}
export const owned={id:'501',owner:{id:'123'},media_type:'IMAGE',media_product_type:'FEED'};
export async function approve(h:ReturnType<typeof harness>,tool:string,args:Data) {
  const result=await h.registry.call(tool,args);
  const approvalId=String(data(result.error).approval_id);
  h.store.approve(approvalId,'test-human');
  return {...args,approval_id:approvalId};
}
