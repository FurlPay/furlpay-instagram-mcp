import { createHmac } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { InstagramError, required } from './errors.js';
import type { Config, Connection, Data, Fetch } from './types.js';
import type { Store } from './store.js';

export const object = (v: unknown): Data => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Data : {};
export const records = (v: unknown): Data[] => Array.isArray(v) ? v.map(object) : [];
export type Params = Record<string, string | number | boolean | undefined>;
export class ApiClient {
  private bound = new AsyncLocalStorage<Connection>();
  private failures = 0;
  private openUntil = 0;
  private nextRequest = 0;
  constructor(readonly config: Config, readonly store: Store, private fetcher: Fetch = fetch,
    private pause: (ms: number) => Promise<unknown> = sleep, private now = Date.now) {}

  connection(permissions: string[] = []): Connection {
    const c = this.store.getConnection();
    required(c && c.appId === this.config.appId && c.product === 'facebook_login', 'INSTAGRAM_REAUTH_REQUIRED', 'Connect the intended Instagram professional account using the operator CLI.');
    const bound = this.bound.getStore();
    required(!bound || (bound.accountId===c.accountId && bound.accessToken===c.accessToken && bound.pageId===c.pageId && bound.connectedAt===c.connectedAt), 'INSTAGRAM_CONNECTION_CHANGED', 'The account connection changed during this operation. Reconcile any in-flight write before continuing.');
    required(c.expiresAt === null || c.expiresAt > this.now() + 30_000, 'INSTAGRAM_REAUTH_REQUIRED', 'The authorization has expired. Reconnect using Meta OAuth.');
    required(!c.dataAccessExpiresAt || c.dataAccessExpiresAt > this.now() + 30_000, 'INSTAGRAM_REAUTH_REQUIRED', 'Meta data access has expired. Reconnect using OAuth.');
    const missing = permissions.filter(p => !c.permissions.includes(p));
    required(missing.length === 0, 'INSTAGRAM_PERMISSION_REQUIRED', `This operation requires granted permissions: ${missing.join(', ')}.`);
    return c;
  }
  withConnection<T>(connection: Connection, work: () => Promise<T>): Promise<T> { return this.bound.run(connection, work); }
  async request(method: 'GET' | 'POST' | 'DELETE', path: string, params: Params = {}, tokenType: 'user' | 'page' = 'user'): Promise<Data> {
    required(/^\/[A-Za-z0-9_:.=-]+(?:\/[a-z_]+)?$/.test(path), 'INSTAGRAM_INVALID_REQUEST', 'Invalid internal API route.');
    const c = this.connection();
    const token = tokenType === 'page' ? c.pageAccessToken : c.accessToken;
    required(token, 'INSTAGRAM_REAUTH_REQUIRED', 'Reconnect to authorize the linked Page.');
    const attempts = method === 'GET' ? 3 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      required(this.openUntil <= this.now(), 'INSTAGRAM_CIRCUIT_OPEN', 'Meta is temporarily unavailable or rate limited. Try again later.');
      const slot = Math.max(this.now(), this.nextRequest);
      required(slot - this.now() < 10_000, 'INSTAGRAM_RATE_LIMITED', 'The local request queue is full. Try again later.');
      this.nextRequest = slot + 500;
      if (slot > this.now()) await this.pause(slot - this.now());
      this.assertSameConnection(c);
      const url = new URL(`https://graph.facebook.com/${this.config.apiVersion}${path}`);
      const values = new URLSearchParams();
      for (const [k,v] of Object.entries(params)) if (v !== undefined) values.set(k, String(v));
      values.set('appsecret_proof', createHmac('sha256', this.config.appSecret).update(token).digest('hex'));
      if (method !== 'POST') url.search = values.toString();
      try {
        const response = await this.fetcher(url, { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(method === 'POST' ? {'Content-Type': 'application/x-www-form-urlencoded'} : {}) },
          body: method === 'POST' ? values : undefined, signal: AbortSignal.timeout(15_000), redirect: 'error' });
        const bodyText = await boundedBody(response,method);
        try { this.assertSameConnection(c); } catch {
          throw new InstagramError(method==='GET'?'INSTAGRAM_CONNECTION_CHANGED':'INSTAGRAM_OUTCOME_UNKNOWN','The connection changed while Meta was processing this request. Reconcile any write before continuing.');
        }
        let data: Data;
        try { data = object(JSON.parse(bodyText)); } catch { throw new InstagramError(method === 'GET' ? 'INSTAGRAM_UPSTREAM_UNAVAILABLE' : 'INSTAGRAM_OUTCOME_UNKNOWN', 'Meta returned an invalid response. Reconcile any write before another attempt.', undefined, true); }
        const error = object(data.error), code = Number(error.code), subcode = Number(error.error_subcode);
        if (!response.ok || data.error) {
          if (code === 190 || code === 102 || response.status === 401) throw new InstagramError('INSTAGRAM_REAUTH_REQUIRED', 'Meta authorization is invalid or expired. Reconnect using OAuth.');
          if (code === 10 || code === 200 || response.status === 403) throw new InstagramError('INSTAGRAM_PERMISSION_REQUIRED', 'Meta denied this operation. Check permissions, Page tasks, App Review and account eligibility.');
          const limited = response.status === 429 || [4,17,32,613,80002].includes(code);
          const header = response.headers.get('retry-after');
          const retryMs = header ? (/^\d+$/.test(header) ? Number(header) * 1000 : Math.max(0, Date.parse(header) - this.now())) : 1000;
          if (limited) {
            if (retryMs > 30_000 || attempt === attempts - 1) this.openUntil = this.now() + Math.min(Math.max(retryMs, 1000), 3_600_000);
            throw new InstagramError('INSTAGRAM_RATE_LIMITED', 'Meta rate limited this account. Retry after the indicated delay.', { retry_after_seconds: Math.ceil(retryMs / 1000) }, true);
          }
          if (response.status >= 500 || error.is_transient === true) throw new InstagramError(method === 'GET' ? 'INSTAGRAM_UPSTREAM_UNAVAILABLE' : 'INSTAGRAM_OUTCOME_UNKNOWN', 'Meta could not confirm the request outcome.', undefined, true);
          if ([2207003,2207009,2207010,2207026,2207052].includes(subcode) || code === 352) throw new InstagramError('INSTAGRAM_INVALID_MEDIA', 'Meta rejected the media. Check the public URL, file format, size and processing requirements.');
          throw new InstagramError('INSTAGRAM_API_REJECTED', 'Meta rejected the operation. Check the documented input and resource eligibility.', { meta_code: Number.isFinite(code) ? code : undefined, meta_subcode: Number.isFinite(subcode) ? subcode : undefined });
        }
        this.failures = 0;
        this.observeUsage(response.headers.get('x-business-use-case-usage'));
        return data;
      } catch (e) {
        const error = e instanceof InstagramError ? e : new InstagramError(method === 'GET' ? 'INSTAGRAM_UPSTREAM_UNAVAILABLE' : 'INSTAGRAM_OUTCOME_UNKNOWN', method === 'GET' ? 'The Meta request timed out or could not be reached.' : 'Meta may have received this write. Check its outcome before approving another attempt.', undefined, true);
        if (error.retryable) {
          this.failures++;
          if (this.failures >= 5) this.openUntil = this.now() + 30_000;
        }
        if (!error.retryable || attempt + 1 >= attempts || this.openUntil > this.now()) throw error;
        const delay = Math.max(Number(error.details?.retry_after_seconds ?? 0) * 1000, Math.floor(Math.random() * (500 * 2 ** attempt)));
        await this.pause(delay);
      }
    }
    throw new InstagramError('INSTAGRAM_UPSTREAM_UNAVAILABLE', 'Meta could not be reached.');
  }
  private assertSameConnection(expected:Connection) {
    const current=this.connection();
    required(current.accountId===expected.accountId && current.connectedAt===expected.connectedAt && current.accessToken===expected.accessToken && current.pageAccessToken===expected.pageAccessToken && current.pageId===expected.pageId,
      'INSTAGRAM_CONNECTION_CHANGED','The connection changed before this request could be sent.');
  }
  private observeUsage(raw: string | null) {
    if (!raw) return;
    try {
      for (const entries of Object.values(object(JSON.parse(raw)))) for (const entry of records(entries)) {
        if (Math.max(Number(entry.call_count ?? 0), Number(entry.total_cputime ?? 0), Number(entry.total_time ?? 0)) >= 100) {
          this.openUntil = this.now() + Math.min(Math.max(Number(entry.estimated_time_to_regain_access ?? 1), 1), 60) * 60_000;
        }
      }
    } catch { /* Header formats can change. HTTP/error handling remains authoritative. */ }
  }
  async ownedMedia(id: string): Promise<Data> {
    const media = await this.request('GET', `/${id}`, { fields: 'id,owner,media_type,media_product_type' });
    required(object(media.owner).id === this.connection().accountId, 'INSTAGRAM_RESOURCE_FORBIDDEN', 'The connected Instagram account must own this media.');
    return media;
  }
  async ownedComment(id: string): Promise<Data> {
    const comment = await this.request('GET', `/${id}`, { fields: 'id,media' });
    const mediaId = object(comment.media).id;
    required(typeof mediaId === 'string' && /^\d+$/.test(mediaId), 'INSTAGRAM_RESOURCE_FORBIDDEN', 'Meta did not establish this comment’s media ownership.');
    await this.ownedMedia(mediaId);
    return comment;
  }
}

async function boundedBody(response:Response,method:string):Promise<string> {
  const limit=2_000_000;
  const tooLarge=()=>new InstagramError(method==='GET'?'INSTAGRAM_RESPONSE_TOO_LARGE':'INSTAGRAM_OUTCOME_UNKNOWN','Meta returned more data than permitted. Reconcile any write before another attempt.');
  if(Number(response.headers.get('content-length'))>limit){await response.body?.cancel();throw tooLarge();}
  if(!response.body)return '';
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let length=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>limit){await reader.cancel();throw tooLarge();}chunks.push(value);}}
  finally{reader.releaseLock();}
  return Buffer.concat(chunks,length).toString('utf8');
}
